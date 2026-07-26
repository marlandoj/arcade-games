#!/usr/bin/env bun
/**
 * OpenFlight Sim — flight-dynamics focused test (OFS-002).
 *
 * Pure + offline. Exercises the atmosphere and 6-DOF flight model directly
 * (no THREE, no DOM — the flight model is duck-typed on the sim object) and
 * asserts each T2 acceptance criterion:
 *   1. ISA atmosphere returns T/p/ρ sea level → tropopause, density feeds lift
 *      and available thrust.
 *   2. Steady wind, discrete gusts, and continuous turbulence are modelled and
 *      configurable per weather preset.
 *   3. Rigid-body integrator resolves forces/moments in body axes with a mass,
 *      inertia tensor, and CG offset.
 *   4. Three airframes with distinct derivative sets.
 *   5. Gear model accumulates ground reaction into the same totals (does not
 *      overwrite aero); spring/damper, friction, steering, brakes.
 *   6. Trainer trims to level flight in cruise and stalls within a plausible
 *      band of its declared stall speed.
 *   7. Integrator stays stable at the substep cap; no NaN/divergence after
 *      sustained control input.
 *
 * Exit 0 on pass, 1 on any failure.
 */

import { atmosphere, densityAltitude, createWindModel, WEATHER_PRESETS } from "../openflight-sim/src/atmosphere.js";
import { createFlightModel, AIRFRAMES, airframeList } from "../openflight-sim/src/flight-model.js";

const FIXED_DT = 1 / 120;
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`  ✗ ${msg}`); failures++; }
  else console.log(`  ✓ ${msg}`);
}
function approx(a: number, b: number, tol: number) { return Math.abs(a - b) <= tol; }
function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }

// ── Minimal duck-typed sim (mirrors the THREE fields the model touches) ──────
type AnySim = any;
function makeSim({ x = 0, y = 300, z = 0, vx = 0, vy = 0, vz = 62 }: { x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number } = {}): AnySim {
  return {
    pos: { x, y, z, set(a: number, b: number, c: number) { this.x = a; this.y = b; this.z = c; } },
    vel: { x: vx, y: vy, z: vz, set(a: number, b: number, c: number) { this.x = a; this.y = b; this.z = c; } },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    airspeed: Math.hypot(vx, vy, vz),
    t: 0,
  };
}
const neutralControls = () => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0.5, brakes: 0, flaps: 0, gear: 1 });

function stepOnce(model: any, sim: AnySim, controls: any, dt: number = FIXED_DT) {
  const env = atmosphere(sim.pos.y);
  model.step(dt, sim, env, controls);
  sim.airspeed = Math.hypot(sim.vel.x, sim.vel.y, sim.vel.z);
  sim.t += dt;
}
function finite(sim: AnySim): boolean {
  return (
    Number.isFinite(sim.pos.x) && Number.isFinite(sim.pos.y) && Number.isFinite(sim.pos.z) &&
    Number.isFinite(sim.vel.x) && Number.isFinite(sim.vel.y) && Number.isFinite(sim.vel.z) &&
    Number.isFinite(sim.quat.x) && Number.isFinite(sim.quat.y) && Number.isFinite(sim.quat.z) && Number.isFinite(sim.quat.w)
  );
}

