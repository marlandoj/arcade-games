/**
 * OpenFlight Sim — 6-DOF Flight Model (OFS-002).
 *
 * Contract (frozen by T1): `createFlightModel(airframeKey)` returns a handle
 * whose `step(dt, sim, env, controls)` integrates a rigid body in body axes and
 * writes the result back onto `sim` (pos, vel, quat). `forces()` and
 * `aeroState()` expose the last computed coefficients for instruments. OFS-002
 * replaces the T1 kinematic placeholder with the full derivative-based
 * integrator: lift/drag/side-force/damping/control derivatives, a mass and
 * inertia tensor, a CG offset, ground reaction, and wind coupling. Call sites
 * are frozen; new handle methods (setWeatherPreset, setGroundElevation,
 * angularVelocity) are additive.
 *
 * ── Axis convention ──────────────────────────────────────────────────────
 * World (THREE): +x = east, +y = up, +z = north. Gravity = (0, -g, 0).
 * Body (THREE local): +x = right, +y = up, +z = forward (nose). The quaternion
 * maps body → world.
 * Stability derivatives are evaluated in standard aerospace axes (x = forward,
 * y = right, z = down) using published textbook signs (Cmα<0, Cnβ>0, Clβ<0,
 * Cmδe<0, etc.). Conversions to/from the sim's body axes:
 *   v_sim = (v_std, -w_std, u_std);  u=Vz_sim, v=Vx_sim, w=-Vy_sim
 *   F_sim = (Y_std, -Z_std, X_std)
 *   M_sim = (-M_std, N_std, -L_std)
 *   ω_sim = (-q_std, r_std, -p_std);  p=-ωz, q=-ωx, r=ωy
 */

import { createWindModel, WEATHER_PRESETS } from "./atmosphere.js";

const G = 9.80665;
const RHO0 = 1.225;

// Control-surface max deflections (rad). The input controls are normalized to
// [-1, 1]; δe/δa/δr are the physical deflections used by the derivatives.
const DELTA_E = 0.35;   // elevator (positive = trailing-edge down = nose down)
const DELTA_A = 0.30;   // aileron  (positive = right-wing-down roll)
const DELTA_R = 0.35;   // rudder   (positive = nose right)

const MAX_RATE = 8.0;   // body-axis rate clamp (rad/s) — bounds the integrator.

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ── Airframes ─────────────────────────────────────────────────────────────
// Derivative sets are representative of each class (textbook stability
// derivatives, not copied from any simulator). CLmax is chosen so the sea-
// level stall speed matches the declared value: Vstall = sqrt(2W/(ρ0·S·CLmax)).
const TRAINER = makeAirframe({
  id: "trainer",
  name: "Skyliner T-76",
  type: "light trainer",
  mass: 1200, S: 16.2, b: 10.2, cbar: 1.59,
  stallSpeed: 28, cruiseSpeed: 62, maxThrust: 4200,
  cgOffset: { x: 0.02, y: 0, z: 0 },
  thrustOffset: { x: 0, y: 0, z: 0.04 },
  inertia: { roll: 1300, pitch: 1700, yaw: 2600, xz: 0 },
  CLmax: 1.51,
  deriv: {
    CL0: 0.25, CLalpha: 4.6, CLq: 3.0, CLde: 0.45, CLflap: 0.35,
    CD0: 0.030, k: 0.052, CDde: 0.012, CDflap: 0.022, CDgear: 0.018,
    CYbeta: -0.31, CYp: -0.04, CYr: 0.35, CYda: 0.0, CYdr: -0.06,
    Clbeta: -0.089, Clp: -0.47, Clr: 0.09, Clda: 0.16, Cldr: 0.005,
    Cm0: 0.012, Cmalpha: -0.60, Cmq: -3.0, Cmde: -0.80, Cmflap: -0.05,
    Cnbeta: 0.065, Cnp: -0.03, Cnr: -0.09, Cnda: -0.006, Cndr: 0.060,
  },
  gear: {
    kStrut: 62000, cStrut: 4200,
    muRoll: 0.02, muBrake: 0.55, muLat: 0.55, cTyre: 14000, maxSteer: 0.50,
    nose: { x: 0, y: -0.95, z: 1.20 }, left: { x: -1.55, y: -0.95, z: -0.65 }, right: { x: 1.55, y: -0.95, z: -0.65 },
  },
});

