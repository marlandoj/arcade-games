/**
 * OpenFlight Sim — Missions, scoring, landing grading, debrief (OFS-005).
 *
 * Fills the T1 boundary stub with the real mission layer. Pure and THREE-free so
 * the focused test drives it on a duck-typed sim without a WebGL context; the
 * orchestrator (main.js) wires the frozen call sites into the shell's briefing,
 * flight loop, and debrief screens.
 *
 * Contract (frozen by T1, preserved here): `createMissions()` returns
 *   { list, active(), start(id), update(dt, sim), remaining(),
 *     end(reason, sim), grade(sim), reset() }.
 * The orchestrator starts a mission on briefing confirm, drives `update` each
 * fixed step, polls `remaining()` to know when a timed/landing run is done, and
 * calls `end`/`grade` to populate the debrief. New members are additive:
 *   course(), activeGateIndex(), progress(sim), spawnFor(id), highScore(id).
 *
 * T5 adds:
 *   • Four+ missions: free flight, a navigation course through aerial gates, a
 *     heading/altitude hold circuit, and a graded landing approach.
 *   • Landing grading that reads touchdown vertical speed, centreline offset and
 *     touchdown point relative to the threshold and produces a per-attempt score.
 *   • Session scoring with a per-mission high score persisted in localStorage
 *     (in-memory fallback when unavailable). No network calls of any kind.
 *   • A rich result object the debrief summarises, with a retry path.
 */

// ── Runway / airfield geometry ───────────────────────────────────────────────
// Mirrors world.js RUNWAY. Duplicated here (not imported) so this module stays
// THREE-free and testable in a plain runtime. Threshold at (0,0); the runway
// runs along +z (heading 0 / north) for `length` metres, `width` metres wide.
export const RUNWAY = Object.freeze({
  threshold: Object.freeze({ x: 0, z: 0 }),
  heading: 0,
  length: 1500,
  width: 30,
  elevation: 0,
});

const MPS_TO_FPM = 196.850394;   // m/s → feet per minute
const MPS_TO_KT = 1.943844;      // m/s → knots
const M_TO_FT = 3.280840;        // metres → feet

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round(v) { return Math.round(v); }
function letterGrade(score) {
  return score >= 90 ? "S" : score >= 75 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D";
}

// ── Mission catalog (≥ 4, incl. a gate navigation course and a graded landing) ─
// Types: "freeflight" (airborne time), "gates" (fly the course in order),
// "hold" (heading/altitude discipline), "landing" (graded touchdown).
// `spawn` overrides the shell's default start state so a landing begins on a
// real approach and the gate course begins pointed down the first leg.
export const MISSIONS = Object.freeze([
  Object.freeze({
    id: "freeflight",
    title: "Free Flight",
    brief: "Open familiarisation. Explore the airfield and terrain — scored by time aloft with the wheels clean.",
    type: "freeflight",
    duration: 0,
    scoring: Object.freeze({ pass: false, target: "Stay airborne" }),
  }),
  Object.freeze({
    id: "navcourse",
    title: "Nav Course",
    brief: "Fly the six-gate navigation course in order. Each ring cleared banks points; beat the clock for the bonus.",
    type: "gates",
    duration: 260,
    course: Object.freeze([
      Object.freeze({ x: 0, y: 300, z: 260, r: 120 }),
      Object.freeze({ x: 360, y: 330, z: 900, r: 125 }),
      Object.freeze({ x: 720, y: 380, z: 1520, r: 135 }),
      Object.freeze({ x: 260, y: 340, z: 2120, r: 135 }),
      Object.freeze({ x: -460, y: 320, z: 1520, r: 135 }),
      Object.freeze({ x: -200, y: 300, z: 720, r: 125 }),
    ]),
    scoring: Object.freeze({ pass: true, target: "Clear all six gates" }),
  }),
  Object.freeze({
    id: "circuit",
    title: "Circuit Discipline",
    brief: "Hold runway heading (0°) within 10° and stay in the 250–450 m altitude band for 30 s. Smooth wins.",
    type: "hold",
    duration: 150,
    hold: Object.freeze({ heading: 0, tolDeg: 10, altLo: 250, altHi: 450, target: 30 }),
    scoring: Object.freeze({ pass: true, target: "Hold heading & altitude 30 s" }),
  }),
  Object.freeze({
    id: "landing",
    title: "Landing Approach",
    brief: "Fly the 3° approach and land on the runway. Graded on sink rate, centreline offset and touchdown point.",
    type: "landing",
    duration: 0,
    // Start ~1.8 km out on a nominal 3° glidepath, gear down, on centreline.
    spawn: Object.freeze({ pos: Object.freeze([0, 96, -1800]), heading: 0, gear: 1, flaps: 20, throttle: 0.45 }),
    scoring: Object.freeze({ pass: true, target: "Grease it on in the touchdown zone" }),
  }),
]);