// ── 1. ISA atmosphere ─────────────────────────────────────────────────────────
console.log("\n[1] ISA atmosphere (sea level → tropopause → stratosphere)");
{
  const sea = atmosphere(0);
  assert(approx(sea.temperature, 288.15, 1e-3), `sea-level T = ${sea.temperature.toFixed(3)} K (288.15)`);
  assert(approx(sea.pressure, 101325, 1e-3), `sea-level p = ${sea.pressure.toFixed(1)} Pa (101325)`);
  assert(approx(sea.density, 1.225, 1e-3), `sea-level ρ = ${sea.density.toFixed(4)} kg/m³ (1.225)`);
  const trop = atmosphere(11000);
  assert(approx(trop.temperature, 216.65, 1e-2), `tropopause T = ${trop.temperature.toFixed(3)} K (216.65)`);
  assert(approx(trop.pressure, 22632, 5), `tropopause p = ${trop.pressure.toFixed(1)} Pa (~22632)`);
  assert(approx(trop.density, 0.3639, 5e-3), `tropopause ρ = ${trop.density.toFixed(4)} kg/m³ (~0.3639)`);
  const strat = atmosphere(20000);
  assert(approx(strat.temperature, 216.65, 1e-2), `stratosphere T = ${strat.temperature.toFixed(3)} K (isothermal 216.65)`);
  assert(strat.pressure < trop.pressure && strat.density < trop.density, "p,ρ continue to fall above the tropopause");
  assert(sea.density > trop.density && trop.density > strat.density, "density decreases monotonically with altitude");
  assert(Number.isFinite(densityAltitude(1000, 10)), "densityAltitude returns a finite value for an OAT deviation");
}
// Density feeds lift and available thrust.
{
  const c = { ...neutralControls(), throttle: 1, gear: 0 };
  const mLow = createFlightModel("trainer");
  const mHigh = createFlightModel("trainer");
  const low = makeSim({ y: 10, vz: 62 });
  const high = makeSim({ y: 11000, vz: 62 });
  stepOnce(mLow, low, c); stepOnce(mHigh, high, c);
  assert(mHigh.forces().thrust < mLow.forces().thrust, `thrust falls with density: sea=${mLow.forces().thrust.toFixed(0)} N, 11km=${mHigh.forces().thrust.toFixed(0)} N`);
  assert(mHigh.forces().lift < mLow.forces().lift, `lift falls with density: sea=${mLow.forces().lift.toFixed(0)} N, 11km=${mHigh.forces().lift.toFixed(0)} N`);
}

// ── 2. Wind: steady, discrete gusts, continuous turbulence ───────────────────
console.log("\n[2] Wind model (steady / discrete gust / continuous turbulence)");
{
  const calm = createWindModel(WEATHER_PRESETS.calm);
  const turb = createWindModel(WEATHER_PRESETS.turbulent);
  let calmMax = 0, turbMax = 0, turbVar = 0, turbMean = 0, n = 0;
  for (let i = 0; i < 600; i++) {
    const cs = calm.sample(FIXED_DT, 50, 60, i * FIXED_DT);
    const ts = turb.sample(FIXED_DT, 50, 60, i * FIXED_DT);
    calmMax = Math.max(calmMax, Math.hypot(cs.windN, cs.windE, cs.windU));
    const tm = Math.hypot(ts.windN, ts.windE, ts.windU);
    turbMax = Math.max(turbMax, tm);
    turbMean += tm; n++;
  }
  turbMean /= n;
  assert(turbMax > 5 * calmMax, `turbulent wind exceeds calm (${turbMax.toFixed(2)} vs ${calmMax.toFixed(2)} m/s)`);
  assert(turbMean > 0.5, `continuous turbulence produces sustained wind (mean ${turbMean.toFixed(2)} m/s)`);
  // Steady wind scales with the preset (breezy 5 m/s N → scaled by shear near surface).
  const breezy = createWindModel(WEATHER_PRESETS.breezy);
  const b = breezy.sample(0, 30, 0, 0);
  assert(b.windN > 2 && b.windN < 8, `breezy steady windN in plausible band (${b.windN.toFixed(2)} m/s)`);
  // Discrete gust: a gusty preset produces a transient spike above the steady wind.
  const gusty = createWindModel(WEATHER_PRESETS.gusty);
  let steady = 0, peak = 0;
  for (let i = 0; i < 1200; i++) {
    const g = gusty.sample(FIXED_DT, 50, 60, i * FIXED_DT);
    const m = Math.hypot(g.windN, g.windE);
    steady = Math.max(steady, m - g.gustMag);
    peak = Math.max(peak, m);
  }
  assert(peak > steady + 1.0, `discrete gust produces a spike above steady wind (peak ${peak.toFixed(2)} > steady ${steady.toFixed(2)} m/s)`);
  // Configurable per preset: different presets give different steady wind.
  const calmW = createWindModel(WEATHER_PRESETS.calm).sample(0, 30, 0, 0);
  const gustyW = createWindModel(WEATHER_PRESETS.gusty).sample(0, 30, 0, 0);
  assert(Math.hypot(gustyW.windN, gustyW.windE) > Math.hypot(calmW.windN, calmW.windE), "wind differs per preset (gusty > calm)");
}

