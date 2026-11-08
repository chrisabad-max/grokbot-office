# The dashboard's background music: a calm 84 bpm loop in C (16 bars, ~45.7 s), stdlib only.
# Usage: py -3 make_loop.py <out_dir>   ->  <out_dir>/loop-raw.wav (three identical cycles + tail) and ir.wav.
# build_loop.sh then adds the reverb, cuts one steady-state cycle plus a 2 s overlap and encodes it; the player
# (web/audio/sound.js) crossfades that overlap into the next copy, so the loop has no seam.
import math, random, wave, array, os, sys

SR = 44100
TAU = 2 * math.pi
sin, exp, tanh = math.sin, math.exp, math.tanh
BPM = 84
BEAT = 60 / BPM
BAR = 4 * BEAT
BARS = 16
CYCLE = BARS * BAR
OVERLAP = 2.0
N = int((3 * CYCLE + 4) * SR)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))

L = array.array('f', bytes(4 * N))
R = array.array('f', bytes(4 * N))


def hz(m):
    return 440 * 2 ** ((m - 69) / 12)


def put(t0, sig, gain=1.0, pan=0.0, sig_r=None):
    i0 = int(round(t0 * SR))
    gl = math.cos((pan + 1) * math.pi / 4) * gain * 1.4142
    gr = math.sin((pan + 1) * math.pi / 4) * gain * 1.4142
    r = sig_r if sig_r is not None else sig
    for k in range(max(0, -i0), min(len(sig), N - i0)):
        L[i0 + k] += sig[k] * gl
        R[i0 + k] += r[k] * gr


def norm(x):
    p = max(abs(v) for v in x) or 1.0
    return [v / p for v in x]


TB = 2048
SAW = [sum(sin(TAU * h * i / TB) / h for h in range(1, 20)) for i in range(TB)]
_m = max(abs(v) for v in SAW)
SAW = [v / _m for v in SAW]
_pad = {}


def pad(notes, dur, att=0.6, rel=1.0, cutoff=1100):
    key = (tuple(notes), round(dur, 3))
    if key in _pad:
        return _pad[key]
    rng = random.Random(hash(key) & 0xffff)
    n = int((dur + rel) * SR)
    a, b = [0.0] * n, [0.0] * n
    for m in notes:
        f = hz(m)
        for det, main, other in ((-0.0035, a, b), (0.0035, b, a)):
            inc, ph = f * (1 + det) * TB / SR, rng.random() * TB
            for k in range(n):
                v = SAW[int(ph) & 2047]
                ph += inc
                main[k] += v
                other[k] += 0.35 * v
    c = 1 - exp(-TAU * cutoff / SR)
    yl = yr = 0.0
    for k in range(n):
        t = k / SR
        e = 0.5 - 0.5 * math.cos(math.pi * t / att) if t < att else (
            0.5 + 0.5 * math.cos(math.pi * min(1.0, (t - dur) / rel)) if t > dur else 1.0)
        yl += c * (a[k] - yl)
        yr += c * (b[k] - yr)
        a[k], b[k] = yl * e, yr * e
    _pad[key] = (a, b)
    return a, b


_ep = {}


def ep(m, dur):
    key = (m, round(dur, 3))
    if key not in _ep:
        w = TAU * hz(m) / SR
        n = int((dur + 0.8) * SR)
        out = [0.0] * n
        for k in range(n):
            t = k / SR
            a = exp(-t * 0.9) * (1 - exp(-t * 300))
            if t > dur:
                a *= exp(-(t - dur) * 7)
            idx = 1.3 * exp(-t * 3) + 0.2
            out[k] = a * (sin(w * k + idx * sin(w * k)) + 0.08 * exp(-t * 26) * sin(14 * w * k))
        _ep[key] = out
    return _ep[key]


_bass = {}


def bass(m, dur):
    key = (m, round(dur, 3))
    if key not in _bass:
        w = TAU * hz(m) / SR
        n = int((dur + 0.15) * SR)
        out = [0.0] * n
        for k in range(n):
            t = k / SR
            a = (1 - exp(-t * 180)) * (0.6 + 0.4 * exp(-t * 3))
            if t > dur:
                a *= max(0.0, 1 - (t - dur) / 0.15)
            out[k] = a * tanh(1.2 * (sin(w * k) + 0.2 * sin(2 * w * k)))
        _bass[key] = out
    return _bass[key]


def bell(m, dur=1.8):
    w = TAU * hz(m) / SR
    return norm([exp(-k / SR * 2.4) * (1 - exp(-k / SR * 900)) * sin(w * k + 0.5 * exp(-k / SR * 6) * sin(3.0 * w * k))
                 + 0.2 * exp(-k / SR * 7) * sin(2 * w * k) for k in range(int(dur * SR))])


