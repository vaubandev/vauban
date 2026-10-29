"use strict";

// Octagonal trace after Neuf-Brisach (Vauban, 1698).
const N = 8, R = 1, R1 = 0.8, D = 0.17, R2 = 0.74, D2 = 0.27, ROT = -Math.PI / 2 + Math.PI / 8;
function trace(s) {
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = ROT + (i * 2 * Math.PI) / N;
    for (const [r, da] of [[R2, -D2], [R1, -D], [R, 0], [R1, D], [R2, D2]]) {
      pts.push([s * r * Math.cos(a + da), s * r * Math.sin(a + da)]);
    }
  }
  return pts;
}
// Distance from centre to polygon edge along angle t (fort is star-shaped about centre).
function reach(poly, t) {
  const dx = Math.cos(t), dy = Math.sin(t);
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    const ex = x2 - x1, ey = y2 - y1, den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const s = (x1 * ey - y1 * ex) / den, u = (x1 * dy - y1 * dx) / den;
    if (s > 0 && u >= 0 && u <= 1) best = Math.min(best, s);
  }
  return best;
}

const cv = document.getElementById("fort");
const ctx = cv.getContext("2d");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const PAPER = "233,227,210", FIRE = "#ff4a1c", OLIVE = "#a7b264";
let W = 560, S = 240, rings = [];

const RINGS = [
  { k: 0.98, name: "I  DITCH · caps", w: 1, dash: [3, 4] },
  { k: 0.8, name: "II  CURTAIN · allowlist", w: 2.2 },
  { k: 0.56, name: "III  GATE · time-lock", w: 1.4 },
  { k: 0.32, name: "IV  KEEP · kill switch", w: 2.6 },
];

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  W = cv.clientWidth || 560;
  cv.width = W * dpr;
  cv.height = W * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  S = W * 0.4;
  rings = RINGS.map((r) => ({ ...r, poly: trace(S * r.k) }));
}

