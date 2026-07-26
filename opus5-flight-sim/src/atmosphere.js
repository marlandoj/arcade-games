/**
 * ISA standard atmosphere + boundary-layer wind + Dryden-flavoured turbulence.
 *
 * Everything is SI. Altitudes are geometric metres above mean sea level.
 */

export const G0 = 9.80665;        // m/s^2
export const R_AIR = 287.05287;   // J/(kg K)
export const GAMMA = 1.4;
export const T0 = 288.15;         // K
export const P0 = 101325;         // Pa
export const RHO0 = 1.225;        // kg/m^3
export const LAPSE = 0.0065;      // K/m (troposphere)
export const TROPOPAUSE = 11000;  // m

const T_TROP = T0 - LAPSE * TROPOPAUSE;                 // 216.65 K
const P_TROP = P0 * Math.pow(T_TROP / T0, G0 / (LAPSE * R_AIR));

/** International Standard Atmosphere up to ~20 km. */
export function isa(alt) {
  let T, p;
  if (alt <= TROPOPAUSE) {
    T = T0 - LAPSE * alt;
    p = P0 * Math.pow(T / T0, G0 / (LAPSE * R_AIR));
  } else {
    T = T_TROP;
    p = P_TROP * Math.exp((-G0 * (alt - TROPOPAUSE)) / (R_AIR * T_TROP));
  }
  const rho = p / (R_AIR * T);
  return { T, p, rho, a: Math.sqrt(GAMMA * R_AIR * T), sigma: rho / RHO0 };
}

/** Pressure altitude for a given altimeter (Kollsman) setting in inHg. */
export function pressureAltitude(altMSL, baroInHg) {
  const stdInHg = 29.9213;
  return altMSL + (stdInHg - baroInHg) * 304.8; // ~1000 ft per inHg
}

/** True airspeed -> indicated airspeed (calibrated, incompressible). */
export function tasToIas(tas, rho) {
  return tas * Math.sqrt(rho / RHO0);
}

/* ------------------------------------------------------------------ */
/* Wind                                                                */
/* ------------------------------------------------------------------ */

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Wind field: steady wind with a logarithmic surface boundary layer,
 * slow synoptic veer with altitude, low-frequency gusts, and a
 * first-order-lag turbulence model whose intensity scales with the
 * weather setting and inversely with altitude.
 */
export class WindModel {
  /**
   * @param {object} opts
   * @param {number} opts.dirDeg  direction the wind is coming FROM (deg true)
   * @param {number} opts.speed   surface wind speed (m/s) at 10 m
   * @param {number} opts.gust    gust amplitude (m/s)
   * @param {number} opts.turbulence 0..1 severity
   */
  constructor(opts = {}) {
    this.set(opts);
    this.t = 0;
    this.turb = [0, 0, 0];
    this.turbRate = [0, 0, 0];
    this.seed = 1337;
  }

  set({ dirDeg = 250, speed = 4, gust = 2, turbulence = 0.25 } = {}) {
    this.dirDeg = dirDeg;
    this.speed = speed;
    this.gust = gust;
    this.turbulence = turbulence;
  }

  /**
   * Steady + gust wind vector in world coordinates (X east, Y up, Z south).
   * Returns the velocity of the air mass, i.e. wind blowing TOWARD that vector.
   */
  steadyAt(alt, out) {
    // Log-law boundary layer, z0 = 0.15 m (open country), reference 10 m.
    const z = Math.max(alt, 0.5);
    const z0 = 0.15;
    let prof = Math.log(z / z0) / Math.log(10 / z0);
    prof = Math.max(0.15, Math.min(prof, 1.0));
    // Above ~600 m the gradient wind is stronger and veers right (N. hemisphere).
    const hi = Math.min(1, Math.max(0, (alt - 300) / 1500));
    const mag = this.speed * (prof + hi * 0.9);
    const veer = hi * 22; // degrees
    const dir = ((this.dirDeg + veer) * Math.PI) / 180;

    // Gusts: two incommensurate sinusoids + a slow ramp.
    const gustMag =
      this.gust *
      (0.6 * Math.sin(this.t * 0.31 + 1.1) +
        0.3 * Math.sin(this.t * 0.87 + 2.4) +
        0.25 * Math.sin(this.t * 0.13));
    const total = Math.max(0, mag + gustMag * prof);

    // "From" direction -> air-mass velocity vector. 0 deg = from north.
    // North is -Z, east is +X.
    out.x = -total * Math.sin(dir);
    out.z = total * Math.cos(dir);
    out.y = 0;
    return out;
  }

  /** Advance turbulence state. dt in seconds, alt in metres, tas in m/s. */
  update(dt, alt, tas) {
    this.t += dt;
    const sev = this.turbulence;
    if (sev <= 0) {
      this.turb[0] = this.turb[1] = this.turb[2] = 0;
      return;
    }
    // Intensity: strongest in the low-level convective layer, thermals
    // die out above ~2500 m, and it scales with airspeed (gust -> load).
    const lowLevel = Math.exp(-Math.max(0, alt) / 1400);
    const sigma = sev * (1.4 + 3.2 * lowLevel) * (0.5 + Math.min(tas, 90) / 90);
    // Band-limited noise: second-order lag driven by white noise.
    const wn = 1.9; // rad/s corner
    for (let i = 0; i < 3; i++) {
      this.seed = (this.seed * 1664525 + 1013904223) & 0x7fffffff;
      const white = (hash(this.seed * 0.0001 + i * 7.7) - 0.5) * 2;
      const acc = wn * wn * (white * sigma - this.turb[i]) - 2 * 0.7 * wn * this.turbRate[i];
      this.turbRate[i] += acc * dt;
      this.turb[i] += this.turbRate[i] * dt;
    }
  }

  /** Full wind vector including turbulence, written into `out`. */
  sample(alt, out) {
    this.steadyAt(alt, out);
    const g = Math.min(1, Math.max(0, alt / 30)); // turbulence fades on the ground
    out.x += this.turb[0] * g;
    out.y += this.turb[1] * 0.65 * g;
    out.z += this.turb[2] * g;
    return out;
  }

  /** Headwind/crosswind components for a runway heading (deg true). */
  runwayComponents(rwyHeadingDeg) {
    const d = ((this.dirDeg - rwyHeadingDeg) * Math.PI) / 180;
    return {
      head: this.speed * Math.cos(d),
      cross: this.speed * Math.sin(d), // + = from the right
    };
  }
}

export const WEATHER_PRESETS = {
  calm: { label: 'CALM', dirDeg: 250, speed: 1.5, gust: 0.5, turbulence: 0.06, cloudBase: 2400, overcast: 0.15, visibility: 45000 },
  breezy: { label: 'BREEZY', dirDeg: 245, speed: 6, gust: 2.5, turbulence: 0.28, cloudBase: 1500, overcast: 0.4, visibility: 30000 },
  gusty: { label: 'GUSTY', dirDeg: 300, speed: 10, gust: 5, turbulence: 0.55, cloudBase: 1100, overcast: 0.6, visibility: 18000 },
  storm: { label: 'STORM FRONT', dirDeg: 160, speed: 15, gust: 8, turbulence: 0.9, cloudBase: 600, overcast: 0.92, visibility: 7000 },
};