rng = random.Random(3)
KICK, ph = [], 0.0
for k in range(int(0.45 * SR)):
    t = k / SR
    ph += TAU * (46 + 90 * exp(-t * 28)) / SR
    KICK.append(tanh(1.3 * exp(-t * 8) * sin(ph)))
KICK = norm(KICK)
RIM, y1, y2 = [], 0.0, 0.0
for k in range(int(0.25 * SR)):
    t = k / SR
    x = rng.random() * 2 - 1
    y1 += 0.52 * (x - y1)
    y2 += 0.12 * (x - y2)
    RIM.append((y1 - y2) * exp(-t * 24) + 0.3 * sin(TAU * 320 * t) * exp(-t * 40))
RIM = norm(RIM)
SHK, lp = [], 0.0
for k in range(int(0.1 * SR)):
    t = k / SR
    x = rng.random() * 2 - 1
    lp += 0.47 * (x - lp)
    SHK.append((x - lp) * (1 - exp(-t * 150)) * exp(-t * 34))
SHK = norm(SHK)

A = [(41, [57, 60, 64, 67], [84, 81, 79]),    # Fmaj9
     (40, [55, 59, 62, 64], [83, 79, 76]),    # Em7
     (45, [55, 59, 60, 64], [84, 83, 76]),    # Am9
     (43, [59, 62, 64, 67], [86, 83, 79])]    # G6
B = [(38, [53, 57, 60, 64], [81, 77, 76]),    # Dm9
     (40, [55, 59, 62, 64], [83, 79, 76]),    # Em7
     (41, [57, 60, 64, 67], [84, 81, 79]),    # Fmaj9
     (43, [55, 60, 62, 67], [86, 84, 79])]    # Gsus
SONG = A + A + B + A

for cycle in range(3):
    for b, (root, voicing, motif) in enumerate(SONG):
        t = cycle * CYCLE + b * BAR
        lift = b >= 8                                       # second half: the bell line and a fuller groove
        pa, pb = pad(voicing, BAR)
        put(t, pa, 0.017, 0, pb)
        for i, m in enumerate(voicing):                     # keys: on 1 and on the "and" of 2, slightly strummed
            put(t + i * 0.014, ep(m, 1.4 * BEAT), 0.06, -0.3 + 0.2 * i)
            put(t + 1.5 * BEAT + i * 0.014, ep(m, 2.2 * BEAT), 0.045, -0.3 + 0.2 * i)
        put(t, bass(root, 1.3 * BEAT), 0.28)
        put(t + 1.5 * BEAT, bass(root, 1.0 * BEAT), 0.24)
        put(t + 3.5 * BEAT, bass(root + 12, 0.35 * BEAT), 0.12)
        put(t, KICK, 0.34)
        put(t + 1.5 * BEAT, KICK, 0.24)
        put(t + 2 * BEAT, RIM, 0.11, 0.1)
        for s in range(8):
            put(t + s * BEAT / 2, SHK, (0.035 if s % 2 else 0.02) * (1.15 if lift else 1), 0.35)
        if lift:
            for when, m in zip((0, 1.5, 3), motif):
                put(t + when * BEAT, bell(m), 0.045, 0.25)
        elif b % 4 == 3:
            put(t + 3 * BEAT, bell(motif[0]), 0.03, 0.25)


def write(path, a, b, target=0.9):
    p = max(max(abs(v) for v in a), max(abs(v) for v in b)) or 1.0
    k = target / p
    data = array.array('h', bytes(4 * len(a)))
    for i in range(len(a)):
        data[2 * i] = int(a[i] * k * 32767)
        data[2 * i + 1] = int(b[i] * k * 32767)
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def make_ir(length=2.6, rt60=2.0, pre=0.015):
    r2 = random.Random(9)
    n = int(length * SR)
    a, b = [0.0] * n, [0.0] * n
    yl = yr = 0.0
    for k in range(int(pre * SR), n):
        t = k / SR - pre
        g = exp(-6.91 * t / rt60)
        c = 1 - exp(-TAU * (500 + 7000 * exp(-t * 1.8)) / SR)
        yl += c * ((r2.random() * 2 - 1) - yl)
        yr += c * ((r2.random() * 2 - 1) - yr)
        a[k], b[k] = g * yl, g * yr
    return a, b


write(os.path.join(OUT, 'loop-raw.wav'), L, R, 0.6)
write(os.path.join(OUT, 'ir.wav'), *make_ir())
print(f'cycle {CYCLE:.4f} s, overlap {OVERLAP} s')
