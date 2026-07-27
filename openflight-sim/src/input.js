/**
 * OpenFlight Sim — Input (T4, OFS-004).
 *
 * Contract (frozen at T1): `createInput(target)` attaches listeners and returns
 * `{ poll(), reset(), dispose() }` (plus `pressed()`). The orchestrator calls
 * `poll()` each fixed step and reads the normalized controls snapshot whose
 * shape is `CONTROLS_SHAPE`.
 *
 * This wave adds three more control methods on top of the keyboard so the
 * simulator is fully flyable — including on a phone:
 *   • a mouse yoke (hold the left button over the scene and steer with the
 *     pointer; release re-centres);
 *   • gamepad axes and triggers;
 *   • on-screen touch controls — a virtual stick, a throttle slider, and
 *     gear / flap / brake / view / HUD buttons, mounted lazily and shown on
 *     coarse-pointer (touch) devices.
 *
 * Every source feeds one pure combiner, `combineControls`, which is exported so
 * the focused test can assert the mixing without a browser. Gear latches as a
 * toggle (like the flap detent) rather than a momentary hold, and the view / HUD
 * toggles fire once per physical press instead of every frame a key is held.
 */

export const CONTROLS_SHAPE = Object.freeze({
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
  brakes: 0,
  flaps: 0,
  gear: 1,
  viewToggle: false,
  hudToggle: false,
});

const THROTTLE_SLEW_PER_SEC = 0.5;   // full range in ~2 s
const FLAPS_DETENT = 10;             // 4 detents to max deflection (40°)
const FLAPS_MAX = 40;
const MAX_SLEW_DT = 0.25;            // clamp per-poll slew window
const YOKE_GAIN = 1 / 0.42;          // fraction of half-viewport for full deflection
const YOKE_DEADZONE = 0.06;

/**
 * Pure control combiner. Sums the per-axis contributions from every source,
 * clamps them, and resolves throttle (an absolute source — gamepad trigger or
 * touch slider — overrides the slewed keyboard value). Exported for the test.
 */
export function combineControls(s) {
  const throttle = s.throttleAbs != null ? s.throttleAbs : s.throttleSlew || 0;
  return Object.freeze({
    pitch: clamp(sum(s.pitch), -1, 1),
    roll: clamp(sum(s.roll), -1, 1),
    yaw: clamp(sum(s.yaw), -1, 1),
    throttle: clamp(throttle, 0, 1),
    brakes: clamp(s.brakes || 0, 0, 1),
    flaps: clamp(s.flaps || 0, 0, FLAPS_MAX),
    gear: s.gear ? 1 : 0,
    viewToggle: !!s.viewToggle,
    hudToggle: !!s.hudToggle,
  });
}

/** Map a pointer offset within [-1,1] to a yoke axis (deadzone + clamp). */
export function yokeAxis(norm) {
  const v = clamp(norm * YOKE_GAIN, -1, 1);
  if (Math.abs(v) < YOKE_DEADZONE) return 0;
  return v;
}

