/**
 * Analog instrument panel (the classic six-pack) plus a HUD overlay.
 *
 * Static faceplates — bezels, tick marks, numerals, colour arcs — are baked
 * once into an offscreen canvas; each frame only redraws the moving parts.
 */

const KT = 1.94384;      // m/s -> knots
const FT = 3.28084;       // m -> feet
const FPM = 196.850;      // m/s -> feet per minute
const TAU = Math.PI * 2;

function ring(ctx, cx, cy, r) {
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, r * 0.1, cx, cy, r * 1.25);
  g.addColorStop(0, '#2b3038');
  g.addColorStop(1, '#0b0d11');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, r * 1.14, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#454c58'; ctx.lineWidth = r * 0.05;
  ctx.beginPath(); ctx.arc(cx, cy, r * 1.10, 0, TAU); ctx.stroke();
  ctx.fillStyle = '#0a0c10';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
}

function needle(ctx, cx, cy, ang, len, w, color, tail = 0.16) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-w, len * tail);
  ctx.lineTo(-w * 0.45, -len);
  ctx.lineTo(w * 0.45, -len);
  ctx.lineTo(w, len * tail);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function label(ctx, x, y, text, size, color = '#dfe5ee', align = 'center', weight = '600') {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px "Roboto Condensed", "Arial Narrow", Arial, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

export class InstrumentPanel {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} cfg aircraft config (limits drive the arcs)
   */
  constructor(canvas, cfg) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.setAircraft(cfg);
  }

  setAircraft(cfg) {
    this.cfg = cfg;
    const L = cfg.limits;
    this.asi = {
      min: Math.max(20, Math.round((L.vs * KT) * 0.5 / 10) * 10),
      max: Math.ceil((L.vne * KT * 1.12) / 20) * 20,
      vs0: L.vs * KT * 0.92,
      vs1: L.vs * KT,
      vfe: L.vfe * KT,
      vno: L.vne * KT * 0.82,
      vne: L.vne * KT,
    };
    this.vsiMax = cfg.engine.type === 'turbofan' ? 6000 : 2000;
    this.isJet = cfg.engine.type === 'turbofan';
    this.baked = null;
  }

  layout() {
    const W = this.canvas.width, H = this.canvas.height;
    const r = Math.min(W / 8.4, H / 4.9);
    const gx = W * 0.055 + r * 1.2;
    const gy = H * 0.30;
    const dx = r * 2.62, dy = r * 2.42;
    return {
      r,
      asi: [gx, gy], ai: [gx + dx, gy], alt: [gx + dx * 2, gy],
      tc: [gx, gy + dy], hi: [gx + dx, gy + dy], vsi: [gx + dx * 2, gy + dy],
      eng: [gx + dx * 3.05, gy], fuel: [gx + dx * 3.05, gy + dy],
      W, H,
    };
  }

  bake() {
    const W = this.canvas.width, H = this.canvas.height;
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const c = off.getContext('2d');
    const L = this.layout();
    const r = L.r;

    // Panel face
    const pg = c.createLinearGradient(0, 0, 0, H);
    pg.addColorStop(0, '#171a20');
    pg.addColorStop(1, '#0c0e12');
    c.fillStyle = pg;
    c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(255,255,255,0.025)';
    for (let y = 0; y < H; y += 3) c.fillRect(0, y, W, 1);

    this.bakeASI(c, L.asi[0], L.asi[1], r);
    this.bakeAI(c, L.ai[0], L.ai[1], r);
    this.bakeALT(c, L.alt[0], L.alt[1], r);
    this.bakeTC(c, L.tc[0], L.tc[1], r);
    this.bakeHI(c, L.hi[0], L.hi[1], r);
    this.bakeVSI(c, L.vsi[0], L.vsi[1], r);
    this.bakeENG(c, L.eng[0], L.eng[1], r);
    this.bakeFUEL(c, L.fuel[0], L.fuel[1], r);

    this.baked = off;
    this.L = L;
  }

  /* ---------------- static faces ---------------- */

  asiAngle(kt) {
    const a = this.asi;
    const t = (kt - a.min) / (a.max - a.min);
    return -Math.PI / 2 + Math.max(-0.06, Math.min(1.02, t)) * (330 * Math.PI / 180);
  }

  bakeASI(c, cx, cy, r) {
    ring(c, cx, cy, r);
    const a = this.asi;
    const arc = (from, to, color, rad, w) => {
      c.strokeStyle = color; c.lineWidth = w;
      c.beginPath();
      c.arc(cx, cy, rad, this.asiAngle(from) - Math.PI / 2, this.asiAngle(to) - Math.PI / 2);
      c.stroke();
    };
    arc(a.vs0, a.vfe, '#f2f4f8', r * 0.80, r * 0.085);
    arc(a.vs1, a.vno, '#3fd07a', r * 0.89, r * 0.085);
    arc(a.vno, a.vne, '#f5c542', r * 0.89, r * 0.085);
    arc(a.vne, a.vne + (a.max - a.min) * 0.04, '#ef4444', r * 0.89, r * 0.10);

    const step = a.max > 260 ? 20 : 10;
    for (let v = a.min; v <= a.max; v += step) {
      const ang = this.asiAngle(v) - Math.PI / 2;
      const major = v % (step * 2) === 0;
      const r0 = major ? r * 0.68 : r * 0.76;
      c.strokeStyle = '#e8edf5'; c.lineWidth = major ? r * 0.035 : r * 0.02;
      c.beginPath();
      c.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      c.lineTo(cx + Math.cos(ang) * r * 0.94, cy + Math.sin(ang) * r * 0.94);
      c.stroke();
      if (major) {
        label(c, cx + Math.cos(ang) * r * 0.53, cy + Math.sin(ang) * r * 0.53, String(v), r * 0.20);
      }
    }
    label(c, cx, cy + r * 0.44, 'AIRSPEED', r * 0.15, '#8d96a6');
    label(c, cx, cy + r * 0.62, 'KNOTS', r * 0.13, '#6d7686');
  }

  bakeAI(c, cx, cy, r) {
    ring(c, cx, cy, r);
    // Bank scale
    c.save();
    c.translate(cx, cy);
    for (const d of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const ang = (d - 90) * Math.PI / 180;
      const long = d % 30 === 0 || d === 0;
      c.strokeStyle = '#e8edf5'; c.lineWidth = long ? r * 0.035 : r * 0.022;
      c.beginPath();
      c.moveTo(Math.cos(ang) * r * 0.86, Math.sin(ang) * r * 0.86);
      c.lineTo(Math.cos(ang) * r * (long ? 0.99 : 0.94), Math.sin(ang) * r * (long ? 0.99 : 0.94));
      c.stroke();
    }
    c.fillStyle = '#f5c542';
    c.beginPath();
    c.moveTo(0, -r * 0.84); c.lineTo(-r * 0.07, -r * 0.72); c.lineTo(r * 0.07, -r * 0.72);
    c.closePath(); c.fill();
    c.restore();
    label(c, cx, cy + r * 0.72, 'ATTITUDE', r * 0.14, '#8d96a6');
  }

  bakeALT(c, cx, cy, r) {
    ring(c, cx, cy, r);
    for (let i = 0; i < 50; i++) {
      const ang = (i / 50) * TAU - Math.PI / 2;
      const major = i % 5 === 0;
      c.strokeStyle = '#e8edf5'; c.lineWidth = major ? r * 0.035 : r * 0.018;
      c.beginPath();
      c.moveTo(cx + Math.cos(ang) * r * (major ? 0.70 : 0.80), cy + Math.sin(ang) * r * (major ? 0.70 : 0.80));
      c.lineTo(cx + Math.cos(ang) * r * 0.94, cy + Math.sin(ang) * r * 0.94);
      c.stroke();
      if (major) label(c, cx + Math.cos(ang) * r * 0.53, cy + Math.sin(ang) * r * 0.53, String(i / 5), r * 0.24);
    }
    label(c, cx, cy - r * 0.44, 'ALT', r * 0.15, '#8d96a6');
    label(c, cx, cy + r * 0.70, 'FEET', r * 0.13, '#6d7686');
  }

  bakeTC(c, cx, cy, r) {
    ring(c, cx, cy, r);
    for (const s of [-1, 1]) {
      c.strokeStyle = '#f2f4f8'; c.lineWidth = r * 0.03;
      const ang = -Math.PI / 2 + s * (18 * Math.PI / 180);
      c.beginPath();
      c.moveTo(cx + Math.cos(ang) * r * 0.78, cy + Math.sin(ang) * r * 0.78);
      c.lineTo(cx + Math.cos(ang) * r * 0.95, cy + Math.sin(ang) * r * 0.95);
      c.stroke();
      label(c, cx + s * r * 0.62, cy - r * 0.62, s < 0 ? 'L' : 'R', r * 0.17, '#8d96a6');
    }
    // Inclinometer tube
    c.strokeStyle = '#4b5462'; c.lineWidth = r * 0.02;
    c.beginPath(); c.arc(cx, cy - r * 1.05, r * 1.62, 1.25, 1.89); c.stroke();
    for (const s of [-1, 1]) {
      c.strokeStyle = '#cfd6e0'; c.lineWidth = r * 0.025;
      c.beginPath();
      c.moveTo(cx + s * r * 0.115, cy + r * 0.44);
      c.lineTo(cx + s * r * 0.115, cy + r * 0.66);
      c.stroke();
    }
    label(c, cx, cy + r * 0.82, '2 MIN TURN', r * 0.13, '#8d96a6');
  }

  bakeHI(c, cx, cy, r) {
    ring(c, cx, cy, r);
    // Lubber line + fixed aircraft
    c.fillStyle = '#f5c542';
    c.beginPath();
    c.moveTo(cx, cy - r * 0.98); c.lineTo(cx - r * 0.06, cy - r * 0.86); c.lineTo(cx + r * 0.06, cy - r * 0.86);
    c.closePath(); c.fill();
    label(c, cx, cy + r * 0.80, 'HEADING', r * 0.14, '#8d96a6');
  }

  bakeVSI(c, cx, cy, r) {
    ring(c, cx, cy, r);
    const max = this.vsiMax;
    const step = max / 5;
    for (let v = -max; v <= max; v += step) {
      const t = v / max;
      const ang = Math.PI + t * (165 * Math.PI / 180);
      const major = Math.abs(v) % (step * 2) < 1;
      c.strokeStyle = v === 0 ? '#f5c542' : '#e8edf5';
      c.lineWidth = major ? r * 0.035 : r * 0.02;
      c.beginPath();
      c.moveTo(cx + Math.cos(ang) * r * 0.72, cy + Math.sin(ang) * r * 0.72);
      c.lineTo(cx + Math.cos(ang) * r * 0.94, cy + Math.sin(ang) * r * 0.94);
      c.stroke();
      if (major) {
        label(c, cx + Math.cos(ang) * r * 0.55, cy + Math.sin(ang) * r * 0.55,
          String(Math.abs(v) / 1000), r * 0.22);
      }
    }
    label(c, cx, cy - r * 0.42, 'VERT SPEED', r * 0.13, '#8d96a6');
    label(c, cx, cy + r * 0.52, `FPM x1000`, r * 0.13, '#6d7686');
    label(c, cx + r * 0.55, cy - r * 0.20, 'UP', r * 0.13, '#6d7686');
    label(c, cx + r * 0.55, cy + r * 0.22, 'DN', r * 0.13, '#6d7686');
  }

  bakeENG(c, cx, cy, r) {
    ring(c, cx, cy, r * 0.78);
    const rr = r * 0.78;
    const max = this.isJet ? 110 : this.cfg.engine.maxRPM;
    const n = 6;
    for (let i = 0; i <= n; i++) {
      const ang = Math.PI * 0.75 + (i / n) * Math.PI * 1.5;
      c.strokeStyle = '#e8edf5'; c.lineWidth = rr * 0.035;
      c.beginPath();
      c.moveTo(cx + Math.cos(ang) * rr * 0.70, cy + Math.sin(ang) * rr * 0.70);
      c.lineTo(cx + Math.cos(ang) * rr * 0.92, cy + Math.sin(ang) * rr * 0.92);
      c.stroke();
      label(c, cx + Math.cos(ang) * rr * 0.50, cy + Math.sin(ang) * rr * 0.50,
        this.isJet ? String(Math.round((i / n) * max)) : String(Math.round((i / n) * max / 100)), rr * 0.22);
    }
    // Redline
    c.strokeStyle = '#ef4444'; c.lineWidth = rr * 0.09;
    c.beginPath();
    c.arc(cx, cy, rr * 0.86, Math.PI * 0.75 + 0.93 * Math.PI * 1.5, Math.PI * 0.75 + Math.PI * 1.5);
    c.stroke();
    label(c, cx, cy + rr * 0.52, this.isJet ? 'N1 %' : 'RPM x100', rr * 0.19, '#8d96a6');
  }

  bakeFUEL(c, cx, cy, r) {
    ring(c, cx, cy, r * 0.78);
    const rr = r * 0.78;
    for (let i = 0; i <= 4; i++) {
      const ang = Math.PI * 0.75 + (i / 4) * Math.PI * 1.5;
      c.strokeStyle = i === 0 ? '#ef4444' : '#e8edf5';
      c.lineWidth = rr * 0.04;
      c.beginPath();
      c.moveTo(cx + Math.cos(ang) * rr * 0.68, cy + Math.sin(ang) * rr * 0.68);
      c.lineTo(cx + Math.cos(ang) * rr * 0.92, cy + Math.sin(ang) * rr * 0.92);
      c.stroke();
      label(c, cx + Math.cos(ang) * rr * 0.48, cy + Math.sin(ang) * rr * 0.48,
        ['E', '1/4', '1/2', '3/4', 'F'][i], rr * 0.19);
    }
    label(c, cx, cy + rr * 0.55, 'FUEL', rr * 0.20, '#8d96a6');
  }

  /* ---------------- dynamic pass ---------------- */

  /**
   * @param {object} s state snapshot
   *   { ias, altFt, vsFpm, pitch, bank, headingDeg, turnRate, ball,
   *     rpm, fuelFrac, baro }
   */
  draw(s) {
    if (!this.baked || this.baked.width !== this.canvas.width) this.bake();
    const c = this.ctx;
    const L = this.L, r = L.r;
    c.clearRect(0, 0, L.W, L.H);
    c.drawImage(this.baked, 0, 0);

    /* ASI */
    {
      const [cx, cy] = L.asi;
      needle(c, cx, cy, this.asiAngle(s.ias * KT), r * 0.90, r * 0.055, '#f2f4f8');
      c.fillStyle = '#c8cfda';
      c.beginPath(); c.arc(cx, cy, r * 0.07, 0, TAU); c.fill();
      // Digital repeat
      c.fillStyle = 'rgba(0,0,0,0.75)';
      c.fillRect(cx - r * 0.34, cy + r * 0.16, r * 0.68, r * 0.24);
      label(c, cx, cy + r * 0.28, String(Math.round(s.ias * KT)), r * 0.20, '#7ef7c0');
    }

    /* Attitude */
    {
      const [cx, cy] = L.ai;
      c.save();
      c.beginPath(); c.arc(cx, cy, r * 0.985, 0, TAU); c.clip();
      c.translate(cx, cy);
      c.rotate(-s.bank);
      const pxDeg = r / 22;
      const off = s.pitch * 180 / Math.PI * pxDeg;
      c.translate(0, off);
      // Sky / ground
      c.fillStyle = '#2f7fd6';
      c.fillRect(-r * 3, -r * 6, r * 6, r * 6);
      c.fillStyle = '#8a5a2b';
      c.fillRect(-r * 3, 0, r * 6, r * 6);
      c.fillStyle = '#f2f4f8';
      c.fillRect(-r * 3, -r * 0.012, r * 6, r * 0.024);
      // Pitch ladder
      c.lineWidth = r * 0.018;
      c.strokeStyle = '#f2f4f8';
      for (let d = -90; d <= 90; d += 5) {
        if (d === 0) continue;
        const y = -d * pxDeg;
        const major = d % 10 === 0;
        const w = major ? r * 0.34 : r * 0.17;
        c.beginPath(); c.moveTo(-w, y); c.lineTo(w, y); c.stroke();
        if (major && Math.abs(d) <= 30) {
          label(c, -w - r * 0.13, y, String(Math.abs(d)), r * 0.13);
          label(c, w + r * 0.13, y, String(Math.abs(d)), r * 0.13);
        }
      }
      c.restore();
      // Bank pointer
      c.save();
      c.translate(cx, cy); c.rotate(-s.bank);
      c.fillStyle = '#f5c542';
      c.beginPath();
      c.moveTo(0, -r * 0.70); c.lineTo(-r * 0.055, -r * 0.58); c.lineTo(r * 0.055, -r * 0.58);
      c.closePath(); c.fill();
      c.restore();
      // Fixed aircraft symbol
      c.strokeStyle = '#f5c542'; c.lineWidth = r * 0.045;
      c.beginPath();
      c.moveTo(cx - r * 0.42, cy); c.lineTo(cx - r * 0.14, cy);
      c.moveTo(cx + r * 0.14, cy); c.lineTo(cx + r * 0.42, cy);
      c.stroke();
      c.fillStyle = '#f5c542';
      c.beginPath(); c.arc(cx, cy, r * 0.035, 0, TAU); c.fill();
      c.beginPath();
      c.moveTo(cx - r * 0.14, cy); c.lineTo(cx, cy + r * 0.11); c.lineTo(cx + r * 0.14, cy);
      c.closePath(); c.fill();
    }

    /* Altimeter */
    {
      const [cx, cy] = L.alt;
      const ft = s.altFt;
      const hundreds = ((ft % 1000) / 1000) * TAU;
      const thousands = ((ft % 10000) / 10000) * TAU;
      const tenK = ((ft % 100000) / 100000) * TAU;
      // 10k pointer (thin with a triangle tip)
      c.save(); c.translate(cx, cy); c.rotate(tenK);
      c.fillStyle = '#dfe5ee';
      c.beginPath();
      c.moveTo(-r * 0.05, r * 0.08); c.lineTo(-r * 0.05, -r * 0.60);
      c.lineTo(0, -r * 0.72); c.lineTo(r * 0.05, -r * 0.60); c.lineTo(r * 0.05, r * 0.08);
      c.closePath(); c.fill();
      c.restore();
      needle(c, cx, cy, thousands, r * 0.58, r * 0.075, '#f2f4f8');
      needle(c, cx, cy, hundreds, r * 0.90, r * 0.045, '#f2f4f8');
      c.fillStyle = '#c8cfda';
      c.beginPath(); c.arc(cx, cy, r * 0.07, 0, TAU); c.fill();
      // Kollsman window
      c.fillStyle = 'rgba(0,0,0,0.82)';
      c.fillRect(cx + r * 0.28, cy - r * 0.11, r * 0.60, r * 0.22);
      c.strokeStyle = '#5b6472'; c.lineWidth = r * 0.012;
      c.strokeRect(cx + r * 0.28, cy - r * 0.11, r * 0.60, r * 0.22);
      label(c, cx + r * 0.58, cy, s.baro.toFixed(2), r * 0.155, '#7ef7c0');
    }

    /* Turn coordinator */
    {
      const [cx, cy] = L.tc;
      const rate = Math.max(-2.2, Math.min(2.2, s.turnRate / 3));  // 3 deg/s = standard
      c.save();
      c.translate(cx, cy - r * 0.10);
      c.rotate(rate * (18 * Math.PI / 180));
      c.strokeStyle = '#f2f4f8'; c.lineWidth = r * 0.05;
      c.beginPath(); c.moveTo(-r * 0.62, 0); c.lineTo(r * 0.62, 0); c.stroke();
      c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -r * 0.22); c.stroke();
      c.fillStyle = '#f2f4f8';
      c.beginPath(); c.arc(0, 0, r * 0.085, 0, TAU); c.fill();
      c.restore();
      // Ball
      const bx = cx + Math.max(-1, Math.min(1, s.ball)) * r * 0.30;
      const by = cy + r * 0.55 + Math.abs(s.ball) * r * 0.03;
      c.fillStyle = '#1a1d24';
      c.beginPath(); c.arc(cx, cy + r * 0.556, r * 0.40, Math.PI * 0.82, Math.PI * 0.18 + TAU * 0.5, false); c.fill();
      c.fillStyle = '#0e1014';
      c.fillRect(cx - r * 0.42, cy + r * 0.44, r * 0.84, r * 0.24);
      c.fillStyle = '#e8ecf3';
      c.beginPath(); c.arc(bx, by, r * 0.085, 0, TAU); c.fill();
      c.strokeStyle = '#cfd6e0'; c.lineWidth = r * 0.02;
      for (const sd of [-1, 1]) {
        c.beginPath();
        c.moveTo(cx + sd * r * 0.115, cy + r * 0.44);
        c.lineTo(cx + sd * r * 0.115, cy + r * 0.68);
        c.stroke();
      }
    }

    /* Heading indicator */
    {
      const [cx, cy] = L.hi;
      c.save();
      c.beginPath(); c.arc(cx, cy, r * 0.985, 0, TAU); c.clip();
      c.translate(cx, cy);
      c.rotate(-s.headingDeg * Math.PI / 180);
      for (let d = 0; d < 360; d += 5) {
        const ang = (d * Math.PI) / 180 - Math.PI / 2;
        const major = d % 30 === 0;
        c.strokeStyle = '#e8edf5'; c.lineWidth = major ? r * 0.035 : r * 0.018;
        c.beginPath();
        c.moveTo(Math.cos(ang) * r * (major ? 0.68 : 0.78), Math.sin(ang) * r * (major ? 0.68 : 0.78));
        c.lineTo(Math.cos(ang) * r * 0.92, Math.sin(ang) * r * 0.92);
        c.stroke();
        if (major) {
          const txt = d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10);
          c.save();
          c.translate(Math.cos(ang) * r * 0.52, Math.sin(ang) * r * 0.52);
          c.rotate((d * Math.PI) / 180);
          label(c, 0, 0, txt, r * (txt.length > 1 ? 0.20 : 0.26));
          c.restore();
        }
      }
      c.restore();
      // Fixed aircraft
      c.strokeStyle = '#f5c542'; c.lineWidth = r * 0.045;
      c.beginPath();
      c.moveTo(cx, cy - r * 0.30); c.lineTo(cx, cy + r * 0.28);
      c.moveTo(cx - r * 0.28, cy); c.lineTo(cx + r * 0.28, cy);
      c.moveTo(cx - r * 0.12, cy + r * 0.24); c.lineTo(cx + r * 0.12, cy + r * 0.24);
      c.stroke();
      c.fillStyle = 'rgba(0,0,0,0.8)';
      c.fillRect(cx - r * 0.30, cy + r * 0.52, r * 0.60, r * 0.24);
      label(c, cx, cy + r * 0.64, String(Math.round(s.headingDeg)).padStart(3, '0') + '°', r * 0.19, '#7ef7c0');
    }

    /* VSI */
    {
      const [cx, cy] = L.vsi;
      const t = Math.max(-1.08, Math.min(1.08, (s.vsFpm) / this.vsiMax));
      needle(c, cx, cy, Math.PI / 2 + t * (165 * Math.PI / 180), r * 0.88, r * 0.05, '#f2f4f8');
      c.fillStyle = '#c8cfda';
      c.beginPath(); c.arc(cx, cy, r * 0.07, 0, TAU); c.fill();
    }

    /* Engine + fuel */
    {
      const [cx, cy] = L.eng;
      const rr = r * 0.78;
      const max = this.isJet ? 110 : this.cfg.engine.maxRPM;
      const frac = Math.max(0, Math.min(1.03, s.rpm / max));
      const ang = Math.PI * 0.75 + frac * Math.PI * 1.5 + Math.PI / 2;
      needle(c, cx, cy, ang, rr * 0.86, rr * 0.06, '#f2f4f8');
      c.fillStyle = '#c8cfda';
      c.beginPath(); c.arc(cx, cy, rr * 0.08, 0, TAU); c.fill();
      c.fillStyle = 'rgba(0,0,0,0.75)';
      c.fillRect(cx - rr * 0.36, cy + rr * 0.16, rr * 0.72, rr * 0.24);
      label(c, cx, cy + rr * 0.28, this.isJet ? s.rpm.toFixed(0) + '%' : String(Math.round(s.rpm)), rr * 0.20, '#7ef7c0');
    }
    {
      const [cx, cy] = L.fuel;
      const rr = r * 0.78;
      const ang = Math.PI * 0.75 + Math.max(0, Math.min(1, s.fuelFrac)) * Math.PI * 1.5 + Math.PI / 2;
      needle(c, cx, cy, ang, rr * 0.84, rr * 0.06, s.fuelFrac < 0.12 ? '#ef4444' : '#f2f4f8');
      c.fillStyle = '#c8cfda';
      c.beginPath(); c.arc(cx, cy, rr * 0.08, 0, TAU); c.fill();
    }
  }
}

