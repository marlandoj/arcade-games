/**
 * OpenFlight Sim — World, terrain, airfield, sky (OFS-003).
 *
 * Fills the T1 boundary stub with the real scene: a seeded procedural terrain
 * whose elevation is queryable by the flight model (`terrainHeight`), an airfield
 * with a marked runway, threshold/centreline/aiming markings, a taxiway,
 * sequenced approach lighting and a working PAPI that tracks the glidepath, a
 * gradient sky with a sun and layered clouds, and the selected aircraft mesh.
 *
 * The frozen T1 call sites are preserved: `createWorld(scene, options)` returns a
 * handle with `update(alpha, sim)`, `setView(mode)`, `runway`, and `dispose()`.
 * New members (`terrainHeight`, `setAirframe`, `papi`) are additive.
 *
 * All geometry is generated from Three.js primitives and procedural math — no
 * external model, texture, or data files.
 */

import * as THREE from "three";
import { createTerrain, papiIndication, PAPI_GLIDEPATH_DEG } from "./terrain.js";
import { createAirframeMesh } from "./airframe-mesh.js";
import { gateFacing } from "./missions.js";

export const RUNWAY = Object.freeze({
  threshold: Object.freeze({ x: 0, z: 0 }),
  heading: 0,
  length: 1500,
  width: 30,
  elevation: 0,
});

const TERRAIN_SIZE = 12000;
const TERRAIN_SEG = 200;
const TERRAIN_SEED = 20260726;