// ── Persisted high scores (localStorage, with an in-memory fallback) ─────────
// Local-only by construction: localStorage is a same-origin browser store, never
// a network call. The fallback keeps the module usable in a plain runtime (tests)
// and lets a caller inject its own store.
const HS_KEY = "ofs.highscores.v1";

function defaultStore() {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch (_) { /* access can throw in sandboxed frames */ }
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
  };
}

function loadHighScores(store) {
  try {
    const raw = store.getItem(HS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch (_) { return {}; }
}

function saveHighScores(store, table) {
  try { store.setItem(HS_KEY, JSON.stringify(table)); } catch (_) { /* quota / private mode */ }
}

// ── Landing grading (pure) ───────────────────────────────────────────────────
// Reads the three touchdown metrics the acceptance criterion names and folds
// them into a single 0–100 per-attempt score plus a human summary.
//   sinkRate         — vertical speed at first contact, m/s (positive = down)
//   centrelineOffset — |x| from the runway centreline at touchdown, m
//   touchdownPoint   — z past the threshold at touchdown, m (threshold = 0)
//   onRunway         — contact was within the runway rectangle
export function gradeLanding({ sinkRate, centrelineOffset, touchdownPoint, onRunway, airspeed = 0 }) {
  const sink = Math.max(0, sinkRate);
  const sinkFpm = sink * MPS_TO_FPM;

  // Vertical speed: full marks at a feather-soft ≤ 0.5 m/s (~100 fpm), zero by a
  // gear-bending 3.66 m/s (~720 fpm). Beyond that it's a crash.
  const CRASH_SINK = 3.66;
  const vsScore = sink <= 0.5 ? 100 : clamp(100 * (1 - (sink - 0.5) / (CRASH_SINK - 0.5)), 0, 100);

  // Centreline: full marks on the paint, zero at the runway edge.
  const edge = RUNWAY.width / 2;
  const centreScore = clamp(100 * (1 - Math.abs(centrelineOffset) / edge), 0, 100);

  // Touchdown point: reward the marked touchdown zone (150–450 m past the
  // threshold). Landing short (before the threshold) scores zero; long tapers off.
  let pointScore;
  if (touchdownPoint < 0) pointScore = 0;
  else if (touchdownPoint < 150) pointScore = clamp(40 + (touchdownPoint / 150) * 60, 0, 100);
  else if (touchdownPoint <= 450) pointScore = 100;
  else pointScore = clamp(100 - ((touchdownPoint - 450) / (RUNWAY.length - 450)) * 100, 0, 100);

  let score = round(0.45 * vsScore + 0.25 * centreScore + 0.30 * pointScore);
  const crashed = sink > CRASH_SINK;
  if (!onRunway) score = Math.min(score, 25);   // off the runway is never a pass
  if (crashed) score = Math.min(score, 15);      // hard arrival, not a landing
  score = clamp(score, 0, 100);

  const grade = letterGrade(score);
  const side = centrelineOffset === 0 ? "on centreline"
    : `${Math.abs(centrelineOffset).toFixed(1)} m ${centrelineOffset < 0 ? "left" : "right"} of centre`;
  const where = !onRunway ? "off the runway"
    : touchdownPoint < 0 ? `${Math.abs(round(touchdownPoint))} m short of the threshold`
    : `${round(touchdownPoint)} m past the threshold`;
  const summary = crashed
    ? `Hard arrival: ${round(sinkFpm)} fpm, ${where}.`
    : `Touchdown ${round(sinkFpm)} fpm at ${round(airspeed * MPS_TO_KT)} kt, ${side}, ${where}.`;

  return Object.freeze({
    score, grade, summary, crashed, onRunway,
    sinkRate: sink, sinkFpm, centrelineOffset, touchdownPoint, airspeed,
  });
}

// ── Gate helpers (pure) ──────────────────────────────────────────────────────
export function gateDistance(gate, pos) {
  return Math.hypot(pos.x - gate.x, pos.y - gate.y, pos.z - gate.z);
}
export function gateCaptured(gate, pos) {
  return gateDistance(gate, pos) <= gate.r;
}

// Sine of the steepest a gate ring may pitch away from vertical (~20°).
export const MAX_GATE_TILT = 0.35;

// Unit vector the gate ring's hole axis should point along, so the pilot sights
// down the ring on approach instead of at its edge. A gate faces the leg it is
// arrived on; the first faces away from the runway threshold. The renderer aims
// the ring's +Z at this — it must not apply a fixed rotation of its own.
export function gateFacing(course, i) {
  const list = Array.isArray(course) ? course : [];
  const g = list[i];
  if (!g) return { x: 0, y: 0, z: 1 };
  const prev = i > 0 ? list[i - 1] : { x: RUNWAY.threshold.x, y: 0, z: RUNWAY.threshold.z };
  const dx = g.x - prev.x, dy = g.y - prev.y, dz = g.z - prev.z;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-6)) return { x: 0, y: 0, z: 1 };

  let ux = dx / len, uy = dy / len, uz = dz / len;
  // A steeply climbing leg — the first one, off the runway, climbs 300 m in 260 —
  // would pitch the ring back far enough to read as flat again. Cap the pitch and
  // renormalise across the ground track: bearing is preserved, only tilt is bounded.
  if (Math.abs(uy) > MAX_GATE_TILT) {
    uy = Math.sign(uy) * MAX_GATE_TILT;
    const h = Math.hypot(ux, uz);
    const want = Math.sqrt(1 - uy * uy);
    if (h > 1e-6) { ux = (ux / h) * want; uz = (uz / h) * want; }
    else { uz = want; }
  }
  return { x: ux, y: uy, z: uz };
}