const AEROBATIC = makeAirframe({
  id: "aerobatic",
  name: "Voltige X1",
  type: "aerobatic",
  mass: 820, S: 12.8, b: 8.6, cbar: 1.50,
  stallSpeed: 26, cruiseSpeed: 70, maxThrust: 3600,
  cgOffset: { x: 0, y: 0, z: 0 },
  thrustOffset: { x: 0, y: 0.0, z: 0 },
  inertia: { roll: 820, pitch: 1050, yaw: 1450, xz: 0 },
  CLmax: 1.52,
  deriv: {
    CL0: 0.0, CLalpha: 5.0, CLq: 4.0, CLde: 0.62, CLflap: 0.0,
    CD0: 0.026, k: 0.060, CDde: 0.012, CDflap: 0.0, CDgear: 0.012,
    CYbeta: -0.40, CYp: -0.05, CYr: 0.40, CYda: 0.0, CYdr: -0.10,
    Clbeta: -0.05, Clp: -0.50, Clr: 0.12, Clda: 0.24, Cldr: 0.006,
    Cm0: 0.0, Cmalpha: -0.35, Cmq: -2.4, Cmde: -0.95, Cmflap: 0.0,
    Cnbeta: 0.080, Cnp: -0.02, Cnr: -0.11, Cnda: -0.004, Cndr: 0.085,
  },
  gear: {
    kStrut: 48000, cStrut: 3200,
    muRoll: 0.02, muBrake: 0.50, muLat: 0.55, cTyre: 13000, maxSteer: 0.40,
    nose: { x: 0, y: -0.85, z: 1.10 }, left: { x: -1.40, y: -0.85, z: -0.55 }, right: { x: 1.40, y: -0.85, z: -0.55 },
  },
});

const JET = makeAirframe({
  id: "jet",
  name: "Lumina J-7",
  type: "light jet",
  mass: 6500, S: 24.0, b: 13.4, cbar: 1.95,
  stallSpeed: 58, cruiseSpeed: 160, maxThrust: 18000,
  cgOffset: { x: 0.03, y: 0, z: 0 },
  thrustOffset: { x: 0, y: 0.0, z: 0 },
  inertia: { roll: 9000, pitch: 14000, yaw: 21000, xz: 0 },
  CLmax: 1.30,
  deriv: {
    CL0: 0.10, CLalpha: 4.3, CLq: 3.6, CLde: 0.40, CLflap: 0.30,
    CD0: 0.022, k: 0.044, CDde: 0.010, CDflap: 0.018, CDgear: 0.014,
    CYbeta: -0.28, CYp: -0.03, CYr: 0.32, CYda: 0.0, CYdr: -0.05,
    Clbeta: -0.080, Clp: -0.42, Clr: 0.07, Clda: 0.12, Cldr: 0.004,
    Cm0: 0.006, Cmalpha: -0.50, Cmq: -3.6, Cmde: -0.70, Cmflap: -0.04,
    Cnbeta: 0.080, Cnp: -0.02, Cnr: -0.12, Cnda: -0.005, Cndr: 0.055,
  },
  gear: {
    kStrut: 260000, cStrut: 16000,
    muRoll: 0.02, muBrake: 0.45, muLat: 0.50, cTyre: 60000, maxSteer: 0.35,
    nose: { x: 0, y: -1.30, z: 2.40 }, left: { x: -2.10, y: -1.20, z: -1.10 }, right: { x: 2.10, y: -1.20, z: -1.10 },
  },
});

function makeAirframe(def) {
  return Object.freeze({
    ...def,
    inertia: Object.freeze(def.inertia),
    cgOffset: Object.freeze(def.cgOffset),
    thrustOffset: Object.freeze(def.thrustOffset),
    deriv: Object.freeze(def.deriv),
    gear: Object.freeze(def.gear),
  });
}

export const AIRFRAMES = Object.freeze({
  trainer: TRAINER,
  aerobatic: AEROBATIC,
  jet: JET,
});

