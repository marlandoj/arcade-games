/**
 * OpenFlight Sim — Missions, scoring, debrief (T1 boundary stub, OFS-005 fills).
 *
 * Contract: `createMissions()` returns `{ list, active(), start(id),
 * update(dt, sim), end(reason, sim), grade(sim) }`. The orchestrator starts a
 * mission on briefing confirm, drives `update` each fixed step, and calls
 * `end`/`grade` to populate the debrief screen. T5 adds the navigation course,
 * graded landing, persisted high scores and per-attempt scoring. The call
 * sites here are frozen.
 */

export const MISSIONS = Object.freeze([
  Object.freeze({
    id: "freeflight",
    title: "Free Flight",
    brief: "Familiarisation flight. Hold altitude and heading over the airfield. Throttle up and enjoy the T1 shell.",
    type: "freeflight",
    duration: 0,
    scoring: Object.freeze({ pass: false, target: null }),
  }),
  Object.freeze({
    id: "circuit",
    title: "Circuit Check",
    brief: "Fly a stable circuit around the runway. (Landing grading arrives with OFS-005.)",
    type: "navigation",
    duration: 180,
    scoring: Object.freeze({ pass: true, target: "Hold heading within 10° for 30 s" }),
  }),
]);

export function createMissions() {
  let activeMission = null;
  let timer = 0;
  let headingHold = null;
  let headingScore = 0;

  return {
    list: MISSIONS,

    active() { return activeMission; },

    start(id) {
      const m = MISSIONS.find((x) => x.id === id) || MISSIONS[0];
      activeMission = m;
      timer = 0;
      headingHold = null;
      headingScore = 0;
      return m;
    },

    update(dt, sim) {
      if (!activeMission) return;
      timer += dt;
      if (activeMission.type === "navigation") {
        if (headingHold === null || Math.abs(sim.heading - headingHold) > 0.175) {
          headingHold = sim.heading;
          headingScore = 0;
        } else {
          headingScore += dt;
        }
      }
    },

    remaining() {
      if (!activeMission || !activeMission.duration) return Infinity;
      return Math.max(0, activeMission.duration - timer);
    },

    end(reason, sim) {
      if (!activeMission) return null;
      const g = this.grade(sim);
      const result = Object.freeze({
        mission: activeMission.id,
        title: activeMission.title,
        reason: reason || "complete",
        duration: timer,
        score: g.score,
        grade: g.grade,
        summary: g.summary,
      });
      activeMission = null;
      timer = 0;
      return result;
    },

    grade(sim) {
      // Navigation missions are scored by heading-hold time. Free Flight is
      // type `freeflight`, so it must NOT be scored by the heading metric
      // (ZOU-920 remediation #11): score it by sustained flight time instead.
      if (activeMission && activeMission.type === "navigation") {
        const held = Math.min(30, headingScore);
        const score = Math.round((held / 30) * 100);
        const grade = score >= 90 ? "S" : score >= 75 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D";
        return Object.freeze({
          score,
          grade,
          summary: `Heading held ${held.toFixed(0)} s of 30 s.`,
          touchdownVs: 0,
          centrelineOffset: 0,
          touchdownPoint: 0,
          headingHeld: held,
        });
      }
      const dur = Math.max(0, timer);
      const score = Math.min(100, Math.round((dur / 60) * 100));
      const grade = score >= 90 ? "S" : score >= 75 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D";
      return Object.freeze({
        score,
        grade,
        summary: `Free flight: ${Math.round(dur)} s airborne.`,
        touchdownVs: 0,
        centrelineOffset: 0,
        touchdownPoint: 0,
        headingHeld: 0,
      });
    },

    reset() { activeMission = null; timer = 0; headingHold = null; headingScore = 0; },
  };
}

export const __OFS_BOUNDARY__ = "missions";
