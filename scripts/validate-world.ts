#!/usr/bin/env bun
/**
 * OpenFlight Sim — world/terrain focused test (OFS-003).
 *
 * Pure + offline. Exercises the THREE-free terrain field and PAPI math directly,
 * plus the terrain↔flight-model coupling (the flight model rests the aircraft on
 * the *queried* surface). The mesh/scene acceptance criteria — runway markings,
 * approach lighting, sky dome, animated aircraft — are geometry built on top of
 * these primitives and are verified by the headless browser reachability check.
 *
 * Asserts the T3 acceptance criteria that are testable without a GL context:
 *   1. Procedural terrain with real elevation variation from a stable, seeded
 *      generator (deterministic; seed changes the surface).
 *   2. The airfield footprint is flattened to the runway datum; terrain varies
 *      away from it.
 *   3. Terrain height is queryable and is the same surface the flight model uses
 *      for ground contact (aircraft rests on raised terrain, not a flat y=0).
 *   4. PAPI indication tracks the glidepath: 2 white/2 red on slope, more white
 *      when high, more red when low, monotonic in approach angle.
 *
 * Exit 0 on pass, 1 on any failure.
 */

import { createTerrain, papiIndication, PAPI_GLIDEPATH_DEG } from "../openflight-sim/src/terrain.js";
import { createFlightModel } from "../openflight-sim/src/flight-model.js";
import { atmosphere } from "../openflight-sim/src/atmosphere.js";

const RUNWAY = { threshold: { x: 0, z: 0 }, heading: 0, length: 1500, width: 30, elevation: 0 };
const FIXED_DT = 1 / 120;
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`  ✗ ${msg}`); failures++; }
  else console.log(`  ✓ ${msg}`);
}

// ── 1. Seeded, deterministic, varied terrain ────────────────────────────────
console.log("[1] Seeded procedural terrain");
{
  const a = createTerrain({ seed: 20260726, runway: RUNWAY });
  const b = createTerrain({ seed: 20260726, runway: RUNWAY });
  const c = createTerrain({ seed: 99, runway: RUNWAY });

  let identical = true, differsFromOtherSeed = false;
  let min = Infinity, max = -Infinity, finite = true;
  for (let x = -6000; x <= 6000; x += 250) {
    for (let z = -6000; z <= 6000; z += 250) {
      const ha = a.heightAt(x, z);
      const hb = b.heightAt(x, z);
      const hc = c.heightAt(x, z);
      if (ha !== hb) identical = false;
      if (Math.abs(ha - hc) > 1) differsFromOtherSeed = true;
      if (!Number.isFinite(ha)) finite = false;
      min = Math.min(min, ha); max = Math.max(max, ha);
    }
  }
  assert(identical, "same seed → byte-identical elevation everywhere (deterministic)");
  assert(differsFromOtherSeed, "different seed → a different surface");
  assert(finite, "every sampled elevation is finite");
  assert(max - min > 150, `real elevation variation across the map (range ${(max - min).toFixed(0)} m)`);
}

// ── 2. Airfield flattened, terrain varies away from it ──────────────────────
console.log("\n[2] Airfield flattening");
{
  const t = createTerrain({ seed: 20260726, runway: RUNWAY });
  // On the runway centreline and in the approach corridor → datum.
  const onRunway = [0, 200, 750, 1400].every((z) => Math.abs(t.heightAt(0, z) - RUNWAY.elevation) < 0.001);
  const approach = Math.abs(t.heightAt(0, -200)) < 0.001;
  assert(onRunway, "runway surface is flat at the datum along its length");
  assert(approach, "approach corridor at the threshold is flat");
  // Far from the airfield the surface departs from the datum somewhere.
  let variesAway = false;
  for (let x = -5000; x <= 5000; x += 300) if (Math.abs(t.heightAt(x, 4000)) > 5) variesAway = true;
  assert(variesAway, "terrain departs from the datum away from the airfield");
  // Blend is monotone-ish: flat at centre, full terrain far out.
  assert(t.airfieldBlend(0, 750) === 0 && t.airfieldBlend(0, 6000) === 1, "flatten blend is 0 at field, 1 far away");
}

