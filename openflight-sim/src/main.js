/**
 * OpenFlight Sim — Orchestrator (T1, OFS-001).
 *
 * Wires the frozen module boundaries together:
 *   fixed-step clock → atmosphere → flight-model → world → instruments → audio
 *   and drives the screen state machine (title → briefing → flying → paused →
 *   debrief). Later waves (OFS-002..005) replace the module bodies without
 *   reshaping the call sites below.
 */

import * as THREE from "three";
import * as atmosphere from "./atmosphere.js";
import { WEATHER_PRESETS } from "./atmosphere.js";
import { createFlightModel, AIRFRAMES, airframeList } from "./flight-model.js";
import { createWorld } from "./world.js";
import { createInstruments, attitudeFromQuat } from "./instruments.js";
import { createAudio } from "./audio.js";
import { createInput, CONTROLS_SHAPE } from "./input.js";
import { createMissions, MISSIONS } from "./missions.js";

const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 5;
const MAX_FRAME_TIME = 0.25;
const VERSION = "0.5.0";

const SCREENS = Object.freeze(["title", "briefing", "flying", "paused", "debrief"]);

const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 12000);
const hudRoot = document.getElementById("hud");

const sim = {
  t: 0,
  dt: FIXED_DT,
  screen: "title",
  airframe: "trainer",
  pos: new THREE.Vector3(0, 300, -200),
  prevPos: new THREE.Vector3(0, 300, -200),
  vel: new THREE.Vector3(0, 0, 60),
  quat: new THREE.Quaternion(),
  altitude: 300,
  airspeed: 60,
  heading: 0,
  verticalSpeed: 0,
  rpm: 0.6,
  fuel: 100,
  throttle: 0.6,
  gear: 1,
  flaps: 0,
  // Derived read-only state published for instruments/audio (they never mutate
  // sim). Attitude comes from the quaternion; aero/ground state from the flight
  // model. OFS-004 consumers read these; the flight model owns the truth.
  pitch: 0,
  bank: 0,
  noseHeading: 0,
  stalled: false,
  loadFactor: 1,
  aoa: 0,
  sideslip: 0,
  onGround: false,
  gearForce: 0,
  controls: { ...CONTROLS_SHAPE },
  mission: null,
  result: null,
  substeps: 0,
  accumulator: 0,
  debt: 0,
};

const flightModel = createFlightModel(sim.airframe);
const world = createWorld(scene);
const instruments = createInstruments(hudRoot);
const audio = createAudio();
const input = createInput(window);
const missions = createMissions();

let selectedAirframe = "trainer";
let selectedMissionId = "freeflight";
let selectedWeather = "calm";
let accumulator = 0;
let last = performance.now();
let rafId = 0;

function setScreen(next) {
  if (!SCREENS.includes(next)) return;
  sim.screen = next;
  for (const id of SCREENS) {
    const el = document.getElementById("screen-" + id);
    if (el) el.classList.toggle("is-active", id === next);
  }
  const hudVisible = next === "flying";
  // Use an explicit value, not "": the #hud rule defaults to display:none, so an
  // empty inline value would fall back to that and hide the whole overlay.
  hudRoot.style.display = hudVisible ? "block" : "none";
  if (next === "flying") {
    accumulator = 0;
    last = performance.now();
  }
  if (next !== "flying" && next !== "paused") {
    instruments.setHudVisible(false);
  }
  // The mission banner belongs to the live flight only.
  const banner = document.getElementById("mission-banner");
  if (banner) banner.style.display = next === "flying" ? "flex" : "none";
  document.getElementById("screen-root").dataset.screen = next;
}