export function createWorld(scene, options = {}) {
  const opts = { seed: TERRAIN_SEED, airframe: "trainer", ...options };
  const disposables = { geos: new Set(), mats: new Set(), objs: [] };
  const track = (obj) => {
    if (obj.geometry) disposables.geos.add(obj.geometry);
    if (obj.material) (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => disposables.mats.add(m));
    return obj;
  };

  // ── Terrain field (queryable + visible share one generator) ────────────────
  const terrain = createTerrain({ seed: opts.seed, runway: RUNWAY });

  // ── Sky: gradient dome + sun ───────────────────────────────────────────────
  const sunElev = 0.62, sunAzim = 0.7; // radians
  const sunDir = new THREE.Vector3(
    Math.cos(sunElev) * Math.sin(sunAzim),
    Math.sin(sunElev),
    Math.cos(sunElev) * Math.cos(sunAzim),
  ).normalize();

  const horizon = new THREE.Color(0xcfe3f2);
  scene.background = horizon.clone();
  scene.fog = new THREE.Fog(horizon.clone(), 2500, 10500);

  const skyGeo = new THREE.SphereGeometry(9500, 32, 18);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x2c6fb5) },
      uMid: { value: new THREE.Color(0x9ec5e8) },
      uBottom: { value: new THREE.Color(0xdfeaf2) },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(0xfff2cf) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uBottom;
      uniform vec3 uSunDir; uniform vec3 uSunColor;
      void main() {
        float h = clamp(vDir.y, -0.15, 1.0);
        vec3 col = h < 0.18
          ? mix(uBottom, uMid, clamp((h + 0.15) / 0.33, 0.0, 1.0))
          : mix(uMid, uTop, clamp((h - 0.18) / 0.82, 0.0, 1.0));
        float sd = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);
        col += uSunColor * pow(sd, 220.0) * 1.4;          // sun disc
        col += uSunColor * pow(sd, 6.0) * 0.18;           // glow
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  scene.add(sky);
  disposables.geos.add(skyGeo); disposables.mats.add(skyMat); disposables.objs.push(sky);

  // ── Lights ─────────────────────────────────────────────────────────────────
  const hemi = new THREE.HemisphereLight(0xbcd6f2, 0x39492c, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d6, 1.05);
  sun.position.copy(sunDir).multiplyScalar(1200);
  scene.add(sun);
  const ambient = new THREE.AmbientLight(0x2f3c4c, 0.35);
  scene.add(ambient);
  disposables.objs.push(hemi, sun, ambient);

  // ── Terrain mesh (displaced from the same field the flight model queries) ──
  const terrGeo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEG, TERRAIN_SEG);
  terrGeo.rotateX(-Math.PI / 2);
  const tpos = terrGeo.attributes.position;
  const tcol = new Float32Array(tpos.count * 3);
  for (let i = 0; i < tpos.count; i++) {
    const x = tpos.getX(i), z = tpos.getZ(i);
    const h = terrain.heightAt(x, z);
    tpos.setY(i, h);
    const c = terrain.sampleColor(h);
    tcol[i * 3] = c[0]; tcol[i * 3 + 1] = c[1]; tcol[i * 3 + 2] = c[2];
  }
  terrGeo.setAttribute("color", new THREE.BufferAttribute(tcol, 3));
  terrGeo.computeVertexNormals();
  const terrMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const terrainMesh = new THREE.Mesh(terrGeo, terrMat);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);
  disposables.geos.add(terrGeo); disposables.mats.add(terrMat); disposables.objs.push(terrainMesh);

  // ── Airfield ───────────────────────────────────────────────────────────────
  const airfield = new THREE.Group();
  const datum = RUNWAY.elevation;
  const rwCenterZ = RUNWAY.threshold.z + RUNWAY.length / 2;

  // Apron/grass pad slightly raised over terrain datum to avoid z-fighting.
  const padGeo = new THREE.PlaneGeometry(RUNWAY.width + 120, RUNWAY.length + 400);
  const padMat = new THREE.MeshStandardMaterial({ color: 0x3a552c, roughness: 1 });
  const pad = new THREE.Mesh(padGeo, padMat);
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(0, datum + 0.02, rwCenterZ);
  airfield.add(pad);
  track(pad);

  // Runway.
  const rwGeo = new THREE.PlaneGeometry(RUNWAY.width, RUNWAY.length);
  // polygonOffset pushes the tarmac back a hair so the coplanar markings win the
  // depth test at grazing angles (no z-fighting down the length of the runway).
  const rwMat = new THREE.MeshStandardMaterial({ color: 0x26262b, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const runwayMesh = new THREE.Mesh(rwGeo, rwMat);
  runwayMesh.rotation.x = -Math.PI / 2;
  runwayMesh.position.set(0, datum + 0.05, rwCenterZ);
  airfield.add(runwayMesh);
  track(runwayMesh);

  // Shared marking materials.
  const whiteMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
  const markMat = new THREE.MeshBasicMaterial({ color: 0xe8e8ea });
  disposables.mats.add(whiteMat); disposables.mats.add(markMat);
  const markY = datum + 0.14;

  const addMark = (geo, x, z, mat = whiteMat) => {
    disposables.geos.add(geo);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, markY, z);
    airfield.add(m);
    return m;
  };

  // Centreline dashes.
  const dashGeo = new THREE.PlaneGeometry(0.6, 22);
  for (let z = 40; z < RUNWAY.length - 40; z += 46) addMark(dashGeo, 0, z);

  // Threshold "piano key" bars at each runway end.
  const barGeo = new THREE.PlaneGeometry(1.6, 16);
  for (let k = -3; k <= 3; k++) {
    if (k === 0) continue;
    addMark(barGeo, k * 2.6, 12, whiteMat);
    addMark(barGeo, k * 2.6, RUNWAY.length - 12, whiteMat);
  }

  // Aiming-point + touchdown-zone blocks near the approach end.
  const aimGeo = new THREE.PlaneGeometry(3.4, 20);
  addMark(aimGeo, -5, 300, whiteMat);
  addMark(aimGeo, 5, 300, whiteMat);
  const tdzGeo = new THREE.PlaneGeometry(1.4, 10);
  for (const z of [150, 220]) { addMark(tdzGeo, -4, z); addMark(tdzGeo, 4, z); }

  // Taxiway: parallel strip + connector to the runway.
  const taxiMat = new THREE.MeshStandardMaterial({ color: 0x2f3138, roughness: 0.95 });
  disposables.mats.add(taxiMat);
  const taxiParGeo = new THREE.PlaneGeometry(12, RUNWAY.length * 0.7);
  const taxiPar = new THREE.Mesh(taxiParGeo, taxiMat);
  taxiPar.rotation.x = -Math.PI / 2;
  taxiPar.position.set(60, datum + 0.04, rwCenterZ);
  airfield.add(taxiPar); track(taxiPar);
  const taxiConGeo = new THREE.PlaneGeometry(120, 12);
  const taxiCon = new THREE.Mesh(taxiConGeo, taxiMat);
  taxiCon.rotation.x = -Math.PI / 2;
  taxiCon.position.set(30, datum + 0.04, 120);
  airfield.add(taxiCon); track(taxiCon);

  scene.add(airfield);
  disposables.objs.push(airfield);

  // ── Approach lighting (sequenced flash toward the threshold) ───────────────
  const approachGroup = new THREE.Group();
  const alGeo = new THREE.SphereGeometry(1.0, 6, 5);
  const alMat = new THREE.MeshBasicMaterial({ color: 0xfff4d0 });
  disposables.geos.add(alGeo); disposables.mats.add(alMat);
  const approachLights = [];
  // Centreline bars stepping out from the threshold along -z.
  for (let i = 1; i <= 18; i++) {
    const z = -i * 45;
    const bar = new THREE.Group();
    const count = i % 3 === 0 ? 3 : 1;
    for (let j = 0; j < count; j++) {
      const l = new THREE.Mesh(alGeo, alMat);
      l.position.set((j - (count - 1) / 2) * 4, datum + 0.6, z);
      bar.add(l);
    }
    bar.userData.seqIndex = i;
    approachGroup.add(bar);
    approachLights.push(bar);
  }
  scene.add(approachGroup);
  disposables.objs.push(approachGroup);

  // Runway edge lights.
  const edgeGeo = new THREE.SphereGeometry(0.7, 5, 4);
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0xfff0c0 });
  disposables.geos.add(edgeGeo); disposables.mats.add(edgeMat);
  const edgeGroup = new THREE.Group();
  for (let z = 0; z <= RUNWAY.length; z += 60) {
    for (const sx of [-RUNWAY.width / 2 - 1.5, RUNWAY.width / 2 + 1.5]) {
      const l = new THREE.Mesh(edgeGeo, edgeMat);
      l.position.set(sx, datum + 0.5, z);
      edgeGroup.add(l);
    }
  }
  scene.add(edgeGroup);
  disposables.objs.push(edgeGroup);

  // ── PAPI (four units abeam the touchdown zone) ─────────────────────────────
  const papiPos = { x: -RUNWAY.width / 2 - 12, y: datum, z: 300 };
  const papiGroup = new THREE.Group();
  const papiGeo = new THREE.SphereGeometry(1.1, 8, 6);
  disposables.geos.add(papiGeo);
  const papiUnits = [];
  for (let i = 0; i < 4; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    disposables.mats.add(mat);
    const l = new THREE.Mesh(papiGeo, mat);
    l.position.set(papiPos.x - i * 3, datum + 1.2, papiPos.z);
    papiGroup.add(l);
    papiUnits.push(l);
  }
  scene.add(papiGroup);
  disposables.objs.push(papiGroup);
  const RED = new THREE.Color(0xff2a2a);
  const WHITE = new THREE.Color(0xffffff);

  // ── Clouds (two layers, drift is a pure function of fixed-step sim time) ────
  const cloudGroup = new THREE.Group();
  const cloudGeo = new THREE.SphereGeometry(48, 7, 5);
  disposables.geos.add(cloudGeo);
  const cloudBases = [];
  const rng = mulberry32(opts.seed ^ 0x51ed);
  const layers = [{ y: 620, n: 14, op: 0.6 }, { y: 1150, n: 10, op: 0.42 }];
  for (const layer of layers) {
    const cm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: layer.op, depthWrite: false });
    disposables.mats.add(cm);
    for (let i = 0; i < layer.n; i++) {
      const cx = (rng() - 0.5) * 9000;
      const cz = (rng() - 0.5) * 9000;
      const cloud = new THREE.Mesh(cloudGeo, cm);
      cloud.position.set(cx, layer.y + (rng() - 0.5) * 120, cz);
      cloud.scale.set(1.4 + rng() * 2.2, 0.7 + rng() * 0.6, 1.4 + rng() * 2.2);
      cloudBases.push({ x: cx, mesh: cloud });
      cloudGroup.add(cloud);
    }
  }
  scene.add(cloudGroup);
  disposables.objs.push(cloudGroup);

  // ── Aircraft mesh ──────────────────────────────────────────────────────────
  let airframeId = opts.airframe;
  let aircraft = createAirframeMesh(airframeId);
  scene.add(aircraft.group);

  // ── Navigation-course gates (additive, OFS-005) ────────────────────────────
  // The mission layer owns the course geometry and scoring; world.js only draws
  // it. `setCourse` (re)builds the rings, `setActiveGate` colours the next gate.
  const courseGroup = new THREE.Group();
  courseGroup.visible = false;
  scene.add(courseGroup);
  disposables.objs.push(courseGroup);
  let gateRings = [];
  const GATE_NEXT = new THREE.Color(0x22d3ee);
  const GATE_DONE = new THREE.Color(0x46e36b);
  const GATE_TODO = new THREE.Color(0x6b7a8f);
  let activeGate = 0;

  function clearCourse() {
    for (const ring of gateRings) {
      courseGroup.remove(ring);
      ring.geometry.dispose();
      ring.material.dispose();
    }
    gateRings = [];
  }

  let viewMode = "chase";
  let papiWhites = 2;

  const _acPos = new THREE.Vector3();

  const handle = {
    runway: RUNWAY,
    get aircraft() { return aircraft.group; },
    papiPos,

    terrainHeight(x, z) { return terrain.heightAt(x, z); },

    setAirframe(id) {
      if (id === airframeId) return;
      scene.remove(aircraft.group);
      aircraft.dispose();
      airframeId = id;
      aircraft = createAirframeMesh(id);
      scene.add(aircraft.group);
    },

    get papi() { return { whites: papiWhites, glidepath: PAPI_GLIDEPATH_DEG }; },

    // Build the visible gate rings for a navigation course (empty ⇒ hide them).
    setCourse(gates) {
      clearCourse();
      const list = Array.isArray(gates) ? gates : [];
      for (let i = 0; i < list.length; i++) {
        const g = list[i];
        const geo = new THREE.TorusGeometry(g.r || 120, 4, 8, 40);
        const mat = new THREE.MeshBasicMaterial({ color: GATE_TODO, transparent: true, opacity: 0.85 });
        const ring = new THREE.Mesh(geo, mat);
        ring.position.set(g.x, g.y, g.z);
        // TorusGeometry already lies in XY with its hole on +Z, so aiming that
        // axis down the arrival leg leaves the ring facing the pilot. A fixed
        // rotation here would lay it flat and present it edge-on instead.
        const f = gateFacing(list, i);
        ring.lookAt(g.x + f.x, g.y + f.y, g.z + f.z);
        courseGroup.add(ring);
        gateRings.push(ring);
      }
      activeGate = 0;
      courseGroup.visible = gateRings.length > 0;
    },

    setActiveGate(i) { activeGate = i; },

    update(alpha, sim) {
      _acPos.lerpVectors(sim.prevPos, sim.pos, alpha);
      aircraft.group.position.copy(_acPos);
      aircraft.group.quaternion.copy(sim.quat);
      aircraft.update(sim);

      // Cloud drift from fixed-step sim time (frame-rate independent).
      const t = sim.t || 0;
      for (let i = 0; i < cloudBases.length; i++) {
        const b = cloudBases[i];
        b.mesh.position.x = b.x + Math.sin(t * 0.03 + i) * 40;
      }

      // Sequenced approach flasher rippling toward the threshold (~2 Hz sweep).
      const head = Math.floor((t * 2) % (approachLights.length + 4));
      for (const bar of approachLights) {
        bar.visible = bar.userData.seqIndex <= head && bar.userData.seqIndex > head - 3;
      }

      // Gate rings: cleared behind → green, next → pulsing cyan, ahead → grey.
      if (courseGroup.visible) {
        const pulse = 0.6 + 0.4 * Math.sin((sim.t || 0) * 4);
        for (let i = 0; i < gateRings.length; i++) {
          const ring = gateRings[i];
          if (i < activeGate) { ring.material.color.copy(GATE_DONE); ring.material.opacity = 0.5; }
          else if (i === activeGate) { ring.material.color.copy(GATE_NEXT); ring.material.opacity = pulse; }
          else { ring.material.color.copy(GATE_TODO); ring.material.opacity = 0.8; }
        }
      }

      // PAPI colours track the live glidepath from the aircraft's position.
      const ind = papiIndication(sim.pos, papiPos);
      papiWhites = ind.whites;
      for (let i = 0; i < papiUnits.length; i++) {
        papiUnits[i].material.color.copy(ind.colors[i] === "white" ? WHITE : RED);
      }
    },

    setView(mode) { viewMode = mode; },
    getView() { return viewMode; },

    dispose() {
      clearCourse();
      scene.remove(...disposables.objs, aircraft.group);
      scene.background = null;
      scene.fog = null;
      aircraft.dispose();
      for (const g of disposables.geos) g.dispose();
      for (const m of disposables.mats) m.dispose();
    },
  };
  return handle;
}

// Small seeded PRNG for cloud placement (deterministic per world seed).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const __OFS_BOUNDARY__ = "world";
