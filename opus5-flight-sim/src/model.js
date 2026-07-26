/**
 * Aircraft meshes built from primitives, with animated control surfaces,
 * flaps, retractable gear, a propeller that blurs with RPM, and position /
 * anti-collision lighting.
 *
 * Local space matches three.js convention: -Z forward, +X right, +Y up.
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Lifting-surface helper                                              */
/* ------------------------------------------------------------------ */

/**
 * A tapered, swept, dihedral lifting surface with a symmetric airfoil section.
 * Built by extruding one section and warping it per-vertex.
 */
function liftingSurface({
  span, chordRoot, chordTip = chordRoot, thickness = 0.12,
  sweepDeg = 0, dihedralDeg = 0, twistDeg = 0, halves = 'both',
}) {
  const c = chordRoot;
  const t = thickness * c;
  const shape = new THREE.Shape();
  const N = 14;
  const camber = (x) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
  shape.moveTo(0, 0);
  for (let i = 1; i <= N; i++) { const u = i / N; shape.lineTo(u * c, camber(u)); }
  for (let i = N; i >= 0; i--) { const u = i / N; shape.lineTo(u * c, -camber(u)); }

  const geo = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false, curveSegments: 2 });
  geo.rotateY(-Math.PI / 2);           // extrusion axis -> -X
  geo.translate(span / 2, 0, 0);       // centre on the fuselage

  const pos = geo.attributes.position;
  const half = span / 2;
  const tanS = Math.tan(sweepDeg * DEG);
  const tanD = Math.tan(dihedralDeg * DEG);
  const tipRatio = chordTip / chordRoot;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    const f = Math.min(1, Math.abs(x) / half);
    const taper = 1 + (tipRatio - 1) * f;
    z *= taper; y *= taper;
    const tw = twistDeg * DEG * f;
    const cz = z * Math.cos(tw) - y * Math.sin(tw);
    const cy = z * Math.sin(tw) + y * Math.cos(tw);
    pos.setZ(i, cz + Math.abs(x) * tanS);
    pos.setY(i, cy + Math.abs(x) * tanD);
  }
  geo.computeVertexNormals();
  if (halves === 'right') geo.translate(half, 0, 0);
  if (halves === 'left') geo.translate(-half, 0, 0);
  return geo;
}

function lathe(profile, segments = 16) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.001), y));
  const g = new THREE.LatheGeometry(pts, segments);
  g.rotateX(Math.PI / 2); // axis Y -> Z (nose toward -Z when profile y is negative)
  return g;
}

function glow(color, size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, '#fff');
  grd.addColorStop(0.3, color);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(cv);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  s.scale.setScalar(size);
  return s;
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

function makeProp(radius, blades, color = 0x14161c) {
  const g = new THREE.Group();
  const hub = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.55, 10),
    new THREE.MeshStandardMaterial({ color: 0xb8bec9, metalness: 0.8, roughness: 0.3 })
  );
  hub.rotation.x = -Math.PI / 2;
  g.add(hub);
  const bladeGeo = liftingSurface({ span: radius, chordRoot: 0.20, chordTip: 0.11, thickness: 0.14, halves: 'right' });
  const bladeMat = new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.55 });
  const spin = new THREE.Group();
  for (let i = 0; i < blades; i++) {
    const b = new THREE.Mesh(bladeGeo, bladeMat);
    b.rotation.z = (i / blades) * Math.PI * 2;
    b.rotation.y = 0.35;
    spin.add(b);
  }
  g.add(spin);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 28),
    new THREE.MeshBasicMaterial({ color: 0xc9d4e2, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
  );
  disc.position.z = -0.05;
  g.add(disc);
  return { group: g, spin, disc };
}

function wheel(r, w, color = 0x1a1c22) {
  const g = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, w, 14),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
  );
  g.rotation.z = Math.PI / 2;
  return g;
}

