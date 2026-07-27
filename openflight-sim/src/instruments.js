/**
 * OpenFlight Sim — Instruments, HUD, panel (T4, OFS-004).
 *
 * Contract (frozen at T1): `createInstruments(root)` mounts the cockpit readouts
 * into `root` (an HTMLElement overlay) and returns `{ update(sim), setHudVisible(v),
 * setPanelVisible(v), isHudVisible(), isPanelVisible(), dispose() }`. The
 * orchestrator calls `update(sim)` each render.
 *
 * This wave fills the stub with:
 *   • an analog six-pack — ASI, attitude indicator, altimeter, turn coordinator,
 *     heading indicator, VSI — built from SVG and driven from simulation state;
 *   • tachometer / N1, fuel, flap and gear indication;
 *   • a toggleable HUD glass overlay with speed, altitude, heading, vertical
 *     speed and a flight-path marker.
 *
 * Instruments READ `sim` only — they never mutate it. All gauge geometry is pure
 * SVG/DOM; the value→needle mappings are exported so the focused test can assert
 * them without a browser.
 */

import { AIRFRAMES } from "./flight-model.js";

const MS_TO_KT = 1.94384;
const M_TO_FT = 3.28084;
const MS_TO_FPM = 196.85;
const RAD_TO_DEG = 180 / Math.PI;
const SVGNS = "http://www.w3.org/2000/svg";

// ── Pure value → indication mappings (exported for the focused test) ─────────

/** Sweep a 0..1 fraction across a 270° arc, 0 at 7:30, full at 4:30 (deg, cw). */
export function sweep270(frac) {
  return -135 + 270 * clamp01(frac);
}

/** Airspeed-indicator needle angle (deg cw from 12 o'clock). */
export function asiNeedleAngle(knots, maxKnots) {
  return sweep270((knots || 0) / (maxKnots || 1));
}

/** Altimeter hundreds- and thousands-foot hand angles (deg cw from 12). */
export function altNeedleAngles(feet) {
  const f = Number.isFinite(feet) ? feet : 0;
  const hundreds = ((f % 1000) + 1000) % 1000; // 0..1000 ft → one full turn
  const thousands = ((f % 10000) + 10000) % 10000; // 0..10000 ft → one full turn
  return { hundreds: 360 * (hundreds / 1000), thousands: 360 * (thousands / 10000) };
}

/** VSI needle angle: 0 fpm points left (9 o'clock), climb up, ±2000 full scale. */
export function vsiNeedleAngle(fpm) {
  const f = clamp((fpm || 0) / 2000, -1, 1);
  return -90 + f * 80;
}

/** Heading card rotation so the live heading sits under the top lubber line. */
export function headingCardRotation(headingDeg) {
  return -norm360(headingDeg);
}

/** Turn-coordinator aircraft-symbol bank (deg). Standard rate (3°/s) → ±20°. */
export function turnRateToBank(turnRateDegPerSec) {
  return clamp((turnRateDegPerSec || 0) / 3, -1.6, 1.6) * 20;
}

/** Inclinometer ball offset (svg units) from a sideslip angle (rad). */
export function slipBallOffset(sideslipRad, maxOffset = 14) {
  return clamp((sideslipRad || 0) / 0.28, -1, 1) * maxOffset;
}

/**
 * Flight-path-marker screen offset for the HUD, in the SVG's centred units.
 * Horizontal follows drift (track − nose heading), vertical follows the
 * flight-path angle. Both are clamped so the marker stays on the glass.
 */
export function flightPathMarkerOffset(fpaRad, driftRad, unitsPerRad = 520, limit = 300) {
  const x = clamp((driftRad || 0) * unitsPerRad, -limit, limit);
  const y = clamp(-(fpaRad || 0) * unitsPerRad, -limit, limit);
  return { x, y };
}

/** Flight-path angle (rad) from vertical and forward speed. */
export function flightPathAngle(verticalSpeedMs, airspeedMs) {
  const horiz = Math.sqrt(Math.max(0, (airspeedMs || 0) ** 2 - (verticalSpeedMs || 0) ** 2));
  return Math.atan2(verticalSpeedMs || 0, Math.max(1, horiz));
}

/**
 * Attitude (pitch, bank, nose heading) from a quaternion {x,y,z,w} that maps
 * body → world with body axes x=right, y=up, z=forward and world +y up. Pure —
 * the orchestrator imports this to publish read-only attitude onto `sim`.
 */
