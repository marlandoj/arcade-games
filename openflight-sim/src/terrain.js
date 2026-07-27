/**
 * OpenFlight Sim — Terrain field & airfield math (OFS-003).
 *
 * Pure, deterministic, and THREE-free so the flight model, missions, and the
 * focused test can all query the *same* surface the player sees without pulling
 * in a WebGL renderer. `world.js` builds the visible mesh from `heightAt`;
 * `flight-model.setGroundElevation()` is fed from `heightAt`; both therefore
 * agree on ground contact and collision.
 *
 * The generator is a seeded fractal value-noise field (fBm). Given the same
 * seed it produces byte-identical elevation everywhere — no Math.random, no
 * time, no global state. The airfield footprint is smoothly flattened to the
 * runway elevation so the runway, taxiway, and approach corridor stay level.
 */

// ── Integer hash → [0,1) lattice value (deterministic, seed-mixed) ───────────
function hashInt(x) {
  x = x >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}
function lattice(ix, iz, seed) {
  const h = hashInt(hashInt(ix) ^ Math.imul(hashInt(iz), 0x9e3779b1) ^ hashInt(seed));
  return h / 4294967296; // [0,1)
}
function smootherstep(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

// Bilinear-interpolated value noise on the integer lattice, in [0,1].
function valueNoise(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = smootherstep(x - x0), fz = smootherstep(z - z0);
  const v00 = lattice(x0, z0, seed);
  const v10 = lattice(x0 + 1, z0, seed);
  const v01 = lattice(x0, z0 + 1, seed);
  const v11 = lattice(x0 + 1, z0 + 1, seed);
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fz;
}

// Distance from a point to the runway centre segment in the ground plane, used
// to decide how much of the airfield footprint to flatten. The segment is
// extended `approach` metres off the threshold so the final-approach corridor is
// levelled with the runway, not just the pavement: the landing mission joins a
// 3° glidepath ~1.8 km out, which is only ~94 m above the datum, and an
// unflattened fBm ridge inside that corridor reaches ~107 m — terrain *above*
// the published glidepath, i.e. an approach that cannot be flown.
function distToRunway(x, z, rw, approach = 0) {
  // Segment runs along +z from the approach fix, through the threshold, to the
  // far end, all at x = rw.threshold.x.
  const z0 = rw.threshold.z - approach;
  const z1 = rw.threshold.z + rw.length;
  const cz = Math.max(z0, Math.min(z1, z));
  return Math.hypot(x - rw.threshold.x, z - cz);
}

/**
 * createTerrain(options) → seeded heightfield handle.
 *   heightAt(x, z)  world-metre elevation (y), stable for a given seed.
 *   sampleColor(h)  [r,g,b] in 0..1 for a given elevation (used by the mesh).
 */
export function createTerrain(options = {}) {
  const seed = (options.seed ?? 1337) >>> 0;
  const amplitude = options.amplitude ?? 320;     // peak-to-valley scale (m)
  const baseCell = options.cellSize ?? 1400;      // metres per lowest octave cell
  const octaves = options.octaves ?? 5;
  const lacunarity = options.lacunarity ?? 2.0;
  const gain = options.gain ?? 0.5;
  const runway = options.runway;
  const flatRadius = options.flatRadius ?? 520;   // fully level out to here
  const blendRadius = options.blendRadius ?? 2100; // ease to full terrain by here
  const approach = options.approach ?? 2000;      // corridor levelled off the threshold

  // fBm in [0,1], seed-mixed per octave so octaves are decorrelated.
  function fbm(x, z) {
    let freq = 1 / baseCell, amp = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * valueNoise(x * freq, z * freq, (seed + o * 1013904223) >>> 0);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  function rawHeight(x, z) {
    const n = fbm(x, z);
    // Ridged emphasis: square the field so valleys are broad and peaks sharper,
    // then bias so a good fraction of the map sits near the airfield datum.
    const ridged = n * n;
    return (ridged - 0.18) * amplitude;
  }

  function airfieldBlend(x, z) {
    if (!runway) return 1;
    const d = distToRunway(x, z, runway, approach);
    if (d <= flatRadius) return 0;             // fully flat
    if (d >= blendRadius) return 1;            // full terrain
    return smootherstep((d - flatRadius) / (blendRadius - flatRadius));
  }

  function heightAt(x, z) {
    const datum = runway ? runway.elevation || 0 : 0;
    const blend = airfieldBlend(x, z);
    if (blend <= 0) return datum;
    return datum + rawHeight(x, z) * blend;
  }

  return {
    seed,
    amplitude,
    approach,
    heightAt,
    airfieldBlend,
    // Elevation-banded colour ramp (grass → scrub → rock → snow).
    sampleColor(h) {
      const t = Math.max(0, Math.min(1, (h + 40) / (amplitude * 0.9)));
      if (t < 0.32) return lerp3([0.24, 0.42, 0.20], [0.30, 0.46, 0.22], t / 0.32);
      if (t < 0.60) return lerp3([0.30, 0.46, 0.22], [0.42, 0.38, 0.24], (t - 0.32) / 0.28);
      if (t < 0.82) return lerp3([0.42, 0.38, 0.24], [0.46, 0.44, 0.42], (t - 0.60) / 0.22);
      return lerp3([0.46, 0.44, 0.42], [0.92, 0.94, 0.98], (t - 0.82) / 0.18);
    },
  };
}

function lerp3(a, b, t) {
  t = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ── PAPI (Precision Approach Path Indicator) ─────────────────────────────────
// Four light units abeam the touchdown zone. Each shows white when the aircraft
// is above that unit's set angle, red when below. Standard 3.0° glidepath:
// 2 white + 2 red = on slope; more white = high; more red = low.
export const PAPI_GLIDEPATH_DEG = 3.0;
export const PAPI_LIGHT_ANGLES_DEG = Object.freeze([2.5, 2.83, 3.17, 3.5]);

/**
 * papiIndication(aircraft, papiPos) → { angleDeg, colors[4], whites, onSlope }.
 * `colors` is ordered outer→inner (index 0 = 2.5°, the first to turn white).
 */
export function papiIndication(aircraft, papiPos) {
  const dx = aircraft.x - papiPos.x;
  const dz = aircraft.z - papiPos.z;
  const horiz = Math.max(1, Math.hypot(dx, dz));
  const angleDeg = Math.atan2(aircraft.y - papiPos.y, horiz) * (180 / Math.PI);
  const colors = PAPI_LIGHT_ANGLES_DEG.map((a) => (angleDeg >= a ? "white" : "red"));
  const whites = colors.reduce((n, c) => n + (c === "white" ? 1 : 0), 0);
  return { angleDeg, colors, whites, onSlope: whites === 2 };
}

export const __OFS_BOUNDARY__ = "terrain";
