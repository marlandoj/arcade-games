/**
 * OpenFlight Sim — Aircraft meshes (OFS-003).
 *
 * Three flyable airframes built entirely from Three.js primitives — no model or
 * texture files. Each returns a handle:
 *   { group, update(sim), dispose() }
 * where `group` is oriented in the sim's body frame (+z = nose, +y = up,
 * +x = right) so `world.update()` can copy the flight-model quaternion straight
 * onto it. `update(sim)` animates the control surfaces (from sim.controls),
 * retracts/extends the gear (from sim.gear), spins the prop or fan (from sim.rpm
 * and sim.t), and drives the navigation, strobe, beacon, and landing lights.
 *
 * Geometry roughly matches each airframe's gear stance in flight-model.js so the
 * wheels sit where the ground-reaction model puts them.
 */

import * as THREE from "three";

const NAV_RED = 0xff2b2b;
const NAV_GREEN = 0x2bff5a;
const WHITE = 0xffffff;
const BEACON_RED = 0xff3020;

// Shared registry so dispose() can release everything a build allocated.
function makeBag() {
  const geos = new Set();
  const mats = new Set();
  const track = (obj) => {
    if (obj.geometry) geos.add(obj.geometry);
    const m = obj.material;
    if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => mats.add(mm));
    return obj;
  };
  return { geos, mats, track };
}

function surfaceMat(bag, color, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ color, metalness: 0.25, roughness: 0.55, ...opts });
  bag.mats.add(m);
  return m;
}
function lightMat(bag, color) {
  const m = new THREE.MeshBasicMaterial({ color });
  bag.mats.add(m);
  return m;
}

function box(bag, w, h, d) { const g = new THREE.BoxGeometry(w, h, d); bag.geos.add(g); return g; }
function cyl(bag, rt, rb, h, s = 12) { const g = new THREE.CylinderGeometry(rt, rb, h, s); bag.geos.add(g); return g; }
function sph(bag, r, s = 8) { const g = new THREE.SphereGeometry(r, s, s); bag.geos.add(g); return g; }

/**
 * Build one gear leg as a pivot group so it can rotate up into the airframe.
 * `retractAxis` is the local axis the leg folds about; `dir` its sense.
 */
function makeGearLeg(bag, mats, { x, y, z, legLen, wheelR, retract }) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);

  const strut = new THREE.Mesh(cyl(bag, 0.06, 0.06, legLen, 6), mats.strut);
  strut.position.y = -legLen / 2;
  bag.track(strut);
  pivot.add(strut);

  const wheel = new THREE.Mesh(cyl(bag, wheelR, wheelR, 0.14, 12), mats.tyre);
  wheel.rotation.z = Math.PI / 2;   // roll axis = x
  wheel.position.y = -legLen;
  bag.track(wheel);
  pivot.add(wheel);

  pivot.userData.retract = retract; // { axis:'x'|'z', amount:radians }
  return pivot;
}

function applyGear(pivot, ext) {
  // ext 1 = down (rest orientation), 0 = fully retracted.
  const r = pivot.userData.retract;
  const folded = (1 - ext) * r.amount;
  if (r.axis === "x") pivot.rotation.x = folded;
  else pivot.rotation.z = folded;
  pivot.visible = ext > 0.02 || r.amount === 0;
}

// ── Airframe builders ────────────────────────────────────────────────────────