export function createInput(target = window) {
  const doc = typeof document !== "undefined" ? document : null;
  const canvas = doc ? doc.getElementById("scene") : null;

  const keys = new Set();
  const gamepads = new Map();

  // Persistent actuator state.
  let throttle = 0.6;
  let flaps = 0;
  let gearDown = 1;          // latched; toggled on the 'g' edge / touch button
  let lastPoll = 0;

  // One-shot edges consumed by the next poll().
  let pendingView = false;
  let pendingHud = false;

  // Mouse-yoke state.
  const mouse = { active: false, x: 0, y: 0 };

  // Touch state, populated by the on-screen controls (built lazily).
  const touch = { roll: 0, pitch: 0, throttle: null, brakes: 0 };
  let touchUI = null;

  function down(e) {
    const k = normalize(e.key);
    if (!k) return;
    keys.add(k);
    if (e.repeat) return;                          // ignore auto-repeat for edges
    if (k === "f") flaps = clamp(flaps + FLAPS_DETENT, 0, FLAPS_MAX);
    if (k === "g") gearDown = gearDown ? 0 : 1;    // latched toggle
    if (k === "v") pendingView = true;
    if (k === "h") pendingHud = true;
  }
  function up(e) {
    const k = normalize(e.key);
    if (k) keys.delete(k);
  }
  function blur() { keys.clear(); mouse.active = false; }
  function onGamepad(e) { gamepads.set(e.gamepad.index, e.gamepad); }
  function onGamepadOff(e) { gamepads.delete(e.gamepad.index); }

  // ── Mouse yoke ──────────────────────────────────────────────────────────
  function pointerDown(e) {
    if (e.pointerType && e.pointerType !== "mouse") return; // touch handled elsewhere
    if (canvas && e.target !== canvas) return;              // only when steering the scene
    mouse.active = true;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }
  function pointerMove(e) {
    if (!mouse.active) return;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }
  function pointerUp() { mouse.active = false; }

  if (doc) {
    target.addEventListener("keydown", down);
    target.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    window.addEventListener("gamepadconnected", onGamepad);
    window.addEventListener("gamepaddisconnected", onGamepadOff);
    window.addEventListener("pointerdown", pointerDown);
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerUp);
    touchUI = buildTouchControls(doc, touch, {
      toggleGear() { gearDown = gearDown ? 0 : 1; },
      stepFlaps() { flaps = flaps >= FLAPS_MAX ? 0 : clamp(flaps + FLAPS_DETENT, 0, FLAPS_MAX); },
      toggleView() { pendingView = true; },
      toggleHud() { pendingHud = true; },
    });
  }

  function mouseAxes() {
    if (!mouse.active || typeof window === "undefined") return { roll: 0, pitch: 0 };
    const halfW = window.innerWidth / 2 || 1;
    const halfH = window.innerHeight / 2 || 1;
    return {
      roll: yokeAxis((mouse.x - halfW) / halfW),
      pitch: yokeAxis((mouse.y - halfH) / halfH),
    };
  }

  function gamepadState() {
    const axes = { roll: 0, pitch: 0, yaw: 0 };
    let throttleAbs = null;
    for (const gp of gamepads.values()) {
      if (!gp || !gp.axes) continue;
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0, az = gp.axes[2] || 0;
      if (Math.abs(ax) > 0.12) axes.roll += ax;
      if (Math.abs(ay) > 0.12) axes.pitch += ay;
      if (Math.abs(az) > 0.12) axes.yaw += az;
      const rt = gp.buttons && gp.buttons[7] && gp.buttons[7].value;
      if (rt && rt > 0.01) throttleAbs = rt;
    }
    return { axes, throttleAbs };
  }

  return {
    poll() {
      // Keyboard axes.
      let kPitch = 0, kRoll = 0, kYaw = 0;
      if (keys.has("arrowup") || keys.has("s")) kPitch -= 1;
      if (keys.has("arrowdown") || keys.has("w")) kPitch += 1;
      if (keys.has("arrowleft") || keys.has("a")) kRoll -= 1;
      if (keys.has("arrowright") || keys.has("d")) kRoll += 1;
      if (keys.has("q")) kYaw -= 1;
      if (keys.has("e")) kYaw += 1;

      // Throttle slew (Shift up / Control down), unless a live absolute source wins.
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const dtSlew = lastPoll ? Math.min(MAX_SLEW_DT, Math.max(0, (now - lastPoll) / 1000)) : 0;
      lastPoll = now;
      const slew = THROTTLE_SLEW_PER_SEC * dtSlew;
      if (keys.has("shift")) throttle = clamp(throttle + slew, 0, 1);
      else if (keys.has("control")) throttle = clamp(throttle - slew, 0, 1);

      const m = mouseAxes();
      const g = gamepadState();

      // Absolute throttle: touch slider first, then gamepad trigger, else slew.
      let throttleAbs = null;
      if (touch.throttle != null) { throttleAbs = touch.throttle; throttle = touch.throttle; }
      else if (g.throttleAbs != null) { throttleAbs = g.throttleAbs; throttle = g.throttleAbs; }

      const brakes = (keys.has(" ") ? 1 : 0) + (touch.brakes || 0);

      const viewToggle = pendingView; pendingView = false;
      const hudToggle = pendingHud; pendingHud = false;

      return combineControls({
        pitch: [kPitch, m.pitch, g.axes.pitch, touch.pitch],
        roll: [kRoll, m.roll, g.axes.roll, touch.roll],
        yaw: [kYaw, g.axes.yaw],
        throttleSlew: throttle,
        throttleAbs,
        brakes,
        flaps,
        gear: gearDown,
        viewToggle,
        hudToggle,
      });
    },
    pressed(key) { return keys.has(normalize(key)); },
    reset() {
      keys.clear();
      throttle = 0.6; flaps = 0; gearDown = 1; lastPoll = 0;
      pendingView = false; pendingHud = false;
      mouse.active = false;
      touch.roll = 0; touch.pitch = 0; touch.throttle = null; touch.brakes = 0;
      if (touchUI) touchUI.reset();
    },
    dispose() {
      if (!doc) return;
      target.removeEventListener("keydown", down);
      target.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      window.removeEventListener("gamepadconnected", onGamepad);
      window.removeEventListener("gamepaddisconnected", onGamepadOff);
      window.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerUp);
      if (touchUI) touchUI.dispose();
    },
  };
}

// ── On-screen touch controls ─────────────────────────────────────────────────

