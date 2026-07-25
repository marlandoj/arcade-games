/**
 * Missions, objective tracking, landing grading, and score persistence.
 */

import * as THREE from 'three';
import { AIRPORT } from './world.js';

const KT = 1.94384;
const FT = 3.28084;
const FPM = 196.85;
const HI_KEY = 'opus5fs.hi.v1';

/* ------------------------------------------------------------------ */
/* Landing grading                                                     */
/* ------------------------------------------------------------------ */

/**
 * Grade a completed landing.
 * @param {object} td touchdown snapshot
 *   { vsFpm, offsetM, alongM, iasKt, vrefKt, bankDeg, crabDeg, onRunway, rolloutM }
 */
export function gradeLanding(td) {
  const parts = [];
  const pen = (label, value, good, bad, weight, fmt) => {
    const t = Math.max(0, Math.min(1, (Math.abs(value) - good) / (bad - good)));
    const lost = Math.round(t * weight);
    parts.push({ label, text: fmt(value), lost, weight });
    return lost;
  };

  let score = 1000;
  score -= pen('Touchdown rate', td.vsFpm, 90, 600, 320, (v) => `${Math.round(Math.abs(v))} fpm`);
  score -= pen('Centreline', td.offsetM, 2.5, 24, 180, (v) => `${Math.abs(v).toFixed(1)} m`);
  score -= pen('Aiming point', td.alongM, 90, 700, 180, (v) => `${Math.round(Math.abs(v))} m`);
  score -= pen('Approach speed', td.iasKt - td.vrefKt, 4, 32, 140, (v) => `${v > 0 ? '+' : ''}${Math.round(v)} kt`);
  score -= pen('Wings level', td.bankDeg, 2, 14, 100, (v) => `${Math.abs(v).toFixed(1)}°`);
  score -= pen('Alignment', td.crabDeg, 2.5, 16, 80, (v) => `${Math.abs(v).toFixed(1)}°`);
  if (!td.onRunway) { score -= 420; parts.push({ label: 'Off-runway touchdown', text: 'penalty', lost: 420, weight: 420 }); }

  score = Math.max(0, Math.round(score));
  const grade =
    score >= 930 ? 'A+' : score >= 860 ? 'A' : score >= 780 ? 'B' :
    score >= 680 ? 'C' : score >= 560 ? 'D' : 'E';
  const verdict =
    score >= 930 ? 'GREASED IT' :
    score >= 860 ? 'TEXTBOOK' :
    score >= 780 ? 'SOLID' :
    score >= 680 ? 'ACCEPTABLE' :
    score >= 560 ? 'FIRM — REVIEW THE NUMBERS' : 'ARRIVAL, NOT A LANDING';
  return { score, grade, verdict, parts };
}

/* ------------------------------------------------------------------ */
/* High scores                                                         */
/* ------------------------------------------------------------------ */

export function loadHighScores() {
  try { return JSON.parse(localStorage.getItem(HI_KEY) || '{}'); } catch { return {}; }
}

export function saveHighScore(missionId, aircraftId, score) {
  const all = loadHighScores();
  const key = `${missionId}:${aircraftId}`;
  const prev = all[key] || 0;
  if (score > prev) {
    all[key] = score;
    try { localStorage.setItem(HI_KEY, JSON.stringify(all)); } catch { /* private mode */ }
    return true;
  }
  return false;
}

export function bestFor(missionId, aircraftId) {
  return loadHighScores()[`${missionId}:${aircraftId}`] || 0;
}

/* ------------------------------------------------------------------ */
/* Mission definitions                                                 */
/* ------------------------------------------------------------------ */

function wp(x, z, alt, r, label) {
  return { pos: new THREE.Vector3(x, alt, z), r, label, hit: false };
}

const E = AIRPORT.elev;

