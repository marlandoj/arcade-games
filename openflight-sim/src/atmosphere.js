/**
 * OpenFlight Sim — Atmosphere (T1 boundary stub, OFS-002 fills).
 *
 * Contract: the orchestrator calls `atmosphere(altitudeM)` every fixed step
 * to obtain the local air state, and `sampleWind(altitudeM, preset, t)` for
 * the ambient wind vector used by the flight model and instruments. T2 will
 * replace the ISA constants and wind/turbulence model with the real
 * troposphere-to-tropopause implementation; the call sites here are frozen.
 */

export const ISA = Object.freeze({
  seaLevelTemperature: 288.15,
  seaLevelPressure: 101325,
  seaLevelDensity: 1.225,
  lapseRate: -0.0065,
  gasConstant: 287.05287,
  gamma: 1.4,
  tropopause: 11000,
});

export const WEATHER_PRESETS = Object.freeze({
  calm:        { id: "calm",        label: "Calm",        windN: 0,  windE: 0,  gustiness: 0,   turbulence: 0   },
  breezy:      { id: "breezy",      label: "Breezy",      windN: 5,  windE: 0,  gustiness: 1.5, turbulence: 0.1 },
  gusty:       { id: "gusty",       label: "Gusty",       windN: 8,  windE: 3,  gustiness: 4,   turbulence: 0.3 },
  turbulent:   { id: "turbulent",   label: "Turbulent",   windN: 6,  windE: 6,  gustiness: 5,   turbulence: 0.8 },
});

/**
 * International Standard Atmosphere sample at a given geometric altitude.
 * Returns temperature (K), pressure (Pa), density (kg/m^3), speed of sound
 * (m/s), and dynamic viscosity (Pa·s). Troposphere lapse below 11 km; the
 * isothermal stratosphere relation above (ZOU-920 remediation #12). T2 will
 * add the density-altitude correction; the call sites here are frozen.
 */
export function atmosphere(altitudeM) {
  const h = Math.max(0, altitudeM || 0);
  const g = 9.80665;
  const R = ISA.gasConstant;
  const lapseMagnitude = -ISA.lapseRate; // 0.0065 K/m
  const exponent = g / (R * lapseMagnitude); // ~5.25588
  let T, p;
  if (h < ISA.tropopause) {
    T = ISA.seaLevelTemperature + ISA.lapseRate * h;
    p = ISA.seaLevelPressure * Math.pow(T / ISA.seaLevelTemperature, exponent);
  } else {
    // Above the tropopause temperature is constant (isothermal); pressure
    // decays exponentially from the tropopause value, not the troposphere power law.
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

/** Density altitude in meters for a given OAT deviation. Stub passes through. */
export function densityAltitude(altitudeM, oatDeviationK = 0) {
  return Math.max(0, (altitudeM || 0) + (oatDeviationK || 0) * 120);
}

/**
 * Wind vector at altitude for a weather preset at sim time t.
 * Returns { windN, windE, gust } in m/s (north/east components, gust is the
 * instantaneous turbulent magnitude increment). Stub returns a steady breeze
 * with a small sinusoidal gust; T2 adds discrete gusts + continuous turbulence.
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

export const __OFS_BOUNDARY__ = "atmosphere";