function beginFlight() {
  sim.airframe = selectedAirframe;
  // Wire the briefing selection through (ZOU-920 remediation #1): the chosen
  // airframe is what actually flies.
  flightModel.setAirframe(selectedAirframe);
  // OFS-003: swap in the matching aircraft mesh and seed the ground elevation
  // from the shared terrain field so gear contact starts on the right surface.
  world.setAirframe(selectedAirframe);
  flightModel.setGroundElevation(world.terrainHeight(0, -200));
  // OFS-002: bind the chosen weather preset to the flight model's wind model
  // (steady wind + discrete gusts + continuous turbulence). Defaults to calm,
  // preserving T1 behaviour.
  flightModel.setWeatherPreset(WEATHER_PRESETS[selectedWeather] || WEATHER_PRESETS.calm);
  input.reset();

  // OFS-005: the selected mission may override the spawn state (e.g. the landing
  // approach starts ~1.8 km out on a 3° glidepath, gear down, approach flap).
  // Default matches the T1 spawn so free flight is unchanged.
  missions.reset();
  const spawn = missions.spawnFor(selectedMissionId);
  const sx = spawn ? spawn.pos[0] : 0;
  const sy = spawn ? spawn.pos[1] : 300;
  const sz = spawn ? spawn.pos[2] : -200;
  const hdg = spawn ? (spawn.heading || 0) : 0;
  const spd = AIRFRAMES[sim.airframe].cruiseSpeed * 0.7;
  sim.pos.set(sx, sy, sz);
  sim.prevPos.copy(sim.pos);
  // heading 0 ⇒ forward is +z; a yaw about world-up rotates the start vector.
  sim.vel.set(Math.sin(hdg) * spd, 0, Math.cos(hdg) * spd);
  sim.quat.setFromAxisAngle(_worldUp, hdg);
  if (spawn) input.configure({ throttle: spawn.throttle, flaps: spawn.flaps, gear: spawn.gear });
  flightModel.setGroundElevation(world.terrainHeight(sx, sz));

  sim.altitude = sim.pos.y;
  sim.airspeed = sim.vel.length();
  sim.heading = Math.atan2(sim.vel.x, sim.vel.z);
  sim.verticalSpeed = sim.vel.y;
  sim.fuel = 100;
  sim.rpm = 0.6;
  sim.throttle = spawn && typeof spawn.throttle === "number" ? spawn.throttle : 0.6;
  sim.gear = spawn && typeof spawn.gear === "number" ? spawn.gear : 1;
  sim.flaps = spawn && typeof spawn.flaps === "number" ? spawn.flaps : 0;
  sim.debt = 0;
  sim.t = 0;
  sim.result = null;
  sim.mission = missions.start(selectedMissionId);
  // Hand the navigation course (if any) to the world so the gate rings render.
  world.setCourse(missions.course());
  updateMissionBanner();
  audio.init();
  // The HUD glass defaults on at the start of a flight; the H toggle (and its
  // state through a pause) is preserved by setScreen.
  instruments.setHudVisible(true);
  setScreen("flying");
}

function endFlight(reason) {
  sim.result = missions.end(reason, sim);
  renderDebrief();
  setScreen("debrief");
}

function renderDebrief() {
  const r = sim.result || missions.grade(sim);
  const el = document.getElementById("debrief-content");
  if (!el) return;
  const m = MISSIONS.find((x) => x.id === selectedMissionId) || MISSIONS[0];

  // Build the debrief with the DOM API + textContent so data-derived strings
  // (mission title, grade, score, summary) cannot inject HTML (ZOU-920 #6).
  const VALID_GRADES = ["S", "A", "B", "C", "D"];
  const grade = VALID_GRADES.includes(r.grade) ? r.grade : "C";

  const title = document.createElement("div");
  title.className = "ofs-debrief-title";
  title.textContent = m.title;

  const gradeEl = document.createElement("div");
  gradeEl.className = "ofs-debrief-grade grade-" + grade;
  gradeEl.textContent = grade;

  const scoreEl = document.createElement("div");
  scoreEl.className = "ofs-debrief-score";
  const scoreSpan = document.createElement("span");
  scoreSpan.textContent = "/ 100";
  scoreEl.append(String(r.score), " ", scoreSpan);

  const summaryEl = document.createElement("div");
  summaryEl.className = "ofs-debrief-summary";
  summaryEl.textContent = r.summary || "Flight complete.";

  // Mission-specific stats (owned by the mission layer); fall back to the
  // generic flight readout for any result without its own stats.
  const stats = document.createElement("div");
  stats.className = "ofs-debrief-stats";
  const rows = Array.isArray(r.stats) && r.stats.length
    ? r.stats.map((s) => statBlock(String(s.label), String(s.value)))
    : [
        statBlock("Duration", Math.round(sim.t) + " s"),
        statBlock("Altitude", Math.round(sim.altitude * 3.28084) + " ft"),
        statBlock("Airspeed", Math.round(sim.airspeed * 1.94384) + " kt"),
      ];
  stats.append(...rows);

  // Session scoring: persisted per-mission best, with a badge on a new record.
  const hs = document.createElement("div");
  hs.className = "ofs-debrief-high";
  if (r.isRecord) {
    const badge = document.createElement("span");
    badge.className = "ofs-record";
    badge.textContent = "★ NEW RECORD";
    hs.append(badge);
  } else {
    hs.textContent = "BEST " + (r.highScore != null ? r.highScore : 0) + " / 100";
  }

  el.replaceChildren(title, gradeEl, scoreEl, summaryEl, stats, hs);
}

