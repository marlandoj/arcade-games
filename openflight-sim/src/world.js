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

  const runwayMat = new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.9 });
  const runway = new THREE.Mesh(new THREE.PlaneGeometry(RUNWAY.width, RUNWAY.length), runwayMat);
  runway.rotation.x = -Math.PI / 2;
  runway.position.set(RUNWAY.threshold.x, 0.05, RUNWAY.threshold.z + RUNWAY.length / 2);
  scene.add(runway);

  const centerline = new THREE.Mesh(
    new THREE.PlaneGeometry(0.6, RUNWAY.length * 0.9),
    new THREE.MeshBasicMaterial({ color: 0xf2f2f2 })
  );
  centerline.rotation.x = -Math.PI / 2;
  centerline.position.copy(runway.position);
  centerline.position.y = 0.06;
  scene.add(centerline);

  const aircraftGroup = new THREE.Group();
  const fuselage = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.2, 8),
    new THREE.MeshStandardMaterial({ color: 0xeef2f7, metalness: 0.3, roughness: 0.5 })
  );
  fuselage.castShadow = true;
  aircraftGroup.add(fuselage);
  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(11, 0.3, 2),
    new THREE.MeshStandardMaterial({ color: 0xd9e3ee, metalness: 0.3, roughness: 0.5 })
  );
  wing.position.y = 0.2;
  aircraftGroup.add(wing);
  const tail = new THREE.Mesh(
    new THREE.BoxGeometry(4, 0.3, 1.2),
    new THREE.MeshStandardMaterial({ color: 0xd9e3ee, metalness: 0.3, roughness: 0.5 })
  );
  tail.position.set(0, 0.6, -3.6);
  aircraftGroup.add(tail);
  scene.add(aircraftGroup);

  const cloudGroup = new THREE.Group();
  for (let i = 0; i < 12; i++) {
    const cloud = new THREE.Mesh(
      new THREE.SphereGeometry(40, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 })
    );
    cloud.position.set((Math.random() - 0.5) * 4000, 300 + Math.random() * 300, (Math.random() - 0.5) * 4000);
    cloud.scale.setScalar(1 + Math.random() * 1.5);
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
      const t = sim.t;
      cloudGroup.children.forEach((c, i) => {
        c.position.x += Math.sin(t * 0.05 + i) * 0.1;
      });
    },

    setView(mode) { viewMode = mode; },
    getView() { return viewMode; },
    dispose() {
      scene.remove(ground, runway, centerline, aircraftGroup, cloudGroup, hemi, sun, ambient);
      groundGeo.dispose(); groundMat.dispose();
    },
  };
}

export const __OFS_BOUNDARY__ = "world";
