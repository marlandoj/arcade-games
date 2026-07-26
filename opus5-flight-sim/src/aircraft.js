/**
 * Six-degree-of-freedom rigid-body flight model.
 *
 * Body axes follow the aeronautical convention: X forward, Y right, Z down.
 * The renderer uses three.js object space (-Z forward, +X right, +Y up), so
 * every body<->world conversion goes through the three basis vectors cached
 * each step in `fwd`, `rgt`, `dwn`.
 *
 * Aerodynamics use dimensional stability derivatives (per radian) taken from
 * published light-aircraft data sets, a sigmoid blend into a flat-plate model
 * past the stall so the aircraft stays sane through the full +/-180 deg alpha
 * range, Wieselsberger ground effect, and explicit left-turning tendencies
 * (torque, P-factor, slipstream) for the piston airframes.
 */

import * as THREE from 'three';
import { isa, tasToIas, RHO0, G0 } from './atmosphere.js';

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Airframes                                                           */
/* ------------------------------------------------------------------ */

export const AIRCRAFT = {
  trainer: {
    id: 'trainer',
    name: 'SC-172 SKYLARK',
    class: 'Four-seat piston trainer',
    blurb: 'Forgiving, honest, and slow enough to think. The right place to learn a real approach.',
    mass: 1043, S: 16.17, b: 11.0, cbar: 1.49,
    I: [1285, 1825, 2667],
    engine: {
      type: 'piston', power: 134000, etaProp: 0.80, vRef: 45,
      idleRPM: 700, maxRPM: 2700, spool: 2.6, bsfc: 0.30, fuel: 144,
    },
    aero: {
      CL0: 0.31, CLa: 5.143, CLde: 0.43, CLq: 3.9, CLdf: 0.78,
      CD0: 0.0310, e: 0.72, CDdf: 0.055, CDgear: 0.018, CDbrake: 0.0,
      alphaStall: 16 * DEG, stallSharp: 22,
      CY_b: -0.31, CY_dr: 0.187,
      Cl_b: -0.089, Cl_p: -0.470, Cl_r: 0.096, Cl_da: 0.229, Cl_dr: 0.0147,
      Cm0: 0.040, Cm_a: -0.890, Cm_q: -12.4, Cm_de: -1.280, Cm_df: -0.085,
      Cn_b: 0.065, Cn_p: -0.030, Cn_r: -0.099, Cn_da: -0.053, Cn_dr: -0.0657,
    },
    ctrl: { da: 20 * DEG, de: 25 * DEG, dr: 16 * DEG, trimRange: 12 * DEG },
    limits: { vne: 84, vfe: 46, vlo: 70, vs: 25, gPos: 3.8, gNeg: -1.52, maxAlt: 4200 },
    flapDetents: [0, 10, 20, 30],
    gear: { retractable: false },
    prop: { clockwise: true, torque: 0.55, pFactor: 0.9, slipstream: 1.0 },
    dims: { span: 11.0, length: 8.28, height: 2.72, wheelbase: 1.63 },
    contacts: [
      { name: 'nose', p: [1.05, 0, 1.10], k: 42000, c: 3400, brake: 0, steer: 0.55, radius: 0.19 },
      { name: 'left', p: [-0.32, -1.42, 1.18], k: 66000, c: 5200, brake: 1, steer: 0, radius: 0.22 },
      { name: 'right', p: [-0.32, 1.42, 1.18], k: 66000, c: 5200, brake: 1, steer: 0, radius: 0.22 },
    ],
    strikePoints: [
      { p: [3.1, 0, 0.2] }, { p: [-4.2, 0, -0.4] },
      { p: [0, -5.5, -0.1] }, { p: [0, 5.5, -0.1] },
      { p: [-4.0, 0, -1.4] },
    ],
    livery: { body: 0xf2f4f8, stripe: 0x1d4ed8, accent: 0xf59e0b },
    startFlaps: 0,
  },

  aerobat: {
    id: 'aerobat',
    name: 'EX-300 VORTEX',
    class: 'Unlimited aerobatic monoplane',
    blurb: 'Symmetrical wing, 300 horses, 360 degrees of roll per second. It will do exactly what you tell it to.',
    mass: 952, S: 10.70, b: 8.00, cbar: 1.40,
    I: [900, 1200, 1800],
    engine: {
      type: 'piston', power: 224000, etaProp: 0.82, vRef: 48,
      idleRPM: 800, maxRPM: 2700, spool: 3.4, bsfc: 0.32, fuel: 120,
    },
    aero: {
      CL0: 0.02, CLa: 5.30, CLde: 0.62, CLq: 4.4, CLdf: 0,
      CD0: 0.0290, e: 0.78, CDdf: 0, CDgear: 0.020, CDbrake: 0,
      alphaStall: 17.5 * DEG, stallSharp: 18,
      CY_b: -0.36, CY_dr: 0.220,
      Cl_b: -0.062, Cl_p: -0.440, Cl_r: 0.085, Cl_da: 0.480, Cl_dr: 0.020,
      Cm0: 0.005, Cm_a: -0.720, Cm_q: -11.0, Cm_de: -1.600, Cm_df: 0,
      Cn_b: 0.074, Cn_p: -0.028, Cn_r: -0.110, Cn_da: -0.020, Cn_dr: -0.090,
    },
    ctrl: { da: 24 * DEG, de: 28 * DEG, dr: 22 * DEG, trimRange: 10 * DEG },
    limits: { vne: 108, vfe: 999, vlo: 999, vs: 28, gPos: 10, gNeg: -10, maxAlt: 5200 },
    flapDetents: [0],
    gear: { retractable: false },
    prop: { clockwise: true, torque: 0.95, pFactor: 1.2, slipstream: 1.3 },
    dims: { span: 8.0, length: 6.95, height: 2.62, wheelbase: 1.5 },
    contacts: [
      { name: 'left', p: [0.55, -1.05, 1.05], k: 72000, c: 5600, brake: 1, steer: 0, radius: 0.22 },
      { name: 'right', p: [0.55, 1.05, 1.05], k: 72000, c: 5600, brake: 1, steer: 0, radius: 0.22 },
      { name: 'tail', p: [-4.05, 0, 0.55], k: 26000, c: 2400, brake: 0, steer: 0.7, radius: 0.10 },
    ],
    strikePoints: [
      { p: [2.6, 0, 0.2] }, { p: [-3.9, 0, -0.5] },
      { p: [0, -4.0, -0.1] }, { p: [0, 4.0, -0.1] },
    ],
    livery: { body: 0x11151f, stripe: 0xef4444, accent: 0xfacc15 },
    startFlaps: 0,
    taildragger: true,
  },

  jet: {
    id: 'jet',
    name: 'TJ-500 CIRROSTRAT',
    class: 'Light business jet',
    blurb: 'Two turbofans, swept wing, and enough energy to embarrass you on final. Fly the numbers.',
    mass: 5670, S: 30.0, b: 16.0, cbar: 2.05,
    I: [30000, 42000, 66000],
    engine: {
      type: 'turbofan', thrust: 26000, spool: 0.55, tsfc: 1.75e-5, fuel: 2100,
      idleFrac: 0.055,
    },
    aero: {
      CL0: 0.14, CLa: 4.90, CLde: 0.52, CLq: 5.2, CLdf: 0.92,
      CD0: 0.0205, e: 0.80, CDdf: 0.065, CDgear: 0.021, CDbrake: 0.045,
      alphaStall: 14.5 * DEG, stallSharp: 24,
      CY_b: -0.72, CY_dr: 0.155,
      Cl_b: -0.110, Cl_p: -0.390, Cl_r: 0.140, Cl_da: 0.180, Cl_dr: 0.0106,
      Cm0: 0.030, Cm_a: -1.100, Cm_q: -19.0, Cm_de: -1.500, Cm_df: -0.120,
      Cn_b: 0.125, Cn_p: -0.045, Cn_r: -0.190, Cn_da: -0.011, Cn_dr: -0.120,
      mCrit: 0.72,
    },
    ctrl: { da: 18 * DEG, de: 22 * DEG, dr: 20 * DEG, trimRange: 10 * DEG },
    limits: { vne: 180, vfe: 92, vlo: 105, vs: 48, gPos: 3.2, gNeg: -1.0, maxAlt: 13100 },
    flapDetents: [0, 15, 30, 45],
    gear: { retractable: true, cycle: 7.5 },
    prop: { clockwise: false, torque: 0, pFactor: 0, slipstream: 0 },
    dims: { span: 16.0, length: 17.2, height: 4.6, wheelbase: 6.4 },
    contacts: [
      { name: 'nose', p: [5.0, 0, 1.85], k: 260000, c: 22000, brake: 0, steer: 0.42, radius: 0.32 },
      { name: 'left', p: [-1.4, -2.3, 1.95], k: 420000, c: 34000, brake: 1, steer: 0, radius: 0.40 },
      { name: 'right', p: [-1.4, 2.3, 1.95], k: 420000, c: 34000, brake: 1, steer: 0, radius: 0.40 },
    ],
    strikePoints: [
      { p: [7.5, 0, 0.4] }, { p: [-8.4, 0, -0.9] },
      { p: [0, -8.0, 0.1] }, { p: [0, 8.0, 0.1] },
    ],
    livery: { body: 0xe8ecf4, stripe: 0x0f172a, accent: 0x22d3ee },
    startFlaps: 0,
  },
};