// OFS-005: live mission objective banner (top-centre while flying). Reflects the
// active mission's progress — next gate + range, hold-timer, or approach sink /
// centreline — and the persisted per-mission high score.
function updateMissionBanner() {
  const banner = document.getElementById("mission-banner");
  if (!banner) return;
  const p = sim.screen === "flying" ? missions.progress(sim) : null;
  if (!p) { banner.style.display = "none"; return; }
  const m = missions.active();
  const hi = m ? missions.highScore(m.id) : 0;
  const label = document.getElementById("mission-banner-label");
  const detail = document.getElementById("mission-banner-detail");
  const best = document.getElementById("mission-banner-best");
  if (label) label.textContent = p.label;
  if (detail) detail.textContent = p.detail;
  if (best) best.textContent = hi > 0 ? "BEST " + hi : "";
  banner.style.display = "flex";
}

function statBlock(label, value) {
  const wrap = document.createElement("div");
  const s = document.createElement("span");
  s.textContent = label;
  const b = document.createElement("b");
  b.textContent = value;
  wrap.append(s, b);
  return wrap;
}

function stepSimulation(dt) {
  sim.dt = dt;
  sim.prevPos.copy(sim.pos);

  const env = atmosphere.atmosphere(sim.altitude);
  const controls = input.poll();
  sim.controls = controls;
  // Publish control display state onto the live sim object (ZOU-920 #9) so
  // instruments read stable sim fields instead of the replaced controls snapshot.
  sim.throttle = controls.throttle;
  sim.gear = controls.gear;
  sim.flaps = controls.flaps;

  if (controls.hudToggle) instruments.setHudVisible(!instruments.isHudVisible());
  if (controls.viewToggle) cycleView();

  // OFS-003: the flight model's gear/ground reaction reads the same seeded
  // terrain surface the player sees, so contact and collision agree with it.
  flightModel.setGroundElevation(world.terrainHeight(sim.pos.x, sim.pos.z));

  flightModel.step(dt, sim, env, controls);

  sim.altitude = sim.pos.y;
  sim.airspeed = sim.vel.length();
  sim.heading = Math.atan2(sim.vel.x, sim.vel.z);
  sim.verticalSpeed = sim.vel.y;
  sim.rpm = 0.5 + 0.5 * controls.throttle;
  sim.fuel = Math.max(0, sim.fuel - 0.02 * controls.throttle * dt);
  sim.t += dt;

  // Publish derived read-only state for the instruments and audio (OFS-004).
  // Attitude (nose pitch/bank/heading) is read straight off the quaternion; the
  // aero and ground-reaction state come from the flight model, which owns them.
  const att = attitudeFromQuat(sim.quat);
  sim.pitch = att.pitch;
  sim.bank = att.bank;
  sim.noseHeading = att.heading;
  const aero = flightModel.aeroState();
  const fw = flightModel.forces();
  sim.stalled = !!aero.stalled;
  sim.loadFactor = aero.loadFactor;
  sim.aoa = aero.alpha;
  sim.sideslip = aero.beta;
  sim.gearForce = fw.gear;
  sim.onGround = fw.gear > 50; // meaningful weight on wheels

  missions.update(dt, sim);

  if (sim.fuel <= 0) { endFlight("fuel"); return; }
  // Terrain collision uses the queried surface elevation under the aircraft, so
  // the crash floor follows the hills instead of a flat plane at y=0.
  if (sim.altitude <= world.terrainHeight(sim.pos.x, sim.pos.z)) { endFlight("terrain"); return; }
  const rem = missions.remaining();
  if (isFinite(rem) && rem <= 0) { endFlight("complete"); return; }
}

let viewMode = "chase";
function cycleView() {
  viewMode = viewMode === "chase" ? "orbit" : "chase";
  world.setView(viewMode);
}

const _worldUp = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
function updateCamera(alpha) {
  _forward.set(0, 0, 1).applyQuaternion(sim.quat);
  if (viewMode === "chase") {
    _camPos.copy(sim.pos).addScaledVector(_forward, -34).add(new THREE.Vector3(0, 10, 0));
    _camTarget.copy(sim.pos).addScaledVector(_forward, 12);
  } else {
    _camPos.copy(sim.pos).add(new THREE.Vector3(28, 14, -28));
    _camTarget.copy(sim.pos);
  }
  camera.position.lerp(_camPos, 0.08);
  _camTarget.lerpVectors(sim.prevPos, sim.pos, alpha);
  camera.lookAt(_camTarget);
}

function render(alpha) {
  world.setActiveGate(missions.activeGateIndex());
  world.update(alpha, sim);
  instruments.update(sim);
  audio.update(sim);
  if (sim.screen === "flying") updateMissionBanner();
  updateCamera(alpha);
  renderer.render(scene, camera);
}

