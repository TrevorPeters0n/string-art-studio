#!/usr/bin/env python3
"""Generates icon.ico + icon-64/256.png for String Art Studio.

Pure standard library. The mark is a nail ring with a bunch of chords whose
envelope forms a crescent - the same idea at every size, drawn with fewer,
heavier chords below 32 px where fine lines disappear. Chords deliberately
miss the centre; diameters would read as a wheel.

    python make_icon.py
"""
import math, struct, zlib

INK = (216, 162, 74)          # matches --accent in css/style.css

def png_bytes(w, h, rgba):
    raw = b''.join(b'\x00' + bytes(rgba[y*w*4:(y+1)*w*4]) for y in range(h))
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

class Cov:
    """Additive coverage, so crossing chords build up density like real thread."""
    def __init__(self, S): self.S = S; self.a = [0.0]*(S*S)
    def _add(self, x, y, v):
        if 0 <= x < self.S and 0 <= y < self.S: self.a[y*self.S+x] += v
    def line(self, x0, y0, x1, y1, w):
        n = int(max(abs(x1-x0), abs(y1-y0))*2)+2
        r = w/2.0; seen = set()
        for k in range(n+1):
            t = k/n; x, y = x0+(x1-x0)*t, y0+(y1-y0)*t
            for oy in range(int(-r-1), int(r+2)):
                for ox in range(int(-r-1), int(r+2)):
                    px, py = int(x)+ox, int(y)+oy
                    if (px, py) in seen: continue
                    v = min(1.0, max(0.0, r+0.5-math.hypot(px+0.5-x, py+0.5-y)))
                    if v > 0: seen.add((px, py)); self._add(px, py, v)
    def ring(self, cx, cy, R, w):
        n = int(2*math.pi*R*3)
        for k in range(n):
            a0, a1 = 2*math.pi*k/n, 2*math.pi*(k+1)/n
            self.line(cx+R*math.cos(a0), cy+R*math.sin(a0),
                      cx+R*math.cos(a1), cy+R*math.sin(a1), w)

def nail(cx, cy, R, n, i):
    a = -math.pi/2 + 2*math.pi*i/n
    return cx+R*math.cos(a), cy+R*math.sin(a)

def render(size, N, gap, count, ringw, lw, boost, ss):
    S = size*ss; c = Cov(S); cx = cy = (S-1)/2.0; R = S*0.42
    c.ring(cx, cy, R, max(1.0, S*ringw))
    for i in range(count):
        x0, y0 = nail(cx, cy, R, N, i)
        x1, y1 = nail(cx, cy, R, N, (i+gap) % N)
        c.line(x0, y0, x1, y1, max(1.0, S*lw))
    out = bytearray(size*size*4)
    for y in range(size):
        for x in range(size):
            s = 0.0
            for dy in range(ss):
                for dx in range(ss):
                    s += min(1.4, c.a[(y*ss+dy)*S+(x*ss+dx)])
            a = min(1.0, s/(ss*ss)*boost)
            o = (y*size+x)*4
            out[o], out[o+1], out[o+2], out[o+3] = INK[0], INK[1], INK[2], int(a*255)
    return out

def mark(size):
    if size <= 32:      # few, heavy chords - fine ones vanish at this scale
        return render(size, 12, 5, 4, 0.055, 0.085, 1.15, 8)
    return render(size, 36, 15, 22, 0.020, 0.011, 1.30, 4)

SIZES = [16, 20, 24, 32, 48, 64, 128, 256]
imgs = []
for s in SIZES:
    p = png_bytes(s, s, mark(s))
    imgs.append((s, p))
    if s in (64, 256):
        open('icon-%d.png' % s, 'wb').write(p)

n = len(imgs); entries = b''; data = b''; off = 6 + 16*n
for s, p in imgs:
    w = 0 if s >= 256 else s
    entries += struct.pack('<BBBBHHII', w, w, 0, 0, 1, 32, len(p), off)
    off += len(p); data += p
open('icon.ico', 'wb').write(struct.pack('<HHH', 0, 1, n) + entries + data)
print('icon.ico (%d sizes) + icon-64.png + icon-256.png written' % n)