export function airframeList() {
  return Object.keys(AIRFRAMES).map((id) => AIRFRAMES[id]);
}

// ── Quaternion / rotation helpers (operate on plain components) ─────────────
// R maps body → world. R[i][j]: i = world axis, j = body axis.
function rotFromBody(qx, qy, qz, qw) {
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
  ];
}
function matVec(R, v) {
  return {
    x: R[0][0] * v.x + R[0][1] * v.y + R[0][2] * v.z,
    y: R[1][0] * v.x + R[1][1] * v.y + R[1][2] * v.z,
    z: R[2][0] * v.x + R[2][1] * v.y + R[2][2] * v.z,
  };
}
function matTVec(R, v) {
  return {
    x: R[0][0] * v.x + R[1][0] * v.y + R[2][0] * v.z,
    y: R[0][1] * v.x + R[1][1] * v.y + R[2][1] * v.z,
    z: R[0][2] * v.x + R[1][2] * v.y + R[2][2] * v.z,
  };
}
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
// q ⊗ r (Hamilton), stored {x,y,z,w}
function qmul(q, r) {
  return {
    x: q.w * r.x + q.x * r.w + q.y * r.z - q.z * r.y,
    y: q.w * r.y - q.x * r.z + q.y * r.w + q.z * r.x,
    z: q.w * r.z + q.x * r.y - q.y * r.x + q.z * r.w,
    w: q.w * r.w - q.x * r.x - q.y * r.y - q.z * r.z,
  };
}
function qnormalize(q) {
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

// ── Flight model factory ───────────────────────────────────────────────────
export function createFlightModel(airframeKey) {
  let airframe = AIRFRAMES[airframeKey] || AIRFRAMES.trainer;
  let windModel = createWindModel(WEATHER_PRESETS.calm);
  let groundElevation = 0;
  // Rigid-body angular velocity (body, sim axes). Internal to the model so the
  // frozen sim object shape is unchanged.
  let angVel = { x: 0, y: 0, z: 0 };
  let lastForces = { lift: 0, drag: 0, thrust: 0, side: 0, weight: 0, gear: 0 };
  let lastAero = { alpha: 0, beta: 0, aoa: 0, sideslip: 0, loadFactor: 1, stalled: false, airspeed: 0, mach: 0 };

  return {
    get airframe() { return airframe; },

    setAirframe(key) {
      airframe = AIRFRAMES[key] || AIRFRAMES.trainer;
      angVel = { x: 0, y: 0, z: 0 };
      lastForces = { lift: 0, drag: 0, thrust: 0, side: 0, weight: 0, gear: 0 };
      lastAero = { alpha: 0, beta: 0, aoa: 0, sideslip: 0, loadFactor: 1, stalled: false, airspeed: 0, mach: 0 };
    },

    setWeatherPreset(preset) {
      windModel = createWindModel(preset || WEATHER_PRESETS.calm);
    },

    setGroundElevation(h) { groundElevation = Number.isFinite(h) ? h : 0; },

    angularVelocity() { return { x: angVel.x, y: angVel.y, z: angVel.z }; },

    step(dt, sim, env, controls) {
      const a = airframe;
      const rho = (env && env.density) || RHO0;
      const densityRatio = (env && env.densityRatio) || (rho / RHO0);
      const soundSpeed = (env && env.speedOfSound) || 340.3;

      const R = rotFromBody(sim.quat.x, sim.quat.y, sim.quat.z, sim.quat.w);

      // ── Air-relative velocity in body axes ────────────────────────────────
      let windWorld = { x: 0, y: 0, z: 0 };
      if (windModel) {
        const w = windModel.sample(dt, sim.pos.y, sim.airspeed || 0, sim.t || 0);
        // World: +x east, +z north. Wind model returns north/east/up.
        windWorld = { x: w.windE, y: w.windU, z: w.windN };
      }
      const vRelWorld = {
        x: sim.vel.x - windWorld.x,
        y: sim.vel.y - windWorld.y,
        z: sim.vel.z - windWorld.z,
      };
      const vBodySim = matTVec(R, vRelWorld); // air-relative velocity, body sim axes
      const u = vBodySim.z;            // forward (std)
      const v = vBodySim.x;            // right   (std)
      const wComp = -vBodySim.y;       // down    (std)
      const airspeed = Math.hypot(u, v, wComp);

      const alpha = airspeed > 0.5 ? Math.atan2(wComp, u) : 0;   // α nose-up positive
      const beta = airspeed > 0.5 ? Math.atan2(v, Math.hypot(u, wComp)) : 0; // β wind-from-right positive
      const qdyn = 0.5 * rho * airspeed * airspeed;
      const V = Math.max(1.0, airspeed);

      // Body angular velocity (sim) → std rates: p=-ωz, q=-ωx, r=ωy.
      const p_std = -angVel.z, q_std = -angVel.x, r_std = angVel.y;
      const qhat = (q_std * a.cbar) / (2 * V);
      const phat = (p_std * a.b) / (2 * V);
      const rhat = (r_std * a.b) / (2 * V);

      const flapFraction = clamp((controls.flaps || 0) / 40, 0, 1);
      const gearDown = controls.gear === undefined ? 1 : controls.gear;
      const de = (controls.pitch || 0) * DELTA_E;
      const da = (controls.roll || 0) * DELTA_A;
      const dr = (controls.yaw || 0) * DELTA_R;

      // ── Aero coefficients (std axes) ──────────────────────────────────────
      const d = a.deriv;
      const alphaStall = (a.CLmax - d.CL0) / d.CLalpha;
      let CL = d.CL0 + d.CLalpha * alpha + d.CLq * qhat + d.CLde * de + d.CLflap * flapFraction;
      // Post-stall lift model: linear to CLmax at αstall, then cosine decay so
      // lift falls off (sink) without a discontinuity that breaks the integrator.
      if (alpha > alphaStall) {
        const over = alpha - alphaStall;
        CL = a.CLmax * Math.max(0.35, Math.cos(over * 1.6));
      } else if (alpha < -alphaStall * 0.9) {
        const over = -alpha - alphaStall * 0.9;
        CL = -a.CLmax * 0.9 * Math.max(0.35, Math.cos(over * 1.6));
      }
      CL = clamp(CL, -a.CLmax * 1.05, a.CLmax * 1.05);

      const CD = d.CD0 + d.k * CL * CL + d.CDde * Math.abs(de) + d.CDflap * flapFraction + d.CDgear * gearDown;
      const CY = d.CYbeta * beta + d.CYp * phat + d.CYr * rhat + d.CYda * da + d.CYdr * dr;
      const Cl = d.Clbeta * beta + d.Clp * phat + d.Clr * rhat + d.Clda * da + d.Cldr * dr * 0.1;
      const Cm = d.Cm0 + d.Cmalpha * alpha + d.Cmq * qhat + d.Cmde * de + d.Cmflap * flapFraction;
      const Cn = d.Cnbeta * beta + d.Cnp * phat + d.Cnr * rhat + d.Cnda * da + d.Cndr * dr;

      // ── Aerodynamic forces in std body axes (x=forward, y=right, z=down) ──
      const L_aero = qdyn * a.S * CL;     // lift (perpendicular to rel wind, up)
      const D_aero = qdyn * a.S * CD;     // drag (opposite rel wind)
      const Y_aero = qdyn * a.S * CY;     // side force (right)
      const ca = Math.cos(alpha), sa = Math.sin(alpha);
      const cb = Math.cos(beta), sb = Math.sin(beta);
      // Standard wind→body force resolution (β cross-terms on drag, lift in the
      // symmetry plane). Y_body includes the small drag sideslip component.
      const Xa = -D_aero * ca * cb + L_aero * sa;
      const Ya = Y_aero - D_aero * sb;
      const Za = -D_aero * sa * cb - L_aero * ca; // down; lift is up = -Z

      // ── Thrust (std, along body forward), density-scaled ───────────────────
      const thrust = a.maxThrust * clamp(controls.throttle, 0, 1) * Math.pow(clamp(densityRatio, 0.1, 1.2), 0.7);
      const Xt = thrust;

      // ── Moments about CG (std axes) ────────────────────────────────────────
      // Coefficient moments are about the aero reference; correct for CG offset
      // by subtracting r_cg × F_aero. Thrust moment = r_thrust × F_thrust.
      const rcg = a.cgOffset;
      const cgCrossAero = cross(rcg, { x: Xa, y: Ya, z: Za });
      const L_a = qdyn * a.S * a.b * Cl - cgCrossAero.x;
      const M_a = qdyn * a.S * a.cbar * Cm - cgCrossAero.y;
      const N_a = qdyn * a.S * a.b * Cn - cgCrossAero.z;
      const thrustCross = cross(a.thrustOffset, { x: Xt, y: 0, z: 0 });
      const L_t = thrustCross.x, M_t = thrustCross.y, N_t = thrustCross.z;

      // ── Gear (ground reaction) — accumulates, never overwrites aero ─────────
      const omegaWorld = matVec(R, angVel);
      const gear = computeGear(a, controls, R, sim, omegaWorld, groundElevation);
      const FgearBody = matTVec(R, gear.forceWorld);
      const MgearBody = matTVec(R, gear.momentWorld);

      // ── Total body force (sim axes): F_sim = (Y_std, -Z_std, X_std) ──────────
      const FbodySim = {
        x: Ya + FgearBody.x,
        y: (-Za) + FgearBody.y,
        z: Xa + Xt + FgearBody.z,
      };
      const Fworld = matVec(R, FbodySim);
      const weight = a.mass * G;
      const ax = Fworld.x / a.mass;
      const ay = (Fworld.y - weight) / a.mass;
      const az = Fworld.z / a.mass;

      // ── Total moment about CG in std axes (L_std, M_std, N_std) ──────────────
      // M_sim = (-M_std, N_std, -L_std) ⇒ L_std=-Mz_sim, M_std=-Mx_sim, N_std=My_sim
      const MbodySim = {
        x: -M_a - M_t + MgearBody.x,
        y: N_a + N_t + MgearBody.y,
        z: -L_a - L_t + MgearBody.z,
      };
      const L_std = -MbodySim.z, M_std = -MbodySim.x, N_std = MbodySim.y;

      // ── Angular dynamics: Euler's equations, diagonal inertia ──────────────
      const I = a.inertia;
      const pdot = (L_std + q_std * r_std * (I.pitch - I.yaw)) / I.roll;
      const qdot = (M_std + p_std * r_std * (I.yaw - I.roll)) / I.pitch;
      const rdot = (N_std + p_std * q_std * (I.roll - I.pitch)) / I.yaw;

      // ── Integrate (semi-implicit Euler) ─────────────────────────────────────
      let newVx = sim.vel.x + ax * dt;
      let newVy = sim.vel.y + ay * dt;
      let newVz = sim.vel.z + az * dt;
      let newPx = sim.pos.x + newVx * dt;
      let newPy = sim.pos.y + newVy * dt;
      let newPz = sim.pos.z + newVz * dt;

      let newP = clamp(p_std + pdot * dt, -MAX_RATE, MAX_RATE);
      let newQ = clamp(q_std + qdot * dt, -MAX_RATE, MAX_RATE);
      let newR = clamp(r_std + rdot * dt, -MAX_RATE, MAX_RATE);

      // ω_sim = (-q_std, r_std, -p_std)
      const omegaSim = { x: -newQ, y: newR, z: -newP };
      const omegaQuat = { x: omegaSim.x, y: omegaSim.y, z: omegaSim.z, w: 0 };
      const dq = qmul(sim.quat, omegaQuat);
      const nq = qnormalize({
        x: sim.quat.x + 0.5 * dt * dq.x,
        y: sim.quat.y + 0.5 * dt * dq.y,
        z: sim.quat.z + 0.5 * dt * dq.z,
        w: sim.quat.w + 0.5 * dt * dq.w,
      });

      // ── Finite guard: commit only if every component is finite ──────────────
      if (
        !Number.isFinite(newVx) || !Number.isFinite(newVy) || !Number.isFinite(newVz) ||
        !Number.isFinite(newPx) || !Number.isFinite(newPy) || !Number.isFinite(newPz) ||
        !Number.isFinite(nq.x) || !Number.isFinite(nq.y) || !Number.isFinite(nq.z) || !Number.isFinite(nq.w)
      ) {
        return;
      }
      sim.vel.set(newVx, newVy, newVz);
      sim.pos.set(newPx, newPy, newPz);
      sim.quat.x = nq.x; sim.quat.y = nq.y; sim.quat.z = nq.z; sim.quat.w = nq.w;
      angVel = omegaSim;

      // ── Publish last-state for instruments / debug ──────────────────────────
      const loadFactor = (L_aero * ca * cb) / Math.max(1, weight);
      lastForces = {
        lift: L_aero, drag: D_aero, thrust, side: Y_aero, weight, gear: gear.normalTotal,
      };
      lastAero = {
        alpha, beta, aoa: alpha, sideslip: beta,
        loadFactor: Number.isFinite(loadFactor) ? clamp(loadFactor, -5, 12) : 1,
        stalled: alpha > alphaStall,
        airspeed, mach: airspeed / soundSpeed,
      };
    },

    forces() { return lastForces; },
    aeroState() { return lastAero; },
  };
}

// ── Gear model ──────────────────────────────────────────────────────────────
function computeGear(a, controls, R, sim, omegaWorld, groundElev) {
  const g = a.gear;
  const ground = (groundElev || 0);
  let forceWorld = { x: 0, y: 0, z: 0 };
  let momentWorld = { x: 0, y: 0, z: 0 };
  let normalTotal = 0;
  const wheels = [
    { r: g.nose, isNose: true },
    { r: g.left, isNose: false },
    { r: g.right, isNose: false },
  ];
  for (const wheel of wheels) {
    const rWorld = matVec(R, wheel.r);
    const pWorldY = sim.pos.y + rWorld.y;
    const compression = ground - pWorldY;
    if (compression <= 0) continue;
    // Wheel point velocity = v_world + ω_world × r_world
    const wv = cross(omegaWorld, rWorld);
    const wheelVel = { x: sim.vel.x + wv.x, y: sim.vel.y + wv.y, z: sim.vel.z + wv.z };
    // Spring + damper along world up (ground normal); strut pushes up only.
    const Fz = Math.max(0, g.kStrut * compression - g.cStrut * wheelVel.y);
    normalTotal += Fz;

    // Nosewheel steering from yaw control while on the ground.
    const steer = wheel.isNose ? clamp(controls.yaw || 0, -1, 1) * g.maxSteer : 0;
    const fBody = { x: Math.sin(steer), y: 0, z: Math.cos(steer) };
    const rBodyDir = { x: Math.cos(steer), y: 0, z: -Math.sin(steer) };
    const fWorld = matVec(R, fBody);
    const rWorldDir = matVec(R, rBodyDir);

    const vLong = wheelVel.x * fWorld.x + wheelVel.y * fWorld.y + wheelVel.z * fWorld.z;
    const vLat = wheelVel.x * rWorldDir.x + wheelVel.y * rWorldDir.y + wheelVel.z * rWorldDir.z;

    const brakes = clamp(controls.brakes || 0, 0, 1);
    const muLong = g.muRoll + brakes * (g.muBrake - g.muRoll);
    const Flong = -muLong * Fz * Math.tanh(vLong / 1.5);   // smooth Coulomb friction
    const Flat = clamp(-g.cTyre * vLat, -g.muLat * Fz, g.muLat * Fz);

    const Fwheel = {
      x: Flong * fWorld.x + Flat * rWorldDir.x,
      y: Fz,
      z: Flong * fWorld.z + Flat * rWorldDir.z,
    };
    forceWorld.x += Fwheel.x;
    forceWorld.y += Fwheel.y;
    forceWorld.z += Fwheel.z;
    const mmt = cross(rWorld, Fwheel);
    momentWorld.x += mmt.x;
    momentWorld.y += mmt.y;
    momentWorld.z += mmt.z;
  }
  return { forceWorld, momentWorld, normalTotal };
}

export const __OFS_BOUNDARY__ = "flight-model";
