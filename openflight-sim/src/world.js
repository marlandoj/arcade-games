/**
 * OpenFlight Sim — World, terrain, airfield (T1 boundary stub, OFS-003 fills).
 *
 * Contract: `createWorld(scene, options)` builds the procedural world into the
 * given THREE.Scene and returns a handle with `update(alpha, sim)` (called each
 * render), `runway` geometry for missions/instruments, and `setView(mode)`. T3
 * replaces the placeholder ground/sky with seeded terrain, marked runway,
 * taxiway, approach lighting, a working PAPI, sky gradient, sun and clouds.
 * The call sites here are frozen.
 */

import * as THREE from "three";

export const RUNWAY = Object.freeze({
  threshold: Object.freeze({ x: 0, z: 0 }),
  heading: 0,
  length: 1500,
  width: 30,
  elevation: 0,
});

export function createWorld(scene, options = {}) {
  const opts = { sky: 0x9ec5e8, ground: 0x4a6b3a, ...options };

  scene.background = new THREE.Color(opts.sky);
  scene.fog = new THREE.Fog(opts.sky, 800, 6000);

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x3a4a2a, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d6, 1.0);
  sun.position.set(400, 600, 200);
  scene.add(sun);
  const ambient = new THREE.AmbientLight(0x405068, 0.4);
  scene.add(ambient);

  const groundGeo = new THREE.PlaneGeometry(8000, 8000, 1, 1);
  const groundMat = new THREE.MeshStandardMaterial({ color: opts.ground, roughness: 1 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const runwayGeo = new THREE.PlaneGeometry(RUNWAY.width, RUNWAY.length);
  const runwayMat = new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.9 });
  const runway = new THREE.Mesh(runwayGeo, runwayMat);
  runway.rotation.x = -Math.PI / 2;
  runway.position.set(RUNWAY.threshold.x, 0.05, RUNWAY.threshold.z + RUNWAY.length / 2);
  scene.add(runway);

  const centerlineGeo = new THREE.PlaneGeometry(0.6, RUNWAY.length * 0.9);
  const centerlineMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
  const centerline = new THREE.Mesh(centerlineGeo, centerlineMat);
  centerline.rotation.x = -Math.PI / 2;
  centerline.position.copy(runway.position);
  centerline.position.y = 0.06;
  scene.add(centerline);

  const aircraftGroup = new THREE.Group();
  const fuselageGeo = new THREE.BoxGeometry(1.2, 1.2, 8);
  const fuselageMat = new THREE.MeshStandardMaterial({ color: 0xeef2f7, metalness: 0.3, roughness: 0.5 });
  const fuselage = new THREE.Mesh(fuselageGeo, fuselageMat);
  fuselage.castShadow = true;
  aircraftGroup.add(fuselage);
  const wingGeo = new THREE.BoxGeometry(11, 0.3, 2);
  const wingMat = new THREE.MeshStandardMaterial({ color: 0xd9e3ee, metalness: 0.3, roughness: 0.5 });
  const wing = new THREE.Mesh(wingGeo, wingMat);
  wing.position.y = 0.2;
  aircraftGroup.add(wing);
  const tailGeo = new THREE.BoxGeometry(4, 0.3, 1.2);
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xd9e3ee, metalness: 0.3, roughness: 0.5 });
  const tail = new THREE.Mesh(tailGeo, tailMat);
  tail.position.set(0, 0.6, -3.6);
  aircraftGroup.add(tail);
  scene.add(aircraftGroup);

  // Clouds: keep each cloud's base position so drift is a pure function of the
  // fixed-step sim time (ZOU-920 remediation #10) — frame-rate independent.
  const cloudGroup = new THREE.Group();
  const cloudGeos = [];
  const cloudMats = [];
  const cloudBases = [];
  for (let i = 0; i < 12; i++) {
    const cg = new THREE.SphereGeometry(40, 8, 6);
    const cm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
    const cloud = new THREE.Mesh(cg, cm);
    const cx = (Math.random() - 0.5) * 4000;
    const cy = 300 + Math.random() * 300;
    const cz = (Math.random() - 0.5) * 4000;
    cloud.position.set(cx, cy, cz);
    cloud.scale.setScalar(1 + Math.random() * 1.5);
    cloudGeos.push(cg);
    cloudMats.push(cm);
    cloudBases.push({ x: cx, y: cy, z: cz });
    cloudGroup.add(cloud);
  }
  scene.add(cloudGroup);

  let viewMode = "chase";

  return {
    runway: RUNWAY,
    aircraft: aircraftGroup,

    update(alpha, sim) {
      aircraftGroup.position.lerpVectors(sim.prevPos, sim.pos, alpha);
      aircraftGroup.quaternion.copy(sim.quat);
      // Cloud drift driven off fixed-step sim.t (ZOU-920 #10), not per-render
      // accumulation, so motion is independent of render frame rate.
      cloudGroup.children.forEach((c, i) => {
        const b = cloudBases[i];
        c.position.x = b.x + Math.sin(sim.t * 0.05 + i) * 25;
      });
    },

    setView(mode) { viewMode = mode; },
    getView() { return viewMode; },
    dispose() {
      // Release every GPU resource this module created (ZOU-920 remediation #5).
      scene.remove(ground, runway, centerline, aircraftGroup, cloudGroup, hemi, sun, ambient);
      groundGeo.dispose(); groundMat.dispose();
      runwayGeo.dispose(); runwayMat.dispose();
      centerlineGeo.dispose(); centerlineMat.dispose();
      fuselageGeo.dispose(); fuselageMat.dispose();
      wingGeo.dispose(); wingMat.dispose();
      tailGeo.dispose(); tailMat.dispose();
      for (const g of cloudGeos) g.dispose();
      for (const m of cloudMats) m.dispose();
    },
  };
}

export const __OFS_BOUNDARY__ = "world";