/* ------------------------------------------------------------------ */
/* HUD                                                                 */
/* ------------------------------------------------------------------ */

export class HUD {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  draw(s) {
    const c = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    if (!s.on) return;

    const cx = W / 2, cy = H / 2;
    const scale = Math.min(W, H) / 720;
    const green = 'rgba(126,247,160,0.92)';
    c.strokeStyle = green;
    c.fillStyle = green;
    c.lineWidth = 2 * scale;
    c.font = `${Math.round(17 * scale)}px "Roboto Mono", "Courier New", monospace`;
    c.textBaseline = 'middle';

    const pxDeg = (H * 0.5) / 26;

    /* Pitch ladder, rolled and translated */
    c.save();
    c.beginPath();
    c.rect(cx - W * 0.28, cy - H * 0.34, W * 0.56, H * 0.68);
    c.clip();
    c.translate(cx, cy);
    c.rotate(-s.bank);
    c.translate(0, s.pitch * 180 / Math.PI * pxDeg);
    for (let d = -90; d <= 90; d += 5) {
      const y = -d * pxDeg;
      if (Math.abs(y) > H * 0.6) continue;
      const w = (d === 0 ? 190 : Math.abs(d) % 10 === 0 ? 130 : 78) * scale;
      c.setLineDash(d < 0 ? [9 * scale, 7 * scale] : []);
      c.beginPath();
      if (d === 0) {
        c.moveTo(-w, y); c.lineTo(-w * 0.28, y);
        c.moveTo(w * 0.28, y); c.lineTo(w, y);
      } else {
        const tick = Math.sign(d) * 9 * scale;
        c.moveTo(-w, y); c.lineTo(-w * 0.32, y);
        c.moveTo(-w, y); c.lineTo(-w, y + tick);
        c.moveTo(w * 0.32, y); c.lineTo(w, y);
        c.moveTo(w, y); c.lineTo(w, y + tick);
      }
      c.stroke();
      if (d !== 0 && Math.abs(d) % 10 === 0) {
        c.textAlign = 'right';
        c.fillText(String(Math.abs(d)), -w - 6 * scale, y);
        c.textAlign = 'left';
        c.fillText(String(Math.abs(d)), w + 6 * scale, y);
      }
    }
    c.setLineDash([]);
    c.restore();

