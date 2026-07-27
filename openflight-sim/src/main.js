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
import { createInstruments } from "./instruments.js";
import { createAudio } from "./audio.js";
import { createInput, CONTROLS_SHAPE } from "./input.js";
import { createMissions, MISSIONS } from "./missions.js";

const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 5;
const MAX_FRAME_TIME = 0.25;
const VERSION = "0.3.0";

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
  hudRoot.style.display = hudVisible ? "" : "none";
  if (next === "flying") {
    accumulator = 0;
    last = performance.now();
  }
  if (next !== "flying" && next !== "paused") {
    instruments.setHudVisible(false);
  }
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
  sim.pos.set(0, 300, -200);
  sim.prevPos.copy(sim.pos);
  sim.vel.set(0, 0, AIRFRAMES[sim.airframe].cruiseSpeed * 0.7);
  sim.quat.identity();
  sim.altitude = sim.pos.y;
  sim.airspeed = sim.vel.length();
  sim.heading = Math.atan2(sim.vel.x, sim.vel.z);
  sim.verticalSpeed = sim.vel.y;
  sim.fuel = 100;
  sim.rpm = 0.6;
  sim.throttle = 0.6;
  sim.gear = 1;
  sim.flaps = 0;
  sim.debt = 0;
  sim.t = 0;
  sim.result = null;
  missions.reset();
  sim.mission = missions.start(selectedMissionId);
  audio.init();
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

  const stats = document.createElement("div");
  stats.className = "ofs-debrief-stats";
  stats.append(
    statBlock("Duration", Math.round(sim.t) + " s"),
    statBlock("Altitude", Math.round(sim.altitude * 3.28084) + " ft"),
    statBlock("Airspeed", Math.round(sim.airspeed * 1.94384) + " kt"),
  );

  el.replaceChildren(title, gradeEl, scoreEl, summaryEl, stats);
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
  world.update(alpha, sim);
  instruments.update(sim);
  audio.update(sim);
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
    location.href = "../index.html";
    return;
  }
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
    if (k === "Enter" || k === " ") { e.preventDefault(); setScreen("briefing"); }
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
  if (btn) btn.textContent = audio.isMuted() ? "🔇" : "🔊";
}

function init() {
  setScreen("title");
  populateBriefing();
  document.getElementById("start-btn").addEventListener("click", () => { audio.init(); setScreen("briefing"); });
  document.getElementById("launch-btn").addEventListener("click", beginFlight);
  document.getElementById("resume-btn").addEventListener("click", pauseOrResume);
  document.getElementById("briefing-back-btn").addEventListener("click", () => setScreen("title"));
  document.getElementById("pause-quit-btn").addEventListener("click", () => setScreen("title"));
  document.getElementById("retry-btn").addEventListener("click", () => setScreen("briefing"));
  document.getElementById("debrief-menu-btn").addEventListener("click", () => setScreen("title"));
  document.getElementById("mute-btn").addEventListener("click", toggleMute);
  document.getElementById("back-link").addEventListener("click", (e) => { e.preventDefault(); location.href = "../index.html"; });
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
      verticalSpeed: sim.verticalSpeed,
      throttle: sim.throttle,
      fuel: sim.fuel,
      rpm: sim.rpm,
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
