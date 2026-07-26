/**
 * Opus 5 Flight Sim — orchestrator.
 *
 * Owns the scene graph, the fixed-step physics clock, the camera rig, the
 * shell UI (menu / pause / debrief), and the per-frame data flow from the
 * flight model out to the instruments, HUD, nav display, and audio engine.
 *
 * Physics run at a fixed 300 Hz regardless of frame rate; rendering and
 * instrument redraws are decoupled and run once per animation frame.
 */

import * as THREE from 'three';

import { AIRCRAFT, AIRCRAFT_ORDER, FlightModel } from './aircraft.js';
import { AircraftModel } from './model.js';
import { WindModel, WEATHER_PRESETS } from './atmosphere.js';
import {
  AIRPORT, Terrain, Sky, TIME_PRESETS, sunDirection,
  buildWater, CloudLayer, Airport, buildScenery,
} from './world.js';
import { InstrumentPanel, HUD } from './instruments.js';
import { SimAudio } from './audio.js';
import { Input, KEYMAP } from './input.js';
import { MISSIONS, MissionRun, missionById, bestFor, saveHighScore } from './missions.js';

const KT = 1.94384;
const FT = 3.28084;
const FPM = 196.85;
const DEG = Math.PI / 180;
const PHYS_DT = 1 / 300;
const MAX_SUBSTEPS = 45;

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const raf = () => new Promise((r) => requestAnimationFrame(r));

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

const TIME_ORDER = ['dawn', 'day', 'dusk', 'night'];
const WX_ORDER = ['calm', 'breezy', 'gusty', 'storm'];

const REALISM = {
  assisted: { label: 'ASSISTED', assists: true, damageOn: false, note: 'Auto-coordinated rudder, no airframe damage.' },
  standard: { label: 'STANDARD', assists: false, damageOn: true, note: 'Full aerodynamics. Damage on.' },
  full: { label: 'FULL', assists: false, damageOn: true, hard: true, note: 'No assists, no mercy.' },
};
const REALISM_ORDER = ['assisted', 'standard', 'full'];

const CONTROLS = {
  keyboard: { label: 'KEYBOARD', yoke: false },
  yoke: { label: 'MOUSE YOKE', yoke: true },
};
const CONTROL_ORDER = ['keyboard', 'yoke'];

const VIEWS = ['cockpit', 'chase', 'orbit', 'tower'];
const VIEW_LABEL = { cockpit: 'COCKPIT', chase: 'CHASE', orbit: 'ORBIT', tower: 'TOWER' };

const PAVED_DRY = { rollMu: 0.018, gripMu: 0.80, rough: 0.06 };
const PAVED_WET = { rollMu: 0.020, gripMu: 0.45, rough: 0.06 };

/* ------------------------------------------------------------------ */
/* Sim                                                                 */
/* ------------------------------------------------------------------ */

const sim = {
  mode: 'loading',
  sel: { aircraft: 'trainer', mission: 'pattern', time: 'day', weather: 'breezy', realism: 'standard', controls: 'keyboard' },
  view: 'chase',
  hudOn: true,
  navOn: true,
  lightOn: false,
  muted: false,
  t: 0,
  accum: 0,
  last: 0,
  orbitAngle: 0,
  tickerUntil: 0,
  papi: null,
  fps: 60,
};

const audio = new SimAudio();
const wind = new WindModel(WEATHER_PRESETS.breezy);
const windVec = new THREE.Vector3();

let renderer, scene, camera, sky, sun, ambient, hemi, water, terrain, terrainMesh, airport, scenery, clouds;
let panel, hud, input, ac, model, run;
const modelCache = new Map();

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
const _look = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function setLoad(pct, msg) {
  $('loadBar').style.transform = `scaleX(${pct / 100})`;
  $('loadMsg').textContent = msg;
}