function buildTrainer(bag) {
  const group = new THREE.Group();
  const mats = {
    body: surfaceMat(bag, 0xeef2f7),
    wing: surfaceMat(bag, 0xd9e3ee),
    trim: surfaceMat(bag, 0x2a6fb0),
    surface: surfaceMat(bag, 0xc7d3e0, { roughness: 0.6 }),
    strut: surfaceMat(bag, 0x40474f, { metalness: 0.6 }),
    tyre: surfaceMat(bag, 0x14161a, { metalness: 0, roughness: 0.9 }),
  };

  const fuselage = bag.track(new THREE.Mesh(cyl(bag, 0.55, 0.75, 7.4, 14), mats.body));
  fuselage.rotation.x = Math.PI / 2;
  group.add(fuselage);
  const nose = bag.track(new THREE.Mesh(sph(bag, 0.62), mats.body));
  nose.position.z = 3.5; nose.scale.set(1, 1, 1.3);
  group.add(nose);
  const cabin = bag.track(new THREE.Mesh(sph(bag, 0.6), surfaceMat(bag, 0x8fb7d6, { metalness: 0.1, roughness: 0.2, transparent: true, opacity: 0.65 })));
  cabin.position.set(0, 0.5, 1.2); cabin.scale.set(0.9, 0.8, 1.6);
  group.add(cabin);

  // High wing.
  const wing = bag.track(new THREE.Mesh(box(bag, 10.2, 0.22, 1.7), mats.wing));
  wing.position.set(0, 0.85, 0.4);
  group.add(wing);
  const strutL = bag.track(new THREE.Mesh(cyl(bag, 0.05, 0.05, 1.6, 5), mats.strut));
  strutL.position.set(-1.7, 0.35, 0.4); strutL.rotation.z = 0.5;
  group.add(strutL);
  const strutR = bag.track(new THREE.Mesh(cyl(bag, 0.05, 0.05, 1.6, 5), mats.strut));
  strutR.position.set(1.7, 0.35, 0.4); strutR.rotation.z = -0.5;
  group.add(strutR);

  // Ailerons (outboard trailing edge), elevator, rudder — animated.
  const ailL = bag.track(new THREE.Mesh(box(bag, 2.6, 0.12, 0.5), mats.surface));
  ailL.geometry.translate(0, 0, -0.25); ailL.position.set(-3.2, 0.85, 1.0);
  group.add(ailL);
  const ailR = bag.track(new THREE.Mesh(box(bag, 2.6, 0.12, 0.5), mats.surface));
  ailR.geometry.translate(0, 0, -0.25); ailR.position.set(3.2, 0.85, 1.0);
  group.add(ailR);

  // Tail.
  const hstab = bag.track(new THREE.Mesh(box(bag, 3.6, 0.16, 1.0), mats.wing));
  hstab.position.set(0, 0.35, -3.3);
  group.add(hstab);
  const elevator = bag.track(new THREE.Mesh(box(bag, 3.4, 0.12, 0.5), mats.surface));
  elevator.geometry.translate(0, 0, -0.25); elevator.position.set(0, 0.35, -3.8);
  group.add(elevator);
  const vstab = bag.track(new THREE.Mesh(box(bag, 0.16, 1.5, 1.2), mats.trim));
  vstab.position.set(0, 1.0, -3.4);
  group.add(vstab);
  const rudder = bag.track(new THREE.Mesh(box(bag, 0.12, 1.4, 0.5), mats.surface));
  rudder.geometry.translate(0, 0, -0.25); rudder.position.set(0, 1.0, -3.9);
  group.add(rudder);

  // Nose prop.
  const propHub = new THREE.Group();
  propHub.position.z = 3.9;
  const blade = bag.track(new THREE.Mesh(box(bag, 0.18, 3.0, 0.05), surfaceMat(bag, 0x1c1f24, { metalness: 0.4 })));
  propHub.add(blade);
  const blade2 = bag.track(new THREE.Mesh(box(bag, 0.18, 3.0, 0.05), surfaceMat(bag, 0x1c1f24, { metalness: 0.4 })));
  blade2.rotation.z = Math.PI / 2; propHub.add(blade2);
  const disc = bag.track(new THREE.Mesh(new THREE.CircleGeometry(1.5, 24), new THREE.MeshBasicMaterial({ color: 0x9fb0c0, transparent: true, opacity: 0.0, side: THREE.DoubleSide })));
  bag.geos.add(disc.geometry); bag.mats.add(disc.material);
  disc.position.z = 0.02; propHub.add(disc);
  group.add(propHub);

  // Tricycle gear (matches flight-model gear stance).
  const gearGroup = new THREE.Group();
  const noseGear = makeGearLeg(bag, mats, { x: 0, y: -0.35, z: 1.20, legLen: 0.75, wheelR: 0.22, retract: { axis: "x", amount: -1.4 } });
  const leftGear = makeGearLeg(bag, mats, { x: -1.55, y: -0.35, z: -0.65, legLen: 0.75, wheelR: 0.26, retract: { axis: "z", amount: 1.4 } });
  const rightGear = makeGearLeg(bag, mats, { x: 1.55, y: -0.35, z: -0.65, legLen: 0.75, wheelR: 0.26, retract: { axis: "z", amount: -1.4 } });
  gearGroup.add(noseGear, leftGear, rightGear);
  group.add(gearGroup);

  const lights = buildLights(bag, group, { span: 5.1, wingY: 0.85, wingZ: 0.4, tailY: 1.0, tailZ: -3.9, noseZ: 3.6, beaconY: 1.6 });
  return finalizeAircraft(group, bag, {
    ailL, ailR, elevator, rudder, propHub, disc, gears: [noseGear, leftGear, rightGear], lights, propType: "prop",
  });
}