// ── 3. Rigid-body integrator with mass, inertia tensor, CG offset ────────────
console.log("\n[3] Rigid-body integrator (mass / inertia tensor / CG offset)");
{
  const af = AIRFRAMES.trainer;
  assert(af.mass > 0 && af.inertia.roll > 0 && af.inertia.pitch > 0 && af.inertia.yaw > 0, "airframe exposes mass and a 3-axis inertia tensor");
  assert(af.cgOffset.x !== 0 || af.cgOffset.y !== 0 || af.cgOffset.z !== 0, "trainer carries a nonzero CG offset");
  // An applied pitch input rotates the body (quaternion changes), proving the
  // angular solver + inertia are wired through body axes.
  const model = createFlightModel("trainer");
  const sim = makeSim({ y: 300, vz: 62 });
  const q0 = { ...sim.quat };
  for (let i = 0; i < 120; i++) stepOnce(model, sim, { ...neutralControls(), pitch: -0.6, gear: 0 }, FIXED_DT);
  assert(finite(sim), "integrator stays finite under pitch input");
  assert(Math.abs(sim.quat.x) + Math.abs(sim.quat.y) + Math.abs(sim.quat.z) > 1e-3, "quaternion evolves under pitch input (body axes resolved)");
  assert(Math.abs(sim.quat.x) > Math.abs(sim.quat.z), "pitch input dominates the roll-axis quaternion component");
}

// ── 4. Three airframes with distinct derivative sets ─────────────────────────
console.log("\n[4] Three airframes with distinct derivatives");
{
  const list = airframeList();
  assert(list.length === 3, `exactly three airframes (${list.length})`);
  const t = AIRFRAMES.trainer, a = AIRFRAMES.aerobatic, j = AIRFRAMES.jet;
  assert(t.mass !== a.mass && a.mass !== j.mass, "airframes have distinct masses");
  assert(t.deriv.CLalpha !== a.deriv.CLalpha || t.deriv.Clda !== a.deriv.Clda, "trainer & aerobatic differ in lift/roll derivatives");
  assert(t.inertia.roll !== j.inertia.roll, "trainer & jet differ in roll inertia");
  assert(t.deriv.Cmalpha !== a.deriv.Cmalpha, "trainer & aerobatic differ in pitch stability (Cmα)");
  for (const id of ["trainer", "aerobatic", "jet"]) {
    const m = createFlightModel(id);
    const s = makeSim({ y: 400, vz: AIRFRAMES[id as keyof typeof AIRFRAMES].cruiseSpeed });
    for (let i = 0; i < 60; i++) stepOnce(m, s, { ...neutralControls(), gear: 0 }, FIXED_DT);
    assert(finite(s), `${id} steps without NaN`);
  }
}