async function boot() {
  const canvas = $('scene');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.4, 60000);
  camera.position.set(AIRPORT.thr27, AIRPORT.elev + 40, 220);

  setLoad(8, 'Sculpting terrain…');
  await raf();
  terrain = new Terrain({ wetRunway: false });
  terrainMesh = terrain.buildMesh(360, 20000);
  scene.add(terrainMesh);

  setLoad(34, 'Raising the sky…');
  await raf();
  sky = new Sky();
  scene.add(sky.mesh);
  water = buildWater();
  scene.add(water);

  ambient = new THREE.AmbientLight(0xffffff, 0.5);
  hemi = new THREE.HemisphereLight(0x9fc3f0, 0x4a4436, 0.45);
  sun = new THREE.DirectionalLight(0xfff6e8, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 3600;
  sun.shadow.camera.left = -320;
  sun.shadow.camera.right = 320;
  sun.shadow.camera.top = 320;
  sun.shadow.camera.bottom = -320;
  sun.shadow.bias = -0.0004;
  scene.add(ambient, hemi, sun, sun.target);

  setLoad(56, 'Paving runway 27…');
  await raf();
  airport = new Airport(terrain);
  scene.add(airport.group);

  setLoad(76, 'Planting the valley…');
  await raf();
  scenery = buildScenery(terrain);
  scene.add(scenery);

  setLoad(90, 'Stacking cumulus…');
  await raf();
  applyWeatherVisuals(sim.sel.weather, true);
  applyTimeOfDay(sim.sel.time, sim.sel.weather);

  setLoad(97, 'Preflight checks…');
  await raf();
  panel = new InstrumentPanel($('panelCanvas'), AIRCRAFT[sim.sel.aircraft]);
  hud = new HUD($('hud'));
  input = new Input({ canvas });
  input.enabled = false;
  bindUI();
  resize();
  window.addEventListener('resize', resize);

  setLoad(100, 'Ready');
  await raf();
  $('loader').style.display = 'none';
  showScreen('menu');
  sim.mode = 'menu';
  sim.last = performance.now();
  requestAnimationFrame(frame);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const hc = $('hud');
  hc.style.width = '100%';
  hc.style.height = '100%';
  hc.width = Math.round(w * dpr);
  hc.height = Math.round(h * dpr);
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

function applyWeatherVisuals(wxKey, force = false) {
  const wx = WEATHER_PRESETS[wxKey];
  if (!force && clouds && clouds._key === wxKey) return;
  if (clouds) {
    scene.remove(clouds.mesh);
    clouds.mesh.geometry.dispose();
    clouds.mesh.material.dispose();
  }
  clouds = new CloudLayer({
    base: wx.cloudBase,
    coverage: wx.overcast,
    count: 620,
    spread: 26000,
  });
  clouds._key = wxKey;
  scene.add(clouds.mesh);
  terrain.paved = wxKey === 'storm' ? PAVED_WET : PAVED_DRY;
}

function applyTimeOfDay(timeKey, wxKey) {
  const tp = TIME_PRESETS[timeKey];
  const wx = WEATHER_PRESETS[wxKey];
  const dir = sunDirection(tp.elev, tp.azim);
  const overcastDim = 1 - wx.overcast * 0.45;

  sky.setSun(dir, tp.night, tp.turb + wx.overcast * 0.8);
  sun.color.setHex(tp.sun);
  sun.intensity = tp.sunI * overcastDim;
  ambient.intensity = tp.amb * (0.75 + wx.overcast * 0.5);
  hemi.intensity = 0.30 + tp.amb * 0.5;
  hemi.color.setHex(tp.night > 0.5 ? 0x2a3550 : 0x9fc3f0);

  const fog = new THREE.Color(tp.fog);
  if (tp.night > 0.5) fog.multiplyScalar(0.55);
  scene.fog = new THREE.Fog(fog, wx.visibility * 0.10, wx.visibility * 1.20);
  renderer.setClearColor(fog, 1);
  sim.sunDir = dir;
  sim.night = tp.night;
  sim.cloudTint = new THREE.Color(tp.fog);
  sim.cloudTop = new THREE.Color(tp.sun).lerp(new THREE.Color(0xffffff), 0.35);
}

/* ------------------------------------------------------------------ */
/* Menu                                                                */
/* ------------------------------------------------------------------ */

function optionRow(el, order, table, selKey, onPick) {
  el.innerHTML = '';
  for (const key of order) {
    const b = document.createElement('button');
    b.className = 'opt' + (sim.sel[selKey] === key ? ' sel' : '');
    b.textContent = table[key].label;
    b.onclick = () => { sim.sel[selKey] = key; onPick && onPick(key); renderMenu(); };
    el.appendChild(b);
  }
}

function renderMenu() {
  /* --- aircraft --- */
  const acEl = $('acList');
  acEl.innerHTML = '';
  for (const id of AIRCRAFT_ORDER) {
    const c = AIRCRAFT[id];
    const best = bestFor(sim.sel.mission, id);
    const vsKt = Math.round(c.limits.vs * KT);
    const vneKt = Math.round(c.limits.vne * KT);
    const card = document.createElement('button');
    card.className = 'card' + (sim.sel.aircraft === id ? ' sel' : '');
    card.innerHTML =
      `${best ? `<div class="best">BEST ${best}</div>` : ''}` +
      `<div class="cname">${c.name}</div>` +
      `<div class="cclass">${c.class}</div>` +
      `<div class="cdesc">${c.blurb}</div>` +
      `<div class="cstats">` +
      `<span>${Math.round(c.mass)} KG</span>` +
      `<span>VS ${vsKt} KT</span>` +
      `<span>VNE ${vneKt} KT</span>` +
      `<span>${c.engine.type === 'turbofan' ? 'TURBOFAN' : Math.round(c.engine.power / 745.7) + ' HP'}</span>` +
      `<span>${c.gear.retractable ? 'RETRACT' : 'FIXED GEAR'}</span>` +
      `</div>`;
    card.onclick = () => { sim.sel.aircraft = id; renderMenu(); };
    acEl.appendChild(card);
  }

  /* --- missions --- */
  const msEl = $('msList');
  msEl.innerHTML = '';
  for (const m of MISSIONS) {
    const best = bestFor(m.id, sim.sel.aircraft);
    const card = document.createElement('button');
    card.className = 'card' + (sim.sel.mission === m.id ? ' sel' : '');
    card.innerHTML =
      `${best ? `<div class="best">BEST ${best}</div>` : ''}` +
      `<div class="cname">${m.name}</div>` +
      `<div class="cclass">${m.tagline}</div>` +
      `<div class="cdesc">${m.brief}</div>` +
      `<div class="cstats">${m.objectives.map((o) => `<span>${o}</span>`).join('')}</div>`;
    card.onclick = () => {
      sim.sel.mission = m.id;
      sim.sel.weather = m.weather || sim.sel.weather;
      sim.sel.time = m.time || sim.sel.time;
      renderMenu();
    };
    msEl.appendChild(card);
  }

  optionRow($('timeOpts'), TIME_ORDER, TIME_PRESETS, 'time');
  optionRow($('wxOpts'), WX_ORDER, WEATHER_PRESETS, 'weather');
  optionRow($('diffOpts'), REALISM_ORDER, REALISM, 'realism');
  optionRow($('ctrlOpts'), CONTROL_ORDER, CONTROLS, 'controls');
}

function fillKeys() {
  const html = KEYMAP.map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join('');
  $('keyList').innerHTML = html;
  $('keyList2').innerHTML = html;
}

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id);
  const flying = id === null;
  $('panelWrap').classList.toggle('on', flying && sim.view === 'cockpit');
  $('nav').classList.toggle('on', flying && sim.navOn);
  $('top').style.display = flying ? 'flex' : 'none';
  $('annun').style.display = flying ? 'flex' : 'none';
  $('back').style.display = flying ? 'none' : 'block';
}