export const AIRCRAFT_ORDER = ['trainer', 'aerobat', 'jet'];

/* ------------------------------------------------------------------ */
/* Flight model                                                        */
/* ------------------------------------------------------------------ */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

// groundStep runs while _v2/_v3 hold the force and moment accumulators, so it
// keeps its own scratch set — sharing them silently erased the gear reaction.
const _g1 = new THREE.Vector3();
const _g2 = new THREE.Vector3();
const _g3 = new THREE.Vector3();
const _g4 = new THREE.Vector3();
const _g5 = new THREE.Vector3();
const _g6 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

export class FlightModel {
  constructor(typeId, terrain) {
    this.terrain = terrain;
    this.setType(typeId);
  }

  setType(typeId) {
    const cfg = AIRCRAFT[typeId] || AIRCRAFT.trainer;
    this.cfg = cfg;
    this.type = cfg.id;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.omega = new THREE.Vector3(); // body p,q,r (roll, pitch, yaw rates)

    this.fwd = new THREE.Vector3(0, 0, -1);
    this.rgt = new THREE.Vector3(1, 0, 0);
    this.dwn = new THREE.Vector3(0, -1, 0);

    // Controls, normalised -1..1 (throttle 0..1)
    this.input = { aileron: 0, elevator: 0, rudder: 0, throttle: 0, brake: 0, parkBrake: true };
    this.trim = 0;
    this.flapIdx = cfg.startFlaps || 0;
    this.flapPos = 0;      // 0..1 actual (animated)
    this.gearPos = cfg.gear.retractable ? 1 : 1; // 1 = down
    this.gearCmd = 1;
    this.spoiler = 0;

    // Engine
    this.rpm = 0;
    this.thrustN = 0;
    this.throttleActual = 0;
    this.running = true;
    this.fuel = cfg.engine.fuel;
    this.fuelFlow = 0;

    // Derived / telemetry
    this.alpha = 0; this.beta = 0;
    this.tas = 0; this.ias = 0; this.mach = 0;
    this.alt = 0; this.agl = 0; this.vs = 0;
    this.gLoad = 1; this.gPeak = 1;
    this.stallFrac = 0; this.onGround = false; this.wow = false;
    this.gearLoad = 0; this.touchdownVS = 0;
    this.crashed = false; this.crashReason = '';
    this.damage = 0;
    this.rho = RHO0;
    this.qbar = 0;
    this.lastAccel = new THREE.Vector3();
    this.slipBall = 0;
    this.groundSpeed = 0;
    this.track = 0;
    this.wind = new THREE.Vector3();

    this._contacts = cfg.contacts.map((c) => ({
      ...c,
      local: new THREE.Vector3(c.p[1], -c.p[2], -c.p[0]), // aero -> three
      compression: 0,
      grounded: false,
      lastCompression: 0,
    }));
    this._strike = cfg.strikePoints.map((s) => new THREE.Vector3(s.p[1], -s.p[2], -s.p[0]));
    this._prevVel = new THREE.Vector3();
  }