// ── 5. Gear model accumulates into the same totals ───────────────────────────
console.log("\n[5] Gear model (spring/damper, friction, steering, brakes; accumulates)");
{
  const model = createFlightModel("trainer");
  model.setGroundElevation(0);
  // On the ground with forward speed: both aero lift and gear normal > 0.
  // CG at 0.80 m ⇒ wheels (0.95 m below) compress 0.15 m into the ground.
  const sim = makeSim({ y: 0.80, z: 0, vz: 30 });
  let gearMax = 0, liftSeen = 0;
  for (let i = 0; i < 40; i++) {
    stepOnce(model, sim, { ...neutralControls(), gear: 1, brakes: 0 }, FIXED_DT);
    gearMax = Math.max(gearMax, model.forces().gear);
    liftSeen = Math.max(liftSeen, model.forces().lift);
    if (!finite(sim)) break;
  }
  assert(gearMax > 0, `gear produces upward ground reaction (${gearMax.toFixed(0)} N)`);
  assert(liftSeen > 0, `aero lift is still accumulated while on the ground (${liftSeen.toFixed(0)} N) — not overwritten`);
  // Wheel brakes decelerate a rolling aircraft.
  const roll = makeSim({ y: 1.0, z: 0, vz: 25 });
  for (let i = 0; i < 600; i++) stepOnce(model, roll, { ...neutralControls(), gear: 1, brakes: 1, throttle: 0 }, FIXED_DT);
  assert(roll.vel.z < 5, `wheel brakes stop the aircraft (vz ${roll.vel.z.toFixed(2)} m/s)`);
  // Nosewheel steering yaws the aircraft when taxiing with yaw input.
  const taxi = makeSim({ y: 1.0, z: 0, vz: 8 });
  const qStart = { ...taxi.quat };
  for (let i = 0; i < 300; i++) stepOnce(model, taxi, { ...neutralControls(), gear: 1, yaw: 1, throttle: 0.2 }, FIXED_DT);
  assert(finite(taxi) && (Math.abs(taxi.quat.x) + Math.abs(taxi.quat.y) + Math.abs(taxi.quat.z)) > 1e-3, "nosewheel steering yaws the aircraft on the ground");
  // Ground reaction never lets the aircraft fall through.
  const rest = makeSim({ y: 0.95, z: 0, vz: 0 });
  for (let i = 0; i < 1200; i++) stepOnce(model, rest, { ...neutralControls(), gear: 1, throttle: 0 }, FIXED_DT);
  assert(rest.pos.y > -0.05 && finite(rest), `aircraft rests on the gear without falling through (y ${rest.pos.y.toFixed(3)} m)`);
}