function buildTrainer(cfg) {
  const L = cfg.livery;
  const body = new THREE.MeshStandardMaterial({ color: L.body, metalness: 0.25, roughness: 0.42 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.4, roughness: 0.5 });
  const stripe = new THREE.MeshStandardMaterial({ color: L.stripe, metalness: 0.3, roughness: 0.4 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x86b4d8, metalness: 0, roughness: 0.06, transmission: 0.82,
    transparent: true, opacity: 0.55, side: THREE.DoubleSide,
  });

  const root = new THREE.Group();
  const parts = {};

  const fus = new THREE.Mesh(lathe([
    [0.06, -3.35], [0.40, -3.05], [0.62, -2.5], [0.72, -1.6], [0.74, 0.0],
    [0.68, 1.2], [0.50, 2.6], [0.30, 3.8], [0.08, 4.55],
  ], 18), body);
  root.add(fus);

  const cowl = new THREE.Mesh(lathe([[0.30, -3.5], [0.58, -3.3], [0.66, -2.9], [0.66, -2.4]], 16), stripe);
  root.add(cowl);

  // Cabin greenhouse
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.26, 0.78, 2.5), glass);
  cabin.position.set(0, 0.52, -0.9);
  root.add(cabin);
  const wsPost = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.10, 0.10), body);
  wsPost.position.set(0, 0.90, -2.14);
  root.add(wsPost);

  // High wing
  const wing = new THREE.Mesh(
    liftingSurface({ span: cfg.dims.span, chordRoot: 1.62, chordTip: 1.14, thickness: 0.13, dihedralDeg: 1.7 }),
    body
  );
  wing.position.set(0, 1.02, -1.35);
  wing.castShadow = true;
  root.add(wing);
  const wingStripe = new THREE.Mesh(new THREE.BoxGeometry(cfg.dims.span * 0.98, 0.035, 0.30), stripe);
  wingStripe.position.set(0, 0.98, -0.35);
  root.add(wingStripe);

  // Struts
  for (const s of [-1, 1]) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.22, 2.9), body);
    st.position.set(s * 1.55, 0.45, -0.9);
    st.rotation.z = s * 0.60;
    st.rotation.x = 0.03;
    root.add(st);
  }

  // Flaps + ailerons (inboard / outboard of each half-wing)
  parts.flaps = [];
  parts.ailerons = [];
  for (const s of [-1, 1]) {
    const flap = new THREE.Group();
    const fm = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.06, 0.46), body);
    fm.position.z = 0.23;
    flap.add(fm);
    flap.position.set(s * 1.55, 0.98, -0.62);
    root.add(flap);
    parts.flaps.push(flap);

    const ail = new THREE.Group();
    const am = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.055, 0.40), body);
    am.position.z = 0.20;
    ail.add(am);
    ail.position.set(s * 3.9, 1.05, -0.75);
    root.add(ail);
    parts.ailerons.push({ g: ail, side: s });
  }

  // Empennage
  const fin = new THREE.Mesh(
    liftingSurface({ span: 1.62, chordRoot: 1.55, chordTip: 0.85, thickness: 0.11, sweepDeg: 34, halves: 'right' }),
    body
  );
  fin.rotation.z = Math.PI / 2;
  fin.position.set(0, 0.28, 3.0);
  root.add(fin);
  const finCap = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.9, 0.7), stripe);
  finCap.position.set(0, 1.55, 3.55);
  root.add(finCap);

  parts.rudder = new THREE.Group();
  const rud = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.45, 0.68), body);
  rud.position.set(0, 0.72, 0.34);
  parts.rudder.add(rud);
  parts.rudder.position.set(0, 0.30, 3.86);
  root.add(parts.rudder);

  const tail = new THREE.Mesh(
    liftingSurface({ span: 3.35, chordRoot: 1.05, chordTip: 0.72, thickness: 0.10 }),
    body
  );
  tail.position.set(0, 0.30, 3.25);
  root.add(tail);

  parts.elevator = new THREE.Group();
  const elv = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.05, 0.52), body);
  elv.position.z = 0.26;
  parts.elevator.add(elv);
  parts.elevator.position.set(0, 0.31, 3.98);
  root.add(parts.elevator);

  // Fixed tricycle gear
  const gear = new THREE.Group();
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.11, 0.20), dark);
    leg.position.set(s * 0.72, -0.62, 0.32);
    leg.rotation.z = -s * 0.42;
    gear.add(leg);
    const w = wheel(0.22, 0.14);
    w.position.set(s * 1.42, -1.18, 0.32);
    gear.add(w);
    const fair = new THREE.Mesh(new THREE.SphereGeometry(0.30, 10, 8), body);
    fair.scale.set(0.8, 0.85, 1.5);
    fair.position.set(s * 1.42, -1.14, 0.32);
    gear.add(fair);
  }
  const nLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 1.05, 8), dark);
  nLeg.position.set(0, -0.95, -1.05);
  gear.add(nLeg);
  const nw = wheel(0.19, 0.12);
  nw.position.set(0, -1.42, -1.05);
  gear.add(nw);
  root.add(gear);
  parts.gear = gear;

  const prop = makeProp(0.94, 2);
  prop.group.position.set(0, 0, -3.62);
  root.add(prop.group);
  parts.prop = prop;

  parts.lightAnchors = {
    left: [-cfg.dims.span / 2, 1.05, -1.0],
    right: [cfg.dims.span / 2, 1.05, -1.0],
    tail: [0, 1.2, 4.0],
    beacon: [0, 1.75, 3.3],
    landing: [-1.6, 0.95, -1.7],
  };
  parts.eye = new THREE.Vector3(-0.34, 0.62, -1.62);
  return { root, parts };
}

