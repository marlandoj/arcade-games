/**
 * OpenFlight Sim — Input (T1 boundary stub, OFS-004 fills).
 *
 * Contract: `createInput(target)` attaches listeners and returns
 * `{ poll(), reset(), dispose() }`. The orchestrator calls `poll()` each fixed
 * step to read a normalized controls snapshot. T4 adds mouse yoke, gamepad
 * axes and on-screen touch controls; the polled controls shape is frozen.
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

export function createInput(target = window) {
  const keys = new Set();
  const gamepads = new Map();

  // Persistent actuator state (ZOU-920 remediation #3, #4).
  let throttle = 0.6;          // persists across polls; slews at a bounded rate
  let flaps = 0;               // discrete detent per keypress edge
  let lastPoll = 0;            // wall-clock time of the previous poll (ms)

  const THROTTLE_SLEW_PER_SEC = 0.5;  // full range in ~2 s
  const FLAPS_DETENT = 10;            // 4 detents to max deflection (40)
  const MAX_SLEW_DT = 0.25;           // clamp per-poll slew window (matches MAX_FRAME_TIME)

  function down(e) {
    const k = normalize(e.key);
    if (k) keys.add(k);
    // Flaps actuate one detent per physical keypress (ZOU-920 #3); auto-repeat
    // (e.repeat) is ignored so a held key cannot saturate in a single frame.
    if (k === "f" && !e.repeat) flaps = clamp(flaps + FLAPS_DETENT, 0, 40);
  }
  function up(e) {
    const k = normalize(e.key);
    if (k) keys.delete(k);
  }
  function blur() { keys.clear(); }
  function onGamepad(e) { gamepads.set(e.gamepad.index, e.gamepad); }
  function onGamepadOff(e) { gamepads.delete(e.gamepad.index); }

  target.addEventListener("keydown", down);
  target.addEventListener("keyup", up);
  window.addEventListener("blur", blur);
  window.addEventListener("gamepadconnected", onGamepad);
  window.addEventListener("gamepaddisconnected", onGamepadOff);

  return {
    poll() {
      let pitch = 0, roll = 0, yaw = 0;
      let brakes = 0, gear = 1;
      let viewToggle = false, hudToggle = false;

      if (keys.has("arrowup") || keys.has("s")) pitch -= 1;
      if (keys.has("arrowdown") || keys.has("w")) pitch += 1;
      if (keys.has("arrowleft") || keys.has("a")) roll -= 1;
      if (keys.has("arrowright") || keys.has("d")) roll += 1;
      if (keys.has("q")) yaw -= 1;
      if (keys.has("e")) yaw += 1;

      // Throttle persists and slews at a bounded per-second rate (ZOU-920 #4):
      // Shift slews up, Control slews down, otherwise the setting holds.
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const dtSlew = lastPoll ? Math.min(MAX_SLEW_DT, Math.max(0, (now - lastPoll) / 1000)) : 0;
      lastPoll = now;
      const slew = THROTTLE_SLEW_PER_SEC * dtSlew;
      if (keys.has("shift")) throttle = Math.min(1, throttle + slew);
      else if (keys.has("control")) throttle = Math.max(0, throttle - slew);

      if (keys.has(" ")) brakes = 1;
      if (keys.has("g")) gear = 0;
      if (keys.has("v")) viewToggle = true;
      if (keys.has("h")) hudToggle = true;

      for (const gp of gamepads.values()) {
        if (!gp || !gp.axes) continue;
        const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
        const rt = gp.buttons[7] && gp.buttons[7].value;
        if (Math.abs(ay) > 0.12) pitch -= ay;
        if (Math.abs(ax) > 0.12) roll += ax;
        if (rt && rt > 0.01) throttle = rt;
      }

      pitch = clamp(pitch, -1, 1);
      roll = clamp(roll, -1, 1);
      yaw = clamp(yaw, -1, 1);
      throttle = clamp(throttle, 0, 1);
      brakes = clamp(brakes, 0, 1);

      return Object.freeze({
        pitch, roll, yaw, throttle, brakes, flaps, gear, viewToggle, hudToggle,
      });
    },
    pressed(key) { return keys.has(normalize(key)); },
    reset() { keys.clear(); throttle = 0.6; flaps = 0; lastPoll = 0; },
    dispose() {
      target.removeEventListener("keydown", down);
      target.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      window.removeEventListener("gamepadconnected", onGamepad);
      window.removeEventListener("gamepaddisconnected", onGamepadOff);
    },
  };
}

function normalize(key) {
  if (!key) return null;
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export const __OFS_BOUNDARY__ = "input";
