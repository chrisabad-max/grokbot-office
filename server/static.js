// Static file serving with path-traversal protection, MIME types, ETag and cache headers.
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * @param {{prefix: string, dir: string, cache: string}[]} mounts e.g. [{prefix:'/assets/', ...}, {prefix:'/', ...}]
 */
export function createStatic(mounts) {
  const sorted = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length);
  const roots = new Map();
  const realRoot = (dir) => {
    if (!roots.has(dir)) {
      try { roots.set(dir, fs.realpathSync(dir)); } catch { roots.set(dir, null); }
    }
    return roots.get(dir);
  };

  /** Resolve a URL pathname to a file inside a mount, or null. */
  function resolve(pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    for (const m of sorted) {
      const prefix = m.prefix;
      if (!(decoded === prefix.replace(/\/$/, '') || decoded.startsWith(prefix))) continue;
      const rel = decoded.slice(prefix.length);
      const segs = rel.split('/').filter((s) => s !== '');
      if (segs.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null;
      const root = realRoot(m.dir);
      if (!root) return null;
      let file = path.join(root, ...segs);
      let st;
      try { st = fs.statSync(file); } catch { return null; }
      if (st.isDirectory()) {
        file = path.join(file, 'index.html');
        try { st = fs.statSync(file); } catch { return null; }
      }
      if (!st.isFile()) return null;
      let real;
      try { real = fs.realpathSync(file); } catch { return null; }
      if (real !== root && !real.startsWith(root + path.sep)) return null; // symlink escape
      return { file: real, st, cache: m.cache };
    }
    return null;
  }

  /** Handle GET/HEAD. Returns true if a response was started. */
  function handle(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return true;
    }
    const hit = resolve(pathname);
    if (!hit) return false;
    const { file, st, cache } = hit;
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': mimeFor(file),
      'Cache-Control': cache,
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return true; }
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return true;
  }

  return { handle, resolve };
}