function buildAerobatic(bag) {
  const group = new THREE.Group();
  const mats = {
    body: surfaceMat(bag, 0xd8352e, { metalness: 0.35, roughness: 0.4 }),
    wing: surfaceMat(bag, 0xf4f4f4),
    surface: surfaceMat(bag, 0xe0e0e0, { roughness: 0.6 }),
    strut: surfaceMat(bag, 0x2a2d32, { metalness: 0.6 }),
    tyre: surfaceMat(bag, 0x14161a, { metalness: 0, roughness: 0.9 }),
  };

  const fuselage = bag.track(new THREE.Mesh(cyl(bag, 0.35, 0.7, 6.4, 14), mats.body));
  fuselage.rotation.x = Math.PI / 2;
  group.add(fuselage);
  const spinner = bag.track(new THREE.Mesh(cyl(bag, 0.05, 0.55, 0.7, 12), mats.body));
  spinner.rotation.x = -Math.PI / 2; spinner.position.z = 3.4;
  group.add(spinner);
  const cabin = bag.track(new THREE.Mesh(sph(bag, 0.5), surfaceMat(bag, 0x223344, { metalness: 0.2, roughness: 0.15, transparent: true, opacity: 0.6 })));
  cabin.position.set(0, 0.42, 0.3); cabin.scale.set(0.85, 0.85, 1.5);
  group.add(cabin);

  // Low wing.
  const wing = bag.track(new THREE.Mesh(box(bag, 8.6, 0.2, 1.6), mats.wing));
  wing.position.set(0, -0.15, 0.5);
  group.add(wing);
  const ailL = bag.track(new THREE.Mesh(box(bag, 2.4, 0.12, 0.5), mats.surface));
  ailL.geometry.translate(0, 0, -0.25); ailL.position.set(-2.9, -0.15, 1.1);
  group.add(ailL);
  const ailR = bag.track(new THREE.Mesh(box(bag, 2.4, 0.12, 0.5), mats.surface));
  ailR.geometry.translate(0, 0, -0.25); ailR.position.set(2.9, -0.15, 1.1);
  group.add(ailR);

  const hstab = bag.track(new THREE.Mesh(box(bag, 3.0, 0.14, 0.9), mats.wing));
  hstab.position.set(0, 0.15, -2.9);
  group.add(hstab);
  const elevator = bag.track(new THREE.Mesh(box(bag, 2.8, 0.11, 0.45), mats.surface));
  elevator.geometry.translate(0, 0, -0.22); elevator.position.set(0, 0.15, -3.35);
  group.add(elevator);
  const vstab = bag.track(new THREE.Mesh(box(bag, 0.14, 1.3, 1.1), mats.body));
  vstab.position.set(0, 0.8, -3.0);
  group.add(vstab);
  const rudder = bag.track(new THREE.Mesh(box(bag, 0.11, 1.2, 0.45), mats.surface));
  rudder.geometry.translate(0, 0, -0.22); rudder.position.set(0, 0.8, -3.45);
  group.add(rudder);

  const propHub = new THREE.Group();
  propHub.position.z = 3.75;
  for (let i = 0; i < 3; i++) {
    const b = bag.track(new THREE.Mesh(box(bag, 0.16, 2.7, 0.05), surfaceMat(bag, 0x101216, { metalness: 0.4 })));
    b.rotation.z = (i / 3) * Math.PI * 2; propHub.add(b);
  }
  const disc = bag.track(new THREE.Mesh(new THREE.CircleGeometry(1.4, 24), new THREE.MeshBasicMaterial({ color: 0xaab4c0, transparent: true, opacity: 0, side: THREE.DoubleSide })));
  disc.position.z = 0.02; propHub.add(disc);
  group.add(propHub);

  // Taildragger-ish but modelled as tricycle to match the shared gear model.
  const gearGroup = new THREE.Group();
  const noseGear = makeGearLeg(bag, mats, { x: 0, y: -0.4, z: 1.10, legLen: 0.55, wheelR: 0.2, retract: { axis: "x", amount: 0 } });
  const leftGear = makeGearLeg(bag, mats, { x: -1.4, y: -0.35, z: -0.55, legLen: 0.6, wheelR: 0.24, retract: { axis: "z", amount: 0 } });
  const rightGear = makeGearLeg(bag, mats, { x: 1.4, y: -0.35, z: -0.55, legLen: 0.6, wheelR: 0.24, retract: { axis: "z", amount: 0 } });
  // Fixed gear (aerobatic): spatted, not retractable — amount 0 keeps them down.
  gearGroup.add(noseGear, leftGear, rightGear);
  group.add(gearGroup);

  const lights = buildLights(bag, group, { span: 4.3, wingY: -0.15, wingZ: 0.5, tailY: 0.8, tailZ: -3.45, noseZ: 3.3, beaconY: 1.4 });
  return finalizeAircraft(group, bag, {
    ailL, ailR, elevator, rudder, propHub, disc, gears: [noseGear, leftGear, rightGear], lights, propType: "prop", fixedGear: true,
  });
}