  /* ---------------- placement ---------------- */

  /** Place the aircraft on the ground at a position and heading. */
  placeOnGround(x, z, headingDeg) {
    const h = this.terrain.heightAt(x, z);
    this.quat.setFromEuler(new THREE.Euler(0, -headingDeg * DEG, 0, 'YXZ'));
    this.updateBasis();
    // Sit on the gear: lowest contact point defines the offset.
    let lowest = 0;
    for (const c of this._contacts) {
      const w = _v1.copy(c.local).applyQuaternion(this.quat);
      lowest = Math.min(lowest, w.y - c.radius);
    }
    this.pos.set(x, h - lowest + 0.01, z);
    this.vel.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.input.throttle = 0;
    this.input.parkBrake = true;
    this.rpm = this.cfg.engine.type === 'piston' ? this.cfg.engine.idleRPM : 0;
    this.throttleActual = 0;
    this.crashed = false; this.damage = 0; this.gPeak = 1;
    this.fuel = this.cfg.engine.fuel;
    this.gearPos = 1; this.gearCmd = 1;
    this.flapIdx = this.cfg.startFlaps || 0;
    this.running = true;
    this.updateBasis();
  }

  /** Place the aircraft airborne, trimmed for level flight at a given speed. */
  placeInAir(x, y, z, headingDeg, tas) {
    this.quat.setFromEuler(new THREE.Euler(0, -headingDeg * DEG, 0, 'YXZ'));
    this.pos.set(x, y, z);
    this.updateBasis();
    this.vel.copy(this.fwd).multiplyScalar(tas);
    this.omega.set(0, 0, 0);
    const { rho } = isa(y);
    // Trim alpha for 1g, then pitch the airframe up by that much.
    const W = this.cfg.mass * G0;
    const CLreq = clamp(W / (0.5 * rho * tas * tas * this.cfg.S), -1.4, 1.6);
    const a = (CLreq - this.cfg.aero.CL0) / this.cfg.aero.CLa;
    this.quat.setFromEuler(new THREE.Euler(a, -headingDeg * DEG, 0, 'YXZ'));
    this.updateBasis();
    this.vel.set(0, 0, 0).addScaledVector(this.fwd, tas * Math.cos(a)).addScaledVector(this.dwn, tas * Math.sin(a) * 0);
    this.vel.copy(this.fwd).multiplyScalar(tas);
    this.vel.y = 0;
    this.vel.normalize().multiplyScalar(tas);
    // Trim tab to hold it
    this.trim = clamp((this.cfg.aero.Cm0 + this.cfg.aero.Cm_a * a) / -this.cfg.aero.Cm_de, -1, 1);
    this.input.throttle = this.cfg.engine.type === 'piston' ? 0.72 : 0.55;
    this.throttleActual = this.input.throttle;
    this.rpm = this.cfg.engine.type === 'piston'
      ? this.cfg.engine.idleRPM + this.input.throttle * (this.cfg.engine.maxRPM - this.cfg.engine.idleRPM)
      : 0;
    this.input.parkBrake = false;
    this.gearCmd = this.cfg.gear.retractable ? 0 : 1;
    this.gearPos = this.gearCmd;
    this.crashed = false; this.damage = 0; this.gPeak = 1;
    this.fuel = this.cfg.engine.fuel;
    this.running = true;
  }