function buildAerobat(cfg) {
  const L = cfg.livery;
  const body = new THREE.MeshStandardMaterial({ color: L.body, metalness: 0.35, roughness: 0.34 });
  const red = new THREE.MeshStandardMaterial({ color: L.stripe, metalness: 0.3, roughness: 0.35 });
  const gold = new THREE.MeshStandardMaterial({ color: L.accent, metalness: 0.6, roughness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15181e, roughness: 0.6 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x9ec8e8, roughness: 0.05, transmission: 0.85, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
  });

  const root = new THREE.Group();
  const parts = {};

  const fus = new THREE.Mesh(lathe([
    [0.05, -2.85], [0.44, -2.55], [0.60, -1.9], [0.62, -0.6],
    [0.52, 0.9], [0.34, 2.4], [0.16, 3.5], [0.05, 4.05],
  ], 18), body);
  root.add(fus);
  const cowl = new THREE.Mesh(lathe([[0.26, -3.0], [0.56, -2.8], [0.60, -2.3]], 16), red);
  root.add(cowl);

  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  canopy.scale.set(1, 0.85, 2.1);
  canopy.position.set(0, 0.42, -0.35);
  root.add(canopy);

  const wing = new THREE.Mesh(
    liftingSurface({ span: cfg.dims.span, chordRoot: 1.42, chordTip: 1.02, thickness: 0.15, sweepDeg: 2 }),
    red
  );
  wing.position.set(0, -0.05, -0.55);
  wing.castShadow = true;
  root.add(wing);
  const chev = new THREE.Mesh(new THREE.BoxGeometry(cfg.dims.span * 0.96, 0.03, 0.22), gold);
  chev.position.set(0, 0.06, -0.2);
  root.add(chev);

  parts.flaps = [];
  parts.ailerons = [];
  for (const s of [-1, 1]) {
    const ail = new THREE.Group();
    const am = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.05, 0.44), red);
    am.position.z = 0.22;
    ail.add(am);
    ail.position.set(s * 2.3, -0.02, 0.62);
    root.add(ail);
    parts.ailerons.push({ g: ail, side: s });
  }

  const fin = new THREE.Mesh(
    liftingSurface({ span: 1.35, chordRoot: 1.35, chordTip: 0.78, thickness: 0.10, sweepDeg: 24, halves: 'right' }),
    body
  );
  fin.rotation.z = Math.PI / 2;
  fin.position.set(0, 0.14, 2.55);
  root.add(fin);

  parts.rudder = new THREE.Group();
  const rud = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.30, 0.66), red);
  rud.position.set(0, 0.66, 0.33);
  parts.rudder.add(rud);
  parts.rudder.position.set(0, 0.16, 3.35);
  root.add(parts.rudder);

  const tail = new THREE.Mesh(liftingSurface({ span: 3.0, chordRoot: 0.95, chordTip: 0.64, thickness: 0.10 }), body);
  tail.position.set(0, 0.05, 2.85);
  root.add(tail);
  parts.elevator = new THREE.Group();
  const elv = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.05, 0.48), red);
  elv.position.z = 0.24;
  parts.elevator.add(elv);
  parts.elevator.position.set(0, 0.06, 3.52);
  root.add(parts.elevator);

  // Taildragger gear with spatted mains
  const gear = new THREE.Group();
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.10, 0.26), dark);
    leg.position.set(s * 0.6, -0.42, -0.55);
    leg.rotation.z = -s * 0.55;
    gear.add(leg);
    const spat = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), red);
    spat.scale.set(0.62, 0.9, 1.5);
    spat.position.set(s * 1.05, -0.92, -0.55);
    gear.add(spat);
    const w = wheel(0.22, 0.13);
    w.position.set(s * 1.05, -1.0, -0.55);
    gear.add(w);
  }
  const tw = wheel(0.10, 0.07);
  tw.position.set(0, -0.48, 3.6);
  gear.add(tw);
  const tl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.36, 0.06), dark);
  tl.position.set(0, -0.32, 3.6);
  gear.add(tl);
  root.add(gear);
  parts.gear = gear;

  const prop = makeProp(1.0, 3, 0x0d0f14);
  prop.group.position.set(0, 0, -3.1);
  root.add(prop.group);
  parts.prop = prop;

  parts.lightAnchors = {
    left: [-cfg.dims.span / 2, 0.02, -0.2],
    right: [cfg.dims.span / 2, 0.02, -0.2],
    tail: [0, 0.5, 3.6],
    beacon: [0, 1.4, 2.8],
    landing: [-1.2, -0.05, -0.9],
  };
  parts.eye = new THREE.Vector3(0, 0.48, -0.55);
  return { root, parts };
}