function bindUI() {
  fillKeys();
  renderMenu();

  $('startBtn').onclick = () => startFlight();
  $('keysBtn').onclick = () => {
    const b = $('keysBlock');
    b.style.display = b.style.display === 'none' ? 'block' : 'none';
  };
  $('resumeBtn').onclick = () => resumeFlight();
  $('restartBtn').onclick = () => startFlight();
  $('endBtn').onclick = () => { run.abandon(); endFlight(); };
  $('menuBtn').onclick = () => toMenu();
  $('againBtn').onclick = () => startFlight();
  $('db2Menu').onclick = () => toMenu();

  /* touch */
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  if (isTouch) {
    $('touch').classList.add('on');
    input.bindTouch($('stick'), $('knob'), $('thr'), $('thrKnob'));
    input.bindHold($('tFlapD'), () => input.cmd('flapsDown'));
    input.bindHold($('tFlapU'), () => input.cmd('flapsUp'));
    input.bindHold($('tGear'), () => input.cmd('gear'));
    input.bindHold($('tBrake'), () => { input.touch.brake = 1; }, () => { input.touch.brake = 0; });
    input.bindHold($('tView'), () => input.cmd('view'));
  }

  $('scene').addEventListener('click', () => {
    if (sim.mode === 'flying' && CONTROLS[sim.sel.controls].yoke && !input.pointerLocked) {
      input.requestYoke($('scene'));
    }
  });
}

/* ------------------------------------------------------------------ */
/* Flight lifecycle                                                    */
/* ------------------------------------------------------------------ */

function getModel(cfg) {
  if (!modelCache.has(cfg.id)) {
    const m = new AircraftModel(cfg);
    modelCache.set(cfg.id, m);
    scene.add(m.root);
  }
  return modelCache.get(cfg.id);
}

function startFlight() {
  const def = missionById(sim.sel.mission);
  const cfg = AIRCRAFT[sim.sel.aircraft];

  applyWeatherVisuals(sim.sel.weather);
  applyTimeOfDay(sim.sel.time, sim.sel.weather);

  const wx = WEATHER_PRESETS[sim.sel.weather];
  wind.set(def.windOverride || {
    dirDeg: wx.dirDeg, speed: wx.speed, gust: wx.gust, turbulence: wx.turbulence,
  });
  wind.t = 0;

  ac = new FlightModel(cfg.id, terrain);
  for (const [, m] of modelCache) m.setVisible(false);
  model = getModel(cfg);
  model.setVisible(true);
  panel.setAircraft(cfg);
  audio.init(cfg.engine.type);
  audio.resume();
  audio.setMuted(sim.muted);

  const cruise = cfg.limits.vs * 1.75;
  switch (def.start) {
    case 'runway27':
      ac.placeOnGround(AIRPORT.thr27 - 45, 0, AIRPORT.rwyHeading);
      ac.input.parkBrake = true;
      break;
    case 'final': {
      const d = 4 * 1852;
      const x = AIRPORT.thr27 + d;
      const y = AIRPORT.elev + d * Math.tan(AIRPORT.glideDeg * DEG) + 15;
      ac.placeInAir(x, y, 0, AIRPORT.rwyHeading, cfg.limits.vs * 1.35);
      ac.flapIdx = Math.max(0, cfg.flapDetents.length - 2);
      ac.gearCmd = 1; ac.gearPos = 1;
      break;
    }
    case 'deadstick':
      ac.placeInAir(-2600, AIRPORT.elev + 1220, -1800, 90, cruise);
      ac.running = false;
      ac.input.throttle = 0;
      ac.throttleActual = 0;
      break;
    default:
      ac.placeInAir(2600, AIRPORT.elev + 915, 600, AIRPORT.rwyHeading, cruise);
      break;
  }

  input.throttle = ac.input.throttle;
  input.axes.pitch = input.axes.roll = input.axes.yaw = 0;
  input.touch.throttle = null;
  input.invertPitch = false;
  input.enabled = true;

  run = new MissionRun(def, ac);
  sim.endScheduled = false;
  sim.view = def.start === 'runway27' ? 'chase' : 'cockpit';
  sim.lightOn = TIME_PRESETS[sim.sel.time].night > 0.4 || def.start !== 'runway27';
  sim.mode = 'flying';
  sim.accum = 0;
  sim.last = performance.now();
  sim.orbitAngle = 0;
  camera.fov = 62;
  camera.updateProjectionMatrix();

  showScreen(null);
  applyViewChrome();
  ticker(def.name, 2200);
  if (CONTROLS[sim.sel.controls].yoke) input.requestYoke($('scene'));
}