  updateBasis() {
    this.fwd.set(0, 0, -1).applyQuaternion(this.quat);
    this.rgt.set(1, 0, 0).applyQuaternion(this.quat);
    this.dwn.set(0, -1, 0).applyQuaternion(this.quat);
  }

  /* ---------------- attitude readouts ---------------- */

  get pitch() { return Math.asin(clamp(-this.fwd.y * -1, -1, 1)); }

  euler() {
    // Pitch: angle of the nose above the horizon.
    const pitch = Math.asin(clamp(this.fwd.y, -1, 1));
    // Heading: 0 = north (-Z), clockwise positive.
    let hdg = Math.atan2(this.fwd.x, -this.fwd.z);
    if (hdg < 0) hdg += Math.PI * 2;
    // Bank: rotation of the wing plane about the velocity/nose axis.
    const horizRight = _v1.set(-this.fwd.z, 0, this.fwd.x);
    if (horizRight.lengthSq() < 1e-8) horizRight.set(this.rgt.x, 0, this.rgt.z);
    horizRight.normalize();
    const up = _v2.crossVectors(this.fwd, horizRight).normalize(); // horizon-referenced up
    const bank = Math.atan2(this.rgt.dot(up), this.rgt.dot(horizRight));
    return { pitch, bank: -bank, heading: hdg };
  }

  flapTarget() {
    const d = this.cfg.flapDetents;
    if (d.length <= 1) return 0;
    return d[clamp(this.flapIdx, 0, d.length - 1)] / d[d.length - 1];
  }

  flapDeg() {
    const d = this.cfg.flapDetents;
    return d[clamp(this.flapIdx, 0, d.length - 1)];
  }

  /* ---------------- main step ---------------- */