function buildTouchControls(doc, touch, actions) {
  const root = doc.createElement("div");
  root.className = "ofs-touch";
  // Show on coarse-pointer / touch-capable devices.
  const coarse = (typeof window !== "undefined" && window.matchMedia &&
    window.matchMedia("(pointer: coarse)").matches) ||
    (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) ||
    (typeof window !== "undefined" && "ontouchstart" in window);
  if (coarse) root.classList.add("is-touch");

  // Virtual stick (pitch / roll).
  const stick = doc.createElement("div");
  stick.className = "ofs-stick";
  const knob = doc.createElement("div");
  knob.className = "ofs-stick-knob";
  stick.appendChild(knob);

  // Throttle slider.
  const thrWrap = doc.createElement("div");
  thrWrap.className = "ofs-thr";
  const thrFill = doc.createElement("i");
  const thrKnob = doc.createElement("div");
  thrKnob.className = "ofs-thr-knob";
  const thrLabel = doc.createElement("span");
  thrLabel.textContent = "THR";
  thrWrap.append(thrFill, thrKnob, thrLabel);

  // Buttons.
  const btns = doc.createElement("div");
  btns.className = "ofs-touch-btns";
  const mk = (label, cls) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "ofs-tbtn " + cls;
    b.textContent = label;
    btns.appendChild(b);
    return b;
  };
  const gearB = mk("GEAR", "b-gear");
  const flapB = mk("FLAP", "b-flap");
  const brakeB = mk("BRK", "b-brake");
  const viewB = mk("VIEW", "b-view");
  const hudB = mk("HUD", "b-hud");

  root.append(stick, thrWrap, btns);
  doc.body.appendChild(root);

  // Stick drag → normalized pitch/roll in [-1,1].
  let stickId = null;
  function stickMove(clientX, clientY) {
    const r = stick.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const rad = r.width / 2 || 1;
    let dx = clamp((clientX - cx) / rad, -1, 1);
    let dy = clamp((clientY - cy) / rad, -1, 1);
    touch.roll = dx;
    touch.pitch = dy;
    knob.style.transform = `translate(${dx * rad * 0.6}px, ${dy * rad * 0.6}px)`;
  }
  function stickEnd() {
    stickId = null;
    touch.roll = 0; touch.pitch = 0;
    knob.style.transform = "translate(0,0)";
  }
  stick.addEventListener("pointerdown", (e) => {
    stickId = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    stickMove(e.clientX, e.clientY);
    e.preventDefault();
  });
  stick.addEventListener("pointermove", (e) => {
    if (e.pointerId === stickId) stickMove(e.clientX, e.clientY);
  });
  stick.addEventListener("pointerup", stickEnd);
  stick.addEventListener("pointercancel", stickEnd);

  // Throttle slider → absolute 0..1 (0 at bottom).
  let thrId = null;
  function thrMove(clientY) {
    const r = thrWrap.getBoundingClientRect();
    const v = clamp(1 - (clientY - r.top) / (r.height || 1), 0, 1);
    touch.throttle = v;
    thrFill.style.height = v * 100 + "%";
    thrKnob.style.bottom = `calc(${v * 100}% - 12px)`;
  }
  thrWrap.addEventListener("pointerdown", (e) => {
    thrId = e.pointerId;
    thrWrap.setPointerCapture(e.pointerId);
    thrMove(e.clientY);
    e.preventDefault();
  });
  thrWrap.addEventListener("pointermove", (e) => {
    if (e.pointerId === thrId) thrMove(e.clientY);
  });
  const thrEnd = (e) => { if (e.pointerId === thrId) thrId = null; };
  thrWrap.addEventListener("pointerup", thrEnd);
  thrWrap.addEventListener("pointercancel", thrEnd);

  // Buttons.
  gearB.addEventListener("pointerdown", (e) => { e.preventDefault(); actions.toggleGear(); gearB.classList.toggle("on"); });
  flapB.addEventListener("pointerdown", (e) => { e.preventDefault(); actions.stepFlaps(); });
  viewB.addEventListener("pointerdown", (e) => { e.preventDefault(); actions.toggleView(); });
  hudB.addEventListener("pointerdown", (e) => { e.preventDefault(); actions.toggleHud(); });
  const brakeDown = (e) => { e.preventDefault(); touch.brakes = 1; brakeB.classList.add("on"); };
  const brakeUp = () => { touch.brakes = 0; brakeB.classList.remove("on"); };
  brakeB.addEventListener("pointerdown", brakeDown);
  brakeB.addEventListener("pointerup", brakeUp);
  brakeB.addEventListener("pointercancel", brakeUp);
  brakeB.addEventListener("pointerleave", brakeUp);

  return {
    reset() {
      stickEnd();
      touch.throttle = null; touch.brakes = 0;
      thrFill.style.height = "0%";
      gearB.classList.remove("on");
      brakeB.classList.remove("on");
    },
    dispose() { if (root.parentNode) root.parentNode.removeChild(root); },
  };
}

// ── helpers ────────────────────────────────────────────────────────────────
function normalize(key) { return key ? key.toLowerCase() : null; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function sum(arr) { let t = 0; for (let i = 0; i < arr.length; i++) t += arr[i] || 0; return t; }

export const __OFS_BOUNDARY__ = "input";
