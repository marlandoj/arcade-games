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
import { createFlightModel, AIRFRAMES, airframeList } from "./flight-model.js";
import { createWorld } from "./world.js";
import { createInstruments } from "./instruments.js";
import { createAudio } from "./audio.js";
import { createInput, CONTROLS_SHAPE } from "./input.js";
import { createMissions, MISSIONS } from "./missions.js";

const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 5;
const MAX_FRAME_TIME = 0.25;
const VERSION = "0.1.0";

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
  controls: { ...CONTROLS_SHAPE },
  mission: null,
  result: null,
  substeps: 0,
  accumulator: 0,
};

const flightModel = createFlightModel(sim.airframe);
const world = createWorld(scene);
const instruments = createInstruments(hudRoot);
const audio = createAudio();
const input = createInput(window);
const missions = createMissions();

let selectedAirframe = "trainer";
let selectedMissionId = "freeflight";
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
  el.innerHTML = `
    <div class="ofs-debrief-title">${m.title}</div>
    <div class="ofs-debrief-grade grade-${r.grade}">${r.grade}</div>
    <div class="ofs-debrief-score">${r.score} <span>/ 100</span></div>
    <div class="ofs-debrief-summary">${r.summary || "Flight complete."}</div>
    <div class="ofs-debrief-stats">
      <div><span>Duration</span><b>${Math.round((sim.t))} s</b></div>
      <div><span>Altitude</span><b>${Math.round(sim.altitude * 3.28084)} ft</b></div>
      <div><span>Airspeed</span><b>${Math.round(sim.airspeed * 1.94384)} kt</b></div>
    </div>`;
}

function stepSimulation(dt) {
  sim.dt = dt;
  sim.prevPos.copy(sim.pos);

  const env = atmosphere.atmosphere(sim.altitude);
  const controls = input.poll();
  sim.controls = controls;

  if (controls.hudToggle) instruments.setHudVisible(!instruments.isHudVisible());
  if (controls.viewToggle) cycleView();

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
  if (sim.altitude <= 0) { endFlight("terrain"); return; }
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
    if (steps >= MAX_SUBSTEPS && accumulator > FIXED_DT) {
      accumulator = accumulator % FIXED_DT;
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
  if (af) {
    af.innerHTML = airframeList().map((a) =>
      `<button data-airframe="${a.id}" class="${a.id === selectedAirframe ? "sel" : ""}">${a.name}<small>${a.type}</small></button>`
    ).join("");
    af.addEventListener("click", (e) => {
      const b = e.target.closest("[data-airframe]"); if (!b) return;
      selectedAirframe = b.dataset.airframe;
      [...af.children].forEach((c) => c.classList.toggle("sel", c === b));
    });
  }
  if (ms) {
    ms.innerHTML = MISSIONS.map((m) =>
      `<button data-mission="${m.id}" class="${m.id === selectedMissionId ? "sel" : ""}">${m.title}<small>${m.brief}</small></button>`
    ).join("");
    ms.addEventListener("click", (e) => {
      const b = e.target.closest("[data-mission]"); if (!b) return;
      selectedMissionId = b.dataset.mission;
      [...ms.children].forEach((c) => c.classList.toggle("sel", c === b));
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
      throttle: sim.controls.throttle,
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