  /**
   * @param {number} dt      substep in seconds
   * @param {THREE.Vector3} wind  air-mass velocity in world coords
   * @param {object} opts    { assists:boolean, damageOn:boolean }
   */
  step(dt, wind, opts = {}) {
    const cfg = this.cfg;
    const A = cfg.aero;
    this.updateBasis();
    this.wind.copy(wind);

    const alt = this.pos.y;
    const atm = isa(Math.max(alt, -400));
    this.rho = atm.rho;
    this.alt = alt;

    /* --- actuators --- */
    const ftgt = this.flapTarget();
    const frate = 0.28 * dt * 4;
    this.flapPos += clamp(ftgt - this.flapPos, -frate, frate);
    if (cfg.gear.retractable) {
      const grate = dt / cfg.gear.cycle;
      this.gearPos += clamp(this.gearCmd - this.gearPos, -grate, grate);
    }

    /* --- relative wind --- */
    const rel = _v1.copy(this.vel).sub(wind);
    const V = rel.length();
    this.tas = V;
    this.ias = tasToIas(V, this.rho);
    this.mach = V / atm.a;
    this.groundSpeed = Math.hypot(this.vel.x, this.vel.z);
    this.track = (Math.atan2(this.vel.x, -this.vel.z) + Math.PI * 2) % (Math.PI * 2);

    const u = rel.dot(this.fwd);
    const v = rel.dot(this.rgt);
    const w = rel.dot(this.dwn);
    const Veff = Math.max(V, 0.4);
    const alpha = Math.atan2(w, Math.abs(u) < 1e-4 ? 1e-4 : u);
    const beta = Math.asin(clamp(v / Veff, -1, 1));
    this.alpha = alpha;
    this.beta = beta;

    const p = this.omega.dot(this.fwd);
    const q = this.omega.dot(this.rgt);
    const r = this.omega.dot(this.dwn);

    const qbar = 0.5 * this.rho * V * V;
    this.qbar = qbar;

    /* --- controls --- */
    const de = clamp(this.input.elevator + this.trim * (cfg.ctrl.trimRange / cfg.ctrl.de), -1, 1) * cfg.ctrl.de;
    let da = this.input.aileron * cfg.ctrl.da;
    let dr = this.input.rudder * cfg.ctrl.dr;

    // Turn coordination assist (training mode): blends in rudder with roll rate.
    if (opts.assists) {
      const need = clamp(-beta * 3.4, -1, 1) * cfg.ctrl.dr;
      dr = dr + (need - dr) * 0.75;
    }

    /* --- aerodynamic coefficients --- */
    const flapF = this.flapPos;
    const stallA = A.alphaStall - flapF * 2.0 * DEG - (this.damage > 0.4 ? 2 * DEG : 0);
    // Fischer sigmoid blend into the flat-plate model.
    const M = A.stallSharp;
    const sig =
      (1 + Math.exp(-M * (alpha - stallA)) + Math.exp(M * (alpha + stallA))) /
      ((1 + Math.exp(-M * (alpha - stallA))) * (1 + Math.exp(M * (alpha + stallA))));
    this.stallFrac = clamp(sig, 0, 1);

    const qhat = (q * cfg.cbar) / (2 * Veff);
    const phat = (p * cfg.b) / (2 * Veff);
    const rhat = (r * cfg.b) / (2 * Veff);

    const CLlin = A.CL0 + A.CLa * alpha + A.CLde * de + A.CLq * qhat + A.CLdf * flapF;
    const CLflat = 2 * Math.sin(alpha) * Math.cos(alpha);
    let CL = (1 - sig) * CLlin + sig * CLflat;

    // Ground effect (McCormick): induced drag factor + a lift bump.
    const hb = Math.max(0.02, (this.agl + 0.5) / cfg.b);
    const geK = hb < 1.1 ? (33 * Math.pow(hb, 1.5)) / (1 + 33 * Math.pow(hb, 1.5)) : 1;
    if (hb < 1.1) CL *= 1 + 0.09 * (1 - geK);

    const AR = (cfg.b * cfg.b) / cfg.S;
    const kInd = 1 / (Math.PI * A.e * AR);
    let CD0 = A.CD0 + A.CDdf * flapF + A.CDgear * this.gearPos + (A.CDbrake || 0) * this.spoiler;
    CD0 += this.damage * 0.03;
    if (A.mCrit && this.mach > A.mCrit) {
      const dM = this.mach - A.mCrit;
      CD0 += 22 * dM * dM * dM;
    }
    const CDlin = CD0 + kInd * geK * CLlin * CLlin;
    const CDflat = 1.15 * Math.sin(alpha) * Math.sin(alpha) + 0.05;
    const CD = (1 - sig) * CDlin + sig * CDflat;

    const CY = A.CY_b * beta + A.CY_dr * dr;

    /* --- forces in body axes --- */
    const L = qbar * cfg.S * CL;
    const D = qbar * cfg.S * CD;
    const Yf = qbar * cfg.S * CY;

    const ca = Math.cos(alpha), sa = Math.sin(alpha);
    let Xb = -D * ca + L * sa;
    let Zb = -D * sa - L * ca;
    let Yb = Yf;

    /* --- powerplant --- */
    const { thrust, rpm, flow } = this.engineStep(dt, V, atm);
    Xb += thrust;
    this.thrustN = thrust;
    this.rpm = rpm;
    this.fuelFlow = flow;

    /* --- moments in body axes --- */
    const Sb = qbar * cfg.S * cfg.b;
    const Sc = qbar * cfg.S * cfg.cbar;

    // Post-stall: damping collapses and an asymmetry drops a wing.
    const dampScale = 1 - 0.55 * sig;
    const asym = sig * (0.055 * Math.sign(beta || 0.001) + 0.03 * Math.sin(this.pos.x * 0.07 + this.pos.z * 0.05));

    let Lm = Sb * (A.Cl_b * beta + A.Cl_p * phat * dampScale + A.Cl_r * rhat + A.Cl_da * da * (1 - 0.6 * sig) + A.Cl_dr * dr - asym);
    let Mm = Sc * (A.Cm0 + A.Cm_a * alpha * (1 - sig) + A.Cm_q * qhat * dampScale + A.Cm_de * de * (1 - 0.35 * sig) + A.Cm_df * flapF);
    let Nm = Sb * (A.Cn_b * beta + A.Cn_p * phat + A.Cn_r * rhat * dampScale + A.Cn_da * da + A.Cn_dr * dr);

    // Post-stall pitch break: the flat-plate centre of pressure moves aft.
    Mm += Sc * sig * (-0.30 * Math.sin(2 * alpha));

    /* --- propeller left-turning tendencies --- */
    const P = cfg.prop;
    if (P.torque > 0 && cfg.engine.type === 'piston') {
      const pw = this.throttleActual * (this.running ? 1 : 0);
      const dir = P.clockwise ? -1 : 1;
      Lm += dir * P.torque * 900 * pw;                              // engine torque reaction
      Nm += dir * P.slipstream * 260 * pw * (1 - clamp(V / 55, 0, 1)); // slipstream over the fin
      Nm += dir * P.pFactor * 420 * pw * Math.sin(clamp(alpha, -0.5, 0.5)); // P-factor
    }

    /* --- assemble world force --- */
    const F = _v2.set(0, 0, 0)
      .addScaledVector(this.fwd, Xb)
      .addScaledVector(this.rgt, Yb)
      .addScaledVector(this.dwn, Zb);

    const Mw = _v3.set(0, 0, 0)
      .addScaledVector(this.fwd, Lm)
      .addScaledVector(this.rgt, Mm)
      .addScaledVector(this.dwn, Nm);

    /* --- ground reaction --- */
    this.agl = this.pos.y - this.terrain.heightAt(this.pos.x, this.pos.z);
    const gr = this.groundStep(dt, F, Mw, opts);
    this.onGround = gr.grounded;

    // Aerodynamic + propulsive load factor (gravity excluded), body-Z.
    const specific = _v1.copy(F).divideScalar(cfg.mass);
    this.gLoad = -specific.dot(this.dwn) / G0;
    if (Math.abs(this.gLoad) > Math.abs(this.gPeak)) this.gPeak = this.gLoad;

    // Slip/skid ball: lateral specific force.
    const lat = specific.dot(this.rgt) / G0;
    this.slipBall += (clamp(lat * 2.2, -1.4, 1.4) - this.slipBall) * Math.min(1, dt * 6);

    /* --- gravity + integrate --- */
    F.y -= cfg.mass * G0;

    this._prevVel.copy(this.vel);
    const acc = _v1.copy(F).divideScalar(cfg.mass);
    this.lastAccel.copy(acc);
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);
    this.vs = this.vel.y;