function buildJet(bag) {
  const group = new THREE.Group();
  const mats = {
    body: surfaceMat(bag, 0x30363f, { metalness: 0.5, roughness: 0.35 }),
    wing: surfaceMat(bag, 0x454c56, { metalness: 0.45 }),
    surface: surfaceMat(bag, 0x565d68, { roughness: 0.5 }),
    strut: surfaceMat(bag, 0x22252b, { metalness: 0.7 }),
    tyre: surfaceMat(bag, 0x101115, { metalness: 0, roughness: 0.9 }),
  };

  const fuselage = bag.track(new THREE.Mesh(cyl(bag, 0.5, 0.95, 10.5, 16), mats.body));
  fuselage.rotation.x = Math.PI / 2;
  group.add(fuselage);
  const nose = bag.track(new THREE.Mesh(cyl(bag, 0.05, 0.5, 1.6, 14), mats.body));
  nose.rotation.x = -Math.PI / 2; nose.position.z = 5.9;
  group.add(nose);
  const canopy = bag.track(new THREE.Mesh(sph(bag, 0.55), surfaceMat(bag, 0x14202c, { metalness: 0.3, roughness: 0.1, transparent: true, opacity: 0.55 })));
  canopy.position.set(0, 0.55, 2.6); canopy.scale.set(0.9, 0.7, 1.8);
  group.add(canopy);

  // Swept low wing (approximated with a scaled/rotated box pair).
  const wing = bag.track(new THREE.Mesh(box(bag, 13.4, 0.28, 3.2), mats.wing));
  wing.position.set(0, -0.2, -0.3);
  group.add(wing);
  const ailL = bag.track(new THREE.Mesh(box(bag, 3.4, 0.14, 0.7), mats.surface));
  ailL.geometry.translate(0, 0, -0.35); ailL.position.set(-4.4, -0.2, 0.9);
  group.add(ailL);
  const ailR = bag.track(new THREE.Mesh(box(bag, 3.4, 0.14, 0.7), mats.surface));
  ailR.geometry.translate(0, 0, -0.35); ailR.position.set(4.4, -0.2, 0.9);
  group.add(ailR);

  const hstab = bag.track(new THREE.Mesh(box(bag, 5.2, 0.2, 1.5), mats.wing));
  hstab.position.set(0, 0.2, -4.6);
  group.add(hstab);
  const elevator = bag.track(new THREE.Mesh(box(bag, 5.0, 0.14, 0.6), mats.surface));
  elevator.geometry.translate(0, 0, -0.3); elevator.position.set(0, 0.2, -5.2);
  group.add(elevator);
  const vstab = bag.track(new THREE.Mesh(box(bag, 0.22, 2.1, 1.8), mats.body));
  vstab.position.set(0, 1.2, -4.7);
  group.add(vstab);
  const rudder = bag.track(new THREE.Mesh(box(bag, 0.16, 1.9, 0.6), mats.surface));
  rudder.geometry.translate(0, 0, -0.3); rudder.position.set(0, 1.2, -5.3);
  group.add(rudder);

  // Tail-mounted turbofan with a spinning fan disc in the intake.
  const engine = bag.track(new THREE.Mesh(cyl(bag, 0.7, 0.7, 2.0, 16), mats.strut));
  engine.rotation.x = Math.PI / 2; engine.position.set(0, 0.1, -5.0);
  group.add(engine);
  const propHub = new THREE.Group();
  propHub.position.set(0, 0.1, -4.0);
  for (let i = 0; i < 8; i++) {
    const blade = bag.track(new THREE.Mesh(box(bag, 0.1, 1.1, 0.04), surfaceMat(bag, 0x8b929c, { metalness: 0.8, roughness: 0.3 })));
    blade.rotation.z = (i / 8) * Math.PI * 2; propHub.add(blade);
  }
  const disc = bag.track(new THREE.Mesh(new THREE.CircleGeometry(0.66, 20), new THREE.MeshBasicMaterial({ color: 0x11151a, side: THREE.DoubleSide })));
  disc.position.z = -0.1; propHub.add(disc);
  group.add(propHub);

  // Retractable tricycle gear (matches jet gear stance).
  const gearGroup = new THREE.Group();
  const noseGear = makeGearLeg(bag, mats, { x: 0, y: -0.6, z: 2.40, legLen: 0.9, wheelR: 0.3, retract: { axis: "x", amount: -1.5 } });
  const leftGear = makeGearLeg(bag, mats, { x: -2.10, y: -0.55, z: -1.10, legLen: 0.85, wheelR: 0.34, retract: { axis: "z", amount: 1.5 } });
  const rightGear = makeGearLeg(bag, mats, { x: 2.10, y: -0.55, z: -1.10, legLen: 0.85, wheelR: 0.34, retract: { axis: "z", amount: -1.5 } });
  gearGroup.add(noseGear, leftGear, rightGear);
  group.add(gearGroup);

  const lights = buildLights(bag, group, { span: 6.7, wingY: -0.2, wingZ: -0.3, tailY: 2.2, tailZ: -5.3, noseZ: 6.6, beaconY: 1.6 });
  return finalizeAircraft(group, bag, {
    ailL, ailR, elevator, rudder, propHub, disc, gears: [noseGear, leftGear, rightGear], lights, propType: "fan",
  });
}