function stroke(poly, w, a, dash) {
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.setLineDash(dash || []);
  ctx.lineWidth = w;
  ctx.strokeStyle = `rgba(${PAPER},${a})`;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawPlan() {
  const c = W / 2;
  ctx.save();
  ctx.translate(c, c);

  // glacis hatching between ditch and curtain
  ctx.save();
  ctx.beginPath();
  rings[0].poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = `rgba(${PAPER},.07)`;
  ctx.lineWidth = 1;
  for (let x = -S * 1.2; x < S * 1.2; x += 7) {
    ctx.beginPath();
    ctx.moveTo(x, -S * 1.2);
    ctx.lineTo(x + S * 2.4, S * 1.2);
    ctx.stroke();
  }
  ctx.restore();

  // capital lines through each bastion
  ctx.strokeStyle = `rgba(${PAPER},.12)`;
  ctx.setLineDash([2, 5]);
  for (let i = 0; i < N; i++) {
    const a = ROT + (i * 2 * Math.PI) / N;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * S * 1.18, Math.sin(a) * S * 1.18);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  rings.forEach((r) => stroke(r.poly, r.w, r.k === 0.32 ? 0.95 : 0.6, r.dash));

  // keep fill
  ctx.beginPath();
  rings[3].poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.fillStyle = `rgba(${PAPER},.06)`;
  ctx.fill();
  ctx.restore();

  // ring labels with leaders to the left margin
  ctx.font = `500 ${Math.max(9, W * 0.019)}px "Spline Sans Mono", monospace`;
  ctx.textBaseline = "bottom";
  [200, 213, 228, 246].forEach((deg, i) => {
    const t = (deg * Math.PI) / 180, d = reach(rings[i].poly, t);
    const x = c + Math.cos(t) * d, y = c + Math.sin(t) * d;
    const ly = W * (0.62 + i * 0.075);
    ctx.strokeStyle = `rgba(${PAPER},.35)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(W * 0.2, ly);
    ctx.lineTo(4, ly);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, 7);
    ctx.fillStyle = FIRE;
    ctx.fill();
    ctx.fillStyle = `rgba(${PAPER},.75)`;
    ctx.fillText(RINGS[i].name, 4, ly - 3);
  });

  // north arrow + scale bar
  const nx = W - 30, ny = 34;
  ctx.strokeStyle = `rgba(${PAPER},.6)`;
  ctx.beginPath();
  ctx.moveTo(nx, ny + 16);
  ctx.lineTo(nx, ny - 14);
  ctx.moveTo(nx - 5, ny - 6);
  ctx.lineTo(nx, ny - 14);
  ctx.lineTo(nx + 5, ny - 6);
  ctx.stroke();
  ctx.fillStyle = `rgba(${PAPER},.6)`;
  ctx.textAlign = "center";
  ctx.fillText("N", nx, ny - 16);
  ctx.textAlign = "left";
  const sx = W - 130, sy = W - 18;
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? `rgba(${PAPER},.15)` : `rgba(${PAPER},.6)`;
    ctx.fillRect(sx + i * 28, sy, 28, 4);
  }
  ctx.fillStyle = `rgba(${PAPER},.5)`;
  ctx.fillText("0       50 TOISES", sx, sy - 4);
}

// rulings: which rampart stops it (null = passes to the keep)
const ORDERS = [
  { at: null, kind: "pass", msg: "PASSED   buy 0.04 ETH · PonsRouter" },
  { at: 1, kind: "block", msg: "CURTAIN  approve(MAX) refused" },
  { at: 0, kind: "block", msg: "DITCH    perDay cap reached" },
  { at: null, kind: "pass", msg: "PASSED   transfer 120 USDG" },
  { at: 2, kind: "hold", msg: "GATE     0.80 ETH held · 6h" },
  { at: 1, kind: "block", msg: "CURTAIN  unknown contract 0x9f3e" },
  { at: null, kind: "pass", msg: "PASSED   sell 210k · PonsRouter" },
];
let shots = [], marks = [], log = [], seq = 0, lastSpawn = -1e9;

function spawn(now) {
  const o = ORDERS[seq++ % ORDERS.length];
  const t = -Math.PI * 0.15 + Math.random() * Math.PI * 1.1;
  const stopAt = o.at === null ? S * 0.06 : reach(rings[o.at].poly, t) + 4;
  shots.push({ o, t, r: S * 1.25, from: S * 1.25, stop: stopAt, held: 0, born: now });
}

function rule(s, now) {
  log.unshift({ msg: s.o.msg, kind: s.o.kind, at: now });
  log.length = Math.min(log.length, 4);
  marks.push({ x: Math.cos(s.t) * s.r, y: Math.sin(s.t) * s.r, kind: s.o.kind, at: now });
}

function drawShots(now, dt) {
  const c = W / 2;
  ctx.save();
  ctx.translate(c, c);
  shots = shots.filter((s) => {
    const gate = rings[2] && s.o.kind === "hold" ? reach(rings[2].poly, s.t) + 4 : -1;
    if (s.o.kind === "hold" && !s.held && s.r <= gate) {
      s.held = now;
      rule(s, now);
    }
    const waiting = s.held && now - s.held < 1600;
    if (!waiting) s.r -= dt * S * 0.32;

    const target = s.o.kind === "hold" ? S * 0.06 : s.stop;
    const x = Math.cos(s.t) * s.r, y = Math.sin(s.t) * s.r;
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = `rgba(${PAPER},.28)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.cos(s.t) * s.from, Math.sin(s.t) * s.from);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = s.o.kind === "block" ? FIRE : `rgb(${PAPER})`;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x + 4, y);
    ctx.lineTo(x, y + 4);
    ctx.lineTo(x - 4, y);
    ctx.fill();

    if (s.r <= target) {
      if (s.o.kind !== "hold") rule(s, now);
      else marks.push({ x: 0, y: 0, kind: "pass", at: now });
      return false;
    }
    return true;
  });

  marks = marks.filter((m) => {
    const age = (now - m.at) / 2600;
    if (age > 1) return false;
    const a = 1 - age;
    if (m.kind === "block") {
      ctx.strokeStyle = `rgba(255,74,28,${a})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(m.x - 6, m.y - 6);
      ctx.lineTo(m.x + 6, m.y + 6);
      ctx.moveTo(m.x + 6, m.y - 6);
      ctx.lineTo(m.x - 6, m.y + 6);
      ctx.stroke();
    } else {
      ctx.strokeStyle = m.kind === "hold" ? `rgba(${PAPER},${a})` : `rgba(167,178,100,${a})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 5 + age * 18, 0, 7);
      ctx.stroke();
    }
    return true;
  });

  ctx.beginPath();
  ctx.arc(0, 0, S * 0.05, 0, 7);
  ctx.fillStyle = FIRE;
  ctx.fill();
  ctx.restore();

  // ruling ledger, top-left
  ctx.font = `500 ${Math.max(9, W * 0.019)}px "Spline Sans Mono", monospace`;
  ctx.textBaseline = "top";
  ctx.fillStyle = `rgba(${PAPER},.45)`;
  ctx.fillText("RULINGS", 4, 4);
  log.forEach((l, i) => {
    const col = l.kind === "block" ? "255,74,28" : l.kind === "hold" ? PAPER : "167,178,100";
    ctx.fillStyle = `rgba(${col},${1 - i * 0.2})`;
    ctx.fillText(l.msg, 4, 22 + i * W * 0.032);
  });
}

let prev = 0, running = false;
function frame(now) {
  if (!running) return;
  const dt = Math.min((now - prev) / 1000, 0.05);
  prev = now;
  if (now - lastSpawn > 1500) {
    spawn(now);
    lastSpawn = now;
  }
  ctx.clearRect(0, 0, W, W);
  drawPlan();
  drawShots(now, dt);
  requestAnimationFrame(frame);
}

function start() {
  if (running || reduced) return;
  running = true;
  prev = performance.now();
  requestAnimationFrame(frame);
}

resize();
addEventListener("resize", () => {
  resize();
  if (reduced) drawStatic();
});
function drawStatic() {
  ctx.clearRect(0, 0, W, W);
  drawPlan();
  log = ORDERS.slice(0, 4).map((o) => ({ msg: o.msg, kind: o.kind }));
  drawShots(0, 0);
}
if (reduced) drawStatic();
else {
  new IntersectionObserver(([e]) => (e.isIntersecting ? start() : (running = false))).observe(cv);
  document.fonts && document.fonts.ready.then(() => !running && start());
}