    /* --- angular integrate: I*wdot = M - w x (I*w) --- */
    const Ix = cfg.I[0], Iy = cfg.I[1], Iz = cfg.I[2];
    const mL = Mw.dot(this.fwd), mM = Mw.dot(this.rgt), mN = Mw.dot(this.dwn);
    const pd = (mL - (Iz - Iy) * q * r) / Ix;
    const qd = (mM - (Ix - Iz) * r * p) / Iy;
    const rd = (mN - (Iy - Ix) * p * q) / Iz;

    let np = p + pd * dt, nq = q + qd * dt, nr = r + rd * dt;
    // Numerical safety valve at absurd rates.
    const cap = 12;
    np = clamp(np, -cap, cap); nq = clamp(nq, -cap, cap); nr = clamp(nr, -cap, cap);

    this.omega.set(0, 0, 0)
      .addScaledVector(this.fwd, np)
      .addScaledVector(this.rgt, nq)
      .addScaledVector(this.dwn, nr);

    // Rotate the body: local rotation vector in three space is (q, -r, -p).
    const rv = _v2.set(nq, -nr, -np).multiplyScalar(dt);
    const ang = rv.length();
    if (ang > 1e-9) {
      _q1.setFromAxisAngle(rv.divideScalar(ang), ang);
      this.quat.multiply(_q1).normalize();
    }
    this.updateBasis();