function resumeFlight() {
  if (!run || run.status !== 'active') return;
  sim.mode = 'flying';
  input.enabled = true;
  sim.last = performance.now();
  sim.accum = 0;
  showScreen(null);
  applyViewChrome();
  audio.resume();
  if (CONTROLS[sim.sel.controls].yoke) input.requestYoke($('scene'));
}

function pauseFlight() {
  if (sim.mode !== 'flying') return;
  sim.mode = 'paused';
  input.enabled = false;
  input.releaseYoke();
  renderPause();
  showScreen('pause');
}

function toMenu() {
  if (run && run.status === 'active') run.abandon();
  sim.mode = 'menu';
  input.enabled = false;
  input.releaseYoke();
  renderMenu();
  showScreen('menu');
}

function endFlight() {
  sim.mode = 'debrief';
  input.enabled = false;
  input.releaseYoke();
  const score = run.score || run.computeScore();
  const isNew = saveHighScore(run.def.id, ac.type, score);
  renderDebrief(score, isNew);
  showScreen('debrief');
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

function row(l, v, p) {
  return `<div class="row"><span class="l">${l}</span><span class="v">${v}</span>` +
    (p === undefined ? '' : `<span class="p${p === 0 ? ' zero' : ''}">${p === 0 ? '—' : '-' + p}</span>`) +
    `</div>`;
}

function renderPause() {
  const eu = ac.euler();
  $('pauseStats').innerHTML =
    row('Aircraft', ac.cfg.name) +
    row('Mission', run.def.name) +
    row('Elapsed', fmtTime(run.t)) +
    row('Indicated airspeed', `${Math.round(ac.ias * KT)} kt`) +
    row('Altitude', `${Math.round(ac.pos.y * FT)} ft MSL`) +
    row('Heading', `${String(Math.round((eu.heading / DEG) % 360)).padStart(3, '0')}°`) +
    row('Fuel remaining', `${Math.round((ac.fuel / ac.cfg.engine.fuel) * 100)}%`) +
    row('Landings', String(run.landings)) +
    row('Running score', String(run.computeScore()));
}

function renderDebrief(score, isNew) {
  const L = run.bestLanding;
  const def = run.def;
  $('dbTitle').textContent = run.status === 'failed' ? 'FLIGHT ENDED' : 'DEBRIEF';
  $('dbVerdict').textContent = run.status === 'failed'
    ? (run.message || 'The aircraft did not make it home.')
    : (L ? L.verdict : 'NO LANDING RECORDED');
  $('dbGrade').textContent = L ? L.grade : '—';
  $('dbScore').textContent = String(score);
  $('dbScoreLabel').textContent = def.scoreLabel || 'SCORE';
  $('dbBest').textContent = String(bestFor(def.id, ac.type));
  $('dbBest').style.color = isNew ? '#7ef7c0' : '';

  let html = '';
  if (L) {
    html += L.parts.map((p) => row(p.label, p.text, p.lost)).join('');
    html += row('Landing subtotal', `${L.score} / 1000`);
  }
  html += row('Mission', def.name);
  html += row('Aircraft', ac.cfg.name);
  html += row('Time aloft', fmtTime(run.t));
  if (run.gates && run.gates.length) html += row('Gates', `${run.gateIdx} / ${run.gates.length}`);
  html += row('Landings', String(run.landings));
  html += row('Max G', `${ac.gPeak.toFixed(1)} g`);
  html += row('Airframe damage', `${Math.round(ac.damage * 100)}%`);
  html += row('Fuel used', `${Math.round((1 - ac.fuel / ac.cfg.engine.fuel) * 100)}%`);
  if (isNew) html += row('PERSONAL BEST', 'NEW RECORD');
  $('dbTable').innerHTML = html;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function ticker(msg, ms = 1500) {
  const el = $('ticker');
  el.textContent = msg;
  el.classList.add('on');
  sim.tickerUntil = performance.now() + ms;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

function applyViewChrome() {
  const flying = sim.mode === 'flying';
  $('panelWrap').classList.toggle('on', flying && sim.view === 'cockpit');
  $('nav').classList.toggle('on', flying && sim.navOn);
  if (model) model.setVisible(sim.view !== 'cockpit');
  $('swView').innerHTML = `VIEW <b>${VIEW_LABEL[sim.view]}</b>`;
}

function handleCommands() {
  for (const c of input.drain()) {
    switch (c) {
      case 'pause':
        if (sim.mode === 'flying') pauseFlight();
        else if (sim.mode === 'paused') resumeFlight();
        break;
      case 'reset':
        if (sim.mode === 'flying' || sim.mode === 'paused') startFlight();
        break;
      case 'view':
        sim.view = VIEWS[(VIEWS.indexOf(sim.view) + 1) % VIEWS.length];
        applyViewChrome();
        audio.click(520);
        break;
      case 'hud':
        sim.hudOn = !sim.hudOn;
        ticker(sim.hudOn ? 'HUD ON' : 'HUD OFF', 900);
        break;
      case 'nav':
        sim.navOn = !sim.navOn;
        applyViewChrome();
        break;
      case 'light':
        sim.lightOn = !sim.lightOn;
        audio.click(300);
        break;
      case 'mute':
        sim.muted = !sim.muted;
        audio.setMuted(sim.muted);
        ticker(sim.muted ? 'AUDIO MUTED' : 'AUDIO ON', 900);
        break;
      case 'yoke':
        if (input.mouseYoke) input.releaseYoke();
        else input.requestYoke($('scene'));
        break;
      case 'flapsDown':
        if (ac && ac.cycleFlaps(1)) { audio.click(260); ticker(`FLAPS ${ac.flapDeg()}°`, 900); }
        break;
      case 'flapsUp':
        if (ac && ac.cycleFlaps(-1)) { audio.click(320); ticker(`FLAPS ${ac.flapDeg()}°`, 900); }
        break;
      case 'gear':
        if (ac && ac.toggleGear()) {
          audio.click(180, 0.16, 0.14);
          ticker(ac.gearCmd > 0.5 ? 'GEAR DOWN' : 'GEAR UP', 1100);
        }
        break;
      case 'parkBrake':
        if (ac) { ac.input.parkBrake = !ac.input.parkBrake; audio.click(420); }
        break;
      case 'trimUp':
        if (ac) ac.trim = clamp(ac.trim + 0.9 * (1 / 60), -1, 1);
        break;
      case 'trimDown':
        if (ac) ac.trim = clamp(ac.trim - 0.9 * (1 / 60), -1, 1);
        break;
      default: break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

function updateCamera(dt) {
  const len = ac.cfg.dims.length;
  const upWorld = _v2.set(0, 1, 0);

  if (sim.view === 'cockpit') {
    const eye = _v.copy(model.parts.eye).applyQuaternion(ac.quat).add(ac.pos);
    camera.position.copy(eye);
    camera.quaternion.copy(ac.quat);
    camera.fov = 68;
  } else if (sim.view === 'chase') {
    const back = len * 1.9 + 6;
    _camTarget.copy(ac.pos)
      .addScaledVector(ac.fwd, -back)
      .addScaledVector(upWorld, len * 0.55 + 2.4);
    const k = 1 - Math.exp(-dt * 5.2);
    camera.position.lerp(_camTarget, k);
    _look.copy(ac.pos).addScaledVector(ac.fwd, len * 2.2);
    camera.up.set(0, 1, 0);
    camera.lookAt(_look);
    camera.fov = 62;
  } else if (sim.view === 'orbit') {
    sim.orbitAngle += dt * 0.22;
    const r = len * 3.6 + 14;
    _camTarget.set(
      ac.pos.x + Math.cos(sim.orbitAngle) * r,
      ac.pos.y + len * 0.5 + 3,
      ac.pos.z + Math.sin(sim.orbitAngle) * r
    );
    camera.position.lerp(_camTarget, 1 - Math.exp(-dt * 6));
    camera.up.set(0, 1, 0);
    camera.lookAt(ac.pos);
    camera.fov = 55;
  } else {
    const tower = _camTarget.set(150, AIRPORT.elev + 29, 140);
    camera.position.copy(tower);
    camera.up.set(0, 1, 0);
    camera.lookAt(ac.pos);
    const d = tower.distanceTo(ac.pos);
    camera.fov = clamp(2600 / Math.max(60, d), 3.5, 52);
  }
  camera.updateProjectionMatrix();
}

/* ------------------------------------------------------------------ */
/* Nav display                                                         */
/* ------------------------------------------------------------------ */

function drawNav() {
  const cv = $('nav');
  const c = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const cx = W / 2, cy = H / 2;
  const eu = ac.euler();
  const rangeM = 6000;
  const scale = (W * 0.46) / rangeM;

  c.clearRect(0, 0, W, H);
  c.fillStyle = 'rgba(6,9,14,0.55)';
  c.fillRect(0, 0, W, H);

  c.save();
  c.translate(cx, cy);
  c.rotate(-eu.heading);

  // Range rings
  c.strokeStyle = 'rgba(255,255,255,0.13)';
  c.lineWidth = 1.5;
  for (const nm of [1, 2, 3]) {
    c.beginPath();
    c.arc(0, 0, nm * 1852 * scale, 0, Math.PI * 2);
    c.stroke();
  }

  const px = (x, z) => [(x - ac.pos.x) * scale, (z - ac.pos.z) * scale];

  // Runway
  c.strokeStyle = 'rgba(232,237,245,0.9)';
  c.lineWidth = 5;
  {
    const [ax, az] = px(AIRPORT.thr09, 0);
    const [bx, bz] = px(AIRPORT.thr27, 0);
    c.beginPath(); c.moveTo(ax, az); c.lineTo(bx, bz); c.stroke();
    c.fillStyle = '#7ef7c0';
    c.beginPath(); c.arc(bx, bz, 5, 0, Math.PI * 2); c.fill();
  }

  // Extended centreline for RWY 27
  c.setLineDash([7, 9]);
  c.strokeStyle = 'rgba(34,211,238,0.55)';
  c.lineWidth = 2;
  {
    const [ax, az] = px(AIRPORT.thr27, 0);
    const [bx, bz] = px(AIRPORT.thr27 + 9000, 0);
    c.beginPath(); c.moveTo(ax, az); c.lineTo(bx, bz); c.stroke();
  }
  c.setLineDash([]);

  // Gates
  if (run.gates.length) {
    for (let i = 0; i < run.gates.length; i++) {
      const g = run.gates[i];
      const [gx, gz] = px(g.pos.x, g.pos.z);
      const active = i === run.gateIdx;
      c.strokeStyle = g.hit ? 'rgba(126,247,192,0.75)' : active ? '#f5c542' : 'rgba(255,255,255,0.30)';
      c.lineWidth = active ? 3 : 2;
      c.beginPath(); c.arc(gx, gz, active ? 10 : 6, 0, Math.PI * 2); c.stroke();
      if (active) {
        c.beginPath(); c.moveTo(0, 0); c.lineTo(gx, gz); c.stroke();
      }
    }
  }
  c.restore();

  // Own ship
  c.save();
  c.translate(cx, cy);
  c.fillStyle = '#22d3ee';
  c.beginPath();
  c.moveTo(0, -13); c.lineTo(9, 10); c.lineTo(0, 5); c.lineTo(-9, 10);
  c.closePath(); c.fill();
  c.restore();

  // Wind arrow
  const wdir = (wind.dirDeg - (eu.heading / DEG)) * DEG;
  c.save();
  c.translate(W - 44, 44);
  c.rotate(wdir + Math.PI);
  c.strokeStyle = '#f5c542';
  c.lineWidth = 2.5;
  c.beginPath();
  c.moveTo(0, -16); c.lineTo(0, 16);
  c.moveTo(-6, 8); c.lineTo(0, 16); c.lineTo(6, 8);
  c.stroke();
  c.restore();

  c.fillStyle = '#8d96a6';
  c.font = '600 17px "Roboto Mono", monospace';
  c.textAlign = 'left';
  c.fillText(`${Math.round(wind.dirDeg).toString().padStart(3, '0')}/${Math.round(wind.speed * KT)}`, 12, 26);
  c.textAlign = 'right';
  c.fillText('3 NM', W - 12, H - 14);
  c.textAlign = 'left';
  c.fillText(String(Math.round(eu.heading / DEG)).padStart(3, '0') + '°', 12, H - 14);
}

/* ------------------------------------------------------------------ */
/* Annunciators + strip                                                */
/* ------------------------------------------------------------------ */

function ann(id, on) { $(id).classList.toggle('on', on); }

function updateAnnunciators() {
  const cfg = ac.cfg;
  const fuelFrac = ac.fuel / cfg.engine.fuel;
  const lowAgl = ac.agl < 180 && !ac.wow;
  const sinking = ac.vs < -6;
  const gearUnsafe = cfg.gear.retractable && ac.gearPos < 0.85 && ac.agl < 300 && !ac.wow && ac.vs < 0;

  ann('aStall', ac.stallFrac > 0.55 && !ac.wow);
  ann('aTerrain', lowAgl && sinking && !gearUnsafe && ac.agl < 130);
  ann('aOverspeed', ac.ias > cfg.limits.vne * 0.985);
  ann('aGear', gearUnsafe);
  ann('aFuel', fuelFrac < 0.12);
  ann('aEngine', !ac.running);
  ann('aBrake', ac.input.parkBrake && ac.wow);

  const p = sim.papi;
  const papiOn = !!p && ac.pos.x > AIRPORT.thr27 && ac.pos.x < AIRPORT.thr27 + 11000 && ac.agl < 900 && !ac.wow;
  const pe = $('aPapi');
  pe.classList.toggle('on', papiOn);
  if (papiOn) {
    const w = p.whites;
    pe.textContent = 'PAPI ' + '○'.repeat(w) + '●'.repeat(4 - w) +
      (w === 2 ? '  ON SLOPE' : w > 2 ? '  HIGH' : '  LOW');
    pe.className = 'ann steady on ' + (w === 2 ? 'ok' : w === 4 || w === 0 ? 'crit' : 'warn');
  }

  const rwy = wind.runwayComponents(AIRPORT.rwyHeading);
  $('swFlap').innerHTML = `FLAPS <b>${ac.flapDeg()}°</b>`;
  $('swGear').innerHTML = `GEAR <b>${cfg.gear.retractable ? (ac.gearPos > 0.9 ? 'DOWN' : ac.gearPos < 0.1 ? 'UP' : 'TRANS') : 'FIXED'}</b>`;
  $('swTrim').innerHTML = `TRIM <b>${ac.trim >= 0 ? '+' : ''}${ac.trim.toFixed(2)}</b>`;
  $('swThr').innerHTML = `PWR <b>${Math.round(ac.input.throttle * 100)}%</b>`;
  $('swThr').classList.toggle('hot', ac.input.throttle > 0.9);
  $('swWind').innerHTML = `WIND <b>${Math.round(wind.dirDeg).toString().padStart(3, '0')}/${Math.round(wind.speed * KT)}` +
    ` X${Math.abs(Math.round(rwy.cross * KT))}</b>`;
}

/* ------------------------------------------------------------------ */
/* Frame                                                               */
/* ------------------------------------------------------------------ */

function buildState() {
  const eu = ac.euler();
  const gsVec = _v.copy(ac.vel);
  const fpaY = Math.asin(clamp(ac.vel.y / Math.max(0.5, ac.vel.length()), -1, 1));
  const horiz = Math.hypot(ac.vel.x, ac.vel.z);
  let track = Math.atan2(ac.vel.x, -ac.vel.z);
  let fpaX = track - eu.heading;
  while (fpaX > Math.PI) fpaX -= Math.PI * 2;
  while (fpaX < -Math.PI) fpaX += Math.PI * 2;
  if (horiz < 2) fpaX = 0;

  return {
    on: sim.hudOn,
    ias: ac.ias,
    gs: gsVec.length(),
    pitch: eu.pitch,
    bank: eu.bank,
    headingDeg: (eu.heading / DEG + 360) % 360,
    altFt: ac.pos.y * FT,
    aglFt: ac.agl * FT,
    vsFpm: ac.vs * FPM,
    turnRate: turnRateDegPerSec(ac, eu.bank),
    ball: clamp(ac.slipBall, -1, 1),
    rpm: ac.rpm,
    throttlePct: Math.round(ac.input.throttle * 100),
    fuelFrac: ac.fuel / ac.cfg.engine.fuel,
    g: ac.gLoad,
    alpha: ac.alpha,
    baro: 29.92,
    fpaX,
    fpaY,
  };
}

/** Rate of turn about the vertical, degrees per second (+ = right). */
function turnRateDegPerSec(a, bank) {
  const V = Math.max(6, Math.hypot(a.vel.x, a.vel.z));
  // On the ground the turn is kinematic (nosewheel), not a coordinated bank.
  if (a.wow) return a.omega.dot(a.dwn) / DEG;
  return ((9.80665 * Math.tan(clamp(bank, -1.4, 1.4))) / V) / DEG;
}

function frame(now) {
  requestAnimationFrame(frame);
  const raw = (now - sim.last) / 1000;
  sim.last = now;
  const dt = clamp(raw, 0, 0.25);
  sim.t += dt;
  sim.fps += (1 / Math.max(raw, 1e-3) - sim.fps) * 0.05;

  if (sim.tickerUntil && now > sim.tickerUntil) {
    $('ticker').classList.remove('on');
    sim.tickerUntil = 0;
  }

  if (sim.mode === 'menu' || sim.mode === 'debrief') {
    input.drain();
    orbitMenuCamera(dt);
    renderer.render(scene, camera);
    return;
  }

  if (sim.mode === 'paused') {
    handleCommands();
    renderer.render(scene, camera);
    return;
  }

  /* ---------------- flying ---------------- */
  input.update(dt);
  handleCommands();
  if (sim.mode !== 'flying') return;

  ac.input.aileron = input.axes.roll;
  ac.input.elevator = -input.axes.pitch;
  // Positive rudder deflection yaws left (Cn_dr < 0) and steers the nosewheel
  // left, so the Q/E axis is inverted into the model's sign convention.
  ac.input.rudder = -input.axes.yaw;
  ac.input.throttle = input.throttle;
  ac.input.brake = input.brake;
  if (input.brake > 0.5 && ac.input.parkBrake) ac.input.parkBrake = false;
  if (ac.input.throttle > 0.25 && ac.input.parkBrake && ac.groundSpeed < 0.5) ac.input.parkBrake = false;

  const opts = REALISM[sim.sel.realism];
  wind.update(dt, ac.pos.y - AIRPORT.elev, ac.tas);
  wind.sample(Math.max(0, ac.pos.y - terrain.heightAt(ac.pos.x, ac.pos.z)), windVec);

  sim.accum += dt;
  let steps = 0;
  while (sim.accum >= PHYS_DT && steps < MAX_SUBSTEPS) {
    ac.step(PHYS_DT, windVec, opts);
    sim.accum -= PHYS_DT;
    steps++;
  }
  if (steps >= MAX_SUBSTEPS) sim.accum = 0;

  run.update(dt, { audio });
  for (const e of run.events.splice(0)) ticker(e.msg, 1600);

  /* --- visuals --- */
  model.update(ac, dt, sim.t);
  model.root.position.copy(ac.pos);
  model.root.quaternion.copy(ac.quat);
  model.setLandingLight(sim.lightOn, 3.2);
  updateCamera(dt);

  sky.mesh.position.copy(camera.position);
  sky.mesh.scale.setScalar(Math.max(200, camera.near * 400));
  clouds.update(camera.position, sim.cloudTint, sim.cloudTop);

  const sd = sim.sunDir;
  sun.position.copy(ac.pos).addScaledVector(sd, 1200);
  sun.target.position.copy(ac.pos);
  sun.target.updateMatrixWorld();

  sim.papi = airport.updatePAPI(ac.pos);
  airport.update(sim.t, ac.pos, wind.dirDeg, wind.speed, sim.night);

  /* --- readouts --- */
  const s = buildState();
  hud.draw(s);
  if (sim.view === 'cockpit') panel.draw(s);
  if (sim.navOn) drawNav();
  updateAnnunciators();

  $('objective').lastElementChild.textContent = run.objectiveLine();
  $('timeChip').lastElementChild.textContent = fmtTime(run.t);
  $('scoreChip').lastElementChild.textContent = String(run.computeScore());

  audio.update({
    rpm: ac.rpm,
    rpmMax: ac.cfg.engine.maxRPM || 100,
    throttle: ac.throttleActual,
    running: ac.running,
    ias: ac.ias,
    onGround: ac.wow,
    groundSpeed: ac.groundSpeed,
    paved: terrain.surfaceAt(ac.pos.x, ac.pos.z) === terrain.paved,
    stall: ac.stallFrac > 0.55 && !ac.wow,
    warn: !ac.running || ac.fuel / ac.cfg.engine.fuel < 0.12,
    jet: ac.cfg.engine.type === 'turbofan',
  });

  renderer.render(scene, camera);

  // The flight keeps simulating for a beat after the mission resolves so the
  // aircraft settles (or finishes tumbling) before the debrief takes over.
  if (run.status !== 'active' && !sim.endScheduled) {
    sim.endScheduled = true;
    if (!run.score) run.score = run.computeScore();
    setTimeout(() => { if (sim.mode === 'flying') endFlight(); }, 1600);
  }
}

function orbitMenuCamera(dt) {
  sim.orbitAngle += dt * 0.045;
  const r = 900;
  camera.position.set(
    AIRPORT.thr27 * 0.2 + Math.cos(sim.orbitAngle) * r,
    AIRPORT.elev + 260,
    Math.sin(sim.orbitAngle) * r
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(0, AIRPORT.elev + 30, 0);
  camera.fov = 55;
  camera.updateProjectionMatrix();
  sky.mesh.position.copy(camera.position);
  sky.mesh.scale.setScalar(400);
  if (clouds && sim.cloudTint) clouds.update(camera.position, sim.cloudTint, sim.cloudTop);
  if (sim.sunDir) {
    sun.position.copy(camera.position).addScaledVector(sim.sunDir, 1200);
    sun.target.position.copy(camera.position);
    sun.target.updateMatrixWorld();
  }
  airport.update(sim.t, camera.position, wind.dirDeg, wind.speed, sim.night || 0);
}

/* ------------------------------------------------------------------ */

// Debug handle: read-only view of the live sim for console inspection.
window.OPUS5 = {
  sim,
  get ac() { return ac; },
  get run() { return run; },
  get input() { return input; },
  get wind() { return wind; },
  get terrain() { return terrain; },
};

applyTimeOfDayDefaults();
boot().catch((err) => {
  console.error(err);
  $('loadMsg').textContent = 'LOAD ERROR: ' + err.message;
  $('loadMsg').style.color = '#ff5a5a';
});

function applyTimeOfDayDefaults() {
  sim.sunDir = sunDirection(TIME_PRESETS.day.elev, TIME_PRESETS.day.azim);
  sim.night = 0;
  sim.cloudTint = new THREE.Color(TIME_PRESETS.day.fog);
  sim.cloudTop = new THREE.Color(0xffffff);
}