    /* Flight path marker */
    const fpx = cx + s.fpaX * pxDeg * 180 / Math.PI;
    const fpy = cy - s.fpaY * pxDeg * 180 / Math.PI;
    c.beginPath();
    c.arc(fpx, fpy, 11 * scale, 0, TAU);
    c.moveTo(fpx - 11 * scale, fpy); c.lineTo(fpx - 26 * scale, fpy);
    c.moveTo(fpx + 11 * scale, fpy); c.lineTo(fpx + 26 * scale, fpy);
    c.moveTo(fpx, fpy - 11 * scale); c.lineTo(fpx, fpy - 22 * scale);
    c.stroke();

    /* Boresight */
    c.beginPath();
    c.moveTo(cx - 40 * scale, cy); c.lineTo(cx - 14 * scale, cy);
    c.moveTo(cx + 14 * scale, cy); c.lineTo(cx + 40 * scale, cy);
    c.moveTo(cx, cy - 8 * scale); c.lineTo(cx, cy + 8 * scale);
    c.stroke();

    /* Speed tape */
    const tapeH = H * 0.44;
    const drawTape = (x, val, step, unit, align) => {
      c.save();
      c.beginPath(); c.rect(x - 52 * scale, cy - tapeH / 2, 104 * scale, tapeH); c.clip();
      const per = tapeH / (step * 10);
      for (let v = Math.floor((val - step * 5) / step) * step; v <= val + step * 5; v += step) {
        const y = cy + (val - v) * per;
        const major = v % (step * 2) === 0;
        c.beginPath();
        c.moveTo(align === 'left' ? x + 34 * scale : x - 34 * scale, y);
        c.lineTo(align === 'left' ? x + (major ? 16 : 25) * scale : x - (major ? 16 : 25) * scale, y);
        c.stroke();
        if (major) {
          c.textAlign = align === 'left' ? 'right' : 'left';
          c.fillText(String(v), align === 'left' ? x + 10 * scale : x - 10 * scale, y);
        }
      }
      c.restore();
      c.strokeRect(x - 52 * scale, cy - tapeH / 2, 104 * scale, tapeH);
      // Current value box
      c.fillStyle = 'rgba(0,0,0,0.55)';
      c.fillRect(x - 52 * scale, cy - 15 * scale, 104 * scale, 30 * scale);
      c.strokeRect(x - 52 * scale, cy - 15 * scale, 104 * scale, 30 * scale);
      c.fillStyle = green;
      c.textAlign = 'center';
      c.font = `bold ${Math.round(20 * scale)}px "Roboto Mono","Courier New",monospace`;
      c.fillText(String(Math.round(val)), x, cy);
      c.font = `${Math.round(17 * scale)}px "Roboto Mono","Courier New",monospace`;
      c.fillText(unit, x, cy + tapeH / 2 + 16 * scale);
    };
    drawTape(cx - W * 0.31, s.ias * KT, 10, 'KIAS', 'left');
    drawTape(cx + W * 0.31, s.altFt, 100, 'FT MSL', 'right');