    /* --- fuel --- */
    if (this.running) {
      this.fuel = Math.max(0, this.fuel - flow * dt);
      if (this.fuel <= 0) this.running = false;
    }

    /* --- damage / structural limits --- */
    if (opts.damageOn !== false) {
      const lim = cfg.limits;
      if (this.gLoad > lim.gPos * 1.12 || this.gLoad < lim.gNeg * 1.12) {
        this.damage = Math.min(1, this.damage + dt * 0.35);
      }
      if (this.ias > lim.vne * 1.06) this.damage = Math.min(1, this.damage + dt * 0.18);
      if (this.gearPos > 0.1 && this.ias > lim.vlo * 1.15) this.damage = Math.min(1, this.damage + dt * 0.12);
      if (this.flapPos > 0.1 && this.ias > lim.vfe * 1.15) this.damage = Math.min(1, this.damage + dt * 0.15);
      if (this.damage >= 1 && !this.crashed) this.fail('STRUCTURAL FAILURE');
    }

    this.checkStrike();
    return gr;
  }

  fail(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
  }

  /* ---------------- engine ---------------- */

  engineStep(dt, V, atm) {
    const E = this.cfg.engine;
    const cmd = this.running ? clamp(this.input.throttle, 0, 1) : 0;
    const lag = Math.min(1, dt * (E.spool || 2));
    this.throttleActual += (cmd - this.throttleActual) * lag;
    const th = this.throttleActual;

    if (E.type === 'piston') {
      const rpm = this.running
        ? E.idleRPM + th * (E.maxRPM - E.idleRPM)
        : Math.max(0, this.rpm - dt * 900 + Math.min(220, V * 9) * 0);
      // Normally-aspirated density lapse (Gagg-Ferrar).
      const dens = clamp((atm.rho / RHO0 - 0.117) / 0.883, 0, 1.05);
      const power = E.power * th * dens * (this.running ? 1 : 0) * (1 - this.damage * 0.5);
      let T = (power * E.etaProp) / Math.max(V, E.vRef);
      // Windmilling / idle prop drag.
      if (this.running) T -= (1 - th) * 0.055 * V * V * 0.5 * atm.rho * 0.02;
      else T -= 0.5 * atm.rho * V * V * 0.9;
      const flow = (power / 1000) * (E.bsfc / 3600);
      return { thrust: T, rpm, flow };
    }

    // Turbofan
    const idle = E.idleFrac || 0.05;
    const frac = this.running ? idle + th * (1 - idle) : 0;
    const T = E.thrust * frac * Math.pow(atm.rho / RHO0, 0.8) * (1 - this.damage * 0.4)
      - (this.running ? 0 : 0.5 * atm.rho * V * V * 0.4);
    const flow = T > 0 ? T * E.tsfc : 0;
    const n1 = this.running ? 22 + frac * 78 : Math.max(0, this.rpm - dt * 12);
    return { thrust: T, rpm: n1, flow };
  }

  /* ---------------- ground contact ---------------- */

  groundStep(dt, F, Mw, opts) {
    const cfg = this.cfg;
    let grounded = false;
    let totalN = 0;
    let maxSink = 0;

    const gearOut = this.gearPos;
    const steerIn = this.input.rudder;
    const brakeCmd = Math.max(this.input.brake, this.input.parkBrake ? 1 : 0);

    for (const c of this._contacts) {
      c.lastCompression = c.compression;
      c.compression = 0;
      c.grounded = false;
      if (cfg.gear.retractable && gearOut < 0.98) continue;

      const rw = _g1.copy(c.local).applyQuaternion(this.quat);
      const wx = this.pos.x + rw.x, wy = this.pos.y + rw.y, wz = this.pos.z + rw.z;
      const gh = this.terrain.heightAt(wx, wz);
      const pen = gh + c.radius - wy;
      if (pen <= 0) continue;

      grounded = true;
      c.grounded = true;
      c.compression = pen;

      // Contact-point velocity = v + omega x r
      const cv = _g2.crossVectors(this.omega, rw).add(this.vel);
      const vDown = -cv.y;

      let N = c.k * pen + c.c * Math.max(vDown, -3);
      if (N < 0) N = 0;
      // Strut bottoming
      if (pen > 0.35) N += (pen - 0.35) * c.k * 6;
      totalN += N;
      maxSink = Math.max(maxSink, vDown);

      // Surface friction basis: heading projected onto the ground plane.
      const roll = _g3.set(this.fwd.x, 0, this.fwd.z);
      if (roll.lengthSq() < 1e-6) roll.set(0, 0, -1);
      roll.normalize();
      if (c.steer > 0) {
        const ang = steerIn * c.steer * 0.55 * clamp(1 - this.groundSpeed / 45, 0.12, 1);
        const cs = Math.cos(ang), sn = Math.sin(ang);
        roll.set(roll.x * cs + roll.z * sn, 0, -roll.x * sn + roll.z * cs);
      }
      const side = _g4.set(-roll.z, 0, roll.x);

      const vRoll = cv.x * roll.x + cv.z * roll.z;
      const vSide = cv.x * side.x + cv.z * side.z;

      const surf = this.terrain.surfaceAt(wx, wz); // { rollMu, gripMu, rough }
      const muRoll = surf.rollMu + brakeCmd * (c.brake ? 0.62 : 0.04) * (1 - this.damage * 0.3);
      const fRoll = -Math.sign(vRoll) * Math.min(muRoll * N, Math.abs(vRoll) * cfg.mass * 6);
      const muSide = surf.gripMu;
      const fSide = -Math.sign(vSide) * Math.min(muSide * N, Math.abs(vSide) * cfg.mass * 9);

      const fx = roll.x * fRoll + side.x * fSide;
      const fz = roll.z * fRoll + side.z * fSide;

      F.x += fx; F.y += N; F.z += fz;
      const fv = _g5.set(fx, N, fz);
      const tq = _g6.crossVectors(rw, fv);
      Mw.add(tq);

      // Runway/grass rumble.
      if (surf.rough > 0 && Math.abs(vRoll) > 1) {
        const j = (Math.sin(wx * 3.1 + wz * 2.7) + Math.sin(wx * 8.3 - wz * 5.1)) * 0.5;
        F.y += j * surf.rough * N * 0.05;
      }
    }

    this.gearLoad = totalN;
    if (grounded && !this.wow) {
      this.touchdownVS = -this._prevVel.y;
      this.justTouched = true;
    }
    this.wow = grounded;

    if (grounded && opts.damageOn !== false) {
      const limitG = cfg.mass * G0 * 9;
      if (totalN > limitG || maxSink > 5.2) this.fail('GEAR COLLAPSE — HARD LANDING');
    }
    return { grounded, sink: maxSink, load: totalN };
  }

  /** Any non-gear part of the airframe touching terrain ends the flight. */
  checkStrike() {
    if (this.crashed) return;
    for (const s of this._strike) {
      const rw = _v1.copy(s).applyQuaternion(this.quat);
      const wy = this.pos.y + rw.y;
      const gh = this.terrain.heightAt(this.pos.x + rw.x, this.pos.z + rw.z);
      if (wy < gh) {
        this.fail(this.tas > 12 ? 'TERRAIN IMPACT' : 'PROP / WINGTIP STRIKE');
        return;
      }
    }
  }

  /* ---------------- helpers ---------------- */

  stallSpeed(bankRad = 0, flap = null) {
    const A = this.cfg.aero;
    const f = flap === null ? this.flapPos : flap;
    const CLmax = A.CL0 + A.CLa * (A.alphaStall - f * 2 * DEG) + A.CLdf * f;
    const n = 1 / Math.max(0.15, Math.cos(bankRad));
    return Math.sqrt((2 * this.cfg.mass * G0 * n) / (RHO0 * this.cfg.S * Math.max(0.4, CLmax)));
  }

  cycleFlaps(dir) {
    const n = this.cfg.flapDetents.length;
    if (n <= 1) return false;
    const next = clamp(this.flapIdx + dir, 0, n - 1);
    if (next === this.flapIdx) return false;
    this.flapIdx = next;
    return true;
  }

  toggleGear() {
    if (!this.cfg.gear.retractable) return false;
    this.gearCmd = this.gearCmd > 0.5 ? 0 : 1;
    return true;
  }
}
