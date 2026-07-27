#!/usr/bin/env bun
/**
 * OpenFlight Sim — instruments / input focused test (OFS-004).
 *
 * Pure + offline. Exercises the parts of the T4 boundary that do not need a
 * browser: the instrument value→needle mappings, the attitude extraction from a
 * quaternion, the flight-path-marker geometry, and the pure control combiner
 * that mixes keyboard / mouse / gamepad / touch into the frozen controls shape.
 *
 * The DOM-bound halves — the SVG six-pack and HUD glass, the WebAudio synth, and
 * the on-screen touch widgets — are geometry/graph plumbing built on top of these
 * primitives and are verified by the headless browser reachability check.
 *
 * Asserts the testable T4 acceptance criteria:
 *   1. The six-pack readouts are driven from simulation state (monotone, bounded
 *      mappings for ASI, ALT, VSI, HI, turn coordinator, attitude).
 *   2. The HUD flight-path marker tracks flight-path angle and drift, clamped to
 *      the glass.
 *   3. Keyboard, mouse yoke, gamepad and touch all reach the flight controls, and
 *      an absolute throttle source overrides the keyboard slew.
 *
 * Exit 0 on pass, 1 on any failure.
 */

import {
  sweep270, asiNeedleAngle, altNeedleAngles, vsiNeedleAngle, headingCardRotation,
  turnRateToBank, slipBallOffset, flightPathMarkerOffset, flightPathAngle, attitudeFromQuat,
} from "../openflight-sim/src/instruments.js";
import { combineControls, yokeAxis, CONTROLS_SHAPE } from "../openflight-sim/src/input.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`  ✗ ${msg}`); failures++; }
  else console.log(`  ✓ ${msg}`);
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── 1. Six-pack mappings ─────────────────────────────────────────────────────
console.log("[1] Analog six-pack mappings");
{
  // Sweep spans a 270° arc, min at −135°, max at +135°, monotone.
  assert(near(sweep270(0), -135) && near(sweep270(1), 135) && near(sweep270(0.5), 0),
    "270° sweep maps 0→−135°, 0.5→0°, 1→+135°");
  assert(sweep270(0.25) < sweep270(0.75), "sweep is monotone increasing");

  // ASI: knots scale onto the sweep against the airframe's max.
  assert(near(asiNeedleAngle(0, 160), -135) && asiNeedleAngle(80, 160) < asiNeedleAngle(160, 160),
    "ASI needle rises monotonically with airspeed");

  // Altimeter: hundreds hand turns 10× faster than the thousands hand.
  const a0 = altNeedleAngles(0);
  const a500 = altNeedleAngles(500);
  const a1000 = altNeedleAngles(1000);
  assert(near(a0.hundreds, 0) && near(a0.thousands, 0), "altimeter reads 0 at 0 ft");
  assert(near(a500.hundreds, 180), "hundreds hand at 180° for 500 ft");
  assert(near(a1000.hundreds, 0, 1e-6) && near(a1000.thousands, 36), "hundreds hand laps at 1000 ft; thousands at 36°");

  // VSI: 0 fpm points left (−90°); climb up, descent down; clamped at ±2000.
  assert(near(vsiNeedleAngle(0), -90), "VSI needle points left (9 o'clock) at 0 fpm");
  assert(vsiNeedleAngle(1000) > vsiNeedleAngle(0) && vsiNeedleAngle(-1000) < vsiNeedleAngle(0),
    "VSI needle swings up for climb, down for descent");
  assert(near(vsiNeedleAngle(5000), vsiNeedleAngle(2000)), "VSI clamps beyond ±2000 fpm");

  // Heading card counter-rotates so the live heading sits at the top.
  assert(near(headingCardRotation(90), -90) && near(headingCardRotation(450), -90),
    "heading card rotation normalises 0..360 and negates");

  // Turn coordinator: standard rate (3°/s) banks the symbol ~20°, clamped.
  assert(near(turnRateToBank(3), 20) && near(turnRateToBank(-3), -20), "standard-rate turn banks the T/C symbol ±20°");
  assert(near(turnRateToBank(30), turnRateToBank(3 * 1.6)), "T/C bank is clamped at high turn rates");
  assert(slipBallOffset(0.28) > 0 && slipBallOffset(-0.28) < 0 && Math.abs(slipBallOffset(10)) <= 14,
    "slip ball follows sideslip sign and is clamped to the race");
}

