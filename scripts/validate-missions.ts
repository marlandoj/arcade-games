#!/usr/bin/env bun
/**
 * OpenFlight Sim — missions / scoring / landing-grade focused test (OFS-005).
 *
 * Pure + offline. Exercises the mission layer directly on a duck-typed sim (no
 * THREE, no DOM) and asserts each T5 acceptance criterion:
 *   1. At least four missions, including a navigation course through gates and a
 *      graded landing approach.
 *   2. Landing grading reads touchdown vertical speed, centreline offset, and
 *      touchdown point relative to the threshold, and produces a per-attempt
 *      score (monotone in each metric; crashes and off-runway arrivals fail).
 *   3. Session scoring with a per-mission high score persisted in a Web-Storage
 *      style store, surviving across mission-runtime instances.
 *   4. No network calls of any kind (static scan of the module source).
 *
 * The DOM-bound halves — the mission banner, the 3D gate rings, and the debrief
 * screen — are plumbing built on these primitives and are covered by the
 * headless browser reachability check.
 *
 * Exit 0 on pass, 1 on any failure.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MISSIONS, createMissions, gradeLanding, gateCaptured, gateDistance, gateFacing, MAX_GATE_TILT, RUNWAY,
} from "../openflight-sim/src/missions.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`  ✗ ${msg}`); failures++; }
  else console.log(`  ✓ ${msg}`);
}

const FIXED_DT = 1 / 120;

// ── A Web-Storage-shaped store, backed by a Map (mirrors localStorage) ───────
function makeStore() {
  const mem = new Map<string, string>();
  return {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    _dump: () => Object.fromEntries(mem),
  };
}

// ── Duck-typed sim (only the fields the mission layer reads) ─────────────────
function makeSim(over: any = {}): any {
  return {
    pos: { x: 0, y: 300, z: -200 },
    vel: { x: 0, y: 0, z: 45 },
    verticalSpeed: 0,
    airspeed: 45,
    altitude: 300,
    heading: 0,
    onGround: false,
    ...over,
  };
}

// ── 1. Mission catalog: ≥4, incl. a gate course and a graded landing ─────────
console.log("[1] Mission catalog");
{
  assert(MISSIONS.length >= 4, `at least four missions (${MISSIONS.length})`);
  const gates = MISSIONS.find((m: any) => m.type === "gates");
  const landing = MISSIONS.find((m: any) => m.type === "landing");
  assert(!!gates && Array.isArray((gates as any).course) && (gates as any).course.length >= 4,
    `a navigation course through gates (${gates ? (gates as any).course.length : 0} gates)`);
  assert(!!landing, "a graded landing approach mission");
  assert(!!(landing as any).spawn, "the landing mission overrides the spawn onto an approach");
  const ids = new Set(MISSIONS.map((m: any) => m.id));
  assert(ids.size === MISSIONS.length, "mission ids are unique");
}

// ── 2a. Landing grade reads all three metrics (monotone, per-attempt) ────────
console.log("\n[2] Landing grading");
{
  const soft = gradeLanding({ sinkRate: 0.3, centrelineOffset: 0, touchdownPoint: 300, onRunway: true, airspeed: 40 });
  const firm = gradeLanding({ sinkRate: 2.0, centrelineOffset: 0, touchdownPoint: 300, onRunway: true, airspeed: 40 });
  const offset = gradeLanding({ sinkRate: 0.3, centrelineOffset: 10, touchdownPoint: 300, onRunway: true, airspeed: 40 });
  const short = gradeLanding({ sinkRate: 0.3, centrelineOffset: 0, touchdownPoint: -60, onRunway: false, airspeed: 40 });
  const long = gradeLanding({ sinkRate: 0.3, centrelineOffset: 0, touchdownPoint: 1200, onRunway: true, airspeed: 40 });
  const crash = gradeLanding({ sinkRate: 5.0, centrelineOffset: 0, touchdownPoint: 300, onRunway: true, airspeed: 40 });
  const off = gradeLanding({ sinkRate: 0.3, centrelineOffset: 0, touchdownPoint: 300, onRunway: false, airspeed: 40 });

  assert(soft.score === 100 && soft.grade === "S", `greased centred touchdown scores S/100 (${soft.score})`);
  assert(soft.score > firm.score, `softer sink rate scores higher (${soft.score} > ${firm.score})`);
  assert(soft.score > offset.score, `smaller centreline offset scores higher (${soft.score} > ${offset.score})`);
  assert(soft.score > short.score, `landing in the zone beats landing short (${soft.score} > ${short.score})`);
  assert(soft.score > long.score, `landing in the zone beats floating long (${soft.score} > ${long.score})`);
  assert(crash.crashed === true && crash.score <= 15, `a 5 m/s arrival is a crash, capped low (${crash.score})`);
  assert(off.onRunway === false && off.score <= 25, `an off-runway touchdown cannot pass (${off.score})`);
  assert(/fpm/.test(soft.summary), "summary reports the sink rate in fpm");

  // The three named metrics are echoed back on the grade for the debrief.
  assert(soft.sinkRate === 0.3 && soft.centrelineOffset === 0 && soft.touchdownPoint === 300,
    "grade echoes vertical speed, centreline offset and touchdown point");
}

// ── 2b. Landing run end-to-end through the mission runtime ───────────────────
console.log("\n[3] Landing mission runtime");
{
  const store = makeStore();
  const missions = createMissions({ storage: store });
  missions.start("landing");
  const sim = makeSim({ pos: { x: 0, y: 20, z: 100 }, onGround: false, verticalSpeed: -0.8 });

  // A few airborne, descending steps then first wheel contact in the zone.
  for (let i = 0; i < 5; i++) { sim.pos.z += 3; missions.update(FIXED_DT, sim); }
  assert(missions.remaining() === Infinity, "before touchdown the landing run is open-ended");

  sim.onGround = true; sim.verticalSpeed = -0.6; sim.pos.x = 1.5; sim.pos.z = 280; sim.airspeed = 38;
  missions.update(FIXED_DT, sim);
  assert(isFinite(missions.remaining()) && missions.remaining() <= 2.5, "touchdown starts the roll-out settle timer");

  for (let i = 0; i < 320; i++) missions.update(FIXED_DT, sim);
  assert(missions.remaining() === 0, "settle timer expires so the shell ends the run");

  const res = missions.end("complete", sim)!;
  assert(res.score > 0 && res.grade === "S", `a soft centred touchdown grades well (${res.grade}/${res.score})`);
  assert(res.stats.length === 3, "debrief carries three landing stats");
  const labels = res.stats.map((s: any) => s.label);
  assert(
    labels.includes("Sink rate") && labels.includes("Centreline") && labels.includes("Touchdown"),
    `stats name sink rate, centreline and touchdown point (${labels.join(", ")})`,
  );
}

// ── 4. Navigation course: gates captured in order, clean sweep grades high ───
console.log("\n[4] Navigation gate course");
{
  const missions = createMissions({ storage: makeStore() });
  const nav: any = missions.start("navcourse");
  const sim = makeSim();
  assert(missions.activeGateIndex() === 0, "the course starts on gate 0");

  for (const g of nav.course) {
    sim.pos = { x: g.x, y: g.y, z: g.z };
    missions.update(FIXED_DT, sim);
  }
  assert(missions.activeGateIndex() === nav.course.length, "all gates cleared in order");
  assert(missions.remaining() === 0, "a completed course ends the run");

  const res = missions.end("complete", sim)!;
  assert(res.score >= 90, `clean sweep grades top-tier (${res.score})`);
  const gatesStat = res.stats.find((s: any) => s.label === "Gates");
  assert(!!gatesStat && gatesStat.value === `${nav.course.length}/${nav.course.length}`,
    `debrief reports every gate cleared (${gatesStat ? gatesStat.value : "—"})`);

  // Gate helpers behave: inside the radius captures, outside does not.
  const g0 = nav.course[0];
  assert(gateCaptured(g0, { x: g0.x, y: g0.y, z: g0.z }), "a gate captures at its centre");
  assert(!gateCaptured(g0, { x: g0.x + g0.r + 50, y: g0.y, z: g0.z }), "a gate does not capture from far outside");
  assert(gateDistance(g0, { x: g0.x, y: g0.y, z: g0.z }) === 0, "gate distance is zero at the centre");
}

// ── 4b. Gate rings face the leg they are flown in on, never laid flat ────────
// Regression guard: the rings were built with a fixed `rotation.x = π/2`, which
// laid them horizontal and left the pilot approaching each one edge-on. Capture
// is a pure radius test, so scoring hid the fault — only the render was wrong.
console.log("\n[4b] Gate ring orientation");
{
  const nav: any = MISSIONS.find((m: any) => m.type === "gates");
  const course: any[] = nav.course;

  for (let i = 0; i < course.length; i++) {
    const f = gateFacing(course, i);
    const len = Math.hypot(f.x, f.y, f.z);
    assert(Math.abs(len - 1) < 1e-9, `gate ${i} facing is a unit vector (${len.toFixed(6)})`);

    // A near-vertical hole axis means the ring lies flat in world space.
    assert(Math.abs(f.y) <= MAX_GATE_TILT + 1e-9,
      `gate ${i} ring stays near-upright (|y| = ${Math.abs(f.y).toFixed(3)} ≤ ${MAX_GATE_TILT})`);

    // Bearing — not the raw 3-D direction — is the property that survives the
    // tilt cap, so assert the ring's ground track matches the leg's.
    const prev = i > 0 ? course[i - 1] : { x: RUNWAY.threshold.x, y: 0, z: RUNWAY.threshold.z };
    const dx = course[i].x - prev.x, dz = course[i].z - prev.z;
    const dh = Math.hypot(dx, dz), fh = Math.hypot(f.x, f.z);
    const bearing = (f.x * dx + f.z * dz) / (dh * fh);
    assert(bearing > 0.999, `gate ${i} faces the leg it is approached on (bearing ${bearing.toFixed(4)})`);
  }

  // The cap binds on the climbing first leg and leaves the shallow ones alone.
  assert(Math.abs(gateFacing(course, 0).y - MAX_GATE_TILT) < 1e-9, "the climb off the runway is tilt-capped");
  assert(Math.abs(gateFacing(course, 2).y) < 0.1, "a shallow leg keeps its own gentle tilt");

  // Out-of-range and empty courses fall back rather than throwing.
  assert(gateFacing([], 0).z === 1 && gateFacing(course, 99).z === 1, "an absent gate falls back to +z");

  // The renderer must derive orientation from the mission layer, never bake one in.
  const worldSrc = readFileSync(fileURLToPath(new URL("../openflight-sim/src/world.js", import.meta.url)), "utf8");
  const from = worldSrc.indexOf("setCourse(gates)");
  const to = worldSrc.indexOf("setActiveGate(i)");
  assert(from > 0 && to > from, "setCourse is locatable in world.js for the source scan");
  const setCourseBody = worldSrc.slice(from, to);
  assert(!/ring\.rotation\.[xyz]\s*=/.test(setCourseBody), "setCourse hard-codes no ring rotation");
  assert(/gateFacing\(/.test(setCourseBody) && /ring\.lookAt\(/.test(setCourseBody),
    "setCourse aims each ring down its arrival leg via gateFacing");
}

// ── 4c. On-runway classification tracks the paved rectangle exactly ──────────
// Regression guard: the touchdown test carried a `+ 6` tolerance, so an arrival
// up to 6 m onto the grass was graded on-runway and scored A/75 — identical to
// touching down on the edge, because the centreline penalty saturates first.
console.log("\n[4c] On-runway classification");
{
  const onRunwayAt = (x: number) => {
    const missions = createMissions({ storage: makeStore() });
    missions.start("landing");
    const sim = makeSim({ pos: { x, y: 5, z: 300 }, onGround: false, verticalSpeed: -0.3, airspeed: 40 });
    missions.update(FIXED_DT, sim);
    sim.onGround = true;
    missions.update(FIXED_DT, sim);
    for (let i = 0; i < 320; i++) missions.update(FIXED_DT, sim);
    return missions.end("complete", sim)!;
  };

  // end() reports the classification through the score and summary, not a field.
  const edge = RUNWAY.width / 2;
  const off = (r: any) => /off the runway/.test(r.summary);

  const inside = onRunwayAt(edge - 0.5);
  assert(!off(inside) && inside.score > 25,
    `a touchdown inside the pavement grades as a landing (${inside.grade}/${inside.score})`);

  const outside = onRunwayAt(edge + 0.5);
  assert(off(outside) && outside.score <= 25,
    `half a metre past the edge is off the runway (${outside.grade}/${outside.score})`);

  // The removed `+ 6` tolerance let x = 21 m score A/75; pin that it cannot again.
  const grass = onRunwayAt(edge + 6);
  assert(off(grass) && grass.score <= 25,
    `6 m onto the grass is off the runway and fails (${grass.grade}/${grass.score})`);
}

// ── 5. Session scoring: persisted per-mission high score + record flag ───────
console.log("\n[5] Persisted high score");
{
  const store = makeStore();
  const missions = createMissions({ storage: store });

  // First attempt sets the record.
  missions.start("freeflight");
  const sim = makeSim({ altitude: 300, airspeed: 45 });
  for (let i = 0; i < Math.round(90 / FIXED_DT); i++) missions.update(FIXED_DT, sim);
  const first = missions.end("complete", sim)!;
  assert(first.isRecord === true, "first completed run is a new record");
  assert(first.highScore === first.score, "high score equals the first attempt's score");

  const persisted = JSON.stringify(store._dump());
  assert(/freeflight/.test(persisted) && /"ofs\.highscores/.test(persisted),
    "the high score is written to the store under a namespaced key");

  // A weaker second attempt does not beat the record.
  missions.start("freeflight");
  const sim2 = makeSim();
  for (let i = 0; i < Math.round(20 / FIXED_DT); i++) missions.update(FIXED_DT, sim2);
  const second = missions.end("complete", sim2)!;
  assert(second.isRecord === false, "a weaker run is not a new record");
  assert(second.highScore === first.score, "the persisted best is retained");

  // Persistence survives a fresh runtime bound to the same store.
  const reopened = createMissions({ storage: store });
  assert(reopened.highScore("freeflight") === first.score,
    "a new mission-runtime instance reads back the persisted high score");
}

// ── 6. No network calls anywhere in the mission module ───────────────────────
console.log("\n[6] Offline / no network");
{
  const src = readFileSync(fileURLToPath(new URL("../openflight-sim/src/missions.js", import.meta.url)), "utf8");
  const banned = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\.connection/;
  assert(!banned.test(src), "missions.js contains no network APIs");
  assert(/localStorage/.test(src), "high scores use localStorage (a local, same-origin store)");
  // RUNWAY geometry is self-contained (no import from the THREE-bound world).
  assert(RUNWAY.length === 1500 && RUNWAY.width === 30, "runway geometry is defined locally, THREE-free");
}

console.log(failures === 0 ? "\n✅ missions: ALL CHECKS PASSED" : `\n❌ missions: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