// ── Lights (nav / strobe / beacon / landing), emissive primitives ────────────
function buildLights(bag, group, cfg) {
  const half = cfg.span / 2;
  const mk = (color, x, y, z, r = 0.11) => {
    const m = new THREE.Mesh(sph(bag, r, 6), lightMat(bag, color));
    m.position.set(x, y, z);
    group.add(m);
    return m;
  };
  const navLeft = mk(NAV_RED, -half, cfg.wingY + 0.05, cfg.wingZ);
  const navRight = mk(NAV_GREEN, half, cfg.wingY + 0.05, cfg.wingZ);
  const navTail = mk(WHITE, 0, cfg.tailY, cfg.tailZ, 0.09);
  const strobeLeft = mk(WHITE, -half, cfg.wingY + 0.05, cfg.wingZ, 0.09);
  const strobeRight = mk(WHITE, half, cfg.wingY + 0.05, cfg.wingZ, 0.09);
  const beacon = mk(BEACON_RED, 0, cfg.beaconY, -0.5, 0.1);
  const landing = mk(WHITE, 0, cfg.wingY, cfg.noseZ, 0.13);
  landing.material.color.setHex(0xfff6d0);
  return { navLeft, navRight, navTail, strobeLeft, strobeRight, beacon, landing };
}