// ── 3. Terrain queried by the flight model (shared surface) ─────────────────
console.log("\n[3] Terrain height feeds flight-model ground contact");
{
  const t = createTerrain({ seed: 20260726, runway: RUNWAY });
  // Pick a point on raised terrain and confirm the query is non-trivial.
  const gx = 3000, gz = 4000;
  const groundH = t.heightAt(gx, gz);
  assert(Number.isFinite(groundH), `queried terrain height at a hillside is finite (${groundH.toFixed(1)} m)`);

  // Drop the trainer at that ground elevation and let the gear settle; it must
  // rest ABOVE the raised terrain, not fall through to y=0.
  const model = createFlightModel("trainer");
  model.setGroundElevation(groundH);
  const sim: any = {
    t: 0, dt: FIXED_DT,
    pos: { x: gx, y: groundH + 3, z: gz, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } },
    prevPos: { x: gx, y: groundH + 3, z: gz },
    vel: { x: 0, y: 0, z: 0, length() { return Math.hypot(this.x, this.y, this.z); }, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    airspeed: 0, altitude: groundH + 3,
  };
  const env = atmosphere(groundH);
  const controls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brakes: 1, flaps: 0, gear: 1 };
  for (let i = 0; i < 6 / FIXED_DT; i++) {
    model.setGroundElevation(groundH);
    model.step(FIXED_DT, sim, env, controls);
    sim.airspeed = sim.vel.length();
    sim.altitude = sim.pos.y;
    sim.t += FIXED_DT;
    if (!Number.isFinite(sim.pos.y)) break;
  }
  assert(Number.isFinite(sim.pos.y), "aircraft on raised terrain stays finite");
  assert(sim.pos.y > groundH + 0.2, `aircraft rests on the raised terrain surface (y ${sim.pos.y.toFixed(2)} m > ground ${groundH.toFixed(2)} m)`);
  assert(sim.pos.y < groundH + 3.5, "aircraft does not float far above the surface");
}

// ── 4. PAPI tracks the glidepath ────────────────────────────────────────────
console.log("\n[4] PAPI glidepath indication");
{
  const papi = { x: -27, y: 0, z: 300 };
  // Build an aircraft position at a given approach angle south of the PAPI.
  const at = (angleDeg: number) => {
    const horiz = 1500;
    const y = papi.y + Math.tan((angleDeg * Math.PI) / 180) * horiz;
    return { x: papi.x, y, z: papi.z - horiz };
  };
  const onSlope = papiIndication(at(PAPI_GLIDEPATH_DEG), papi);
  const high = papiIndication(at(4.2), papi);
  const low = papiIndication(at(1.8), papi);
  const veryLow = papiIndication(at(0.5), papi);
  const veryHigh = papiIndication(at(6.0), papi);

  assert(onSlope.whites === 2, `on the ${PAPI_GLIDEPATH_DEG}° glidepath shows 2 white / 2 red (whites=${onSlope.whites})`);
  assert(onSlope.onSlope, "on-slope flag set when 2 white / 2 red");
  assert(high.whites > 2, `high approach shows more white (whites=${high.whites})`);
  assert(low.whites < 2, `low approach shows more red (whites=${low.whites})`);
  assert(veryHigh.whites === 4, "far above glidepath → all white");
  assert(veryLow.whites === 0, "far below glidepath → all red");
  // Monotonic in angle: whites never decrease as the approach angle increases.
  let monotone = true, prev = -1;
  for (let ang = 0; ang <= 6; ang += 0.25) {
    const w = papiIndication(at(ang), papi).whites;
    if (w < prev) monotone = false;
    prev = w;
  }
  assert(monotone, "white-light count is monotone non-decreasing with approach angle");
}

console.log(failures === 0 ? "\n✅ world/terrain: ALL CHECKS PASSED" : `\n❌ world/terrain: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