export const MISSIONS = [
  {
    id: 'freeflight',
    name: 'FREE FLIGHT',
    tagline: 'No clock. No gates. Just the airplane.',
    brief: 'Airborne over the field at 3,000 ft. Explore the valley, practise stalls, or shoot approaches until the tanks run dry. Points accrue for time aloft and for every landing you grade.',
    weather: 'breezy', time: 'day',
    start: 'air',
    objectives: ['Fly. Land when you feel like it.'],
    scoreLabel: 'FLIGHT SCORE',
  },
  {
    id: 'pattern',
    name: 'PATTERN WORK',
    tagline: 'Left traffic, runway 27, full stop.',
    brief: 'Take off from runway 27, fly a standard left-hand circuit through four gates at pattern altitude, and land back on 27. Graded on gate discipline and on the landing itself.',
    weather: 'breezy', time: 'day',
    start: 'runway27',
    gates: [
      wp(-2400, 500, E + 250, 340, 'CROSSWIND'),
      wp(0, 1300, E + 320, 360, 'DOWNWIND'),
      wp(2500, 900, E + 300, 360, 'BASE'),
      wp(2700, 0, E + 230, 320, 'FINAL'),
    ],
    objectives: ['Depart runway 27', 'Fly four pattern gates', 'Land on runway 27'],
    scoreLabel: 'CIRCUIT SCORE',
  },
  {
    id: 'checkpoint',
    name: 'VALLEY RUN',
    tagline: 'Ten gates. One clock.',
    brief: 'A low-level course through the valley and around the ridge line. Every gate you miss costs you. The clock is running from the moment you cross the first one.',
    weather: 'calm', time: 'dusk',
    start: 'air',
    timed: true,
    gates: [
      wp(-1800, -900, E + 190, 95, 'GATE 1'),
      wp(-3600, -2600, E + 320, 95, 'GATE 2'),
      wp(-2400, -5200, E + 520, 95, 'GATE 3'),
      wp(600, -6100, E + 700, 100, 'GATE 4'),
      wp(3400, -4700, E + 640, 100, 'GATE 5'),
      wp(4600, -1900, E + 430, 95, 'GATE 6'),
      wp(3800, 900, E + 300, 95, 'GATE 7'),
      wp(1500, 2600, E + 260, 95, 'GATE 8'),
      wp(-1400, 2400, E + 230, 95, 'GATE 9'),
      wp(-2900, 600, E + 210, 100, 'GATE 10'),
    ],
    objectives: ['Cross all ten gates in order', 'Beat the clock'],
    scoreLabel: 'COURSE SCORE',
  },
  {
    id: 'crosswind',
    name: 'CROSSWIND CHECK',
    tagline: '18 knots, 70 degrees off the nose.',
    brief: 'You are on a four-mile final for runway 27 with a strong, gusty crosswind from the south. Crab it down, kick it straight, and put the upwind wheel on first. This is the one that separates pilots.',
    weather: 'gusty', time: 'dusk',
    windOverride: { dirDeg: 195, speed: 9.2, gust: 4.6, turbulence: 0.6 },
    start: 'final',
    objectives: ['Fly a stabilised approach', 'Land on runway 27 centreline'],
    scoreLabel: 'APPROACH SCORE',
  },
  {
    id: 'deadstick',
    name: 'ENGINE OUT',
    tagline: 'Best glide. Pick your field. Commit.',
    brief: 'The engine quits at 4,000 ft over the valley. Trim for best glide, turn back if the numbers work, and land it. Anywhere flat counts — the runway counts for a lot more.',
    weather: 'calm', time: 'dawn',
    start: 'deadstick',
    objectives: ['Reach a survivable landing', 'Runway landing for full credit'],
    scoreLabel: 'GLIDE SCORE',
  },
];

export function missionById(id) {
  return MISSIONS.find((m) => m.id === id) || MISSIONS[0];
}

/* ------------------------------------------------------------------ */
/* Runtime tracker                                                     */
/* ------------------------------------------------------------------ */

export class MissionRun {
  constructor(def, ac) {
    this.def = def;
    this.ac = ac;
    this.gates = (def.gates || []).map((g) => ({ ...g, hit: false }));
    this.gateIdx = 0;
    this.t = 0;
    this.started = def.id !== 'checkpoint';
    this.status = 'active';
    this.airborne = false;
    this.everAirborne = false;
    this.landing = null;
    this.landings = 0;
    this.bestLanding = null;
    this.events = [];
    this.score = 0;
    this.message = '';
    this.gateMisses = 0;
    this._settleTimer = 0;
    this._tdPending = null;
    this._maxAlt = 0;
    this._patternDev = 0;
    this._patternSamples = 0;
  }

  push(msg, kind = 'info') { this.events.push({ msg, kind }); }

  vref() {
    const vs = this.ac.stallSpeed(0, this.ac.flapTarget());
    return vs * 1.3 * KT;
  }

  update(dt, sim) {
    if (this.status !== 'active') return;
    const ac = this.ac;
    this.t += dt;

    const wasAir = this.airborne;
    this.airborne = !ac.wow && ac.agl > 1.2;
    if (this.airborne) { this.everAirborne = true; this._maxAlt = Math.max(this._maxAlt, ac.agl); }

    /* --- gates --- */
    if (this.gates.length && this.gateIdx < this.gates.length) {
      const g = this.gates[this.gateIdx];
      const d = ac.pos.distanceTo(g.pos);
      if (d < g.r) {
        g.hit = true;
        this.gateIdx++;
        if (this.def.id === 'checkpoint' && !this.started) { this.started = true; this.t = 0; }
        this.push(`${g.label} ✓`, 'good');
        sim.audio.chirp(true);
      }
    }

    /* --- pattern discipline --- */
    if (this.def.id === 'pattern' && this.airborne && this.gateIdx > 0 && this.gateIdx < 4) {
      const target = E + 305;
      this._patternDev += Math.abs(ac.pos.y - target);
      this._patternSamples++;
    }

    /* --- touchdown capture --- */
    if (wasAir && ac.wow) {
      const rw = this.runwayMetrics();
      const eu = ac.euler();
      this._tdPending = {
        vsFpm: Math.abs(ac.touchdownVS * FPM),
        offsetM: rw.offset,
        alongM: rw.along,
        iasKt: ac.ias * KT,
        vrefKt: this.vref(),
        bankDeg: (eu.bank * 180) / Math.PI,
        crabDeg: rw.crab,
        onRunway: rw.onRunway,
      };
      sim.audio.thump(Math.min(1, Math.abs(ac.touchdownVS) / 3));
      this._settleTimer = 0;
    }

    // A landing counts once the aircraft is down and slow.
    if (this._tdPending) {
      this._settleTimer += dt;
      if (ac.wow && ac.groundSpeed < 3.5 && this._settleTimer > 1.0) {
        this.completeLanding();
      } else if (this.airborne && this._settleTimer > 2.5) {
        // Bounced back into the air / go-around: discard.
        this._tdPending = null;
      } else if (this._settleTimer > 75) {
        this.completeLanding();
      }
    }

    if (ac.crashed && this.status === 'active') {
      this.status = 'failed';
      this.message = ac.crashReason;
      return;
    }

    /* --- mission-specific completion --- */
    if (this.def.id === 'checkpoint' && this.gateIdx >= this.gates.length) {
      this.finish();
    }
    if (this.def.id === 'pattern' && this.gateIdx >= this.gates.length && this.landings > 0) {
      this.finish();
    }
    if ((this.def.id === 'crosswind' || this.def.id === 'deadstick') && this.landings > 0) {
      this.finish();
    }
    if (ac.fuel <= 0 && !ac.running && ac.wow && ac.groundSpeed < 1 && this.status === 'active') {
      this.finish();
    }
  }