// ── 6. Trainer trims to level flight in cruise and stalls near declared speed ─
console.log("\n[6] Trainer trim and stall");
{
  const af = AIRFRAMES.trainer;
  // Analytic stall speed from the model's CLmax (sea level): Vstall = √(2W/(ρ0·S·CLmax)).
  const vStallModel = Math.sqrt((2 * af.mass * 9.80665) / (1.225 * af.S * af.CLmax));
  assert(approx(vStallModel, af.stallSpeed, 0.5), `model stall speed ${vStallModel.toFixed(2)} m/s matches declared ${af.stallSpeed} m/s (±0.5)`);
  // Trim: start at cruise, neutral controls, a cruise-trim throttle (~drag/thrust).
  // Find the cruise trim throttle analytically: T = q·S·CD at cruise, level.
  const model = createFlightModel("trainer");
  const trimThrottle = (() => {
    const rho = 1.225, V = af.cruiseSpeed;
    const q = 0.5 * rho * V * V;
    const alphaTrim = -af.deriv.Cm0 / af.deriv.Cmalpha; // zero-elevator, no-CG-corrected approx
    const CL = af.deriv.CL0 + af.deriv.CLalpha * alphaTrim;
    const CD = af.deriv.CD0 + af.deriv.k * CL * CL;
    return (q * af.S * CD) / af.maxThrust;
  })();
  const sim = makeSim({ y: 300, vz: af.cruiseSpeed });
  let altMin = sim.pos.y, altMax = sim.pos.y;
  let nan = false;
  for (let i = 0; i < 90 / FIXED_DT; i++) {
    stepOnce(model, sim, { ...neutralControls(), throttle: trimThrottle, gear: 0 }, FIXED_DT);
    if (!finite(sim)) { nan = true; break; }
    altMin = Math.min(altMin, sim.pos.y);
    altMax = Math.max(altMax, sim.pos.y);
  }
  assert(!nan, "trim run stays finite (no NaN/divergence)");
  assert(altMax - altMin < 250, `trainer holds roughly level flight in cruise (altitude band ${(altMax - altMin).toFixed(0)} m over 90 s)`);
  assert(Math.abs((altMax + altMin) / 2 - 300) < 200, `cruise trim settles near the start altitude (mean ${(altMax + altMin) / 2} m)`);
  // Dynamic stall: decelerate from cruise with an altitude-hold controller (a
  // controlled stall entry). The wing reaches αstall and the aircraft sinks. The
  // tight 1g stall-speed match is the analytic check above; this confirms the
  // integrator handles the stall and the post-stall descent without diverging.
  const stallSim = makeSim({ y: 400, vz: 55 });
  const altRef = 400;
  let stallAirspeed = null;
  for (let i = 0; i < 40 / FIXED_DT; i++) {
    const noseUp = 0.05 * (altRef - stallSim.pos.y) + 0.10 * (0 - stallSim.vel.y);
    const pitch = -clamp(noseUp, 0, 0.6);
    stepOnce(model, stallSim, { ...neutralControls(), pitch, throttle: 0.0, gear: 0 }, FIXED_DT);
    if (!finite(stallSim)) break;
    if (stallAirspeed === null && model.aeroState().stalled) stallAirspeed = stallSim.airspeed;
  }
  assert(stallAirspeed !== null, "deceleration to the stall produces a stalled state");
  assert(stallAirspeed === null || (stallAirspeed > af.stallSpeed - 5 && stallAirspeed < af.stallSpeed + 18), `stall occurs within a plausible band of declared speed (V at stall ${stallAirspeed === null ? "n/a" : stallAirspeed.toFixed(1)} m/s vs ${af.stallSpeed}; 1g analytic Vstall ${vStallModel.toFixed(1)})`);
  assert(stallSim.pos.y < altRef, `stalled aircraft descends (Δy ${(stallSim.pos.y - altRef).toFixed(0)} m)`);
  assert(finite(stallSim), "stall does not diverge the integrator");
  // Forced stall: full up-elevator at cruise drives α past the stall angle.
  const forced = makeSim({ y: 400, vz: af.cruiseSpeed });
  let stalledSeen = false;
  for (let i = 0; i < 6 / FIXED_DT; i++) {
    stepOnce(model, forced, { ...neutralControls(), pitch: -1, throttle: 0.3, gear: 0 }, FIXED_DT);
    if (model.aeroState().stalled) stalledSeen = true;
    if (!finite(forced)) break;
  }
  assert(stalledSeen, "full up-elevator produces a stalled (post-stall α) state");
  assert(finite(forced), "forced stall does not diverge the integrator");
}

// ── 7. Integrator stability at the substep cap under sustained input ─────────
console.log("\n[7] Integrator stability (sustained control input, substep cap)");
{
  for (const id of ["trainer", "aerobatic", "jet"]) {
    const model = createFlightModel(id);
    model.setWeatherPreset(WEATHER_PRESETS.turbulent);
    const sim = makeSim({ y: 500, vz: AIRFRAMES[id as keyof typeof AIRFRAMES].cruiseSpeed });
    let ok = true, bounded = true;
    for (let i = 0; i < 120 / FIXED_DT; i++) {
      // Sustained, aggressive, alternating input — worst case for the integrator.
      const phase = Math.floor(i / (1 / FIXED_DT)) % 2 ? 1 : -1;
      stepOnce(model, sim, { pitch: phase, roll: phase, yaw: phase, throttle: 1, brakes: 0, flaps: 40, gear: 1 }, FIXED_DT);
      if (!finite(sim)) { ok = false; break; }
      if (Math.abs(sim.pos.y) > 50000 || sim.airspeed > 800 || Math.abs(sim.pos.x) > 50000 || Math.abs(sim.pos.z) > 50000) { bounded = false; break; }
    }
    assert(ok && bounded, `${id} stays finite and bounded under 120 s sustained aggressive input`);
  }
}

console.log(failures === 0 ? "\n✅ flight-dynamics: ALL CHECKS PASSED" : `\n❌ flight-dynamics: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
