/* Procedurally drawn stand-in images so the app is usable with no file. */

const SIZE = 700;

function make(draw) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const x = c.getContext('2d');
  draw(x, SIZE);
  return c;
}

const samples = {
  /* A stylised bust — plenty of soft tone plus a few hard edges. */
  portrait: () => make((x, S) => {
    const g = x.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, '#d9d4c8'); g.addColorStop(1, '#8d8578');
    x.fillStyle = g; x.fillRect(0, 0, S, S);

    const cx = S * 0.5, cy = S * 0.46;

    // shoulders
    x.fillStyle = '#2b2721';
    x.beginPath();
    x.moveTo(S * 0.06, S);
    x.bezierCurveTo(S * 0.14, S * 0.74, S * 0.34, S * 0.66, cx, S * 0.66);
    x.bezierCurveTo(S * 0.66, S * 0.66, S * 0.86, S * 0.74, S * 0.94, S);
    x.closePath(); x.fill();

    // neck
    x.fillStyle = '#9a7a62';
    x.fillRect(cx - S * 0.075, cy + S * 0.12, S * 0.15, S * 0.16);

    // hair mass behind the head
    x.fillStyle = '#251f1a';
    x.beginPath();
    x.ellipse(cx, cy - S * 0.045, S * 0.215, S * 0.255, 0, 0, Math.PI * 2);
    x.fill();

    // face
    const fg = x.createRadialGradient(cx - S * 0.05, cy - S * 0.07, S * 0.02, cx, cy, S * 0.24);
    fg.addColorStop(0, '#f0d9c3'); fg.addColorStop(0.65, '#c9a184'); fg.addColorStop(1, '#8a6249');
    x.fillStyle = fg;
    x.beginPath();
    x.ellipse(cx, cy, S * 0.155, S * 0.205, 0, 0, Math.PI * 2);
    x.fill();

    // fringe
    x.fillStyle = '#251f1a';
    x.beginPath();
    x.ellipse(cx, cy - S * 0.155, S * 0.163, S * 0.085, 0, Math.PI, 0);
    x.fill();

    // eyes
    for (const s of [-1, 1]) {
      const ex = cx + s * S * 0.062, ey = cy - S * 0.025;
      x.fillStyle = '#f6efe6';
      x.beginPath(); x.ellipse(ex, ey, S * 0.033, S * 0.017, 0, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#2e2118';
      x.beginPath(); x.arc(ex, ey, S * 0.0145, 0, Math.PI * 2); x.fill();
      x.strokeStyle = '#3a2c20'; x.lineWidth = S * 0.009; x.lineCap = 'round';
      x.beginPath();
      x.moveTo(ex - S * 0.04, ey - S * 0.042);
      x.quadraticCurveTo(ex, ey - S * 0.058, ex + S * 0.04, ey - S * 0.040);
      x.stroke();
    }

    // nose + mouth
    x.strokeStyle = 'rgba(90,60,42,.55)'; x.lineWidth = S * 0.008;
    x.beginPath();
    x.moveTo(cx + S * 0.004, cy - S * 0.01);
    x.quadraticCurveTo(cx + S * 0.022, cy + S * 0.048, cx - S * 0.006, cy + S * 0.055);
    x.stroke();
    x.strokeStyle = '#7d4a42'; x.lineWidth = S * 0.011;
    x.beginPath();
    x.moveTo(cx - S * 0.045, cy + S * 0.104);
    x.quadraticCurveTo(cx, cy + S * 0.128, cx + S * 0.045, cy + S * 0.104);
    x.stroke();
  }),

  /* Smooth tone only — good for judging gradient reproduction. */
  sphere: () => make((x, S) => {
    const bg = x.createLinearGradient(0, 0, S, S);
    bg.addColorStop(0, '#efece5'); bg.addColorStop(1, '#b3ab9d');
    x.fillStyle = bg; x.fillRect(0, 0, S, S);

    const g = x.createRadialGradient(S * 0.38, S * 0.34, S * 0.02, S * 0.5, S * 0.5, S * 0.42);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, '#b9b2a6');
    g.addColorStop(0.8, '#3d382f'); g.addColorStop(1, '#15130f');
    x.fillStyle = g;
    x.beginPath(); x.arc(S * 0.5, S * 0.48, S * 0.33, 0, Math.PI * 2); x.fill();

    const sh = x.createRadialGradient(S * 0.5, S * 0.87, S * 0.01, S * 0.5, S * 0.87, S * 0.3);
    sh.addColorStop(0, 'rgba(20,18,14,.55)'); sh.addColorStop(1, 'rgba(20,18,14,0)');
    x.fillStyle = sh;
    x.beginPath(); x.ellipse(S * 0.5, S * 0.87, S * 0.3, S * 0.06, 0, 0, Math.PI * 2); x.fill();
  }),

  /* Rings, spokes and a tone ramp — for checking detail and grey response. */
  target: () => make((x, S) => {
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, S, S);
    const cx = S / 2, cy = S / 2;

    for (let i = 0; i < 36; i++) {
      const a0 = (i / 36) * Math.PI * 2, a1 = ((i + 0.5) / 36) * Math.PI * 2;
      x.fillStyle = i % 2 ? '#111111' : '#ffffff';
      x.beginPath(); x.moveTo(cx, cy);
      x.arc(cx, cy, S * 0.46, a0, a1); x.closePath(); x.fill();
    }
    x.fillStyle = '#ffffff';
    x.beginPath(); x.arc(cx, cy, S * 0.33, 0, Math.PI * 2); x.fill();

    for (let i = 8; i >= 1; i--) {
      x.fillStyle = i % 2 ? '#151515' : '#ffffff';
      x.beginPath(); x.arc(cx, cy, (S * 0.33 * i) / 8.5, 0, Math.PI * 2); x.fill();
    }
    const ramp = x.createLinearGradient(cx - S * 0.22, 0, cx + S * 0.22, 0);
    ramp.addColorStop(0, '#000000'); ramp.addColorStop(1, '#ffffff');
    x.fillStyle = ramp;
    x.fillRect(cx - S * 0.22, cy - S * 0.055, S * 0.44, S * 0.11);
  }),
};

export function buildSample(name) {
  const fn = samples[name] || samples.portrait;
  return fn();
}