function buildJet(cfg) {
  const L = cfg.livery;
  const body = new THREE.MeshStandardMaterial({ color: L.body, metalness: 0.55, roughness: 0.24 });
  const trim = new THREE.MeshStandardMaterial({ color: L.stripe, metalness: 0.4, roughness: 0.3 });
  const accent = new THREE.MeshStandardMaterial({ color: L.accent, metalness: 0.5, roughness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22262e, metalness: 0.6, roughness: 0.4 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x1b2a3a, roughness: 0.04, metalness: 0.2, transmission: 0.6, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
  });

  const root = new THREE.Group();
  const parts = {};

  const fus = new THREE.Mesh(lathe([
    [0.10, -8.4], [0.65, -8.0], [1.05, -7.0], [1.28, -5.6], [1.36, -3.0],
    [1.36, 2.0], [1.20, 4.6], [0.86, 6.6], [0.42, 8.0], [0.12, 8.7],
  ], 22), body);
  root.add(fus);

  const nose = new THREE.Mesh(lathe([[0.05, -8.9], [0.42, -8.6], [0.72, -8.1]], 18), trim);
  root.add(nose);
  const belt = new THREE.Mesh(new THREE.BoxGeometry(2.76, 0.22, 13), accent);
  belt.position.set(0, -0.55, -0.6);
  root.add(belt);

  const wsh = new THREE.Mesh(new THREE.SphereGeometry(1.2, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  wsh.scale.set(0.95, 0.62, 1.5);
  wsh.position.set(0, 0.55, -6.3);
  root.add(wsh);

  const wing = new THREE.Mesh(
    liftingSurface({ span: cfg.dims.span, chordRoot: 3.6, chordTip: 1.5, thickness: 0.11, sweepDeg: 24, dihedralDeg: 3.5, twistDeg: -2 }),
    body
  );
  wing.position.set(0, -0.85, -0.6);
  wing.castShadow = true;
  root.add(wing);
  for (const s of [-1, 1]) {
    const wl = new THREE.Mesh(liftingSurface({ span: 1.2, chordRoot: 1.3, chordTip: 0.6, thickness: 0.09, sweepDeg: 32, halves: 'right' }), accent);
    wl.rotation.z = Math.PI / 2 * s;
    wl.position.set(s * cfg.dims.span / 2, -0.35, 2.4);
    root.add(wl);
  }

  parts.flaps = [];
  parts.ailerons = [];
  for (const s of [-1, 1]) {
    const flap = new THREE.Group();
    const fm = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.10, 0.95), body);
    fm.position.z = 0.48;
    flap.add(fm);
    flap.position.set(s * 3.0, -0.72, 1.7);
    root.add(flap);
    parts.flaps.push(flap);

    const ail = new THREE.Group();
    const am = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 0.62), body);
    am.position.z = 0.31;
    ail.add(am);
    ail.position.set(s * 6.4, -0.52, 2.5);
    root.add(ail);
    parts.ailerons.push({ g: ail, side: s });
  }

  // Fuselage-mounted turbofans
  for (const s of [-1, 1]) {
    const nac = new THREE.Mesh(new THREE.CylinderGeometry(0.86, 0.78, 3.4, 16), body);
    nac.rotation.x = Math.PI / 2;
    nac.position.set(s * 2.1, 0.55, 3.2);
    root.add(nac);
    const inlet = new THREE.Mesh(new THREE.TorusGeometry(0.84, 0.10, 8, 18), dark);
    inlet.position.set(s * 2.1, 0.55, 1.5);
    root.add(inlet);
    const fan = new THREE.Mesh(new THREE.CircleGeometry(0.76, 18), new THREE.MeshStandardMaterial({ color: 0x0b0d11, metalness: 0.9, roughness: 0.25 }));
    fan.position.set(s * 2.1, 0.55, 1.49);
    root.add(fan);
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.9, 2.2), body);
    pylon.position.set(s * 1.5, 0.5, 3.2);
    root.add(pylon);
  }

  // T-tail
  const fin = new THREE.Mesh(
    liftingSurface({ span: 3.4, chordRoot: 3.2, chordTip: 1.6, thickness: 0.10, sweepDeg: 40, halves: 'right' }),
    trim
  );
  fin.rotation.z = Math.PI / 2;
  fin.position.set(0, 0.9, 5.2);
  root.add(fin);
  parts.rudder = new THREE.Group();
  const rud = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.8, 1.0), trim);
  rud.position.set(0, 1.4, 0.5);
  parts.rudder.add(rud);
  parts.rudder.position.set(0, 1.0, 7.6);
  root.add(parts.rudder);

  const tail = new THREE.Mesh(
    liftingSurface({ span: 6.2, chordRoot: 1.8, chordTip: 1.0, thickness: 0.09, sweepDeg: 26 }),
    body
  );
  tail.position.set(0, 4.15, 6.2);
  root.add(tail);
  parts.elevator = new THREE.Group();
  const elv = new THREE.Mesh(new THREE.BoxGeometry(6.1, 0.09, 0.72), body);
  elv.position.z = 0.36;
  parts.elevator.add(elv);
  parts.elevator.position.set(0, 4.18, 7.4);
  root.add(parts.elevator);

  // Retractable tricycle gear
  const gear = new THREE.Group();
  const nose_g = new THREE.Group();
  const nleg = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 1.8, 8), dark);
  nleg.position.y = -0.9;
  nose_g.add(nleg);
  const nw2 = wheel(0.32, 0.2);
  nw2.position.y = -1.78;
  nose_g.add(nw2);
  nose_g.position.set(0, -1.05, -5.0);
  gear.add(nose_g);
  for (const s of [-1, 1]) {
    const mg = new THREE.Group();
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 1.7, 8), dark);
    leg.position.y = -0.85;
    mg.add(leg);
    for (const o of [-0.26, 0.26]) {
      const w = wheel(0.40, 0.24);
      w.position.set(o, -1.7, 0);
      mg.add(w);
    }
    mg.position.set(s * 2.3, -1.05, 1.4);
    gear.add(mg);
  }
  root.add(gear);
  parts.gear = gear;
  parts.gearDoors = [];

  parts.prop = null;
  parts.lightAnchors = {
    left: [-cfg.dims.span / 2, -0.3, 2.3],
    right: [cfg.dims.span / 2, -0.3, 2.3],
    tail: [0, 4.4, 7.6],
    beacon: [0, -1.5, 0.5],
    landing: [0, -1.2, -4.6],
  };
  parts.eye = new THREE.Vector3(-0.5, 0.55, -6.6);
  return { root, parts };
}