  runwayMetrics() {
    const ac = this.ac;
    const onRunway = Math.abs(ac.pos.z) <= AIRPORT.width / 2 + 4 && Math.abs(ac.pos.x) <= AIRPORT.length / 2 + 10;
    // Runway 27 is westbound: distance past the threshold at +800.
    const along = AIRPORT.thr27 - ac.pos.x - 300; // relative to the 300 m aiming point
    const offset = ac.pos.z;
    const eu = ac.euler();
    let crab = ((eu.heading * 180) / Math.PI) - AIRPORT.rwyHeading;
    while (crab > 180) crab -= 360;
    while (crab < -180) crab += 360;
    return { onRunway, along, offset, crab };
  }

  completeLanding() {
    const td = this._tdPending;
    this._tdPending = null;
    if (!td) return;
    const g = gradeLanding(td);
    this.landing = { ...td, ...g };
    this.landings++;
    if (!this.bestLanding || g.score > this.bestLanding.score) this.bestLanding = this.landing;
    this.push(`LANDING ${g.grade} — ${g.score}`, g.score >= 780 ? 'good' : 'warn');
  }

  finish() {
    if (this.status !== 'active') return;
    if (this._tdPending) this.completeLanding();
    this.status = 'complete';
    this.score = this.computeScore();
  }

  abandon() {
    if (this.status !== 'active') return;
    if (this._tdPending) this.completeLanding();
    this.status = this.everAirborne ? 'complete' : 'failed';
    this.score = this.computeScore();
  }

  computeScore() {
    const d = this.def;
    const land = this.bestLanding ? this.bestLanding.score : 0;
    let s = 0;
    switch (d.id) {
      case 'checkpoint': {
        s = this.gateIdx * 220;
        const par = 190;
        s += Math.max(0, Math.round((par - this.t) * 12));
        if (this.landings) s += Math.round(land * 0.3);
        break;
      }
      case 'pattern': {
        s = this.gateIdx * 120 + Math.round(land * 1.0);
        const dev = this._patternSamples ? this._patternDev / this._patternSamples : 0;
        s += Math.max(0, Math.round(220 - dev * 2.4));
        break;
      }
      case 'crosswind':
        s = Math.round(land * 1.6);
        break;
      case 'deadstick':
        s = Math.round(land * 1.2) + (this.landing && this.landing.onRunway ? 500 : 120);
        break;
      default:
        s = Math.round(this.t / 6) + Math.round(land * 0.8) + this.landings * 60;
        break;
    }
    if (this.status === 'failed') s = Math.round(s * 0.25);
    s -= Math.round(this.ac.damage * 220);
    return Math.max(0, s);
  }

  /** Short line for the objective strip. */
  objectiveLine() {
    const d = this.def;
    if (this.status === 'complete') return 'MISSION COMPLETE';
    if (this.status === 'failed') return this.message || 'FLIGHT ENDED';
    if (d.gates && this.gateIdx < this.gates.length) {
      const g = this.gates[this.gateIdx];
      const dist = this.ac.pos.distanceTo(g.pos) / 1852;
      const dy = g.pos.y - this.ac.pos.y;
      return `NEXT: ${g.label}  ${dist.toFixed(2)} NM  ${dy >= 0 ? '↑' : '↓'}${Math.abs(Math.round(dy * FT))} FT`;
    }
    if (d.id === 'pattern') return 'LAND RUNWAY 27 — FULL STOP';
    if (d.id === 'crosswind' || d.id === 'deadstick') return 'LAND THE AIRCRAFT';
    if (!this.airborne && !this.everAirborne) return 'CLEARED FOR TAKEOFF — RUNWAY 27';
    return 'FREE FLIGHT — LAND ANY TIME';
  }
}
