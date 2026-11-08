// Journal tail: follows an append-only JSONL file and hands parsed records to a callback.
// Survives partial last lines, truncation, rotation (inode change), garbage and oversized lines.
import fs from 'node:fs';
import path from 'node:path';

const MB = 1024 * 1024;

export class Journal {
  /**
   * @param {string} file journal path
   * @param {object} opts
   * @param {(records: object[], info: {replay: boolean, initial: boolean}) => void} opts.onRecords
   * @param {object} [opts.stats] counters object shared with the state store
   * @param {number} [opts.tailBytes] bytes of history read on startup (default 5 MB)
   * @param {number} [opts.maxLine] lines longer than this many bytes are ignored (default 4096)
   * @param {number} [opts.pollMs] stat poll interval (default 1000)
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(file, opts = {}) {
    this.file = path.resolve(file);
    this.onRecords = opts.onRecords || (() => {});
    this.tailBytes = opts.tailBytes ?? 5 * MB;
    this.maxLine = opts.maxLine ?? 4096;
    this.pollMs = opts.pollMs ?? 1000;
    this.log = opts.log || (() => {});
    this.stats = opts.stats || {};
    for (const k of ['parse_errors', 'too_long', 'lines', 'rotations', 'truncations']) this.stats[k] ??= 0;

    this.fd = null;
    this.ino = 0n;
    this.offset = 0;
    this.partial = [];     // Buffer chunks of the current unfinished line
    this.partialLen = 0;
    this.skipping = false; // discarding the rest of an oversized / leading partial line
    this.everOpened = false;
    this.replay = false;   // true after a rotation/truncation until the first full drain
    this.timer = null;
    this.watcher = null;
    this.debounce = null;
    this.initialDone = false;
  }

  /** Read the tail of the file synchronously, then start watching. */
  start({ watch = true } = {}) {
    this.poll(true);
    this.initialDone = true;
    if (watch) {
      this.timer = setInterval(() => {
        this.ensureWatcher();
        this.poll();
      }, this.pollMs);
      this.ensureWatcher();
    }
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } }
    this.timer = this.debounce = this.watcher = null;
    this.closeFd();
  }

  ensureWatcher() {
    if (this.watcher) return;
    const dir = path.dirname(this.file);
    const base = path.basename(this.file);
    try {
      this.watcher = fs.watch(dir, { persistent: false }, (_evt, name) => {
        if (name && name !== base) return;
        this.schedule();
      });
      this.watcher.on('error', () => {
        try { this.watcher.close(); } catch { /* ignore */ }
        this.watcher = null; // poll keeps working; ensureWatcher retries on the next tick
      });
    } catch {
      this.watcher = null; // directory missing: retried by the poll timer
    }
  }

  schedule() {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.poll();
    }, 8);
  }

  closeFd() {
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* ignore */ } }
    this.fd = null;
  }

  resetBuffer() {
    this.partial = [];
    this.partialLen = 0;
    this.skipping = false;
  }

  /** Check the file once; reads whatever is new. Returns the number of records delivered. */
  poll(initial = false) {
    let st;
    try {
      st = fs.statSync(this.file, { bigint: true });
    } catch {
      if (this.fd !== null) { this.drain(initial); this.closeFd(); this.offset = 0; this.resetBuffer(); this.replay = true; }
      return 0;
    }
    if (!st.isFile()) return 0;
    let delivered = 0;

    if (this.fd !== null && st.ino !== 0n && this.ino !== 0n && st.ino !== this.ino) {
      // Rotation: finish the old file, then switch to the new one.
      delivered += this.drain(initial);
      this.closeFd();
      this.stats.rotations++;
      this.log(`journal rotated (inode changed), reopening ${this.file}`);
      this.offset = 0;
      this.resetBuffer();
      this.replay = true;
    }

    if (this.fd === null) {
      try {
        this.fd = fs.openSync(this.file, 'r');
      } catch {
        return delivered;
      }
      this.ino = st.ino;
      if (!this.everOpened) {
        // First open: read only the tail.
        const size = Number(st.size);
        if (size > this.tailBytes) {
          this.offset = size - this.tailBytes - 1; // one byte before: tells whether we start on a line boundary
          this.skipping = true;
        } else {
          this.offset = 0;
        }
        this.everOpened = true;
      } else {
        this.offset = 0;
      }
    } else if (Number(st.size) < this.offset) {
      this.stats.truncations++;
      this.log('journal truncated, re-reading from the start');
      this.offset = 0;
      this.resetBuffer();
      this.replay = true;
    }

    delivered += this.drain(initial);
    return delivered;
  }

  /** Read from the current offset until EOF (bounded per call). */
  drain(initial) {
    if (this.fd === null) return 0;
    const buf = Buffer.allocUnsafe(1 * MB);
    const records = [];
    let budget = 64 * MB;
    while (budget > 0) {
      let n = 0;
      try {
        n = fs.readSync(this.fd, buf, 0, buf.length, this.offset);
      } catch {
        break;
      }
      if (n <= 0) break;
      this.offset += n;
      budget -= n;
      this.consume(buf.subarray(0, n), records);
    }
    // The first drain after a rotation/truncation is delivered flagged as replay.
    if (records.length) this.onRecords(records, { replay: this.replay, initial: !!initial });
    this.replay = false;
    return records.length;
  }

  consume(chunk, out) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) {
        if (!this.skipping && start < chunk.length) {
          const rest = chunk.subarray(start);
          this.partial.push(Buffer.from(rest)); // copy: chunk buffer is reused
          this.partialLen += rest.length;
          if (this.partialLen > this.maxLine) {
            this.stats.too_long++;
            this.partial = [];
            this.partialLen = 0;
            this.skipping = true;
          }
        }
        return;
      }
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (this.skipping) {
        this.skipping = false;
        this.partial = [];
        this.partialLen = 0;
        continue;
      }
      let line;
      if (this.partialLen) {
        line = Buffer.concat([...this.partial, piece]);
        this.partial = [];
        this.partialLen = 0;
      } else {
        line = piece;
      }
      if (line.length > this.maxLine) { this.stats.too_long++; continue; }
      this.handleLine(line, out);
    }
  }

  handleLine(line, out) {
    let s = line.toString('utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    s = s.trim();
    if (!s) return;
    this.stats.lines++;
    if (s.charCodeAt(0) !== 0x7b /* { */) { this.stats.parse_errors++; return; }
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj);
      else this.stats.parse_errors++;
    } catch {
      this.stats.parse_errors++;
    }
  }
}