/* ------------------------------------------------------------------ */
/* Animated wrapper                                                    */
/* ------------------------------------------------------------------ */

export class AircraftModel {
  constructor(cfg) {
    const built =
      cfg.id === 'jet' ? buildJet(cfg) :
      cfg.id === 'aerobat' ? buildAerobat(cfg) :
      buildTrainer(cfg);

    this.cfg = cfg;
    this.root = built.root;
    this.parts = built.parts;
    this.propAngle = 0;

    this.root.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; }
    });

    // Position + anti-collision lights
    const A = this.parts.lightAnchors;
    this.navLeft = glow('rgba(255,40,40,0.95)', 1.4);
    this.navLeft.position.fromArray(A.left);
    this.navRight = glow('rgba(40,255,90,0.95)', 1.4);
    this.navRight.position.fromArray(A.right);
    this.navTail = glow('rgba(255,255,255,0.9)', 1.2);
    this.navTail.position.fromArray(A.tail);
    this.beacon = glow('rgba(255,60,40,1)', 2.2);
    this.beacon.position.fromArray(A.beacon);
    this.strobeL = glow('rgba(255,255,255,1)', 2.6);
    this.strobeL.position.fromArray(A.left);
    this.strobeR = glow('rgba(255,255,255,1)', 2.6);
    this.strobeR.position.fromArray(A.right);
    this.root.add(this.navLeft, this.navRight, this.navTail, this.beacon, this.strobeL, this.strobeR);

    this.landingLight = new THREE.SpotLight(0xfff3d6, 0, 900, 0.30, 0.55, 1.2);
    this.landingLight.position.fromArray(A.landing);
    this.landingTarget = new THREE.Object3D();
    this.landingTarget.position.set(A.landing[0], A.landing[1] - 8, A.landing[2] - 120);
    this.root.add(this.landingLight, this.landingTarget);
    this.landingLight.target = this.landingTarget;

    this.gearBaseY = this.parts.gear.position.y;
  }

  /**
   * @param {FlightModel} ac
   * @param {number} dt
   * @param {number} t   wall time for strobes
   */
  update(ac, dt, t) {
    const P = this.parts;
    const inp = ac.input;

    // Control surfaces
    const ail = inp.aileron * 22 * DEG;
    for (const a of P.ailerons) a.g.rotation.x = a.side * ail;
    if (P.elevator) P.elevator.rotation.x = -(inp.elevator + ac.trim * 0.5) * 20 * DEG;
    if (P.rudder) P.rudder.rotation.y = -inp.rudder * 24 * DEG;
    for (const f of P.flaps) f.rotation.x = ac.flapPos * 38 * DEG;

    // Propeller: blades spin, disc blurs in
    if (P.prop) {
      const rpm = ac.rpm;
      this.propAngle += (rpm / 60) * Math.PI * 2 * dt * 0.12;
      P.prop.spin.rotation.z = this.propAngle;
      const blur = Math.min(1, Math.max(0, (rpm - 500) / 900));
      P.prop.disc.material.opacity = blur * 0.30;
      P.prop.spin.visible = blur < 0.98;
    }

    // Gear retraction: swing up and fade the struts into the wells
    if (this.cfg.gear.retractable) {
      const g = ac.gearPos;
      P.gear.position.y = this.gearBaseY + (1 - g) * 1.15;
      P.gear.scale.setScalar(0.25 + g * 0.75);
      P.gear.visible = g > 0.02;
    }

    // Lighting
    const strobe = (t % 1.15) < 0.055 || ((t + 0.10) % 1.15) < 0.045;
    this.strobeL.visible = this.strobeR.visible = strobe;
    const bcn = 0.35 + 0.65 * Math.max(0, Math.sin(t * 4.2));
    this.beacon.material.opacity = bcn;
    this.beacon.scale.setScalar(1.6 + bcn * 1.0);
  }

  setLandingLight(on, intensity = 3.0) {
    this.landingLight.intensity = on ? intensity : 0;
  }

  setVisible(v) { this.root.visible = v; }
}
