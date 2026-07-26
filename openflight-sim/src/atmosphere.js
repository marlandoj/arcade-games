/**
 * OpenFlight Sim — Atmosphere (OFS-002).
 *
 * Contract (frozen by T1): the orchestrator calls `atmosphere(altitudeM)` every
 * fixed step to obtain the local air state, and `sampleWind(altitudeM, preset,
 * t)` for the ambient wind vector. OFS-002 fills the ISA density-altitude
 * correction and adds a stateful wind model (`createWindModel`) with steady
 * wind, discrete 1-cos gusts, and continuous Dryden turbulence. The call sites
 * are frozen; new exports are additive.
 */

export const ISA = Object.freeze({
  seaLevelTemperature: 288.15,   // K
  seaLevelPressure: 101325,      // Pa
  seaLevelDensity: 1.225,        // kg/m^3
  lapseRate: -0.0065,            // K/m (troposphere)
  gasConstant: 287.05287,        // J/(kg·K) for dry air
  gamma: 1.4,
  tropopause: 11000,             // m
  g: 9.80665,                    // m/s^2
});

export const WEATHER_PRESETS = Object.freeze({
  calm:      { id: "calm",      label: "Calm",      windN: 0,  windE: 0,  gustiness: 0,   turbulence: 0   },
  breezy:    { id: "breezy",    label: "Breezy",    windN: 5,  windE: 0,  gustiness: 1.5, turbulence: 0.2 },
  gusty:     { id: "gusty",     label: "Gusty",     windN: 8,  windE: 3,  gustiness: 4,   turbulence: 0.4 },
  turbulent: { id: "turbulent", label: "Turbulent", windN: 6,  windE: 6,  gustiness: 5,   turbulence: 0.9 },
});

/**
 * International Standard Atmosphere sample at a given geometric altitude.
 * Returns temperature (K), pressure (Pa), density (kg/m^3), density ratio,
 * speed of sound (m/s), and dynamic viscosity (Pa·s). Troposphere lapse below
 * 11 km; isothermal stratosphere above the tropopause (pressure decays
 * exponentially from the tropopause value).
 */
export function atmosphere(altitudeM) {
  const h = Math.max(0, altitudeM || 0);
  const g = ISA.g;
  const R = ISA.gasConstant;
  const lapseMagnitude = -ISA.lapseRate;          // 0.0065 K/m
  const exponent = g / (R * lapseMagnitude);     // ~5.25588
  let T, p;
  if (h < ISA.tropopause) {
    T = ISA.seaLevelTemperature + ISA.lapseRate * h;
    p = ISA.seaLevelPressure * Math.pow(T / ISA.seaLevelTemperature, exponent);
  } else {
    T = ISA.seaLevelTemperature + ISA.lapseRate * ISA.tropopause;
    const pTrop = ISA.seaLevelPressure * Math.pow(T / ISA.seaLevelTemperature, exponent);
    p = pTrop * Math.exp(-g * (h - ISA.tropopause) / (R * T));
  }
  const rho = p / (R * T);
  const a = Math.sqrt(ISA.gamma * R * T);
  const mu = 1.716e-5 * Math.pow(T / 273.15, 0.75);
  return Object.freeze({
    altitude: h,
    temperature: T,
    pressure: p,
    density: rho,
    densityRatio: rho / ISA.seaLevelDensity,
    speedOfSound: a,
    viscosity: mu,
  });
}

/**
 * Density altitude in meters from ambient pressure and temperature deviation
 * (OFS-002). Uses the ISA pressure-altitude relation inverted for the
 * troposphere: the altitude at which ISA would produce the current pressure.
 */
export function densityAltitude(altitudeM, oatDeviationK = 0) {
  const h = Math.max(0, altitudeM || 0);
  if (h >= ISA.tropopause) return h + (oatDeviationK || 0) * 120;
  const T0 = ISA.seaLevelTemperature;
  const lapseMagnitude = -ISA.lapseRate;
  const exponent = ISA.g / (ISA.gasConstant * lapseMagnitude);
  const T = T0 + ISA.lapseRate * h + (oatDeviationK || 0);
  // Temperature-ratio form of the pressure relation; solve for density altitude.
  const sigma = Math.pow(T / T0, exponent) * (1 / (1 + (oatDeviationK || 0) / (T0 + ISA.lapseRate * h)));
  const hDens = (ISA.gasConstant * T0 / ISA.g) * (Math.pow(1 / sigma, ISA.gasConstant * lapseMagnitude / ISA.g) - 1) / lapseMagnitude;
  return Number.isFinite(hDens) ? Math.max(0, hDens) : h + (oatDeviationK || 0) * 120;
}

/**
 * Wind vector at altitude for a weather preset at sim time t.
 * Returns { windN, windE, gust, turbulence } in m/s (north/east components,
 * gust is the instantaneous turbulent magnitude increment). This pure helper
 * is kept for the T1 boundary; the full stateful wind model (steady + discrete
 * gust + Dryden turbulence) is `createWindModel`.
 */