function finalizeAircraft(group, bag, parts) {
  const { ailL, ailR, elevator, rudder, propHub, disc, gears, lights, propType, fixedGear } = parts;
  let gearExt = 1;

  function update(sim) {
    const c = sim.controls || {};
    // Control surfaces (visual sense; magnitudes bounded to plausible throws).
    const pitch = clamp(c.pitch || 0, -1, 1);
    const roll = clamp(c.roll || 0, -1, 1);
    const yaw = clamp(c.yaw || 0, -1, 1);
    elevator.rotation.x = pitch * 0.5;
    rudder.rotation.y = -yaw * 0.5;
    ailL.rotation.x = -roll * 0.5;   // ailerons differential
    ailR.rotation.x = roll * 0.5;

    // Prop / fan spin — rate tracks rpm; blur the disc at speed.
    const rpm = sim.rpm == null ? 0.6 : sim.rpm;
    const spin = (sim.t || 0) * (propType === "fan" ? 60 : 40) * (0.3 + rpm);
    propHub.rotation.z = spin;
    if (disc && disc.material) {
      const blur = clamp((rpm - 0.4) * 2, 0, 1);
      disc.material.opacity = propType === "fan" ? 1 : blur * 0.55;
    }

    // Gear retraction — ease toward commanded state.
    const target = fixedGear ? 1 : clamp(sim.gear == null ? 1 : sim.gear, 0, 1);
    gearExt += (target - gearExt) * 0.12;
    for (const g of gears) applyGear(g, gearExt);

    // Lights.
    const t = sim.t || 0;
    const strobeOn = (t % 1.1) < 0.06 || ((t % 1.1) > 0.16 && (t % 1.1) < 0.22);
    lights.strobeLeft.visible = strobeOn;
    lights.strobeRight.visible = strobeOn;
    lights.beacon.visible = (t % 1.4) < 0.7;
    // Landing lights on when gear is (mostly) down.
    lights.landing.visible = gearExt > 0.5;
  }

  return {
    group,
    update,
    dispose() {
      for (const g of bag.geos) g.dispose();
      for (const m of bag.mats) m.dispose();
    },
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

const BUILDERS = { trainer: buildTrainer, aerobatic: buildAerobatic, jet: buildJet };

/** createAirframeMesh(id) → { group, update(sim), dispose() }. */
export function createAirframeMesh(id) {
  const bag = makeBag();
  const build = BUILDERS[id] || BUILDERS.trainer;
  return build(bag);
}

export const AIRFRAME_MESH_IDS = Object.freeze(Object.keys(BUILDERS));
export const __OFS_BOUNDARY__ = "airframe-mesh";