export function attitudeFromQuat(q) {
  const fwd = rotateVec(q, 0, 0, 1);
  const up = rotateVec(q, 0, 1, 0);
  const right = rotateVec(q, 1, 0, 0);
  const pitch = Math.asin(clamp(fwd.y, -1, 1));
  const heading = Math.atan2(fwd.x, fwd.z);
  const bank = Math.atan2(-right.y, up.y);
  return { pitch, bank, heading };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createInstruments(root) {
  // The HUD glass overlay (toggleable) and the analog panel are siblings so the
  // orchestrator can hide the whole overlay when not flying while H toggles only
  // the glass.
  const hud = buildHud();
  const panel = buildPanel();
  root.appendChild(hud.el);
  root.appendChild(panel.el);

  let hudVisible = true;
  let panelVisible = true;

  // Turn-rate estimate: low-passed heading derivative across renders.
  let prevHeadingDeg = null;
  let prevT = null;
  let turnRate = 0;

  function update(sim) {
    const af = AIRFRAMES[sim.airframe] || AIRFRAMES.trainer;
    const isJet = (af.type || "").indexOf("jet") >= 0;

    const kt = (sim.airspeed || 0) * MS_TO_KT;
    const ft = (sim.altitude || 0) * M_TO_FT;
    const trackDeg = norm360((sim.heading || 0) * RAD_TO_DEG);
    const noseDeg = norm360((sim.noseHeading != null ? sim.noseHeading : sim.heading || 0) * RAD_TO_DEG);
    const fpm = (sim.verticalSpeed || 0) * MS_TO_FPM;
    const pitchDeg = (sim.pitch || 0) * RAD_TO_DEG;
    const bankDeg = (sim.bank || 0) * RAD_TO_DEG;
    const maxKt = Math.max(60, Math.round((af.cruiseSpeed * MS_TO_KT * 1.55) / 10) * 10);

    // Turn rate from the heading derivative (deg/s), low-passed for a steady
    // needle. Guards the wrap at 360° and the first frame.
    if (prevT != null && sim.t > prevT) {
      let d = noseDeg - prevHeadingDeg;
      if (d > 180) d -= 360; else if (d < -180) d += 360;
      const inst = d / (sim.t - prevT);
      turnRate += (inst - turnRate) * 0.15;
    }
    prevHeadingDeg = noseDeg;
    prevT = sim.t;

    // ── Six-pack ──────────────────────────────────────────────────────────
    hud.g.asi.setAttribute("transform", rot(asiNeedleAngle(kt, maxKt), 60, 60));
    hud.g.asiText.textContent = Math.round(kt);

    setAttitude(hud.g.ai, pitchDeg, bankDeg);

    const alt = altNeedleAngles(ft);
    hud.g.altH.setAttribute("transform", rot(alt.hundreds, 60, 60));
    hud.g.altK.setAttribute("transform", rot(alt.thousands, 60, 60));
    hud.g.altText.textContent = Math.round(ft);

    hud.g.tcPlane.setAttribute("transform", rot(turnRateToBank(turnRate), 60, 60));
    hud.g.tcBall.setAttribute("cx", 60 + slipBallOffset(sim.sideslip || 0));

    hud.g.hiCard.setAttribute("transform", rot(headingCardRotation(noseDeg), 60, 60));
    hud.g.hiText.textContent = pad3(Math.round(noseDeg) % 360);

    hud.g.vsi.setAttribute("transform", rot(vsiNeedleAngle(fpm), 60, 60));
    hud.g.vsiText.textContent = (fpm >= 0 ? "+" : "−") + Math.abs(Math.round(fpm / 10) * 10);

    // ── Power / fuel / flap / gear ─────────────────────────────────────────
    const rpmFrac = clamp01(sim.rpm || 0);
    hud.g.powNeedle.setAttribute("transform", rot(sweep270(rpmFrac), 60, 60));
    hud.g.powLabel.textContent = isJet ? "N1" : "RPM";
    hud.g.powText.textContent = isJet
      ? Math.round(rpmFrac * 100) + "%"
      : Math.round(rpmFrac * 2700);

    panel.el.querySelector("[data-thr]").style.width = pct(sim.throttle);
    const fuel = panel.el.querySelector("[data-fuel]");
    fuel.style.width = pct((sim.fuel || 0) / 100);
    fuel.classList.toggle("warn", (sim.fuel || 0) <= 20);
    panel.el.querySelector("[data-gear]").textContent = sim.gear ? "DOWN" : "UP";
    panel.el.querySelector("[data-gear]").classList.toggle("up", !sim.gear);
    panel.el.querySelector("[data-flaps]").textContent = Math.round(sim.flaps || 0) + "°";
    const stallEl = panel.el.querySelector("[data-stall]");
    stallEl.classList.toggle("on", !!sim.stalled);

    // ── HUD glass ──────────────────────────────────────────────────────────
    hud.glass.spd.textContent = pad3(Math.round(kt));
    hud.glass.alt.textContent = pad5(Math.round(ft));
    hud.glass.hdg.textContent = pad3(Math.round(noseDeg) % 360);
    hud.glass.vs.textContent = (fpm >= 0 ? "+" : "−") + pad4(Math.abs(Math.round(fpm / 10) * 10));

    // Horizon reference line: banks with roll, slides with pitch.
    hud.glass.horizon.setAttribute(
      "transform",
      `rotate(${(-bankDeg).toFixed(2)}) translate(0 ${(pitchDeg * 10).toFixed(1)})`,
    );

    // Flight-path marker: drift (track − nose) sideways, flight-path angle down.
    let drift = ((trackDeg - noseDeg + 540) % 360) - 180; // −180..180 deg
    const fpm2 = flightPathMarkerOffset(
      flightPathAngle(sim.verticalSpeed || 0, sim.airspeed || 0),
      drift / RAD_TO_DEG,
    );
    hud.glass.fpm.setAttribute("transform", `translate(${fpm2.x.toFixed(1)} ${fpm2.y.toFixed(1)})`);
  }

  return {
    update,
    setHudVisible(v) { hudVisible = !!v; hud.glass.el.style.display = v ? "" : "none"; },
    setPanelVisible(v) { panelVisible = !!v; panel.el.style.display = v ? "" : "none"; },
    isHudVisible() { return hudVisible; },
    isPanelVisible() { return panelVisible; },
    dispose() {
      if (hud.el.parentNode === root) root.removeChild(hud.el);
      if (panel.el.parentNode === root) root.removeChild(panel.el);
    },
  };
}

// ── HUD container: analog six-pack + glass overlay ───────────────────────────

function buildHud() {
  const el = document.createElement("div");
  el.className = "ofs-instr";

  // Glass HUD overlay (toggleable).
  const glassEl = document.createElement("div");
  glassEl.className = "ofs-glass";
  const gSvg = svg("svg", { class: "ofs-glass-svg", viewBox: "-500 -500 1000 1000", preserveAspectRatio: "xMidYMid meet" });
  const horizon = svg("g", { class: "ofs-horizon" });
  horizon.appendChild(svg("line", { x1: -900, y1: 0, x2: 900, y2: 0, class: "ofs-h-line" }));
  for (let p = -30; p <= 30; p += 10) {
    if (p === 0) continue;
    const y = -p * 10;
    horizon.appendChild(svg("line", { x1: -60, y1: y, x2: 60, y2: y, class: "ofs-h-tick" }));
    horizon.appendChild(text(-78, y + 5, String(p), "ofs-h-num", "end"));
  }
  const boresight = svg("g", { class: "ofs-bore" });
  boresight.appendChild(svg("path", { d: "M-120 0 L-40 0 M40 0 L120 0 M0 -14 L0 14", class: "ofs-bore-line" }));
  const fpm = svg("g", { class: "ofs-fpm" });
  fpm.appendChild(svg("circle", { cx: 0, cy: 0, r: 20, class: "ofs-fpm-ring" }));
  fpm.appendChild(svg("path", { d: "M-20 0 L-46 0 M20 0 L46 0 M0 -20 L0 -34", class: "ofs-fpm-wings" }));
  gSvg.append(horizon, boresight, fpm);
  glassEl.appendChild(gSvg);

  // HUD text tapes.
  const spd = tapeBox("SPD", "kt", "left");
  const alt = tapeBox("ALT", "ft", "right");
  const hdg = tapeBox("HDG", "°", "top");
  const vs = tapeBox("V/S", "fpm", "vsi");
  glassEl.append(spd.box, alt.box, hdg.box, vs.box);

  // Analog six-pack (+power) row.
  const rack = document.createElement("div");
  rack.className = "ofs-rack";
  const asi = gaugeShell("ASI", "kt");
  const ai = attitudeGauge();
  const altG = gaugeShell("ALT", "ft x100");
  const tc = turnCoordinatorGauge();
  const hi = headingGauge();
  const vsi = gaugeShell("VSI", "fpm x100");
  const pow = gaugeShell("PWR", "");
  rack.append(asi.el, ai.el, altG.el, tc.el, hi.el, vsi.el, pow.el);

  el.append(rack, glassEl);

  // ASI face
  arcTicks(asi.face, 0, 1, 10);
  const asiNeedle = needle(asi.face, "ofs-needle");
  const asiText = centerText(asi.face);

  // ALT face — two hands
  arcTicks(altG.face, 0, 1, 10);
  const altK = needle(altG.face, "ofs-needle ofs-needle-k");
  const altH = needle(altG.face, "ofs-needle");
  const altText = centerText(altG.face, 86);

  // VSI face
  const vsiNeedle = needle(vsi.face, "ofs-needle");
  vsiTicks(vsi.face);
  const vsiText = centerText(vsi.face, 86);

  // PWR face
  arcTicks(pow.face, 0, 1, 10);
  const powNeedle = needle(pow.face, "ofs-needle");
  const powText = centerText(pow.face, 82);

  return {
    el,
    glass: {
      el: glassEl,
      spd: spd.val, alt: alt.val, hdg: hdg.val, vs: vs.val,
      horizon, fpm,
    },
    g: {
      asi: asiNeedle, asiText,
      ai: ai.parts,
      altH, altK, altText,
      tcPlane: tc.plane, tcBall: tc.ball,
      hiCard: hi.card, hiText: hi.text,
      vsi: vsiNeedle, vsiText,
      powNeedle, powText, powLabel: pow.subEl,
    },
  };
}

function buildPanel() {
  const el = document.createElement("div");
  el.className = "ofs-panel";
  el.innerHTML = `
    <div class="ofs-panel-row"><span>THR</span><div class="ofs-bar"><i data-thr></i></div></div>
    <div class="ofs-panel-row"><span>FUEL</span><div class="ofs-bar"><i data-fuel></i></div></div>
    <div class="ofs-panel-row"><span>GEAR</span><b data-gear>DOWN</b></div>
    <div class="ofs-panel-row"><span>FLAPS</span><b data-flaps>0°</b></div>
    <div class="ofs-panel-row ofs-stall"><b data-stall>STALL</b></div>
  `;
  return { el };
}

// ── SVG gauge builders ───────────────────────────────────────────────────────

function gaugeShell(label, sub) {
  const el = document.createElement("div");
  el.className = "ofs-gauge";
  const s = svg("svg", { viewBox: "0 0 120 120" });
  s.appendChild(svg("circle", { cx: 60, cy: 60, r: 58, class: "ofs-bezel" }));
  s.appendChild(svg("circle", { cx: 60, cy: 60, r: 52, class: "ofs-dial" }));
  const cap = document.createElement("div");
  cap.className = "ofs-gauge-cap";
  cap.textContent = label;
  const subEl = document.createElement("div");
  subEl.className = "ofs-gauge-sub";
  subEl.textContent = sub;
  el.append(s, cap, subEl);
  return { el, face: s, subEl };
}

function attitudeGauge() {
  const el = document.createElement("div");
  el.className = "ofs-gauge";
  const s = svg("svg", { viewBox: "0 0 120 120" });
  const clipId = "ofs-ai-clip-" + (attitudeGauge._n = (attitudeGauge._n || 0) + 1);
  const defs = svg("defs", {});
  const clip = svg("clipPath", { id: clipId });
  clip.appendChild(svg("circle", { cx: 60, cy: 60, r: 50 }));
  defs.appendChild(clip);
  s.appendChild(defs);
  s.appendChild(svg("circle", { cx: 60, cy: 60, r: 58, class: "ofs-bezel" }));

  const inner = svg("g", { "clip-path": `url(#${clipId})` });
  // Rolls with bank; pitches by translating the card.
  const card = svg("g", {});
  card.appendChild(svg("rect", { x: -120, y: -140, width: 360, height: 200, class: "ofs-ai-sky" }));
  card.appendChild(svg("rect", { x: -120, y: 60, width: 360, height: 200, class: "ofs-ai-gnd" }));
  card.appendChild(svg("line", { x1: -120, y1: 60, x2: 240, y2: 60, class: "ofs-ai-horizon" }));
  for (let p = -20; p <= 20; p += 10) {
    if (p === 0) continue;
    const y = 60 - p * 1.8;
    card.appendChild(svg("line", { x1: 46, y1: y, x2: 74, y2: y, class: "ofs-ai-ladder" }));
  }
  inner.appendChild(card);
  s.appendChild(inner);

  // Fixed miniature aircraft + bank pointer.
  s.appendChild(svg("path", { d: "M40 60 L54 60 M66 60 L80 60 M60 60 L60 66", class: "ofs-ai-plane" }));
  s.appendChild(svg("path", { d: "M60 12 L56 20 L64 20 Z", class: "ofs-ai-ptr" }));
  s.appendChild(svg("circle", { cx: 60, cy: 60, r: 50, class: "ofs-dial-ring" }));

  const cap = document.createElement("div");
  cap.className = "ofs-gauge-cap";
  cap.textContent = "ATT";
  el.append(s, cap);
  return { el, parts: { card } };
}

function turnCoordinatorGauge() {
  const el = document.createElement("div");
  el.className = "ofs-gauge";
  const s = svg("svg", { viewBox: "0 0 120 120" });
  s.appendChild(svg("circle", { cx: 60, cy: 60, r: 58, class: "ofs-bezel" }));
  s.appendChild(svg("circle", { cx: 60, cy: 60, r: 52, class: "ofs-dial" }));
  // Standard-rate reference marks.
  s.appendChild(svg("line", { x1: 16, y1: 52, x2: 26, y2: 48, class: "ofs-tc-mark" }));
  s.appendChild(svg("line", { x1: 104, y1: 52, x2: 94, y2: 48, class: "ofs-tc-mark" }));
  s.appendChild(text(60, 34, "2 MIN", "ofs-tc-cap", "middle"));
  // Banking aircraft symbol.
  const plane = svg("g", { class: "ofs-tc-plane" });
  plane.appendChild(svg("path", { d: "M18 60 L102 60 M60 44 L60 60 M48 74 L72 74", class: "ofs-tc-body" }));
  plane.appendChild(svg("circle", { cx: 60, cy: 60, r: 4, class: "ofs-tc-hub" }));
  s.appendChild(plane);
  // Inclinometer (slip/skid ball) in a curved race.
  s.appendChild(svg("path", { d: "M42 96 A 30 30 0 0 0 78 96", class: "ofs-tc-race" }));
  s.appendChild(svg("line", { x1: 54, y1: 92, x2: 54, y2: 100, class: "ofs-tc-cage" }));
  s.appendChild(svg("line", { x1: 66, y1: 92, x2: 66, y2: 100, class: "ofs-tc-cage" }));
  const ball = svg("circle", { cx: 60, cy: 95, r: 4, class: "ofs-tc-ball" });
  s.appendChild(ball);
  const cap = document.createElement("div");
  cap.className = "ofs-gauge-cap";
  cap.textContent = "T/C";
  el.append(s, cap);
  return { el, plane, ball };
}

function headingGauge() {
  const el = document.createElement("div");
  el.className = "ofs-gauge";
  const s = svg("svg", { viewBox: "0 0 120 120" });
  s.appendChild(svg("circle", { cx: 60, cy: 60, r: 58, class: "ofs-bezel" }));
  s.appendChild(svg("circle", { cx: 60, cy: 60, r: 52, class: "ofs-dial" }));
  const card = svg("g", {});
  const cardinals = { 0: "N", 90: "E", 180: "S", 270: "W" };
  for (let d = 0; d < 360; d += 30) {
    const a = (d * Math.PI) / 180;
    const sin = Math.sin(a), cos = Math.cos(a);
    const r1 = 50, r2 = 44;
    card.appendChild(svg("line", {
      x1: 60 + sin * r1, y1: 60 - cos * r1, x2: 60 + sin * r2, y2: 60 - cos * r2, class: "ofs-hi-tick",
    }));
    const label = cardinals[d] || String(d / 10);
    card.appendChild(text(60 + sin * 36, 60 - cos * 36 + 4, label, "ofs-hi-num", "middle"));
  }
  s.appendChild(card);
  // Fixed aircraft + top lubber line.
  s.appendChild(svg("path", { d: "M60 40 L60 80 M50 54 L70 54 M54 74 L66 74", class: "ofs-hi-plane" }));
  s.appendChild(svg("path", { d: "M60 6 L56 14 L64 14 Z", class: "ofs-ai-ptr" }));
  const t = centerText(s, 100);
  const cap = document.createElement("div");
  cap.className = "ofs-gauge-cap";
  cap.textContent = "HDG";
  el.append(s, cap);
  return { el, card, text: t };
}

// ── SVG primitives ───────────────────────────────────────────────────────────

function needle(face, cls) {
  const g = svg("g", { class: cls });
  g.appendChild(svg("path", { d: "M60 60 L60 16", class: "ofs-needle-line" }));
  g.appendChild(svg("circle", { cx: 60, cy: 60, r: 4, class: "ofs-needle-hub" }));
  face.appendChild(g);
  return g;
}

function arcTicks(face, from, to, count) {
  const g = svg("g", {});
  for (let i = 0; i <= count; i++) {
    const frac = i / count;
    const ang = ((sweep270(from + (to - from) * frac)) * Math.PI) / 180;
    const sin = Math.sin(ang), cos = -Math.cos(ang);
    g.appendChild(svg("line", {
      x1: 60 + sin * 50, y1: 60 + cos * 50, x2: 60 + sin * 42, y2: 60 + cos * 42, class: "ofs-tick",
    }));
    g.appendChild(text(60 + sin * 33, 60 + cos * 33 + 4, String(i), "ofs-tick-num", "middle"));
  }
  face.appendChild(g);
}

function vsiTicks(face) {
  const g = svg("g", {});
  for (let v = -2000; v <= 2000; v += 1000) {
    const ang = (vsiNeedleAngle(v) * Math.PI) / 180;
    const sin = Math.sin(ang), cos = -Math.cos(ang);
    g.appendChild(svg("line", {
      x1: 60 + sin * 50, y1: 60 + cos * 50, x2: 60 + sin * 42, y2: 60 + cos * 42, class: "ofs-tick",
    }));
    g.appendChild(text(60 + sin * 33, 60 + cos * 33 + 4, String(v / 1000), "ofs-tick-num", "middle"));
  }
  face.appendChild(g);
}

function centerText(face, y = 92) {
  const t = text(60, y, "0", "ofs-gauge-val", "middle");
  face.appendChild(t);
  return t;
}

function setAttitude(parts, pitchDeg, bankDeg) {
  const p = clamp(pitchDeg, -25, 25);
  parts.card.setAttribute(
    "transform",
    `rotate(${(-bankDeg).toFixed(2)} 60 60) translate(0 ${(p * 1.8).toFixed(1)})`,
  );
}

function tapeBox(label, unit, where) {
  const box = document.createElement("div");
  box.className = "ofs-tape ofs-tape-" + where;
  const l = document.createElement("span");
  l.className = "ofs-tape-l";
  l.textContent = label;
  const val = document.createElement("b");
  val.textContent = "0";
  const u = document.createElement("span");
  u.className = "ofs-tape-u";
  u.textContent = unit;
  box.append(l, val, u);
  return { box, val };
}

function svg(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function text(x, y, str, cls, anchor) {
  const t = svg("text", { x, y, class: cls });
  if (anchor) t.setAttribute("text-anchor", anchor);
  t.textContent = str;
  return t;
}
function rot(deg, cx, cy) { return `rotate(${(+deg).toFixed(2)} ${cx} ${cy})`; }

// ── Number helpers ───────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function clamp01(v) { return clamp(v || 0, 0, 1); }
function norm360(d) { return ((d % 360) + 360) % 360; }
function pad3(n) { return String(Math.max(0, Math.round(n))).padStart(3, "0"); }
function pad4(n) { return String(Math.max(0, Math.round(n))).padStart(4, "0"); }
function pad5(n) { return String(Math.max(0, Math.round(n))).padStart(5, "0"); }
function pct(v) { return clamp01(v) * 100 + "%"; }

// Rotate vector (vx,vy,vz) by quaternion q = {x,y,z,w}. Pure, no deps.
function rotateVec(q, vx, vy, vz) {
  const { x, y, z, w } = q;
  // t = 2 * (q_vec × v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return {
    x: vx + w * tx + (y * tz - z * ty),
    y: vy + w * ty + (z * tx - x * tz),
    z: vz + w * tz + (x * ty - y * tx),
  };
}

export const __OFS_BOUNDARY__ = "instruments";