export function sampleWind(altitudeM, preset = WEATHER_PRESETS.calm, t = 0) {
  const p = preset || WEATHER_PRESETS.calm;
  const shear = Math.min(1, Math.max(0, (altitudeM || 0) / 10));
  const gust = p.gustiness * Math.sin(t * 0.7) * shear;
  return Object.freeze({
    windN: p.windN * (0.4 + 0.6 * shear),
    windE: p.windE * (0.4 + 0.6 * shear),
    gust,
    turbulence: p.turbulence,
  });
}

// ── Deterministic RNG (LCG) so wind is reproducible per preset ───────────────
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function rng() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function gaussian(rng) {
  // Box–Muller transform → standard normal from two uniforms.
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Stateful wind model: steady wind + discrete 1-cos gusts + continuous Dryden
 * turbulence. `sample(dt, alt, airspeed, t)` returns the total wind vector in
 * world axes { windN, windE, windU } (north, east, up) plus diagnostic magnitudes.
 * `airspeed` shapes the Dryden filter cutoffs and is clamped internally.
 */
export function createWindModel(preset = WEATHER_PRESETS.calm) {
  const p = preset || WEATHER_PRESETS.calm;
  const rng = makeRng(hashStr(p.id || "calm") + 0x9e3779b9);

  // First-order Gauss–Markov approximation of the Dryden spectra. State per axis
  // holds the previous filtered output; coefficients are recomputed each sample
  // from the current airspeed so the cutoff tracks how fast the aircraft crosses
  // the turbulence scale length.
  const turb = { u: 0, v: 0, w: 0 };
  // Base intensities scale with the preset's turbulence knob; sigma in m/s.
  const SIGMA_BASE = 2.5;
  // Dryden scale lengths (m): longitudinal differs from lateral/vertical.
  const LU = 530.0;   // longitudinal scale
  const LW = 180.0;   // lateral/vertical scale

  // Discrete 1-cos gust scheduler.
  let nextGustAt = 4 + rng() * 6;          // first gust after a few seconds
  let now = 0;
  let gust = { active: false, t: 0, len: 1.0, amp: 0, dirN: 1, dirE: 0, dirU: 0 };

  function stepGust(dt) {
    now += dt;
    if (!gust.active) {
      if (now >= nextGustAt && p.gustiness > 0.01) {
        const len = 1.0 + rng() * 2.0;     // 1–3 s gust
        const amp = p.gustiness * (0.6 + 0.8 * rng());
        // Random horizontal direction, small upward component.
        const ang = rng() * 2 * Math.PI;
        const up = 0.15 * amp * (rng() - 0.5);
        gust = { active: true, t: 0, len, amp, dirN: Math.cos(ang), dirE: Math.sin(ang), dirU: up };
      }
      return { gN: 0, gE: 0, gU: 0 };
    }
    gust.t += dt;
    const phase = gust.t / gust.len;
    if (phase >= 1) {
      gust.active = false;
      nextGustAt = now + 3 + rng() * 7;
      return { gN: 0, gE: 0, gU: 0 };
    }
    // 1-cos shape: 0.5*(1 - cos(2π φ)), zero at the ends, +amp in the middle.
    const shape = 0.5 * (1 - Math.cos(2 * Math.PI * phase));
    return {
      gN: gust.amp * gust.dirN * shape,
      gE: gust.amp * gust.dirE * shape,
      gU: gust.amp * gust.dirU * shape,
    };
  }

  function drydenAxis(prev, sigma, L, V, dt) {
    const Veff = Math.max(1.0, V);
    const phi = Math.exp(-Veff * dt / L);
    const psi = sigma * Math.sqrt(Math.max(0, 1 - phi * phi));
    return prev * phi + psi * gaussian(rng);
  }

  return {
    preset: p,

    sample(dt, alt, airspeed, t) {
      const h = Math.max(0, alt || 0);
      const V = Math.max(0, airspeed || 0);
      // Wind shear: surface friction reduces low-altitude wind to ~40% then
      // eases to full above 10 m AGL.
      const shear = Math.min(1, Math.max(0, h / 10));

      const g = stepGust(dt);

      // Continuous turbulence, scaled by preset.turbulence and altitude (lighter
      // near the surface following the Dryden low-altitude intensity profile).
      const altFactor = Math.min(1, 0.3 + 0.7 * Math.min(1, h / 300));
      const sigma = SIGMA_BASE * p.turbulence * altFactor;
      const dtC = Math.min(dt, 1 / 30);
      turb.u = drydenAxis(turb.u, sigma, LU, V, dtC);
      turb.v = drydenAxis(turb.v, sigma, LW, V, dtC);
      turb.w = drydenAxis(turb.w, sigma, LW, V, dtC);

      return {
        windN: p.windN * (0.4 + 0.6 * shear) + g.gN + turb.u,
        windE: p.windE * (0.4 + 0.6 * shear) + g.gE + turb.v,
        windU: g.gU + turb.w,
        gustMag: Math.hypot(g.gN, g.gE, g.gU),
        turbulence: p.turbulence,
      };
    },

    reset() {
      turb.u = turb.v = turb.w = 0;
      now = 0;
      nextGustAt = 4 + rng() * 6;
      gust = { active: false, t: 0, len: 1.0, amp: 0, dirN: 1, dirE: 0, dirU: 0 };
    },
  };
}

export const __OFS_BOUNDARY__ = "atmosphere";