    /* Heading tape */
    const hy = cy - H * 0.40;
    c.save();
    c.beginPath(); c.rect(cx - W * 0.20, hy - 18 * scale, W * 0.40, 36 * scale); c.clip();
    const hper = (W * 0.40) / 60;
    for (let d = Math.round(s.headingDeg) - 34; d <= s.headingDeg + 34; d += 5) {
      const dd = ((d % 360) + 360) % 360;
      const x = cx + (d - s.headingDeg) * hper;
      const major = dd % 10 === 0;
      c.beginPath();
      c.moveTo(x, hy + 12 * scale); c.lineTo(x, hy + (major ? 2 : 7) * scale);
      c.stroke();
      if (major) {
        c.textAlign = 'center';
        c.fillText(String(dd / 10).padStart(2, '0'), x, hy - 6 * scale);
      }
    }
    c.restore();
    c.beginPath();
    c.moveTo(cx, hy + 20 * scale); c.lineTo(cx - 7 * scale, hy + 30 * scale);
    c.lineTo(cx + 7 * scale, hy + 30 * scale); c.closePath();
    c.fill();

    /* Corner data blocks */
    c.textAlign = 'left';
    const lx = cx - W * 0.44;
    c.fillText(`G  ${s.g.toFixed(1)}`, lx, cy - H * 0.22);
    c.fillText(`AOA ${(s.alpha * 180 / Math.PI).toFixed(1)}`, lx, cy - H * 0.185);
    c.fillText(`VS ${s.vsFpm > 0 ? '+' : ''}${Math.round(s.vsFpm)}`, lx, cy - H * 0.15);
    c.textAlign = 'right';
    const rx = cx + W * 0.44;
    c.fillText(`${s.throttlePct}% PWR`, rx, cy - H * 0.22);
    c.fillText(`GS ${Math.round(s.gs * KT)}`, rx, cy - H * 0.185);
    c.fillText(`AGL ${Math.round(s.aglFt)}`, rx, cy - H * 0.15);
  }
}