// ── 2. Attitude + HUD flight-path marker ─────────────────────────────────────
console.log("[2] Attitude extraction and flight-path marker");
{
  // Identity quaternion → wings level, nose on the horizon, heading 0 (north).
  const lvl = attitudeFromQuat({ x: 0, y: 0, z: 0, w: 1 });
  assert(near(lvl.pitch, 0) && near(lvl.bank, 0) && near(lvl.heading, 0), "identity attitude is level, heading north");

  // Pitch up: a nose-up pitch is a negative rotation about the body right axis
  // (matching the flight model, where the nose-up pitch rate q = −ω_x).
  const a = Math.PI / 9; // 20°
  const pitchUp = attitudeFromQuat({ x: Math.sin(-a / 2), y: 0, z: 0, w: Math.cos(-a / 2) });
  assert(pitchUp.pitch > 0.1, `nose-up rotation reads as positive pitch (${(pitchUp.pitch).toFixed(3)} rad)`);
  const pitchDn = attitudeFromQuat({ x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) });
  assert(pitchDn.pitch < -0.1, "nose-down rotation reads as negative pitch");

  // Bank right: rotate about body +z (forward) axis → right wing down (bank>0).
  const rollR = attitudeFromQuat({ x: 0, y: 0, z: Math.sin(-a / 2), w: Math.cos(-a / 2) });
  assert(rollR.bank > 0.1, `roll right reads as positive bank (${(rollR.bank).toFixed(3)} rad)`);

  // Flight-path angle: climbing at 5 m/s over 50 m/s airspeed → small positive γ.
  const gamma = flightPathAngle(5, 50);
  assert(gamma > 0 && gamma < 0.2, `climb gives a small positive flight-path angle (${gamma.toFixed(3)} rad)`);
  assert(near(flightPathAngle(0, 50), 0), "level flight gives zero flight-path angle");

  // FPM offset: climb pushes the marker up (negative y in screen space); drift
  // right pushes it right (positive x); both clamp to the glass.
  const up = flightPathMarkerOffset(gamma, 0);
  assert(up.y < 0 && near(up.x, 0), "climb raises the flight-path marker");
  const drift = flightPathMarkerOffset(0, 0.2);
  assert(drift.x > 0, "right drift moves the marker right");
  const big = flightPathMarkerOffset(1.5, 1.5);
  assert(Math.abs(big.x) <= 300 && Math.abs(big.y) <= 300, "flight-path marker stays clamped on the glass");
}

// ── 3. Control combiner: every input method reaches the aircraft ─────────────
console.log("[3] Control combiner — keyboard / mouse / gamepad / touch");
{
  // The combiner returns exactly the frozen controls shape.
  const base = combineControls({ pitch: [0], roll: [0], yaw: [0], throttleSlew: 0.6, gear: 1 });
  assert(Object.keys(CONTROLS_SHAPE).every((k) => k in base), "combiner returns the frozen CONTROLS_SHAPE keys");
  assert(Object.isFrozen(base), "combined controls snapshot is frozen");

  // Axes sum across sources and clamp to [-1, 1].
  const summed = combineControls({ pitch: [0.6, 0.6], roll: [-0.5, -0.9], yaw: [0.3], throttleSlew: 0.5, gear: 1 });
  assert(near(summed.pitch, 1) && near(summed.roll, -1) && near(summed.yaw, 0.3),
    "axis contributions sum and clamp to [-1, 1]");

  // Keyboard-only path: slewed throttle passes through.
  const kb = combineControls({ pitch: [-1], roll: [0], yaw: [0], throttleSlew: 0.42, gear: 1 });
  assert(near(kb.throttle, 0.42), "keyboard slewed throttle passes through when no absolute source");

  // An absolute throttle source (gamepad trigger / touch slider) overrides slew.
  const abs = combineControls({ pitch: [0], roll: [0], yaw: [0], throttleSlew: 0.9, throttleAbs: 0.2, gear: 1 });
  assert(near(abs.throttle, 0.2), "absolute throttle source overrides the keyboard slew");

  // Mouse yoke: deadzone near centre, clamps at the edges, correct sign.
  assert(yokeAxis(0.01) === 0, "mouse yoke has a centre deadzone");
  assert(yokeAxis(1) === 1 && yokeAxis(-1) === -1, "mouse yoke clamps to ±1 at the edges");
  assert(yokeAxis(0.3) > 0 && yokeAxis(-0.3) < 0, "mouse yoke preserves sign off-centre");

  // Touch contributes an axis just like the others (mixed with keyboard here).
  const touchMix = combineControls({ pitch: [0, 0, 0, 0.7], roll: [0, 0, 0, -0.4], yaw: [0], throttleSlew: 0.5, gear: 1 });
  assert(near(touchMix.pitch, 0.7) && near(touchMix.roll, -0.4), "touch-stick axes reach the controls");

  // Gear/flaps latch through; flaps clamp to the 0..40 range.
  const cfg = combineControls({ pitch: [0], roll: [0], yaw: [0], throttleSlew: 0.5, flaps: 55, gear: 0 });
  assert(cfg.gear === 0 && near(cfg.flaps, 40), "gear latches and flaps clamp to the max detent");
}

if (failures === 0) console.log("\nOFS-004 instruments/input: ALL CHECKS PASSED");
else console.error(`\nOFS-004 instruments/input: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