function frame(now) {
  rafId = requestAnimationFrame(frame);
  let frameTime = (now - last) / 1000;
  last = now;
  if (frameTime > MAX_FRAME_TIME) frameTime = MAX_FRAME_TIME;

  let steps = 0;
  if (sim.screen === "flying") {
    accumulator += frameTime;
    while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      stepSimulation(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
      if (sim.screen !== "flying") break;
    }
    // A slow frame cannot explode the integrator (ZOU-920 remediation #2):
    // the substep budget stays bounded; if there is still unprocessed time
    // after MAX_SUBSTEPS, drop the excess and record it as debt instead of
    // modulo-wrapping (which silently discarded sim time and let elapsed
    // sim time diverge from wall time under load).
    if (steps >= MAX_SUBSTEPS && accumulator > 0) {
      sim.debt += accumulator;
      accumulator = 0;
    }
  }
  sim.substeps = steps;
  sim.accumulator = accumulator;

  const alpha = sim.screen === "flying" ? accumulator / FIXED_DT : 1;
  render(alpha);
}

function pauseOrResume() {
  if (sim.screen === "flying") setScreen("paused");
  else if (sim.screen === "paused") setScreen("flying");
}

window.addEventListener("keydown", onKey);
window.addEventListener("resize", onResize);

function onKey(e) {
  const k = e.key;
  if (k === "Escape") {
    e.preventDefault();
    // A visible controls reference swallows Esc first, so it does not eject the
    // player to the arcade while they are reading the reference.
    if (isControlsOpen()) { closeControls(); return; }
    location.href = "../index.html";
    return;
  }
  if (k === "c" || k === "C") { e.preventDefault(); toggleControls(); return; }
  if (k === "p" || k === "P") {
    e.preventDefault();
    pauseOrResume();
    return;
  }
  if (sim.screen === "title") {
    if (k === "Enter" || k === " ") { e.preventDefault(); setScreen("briefing"); audio.init(); }
  } else if (sim.screen === "briefing") {
    if (k === "Enter" || k === " ") { e.preventDefault(); beginFlight(); }
    if (k === "Backspace") { e.preventDefault(); setScreen("title"); }
  } else if (sim.screen === "flying") {
    if (k === "m" || k === "M") { e.preventDefault(); toggleMute(); }
  } else if (sim.screen === "paused") {
    if (k === "Backspace") { e.preventDefault(); setScreen("title"); }
  } else if (sim.screen === "debrief") {
    if (k === "Enter" || k === " ") { e.preventDefault(); beginFlight(); }
    if (k === "Backspace") { e.preventDefault(); setScreen("title"); }
  }
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function toggleMute() {
  audio.setMuted(!audio.isMuted());
  const btn = document.getElementById("mute-btn");
  if (btn) {
    btn.textContent = audio.isMuted() ? "🔇" : "🔊";
    btn.setAttribute("aria-pressed", String(audio.isMuted()));
  }
}

// Controls reference — reachable from the shell via the "?" button or the C key
// (and closable with Esc). It is a static overlay listing every input method.
function isControlsOpen() {
  const el = document.getElementById("controls-modal");
  return !!el && el.classList.contains("is-open");
}
function openControls() {
  const el = document.getElementById("controls-modal");
  if (el) el.classList.add("is-open");
}
function closeControls() {
  const el = document.getElementById("controls-modal");
  if (el) el.classList.remove("is-open");
}
function toggleControls() { isControlsOpen() ? closeControls() : openControls(); }

function init() {
  setScreen("title");
  populateBriefing();
  document.getElementById("start-btn").addEventListener("click", () => { audio.init(); setScreen("briefing"); });
  document.getElementById("launch-btn").addEventListener("click", beginFlight);
  document.getElementById("resume-btn").addEventListener("click", pauseOrResume);
  document.getElementById("briefing-back-btn").addEventListener("click", () => setScreen("title"));
  document.getElementById("pause-quit-btn").addEventListener("click", () => setScreen("title"));
  // Retry drops straight back into the same mission (same airframe/weather);
  // the ghost TITLE button returns to the menu to reconfigure.
  document.getElementById("retry-btn").addEventListener("click", beginFlight);
  document.getElementById("debrief-menu-btn").addEventListener("click", () => setScreen("title"));
  document.getElementById("mute-btn").addEventListener("click", toggleMute);
  document.getElementById("back-link").addEventListener("click", (e) => { e.preventDefault(); location.href = "../index.html"; });
  const helpBtn = document.getElementById("help-btn");
  if (helpBtn) helpBtn.addEventListener("click", toggleControls);
  const closeBtn = document.getElementById("controls-close");
  if (closeBtn) closeBtn.addEventListener("click", closeControls);
  const modal = document.getElementById("controls-modal");
  if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closeControls(); });
  rafId = requestAnimationFrame(frame);
}