// ── Mission runtime ──────────────────────────────────────────────────────────
export function createMissions(options = {}) {
  const store = options.storage || defaultStore();
  let highScores = loadHighScores(store);

  let mission = null;
  let timer = 0;

  // hold-mission accumulator
  let holdTime = 0;
  let bestHold = 0;

  // gate-course state
  let gateIndex = 0;
  let gatesCleared = 0;
  let gateSplit = 0;         // time since the last gate was cleared
  const gateSplits = [];

  // landing state
  let prevOnGround = false;
  let touchdown = null;      // captured touchdown metrics (first contact)
  let settle = 0;            // seconds since touchdown (roll-out settle timer)

  let finished = false;      // objective satisfied → let remaining() end the run

  function reset() {
    mission = null;
    timer = 0;
    holdTime = 0; bestHold = 0;
    gateIndex = 0; gatesCleared = 0; gateSplit = 0; gateSplits.length = 0;
    prevOnGround = false; touchdown = null; settle = 0;
    finished = false;
  }

  function courseOf(m) { return m && m.type === "gates" && m.course ? m.course : []; }

  const api = {
    list: MISSIONS,

    active() { return mission; },

    spawnFor(id) {
      const m = MISSIONS.find((x) => x.id === id);
      return m && m.spawn ? m.spawn : null;
    },

    highScore(id) { return highScores[id] || 0; },

    course() { return courseOf(mission); },
    activeGateIndex() { return mission && mission.type === "gates" ? gateIndex : -1; },

    start(id) {
      reset();
      mission = MISSIONS.find((x) => x.id === id) || MISSIONS[0];
      return mission;
    },

    update(dt, sim) {
      if (!mission || finished) return;
      timer += dt;

      if (mission.type === "gates") {
        const course = courseOf(mission);
        gateSplit += dt;
        if (gateIndex < course.length && gateCaptured(course[gateIndex], sim.pos)) {
          gateSplits.push(gateSplit);
          gateSplit = 0;
          gateIndex++;
          gatesCleared++;
          if (gateIndex >= course.length) finished = true;   // course complete
        }
      } else if (mission.type === "hold") {
        const h = mission.hold;
        const headingDeg = ((sim.heading * 180) / Math.PI + 360) % 360;
        const err = Math.min(Math.abs(headingDeg - h.heading), 360 - Math.abs(headingDeg - h.heading));
        const inBand = sim.altitude >= h.altLo && sim.altitude <= h.altHi;
        if (err <= h.tolDeg && inBand) {
          holdTime += dt;
          if (holdTime > bestHold) bestHold = holdTime;
          if (bestHold >= h.target) finished = true;
        } else {
          holdTime = 0;   // discipline broken → the clock restarts
        }
      } else if (mission.type === "landing") {
        if (!touchdown && !prevOnGround && sim.onGround) {
          // First wheel contact — freeze the graded touchdown metrics.
          // The paved rectangle exactly. An earlier `+ 6` tolerance graded a
          // touchdown up to 6 m onto the grass as an on-runway arrival, which
          // scored A/75 — the same as touching down on the edge — because the
          // centreline penalty saturates before it gets there.
          const onRunway =
            sim.pos.z >= 0 && sim.pos.z <= RUNWAY.length &&
            Math.abs(sim.pos.x) <= RUNWAY.width / 2;
          touchdown = {
            sinkRate: Math.max(0, -sim.verticalSpeed),
            centrelineOffset: sim.pos.x - RUNWAY.threshold.x,
            touchdownPoint: sim.pos.z - RUNWAY.threshold.z,
            onRunway,
            airspeed: sim.airspeed,
          };
        }
        prevOnGround = sim.onGround;
        if (touchdown) settle += dt;   // roll-out; remaining() ends the run
      }
    },

    // Infinity ⇒ open-ended (ends only on fuel/terrain). A finite value ≤ 0 tells
    // the orchestrator the objective/clock is done and it should end the flight.
    remaining() {
      if (!mission) return Infinity;
      if (mission.type === "landing") {
        return touchdown ? Math.max(0, 2.5 - settle) : Infinity;
      }
      if (finished) return 0;                       // objective satisfied
      if (!mission.duration) return Infinity;       // untimed
      return Math.max(0, mission.duration - timer);
    },

    // Live objective read-out for the mission HUD banner.
    progress(sim) {
      if (!mission) return null;
      if (mission.type === "freeflight") {
        return { label: "FREE FLIGHT", detail: `${round(timer)} s aloft` };
      }
      if (mission.type === "gates") {
        const course = courseOf(mission);
        if (gateIndex >= course.length) return { label: "COURSE CLEAR", detail: "all gates" };
        const g = course[gateIndex];
        const d = gateDistance(g, sim.pos);
        const bearing = ((Math.atan2(g.x - sim.pos.x, g.z - sim.pos.z) * 180) / Math.PI + 360) % 360;
        return { label: `GATE ${gateIndex + 1}/${course.length}`, detail: `${round(d)} m · brg ${round(bearing)}°` };
      }
      if (mission.type === "hold") {
        const h = mission.hold;
        return { label: "HOLD HDG/ALT", detail: `${holdTime.toFixed(0)}/${h.target} s in band` };
      }
      if (mission.type === "landing") {
        if (touchdown) return { label: "TOUCHDOWN", detail: `${round(touchdown.sinkRate * MPS_TO_FPM)} fpm` };
        const sinkFpm = round(Math.max(0, -sim.verticalSpeed) * MPS_TO_FPM);
        const off = sim.pos.x - RUNWAY.threshold.x;
        const offTxt = Math.abs(off) < 2 ? "centred" : `${Math.abs(round(off))}m ${off < 0 ? "L" : "R"}`;
        return { label: "APPROACH", detail: `sink ${sinkFpm} fpm · ${offTxt}` };
      }
      return { label: mission.title.toUpperCase(), detail: "" };
    },

    grade(sim, reason) {
      if (!mission) {
        return Object.freeze({ score: 0, grade: "D", summary: "No mission.", stats: [] });
      }

      if (mission.type === "landing") {
        if (touchdown) {
          const g = gradeLanding(touchdown);
          return Object.freeze({
            score: g.score, grade: g.grade, summary: g.summary,
            stats: [
              { label: "Sink rate", value: `${round(g.sinkFpm)} fpm` },
              { label: "Centreline", value: `${Math.abs(g.centrelineOffset).toFixed(1)} m` },
              { label: "Touchdown", value: `${round(g.touchdownPoint)} m` },
            ],
          });
        }
        const why = reason === "terrain" ? "Crashed short of the runway."
          : reason === "fuel" ? "Ran out of fuel before touchdown."
          : "Flight ended without a touchdown.";
        return Object.freeze({ score: 0, grade: "D", summary: why, stats: [] });
      }

      if (mission.type === "gates") {
        const course = courseOf(mission);
        const total = course.length || 1;
        const frac = gatesCleared / total;
        let score = round(frac * 90);
        // Time bonus only for a clean sweep — rewards a quick, tidy run.
        let bonus = 0;
        if (gatesCleared >= total && mission.duration) {
          bonus = round(clamp(10 * (1 - timer / mission.duration), 0, 10));
          score += bonus;
        }
        score = clamp(score, 0, 100);
        const summary = gatesCleared >= total
          ? `Course complete: all ${total} gates in ${round(timer)} s (+${bonus} time bonus).`
          : `Cleared ${gatesCleared} of ${total} gates before the clock ran out.`;
        return Object.freeze({
          score, grade: letterGrade(score), summary,
          stats: [
            { label: "Gates", value: `${gatesCleared}/${total}` },
            { label: "Time", value: `${round(timer)} s` },
            { label: "Best split", value: gateSplits.length ? `${Math.min(...gateSplits).toFixed(1)} s` : "—" },
          ],
        });
      }

      if (mission.type === "hold") {
        const h = mission.hold;
        const held = Math.min(h.target, bestHold);
        const score = clamp(round((held / h.target) * 100), 0, 100);
        return Object.freeze({
          score, grade: letterGrade(score),
          summary: `Held heading & altitude ${held.toFixed(0)} s of ${h.target} s.`,
          stats: [
            { label: "In band", value: `${held.toFixed(0)}/${h.target} s` },
            { label: "Altitude", value: `${round(sim.altitude * M_TO_FT)} ft` },
            { label: "Heading", value: `${round(((sim.heading * 180) / Math.PI + 360) % 360)}°` },
          ],
        });
      }

      // freeflight — sustained flight time.
      const score = clamp(round((timer / 90) * 100), 0, 100);
      return Object.freeze({
        score, grade: letterGrade(score),
        summary: `Free flight: ${round(timer)} s airborne.`,
        stats: [
          { label: "Time aloft", value: `${round(timer)} s` },
          { label: "Altitude", value: `${round(sim.altitude * M_TO_FT)} ft` },
          { label: "Airspeed", value: `${round(sim.airspeed * MPS_TO_KT)} kt` },
        ],
      });
    },

    end(reason, sim) {
      if (!mission) return null;
      const g = this.grade(sim, reason);

      // Session scoring: fold the attempt into the persisted per-mission high
      // score and flag a new record for the debrief.
      const prevHigh = highScores[mission.id] || 0;
      const isRecord = g.score > prevHigh;
      const highScore = Math.max(prevHigh, g.score);
      if (isRecord) {
        highScores = { ...highScores, [mission.id]: g.score };
        saveHighScores(store, highScores);
      }

      const result = Object.freeze({
        mission: mission.id,
        title: mission.title,
        type: mission.type,
        reason: reason || "complete",
        duration: timer,
        score: g.score,
        grade: g.grade,
        summary: g.summary,
        stats: Object.freeze((g.stats || []).map((s) => Object.freeze({ ...s }))),
        highScore,
        isRecord,
      });
      mission = null;
      return result;
    },

    reset,
  };

  return api;
}

export const __OFS_BOUNDARY__ = "missions";