function populateBriefing() {
  const af = document.getElementById("briefing-airframe");
  const ms = document.getElementById("briefing-mission");
  const wx = document.getElementById("briefing-weather");
  // Build the briefing with the DOM API + textContent (ZOU-920 remediation #6)
  // so airframe/mission names and summaries cannot inject markup.
  if (af) {
    af.replaceChildren(...airframeList().map((a) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.airframe = a.id;
      if (a.id === selectedAirframe) btn.classList.add("sel");
      const small = document.createElement("small");
      small.textContent = a.type;
      btn.append(a.name, small);
      return btn;
    }));
    af.addEventListener("click", (e) => {
      const b = e.target.closest("[data-airframe]"); if (!b) return;
      selectedAirframe = b.dataset.airframe;
      [...af.children].forEach((c) => c.classList.toggle("sel", c === b));
    });
  }
  if (ms) {
    ms.replaceChildren(...MISSIONS.map((m) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.mission = m.id;
      if (m.id === selectedMissionId) btn.classList.add("sel");
      const small = document.createElement("small");
      small.textContent = m.brief;
      btn.append(m.title, small);
      return btn;
    }));
    ms.addEventListener("click", (e) => {
      const b = e.target.closest("[data-mission]"); if (!b) return;
      selectedMissionId = b.dataset.mission;
      [...ms.children].forEach((c) => c.classList.toggle("sel", c === b));
    });
  }
  // OFS-002: weather preset picker. Per-preset steady wind, discrete gusts and
  // continuous turbulence are configured here and bound to the flight model on
  // launch (defaults to Calm, so T1 behaviour is unchanged).
  if (wx) {
    const presets = Object.values(WEATHER_PRESETS);
    wx.replaceChildren(...presets.map((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.weather = p.id;
      if (p.id === selectedWeather) btn.classList.add("sel");
      const small = document.createElement("small");
      small.textContent = `wind ${p.windN} m/s · gust ${p.gustiness} · turb ${p.turbulence}`;
      btn.append(p.label, small);
      return btn;
    }));
    wx.addEventListener("click", (e) => {
      const b = e.target.closest("[data-weather]"); if (!b) return;
      selectedWeather = b.dataset.weather;
      [...wx.children].forEach((c) => c.classList.toggle("sel", c === b));
    });
  }
}

const OPENFLIGHT = Object.freeze({
  get version() { return VERSION; },
  get screen() { return sim.screen; },
  get airframe() { return sim.airframe; },
  get clock() {
    return Object.freeze({
      fixedDt: FIXED_DT,
      maxSubsteps: MAX_SUBSTEPS,
      maxFrameTime: MAX_FRAME_TIME,
      accumulator: sim.accumulator,
      substeps: sim.substeps,
      debt: sim.debt,
      simTime: sim.t,
    });
  },
  get state() {
    return Object.freeze({
      t: sim.t,
      screen: sim.screen,
      airframe: sim.airframe,
      altitude: sim.altitude,
      airspeed: sim.airspeed,
      heading: sim.heading,
      noseHeading: sim.noseHeading,
      verticalSpeed: sim.verticalSpeed,
      pitch: sim.pitch,
      bank: sim.bank,
      stalled: sim.stalled,
      loadFactor: sim.loadFactor,
      onGround: sim.onGround,
      throttle: sim.throttle,
      fuel: sim.fuel,
      rpm: sim.rpm,
      muted: audio.isMuted(),
      hudVisible: instruments.isHudVisible(),
      pos: sim.pos.toArray(),
      vel: sim.vel.toArray(),
      quat: sim.quat.toArray(),
      mission: sim.mission ? sim.mission.id : null,
      result: sim.result,
    });
  },
  get boundaries() {
    return Object.freeze({
      atmosphere: atmosphere.__OFS_BOUNDARY__,
      flightModel: "flight-model",
      world: "world",
      instruments: "instruments",
      audio: "audio",
      input: "input",
      missions: "missions",
    });
  },
  help() {
    return "OPENFLIGHT.state — frozen sim snapshot; OPENFLIGHT.clock — fixed-step stats; OPENFLIGHT.screen — current screen.";
  },
});
Object.defineProperty(window, "OPENFLIGHT", { value: OPENFLIGHT, writable: false, configurable: false });

init();
