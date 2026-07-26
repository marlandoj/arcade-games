/**
 * World: procedural terrain (shared by physics and rendering), atmospheric sky,
 * water, instanced cloud layer, and the airport — runway, painted markings,
 * edge/threshold/approach lighting, a live PAPI, and scenery.
 *
 * The terrain height function is authoritative: the collision model and the
 * mesh sample exactly the same `heightAt`, so wheels never float or sink.
 */

import * as THREE from 'three';

export const AIRPORT = {
  elev: 210,
  rwyHeading: 270,      // primary landing direction (deg true)
  length: 1600,
  width: 45,
  // Runway runs along world X. RWY 27 lands westbound (toward -X).
  thr27: 800,
  thr09: -800,
  aim27: 500,
  papiX: 500,
  papiZ: -38,
  glideDeg: 3.0,
  name: 'KZBR / ZOUROBOROS FIELD',
};

const SEA = 138;

/* ------------------------------------------------------------------ */
/* Noise                                                               */
/* ------------------------------------------------------------------ */

function hash2(ix, iy) {
  let n = (ix * 374761393 + iy * 668265263) | 0;
  n = (n ^ (n >> 13)) | 0;
  n = Math.imul(n, 1274126177) | 0;
  n = (n ^ (n >> 16)) >>> 0;
  return n / 4294967295;
}

function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

function fbm(x, y, oct, gain = 0.5, lac = 2.03) {
  let s = 0, a = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y);
    n += a; a *= gain;
    x *= lac; y *= lac;
    x += 31.4; y -= 17.7;
  }
  return s / n;
}

function ridged(x, y, oct) {
  let s = 0, a = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    const v = 1 - Math.abs(vnoise(x, y) * 2 - 1);
    s += a * v * v;
    n += a; a *= 0.52;
    x *= 2.07; y *= 2.07;
    x -= 12.3; y += 41.1;
  }
  return s / n;
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ */
/* Terrain                                                             */
/* ------------------------------------------------------------------ */

const GRASS = { rollMu: 0.075, gripMu: 0.52, rough: 1.0 };
const PAVED = { rollMu: 0.018, gripMu: 0.80, rough: 0.06 };
const WET = { rollMu: 0.020, gripMu: 0.45, rough: 0.06 };

export class Terrain {
  constructor({ wetRunway = false } = {}) {
    this.paved = wetRunway ? WET : PAVED;
    this.grass = GRASS;
    this._cache = new Map();
  }

  /** Metres above mean sea level at a world XZ position. */
  heightAt(x, z) {
    const r = Math.hypot(x, z);

    // Rolling base terrain
    let h = 150 + fbm(x * 0.00042 + 100, z * 0.00042 - 60, 4) * 150;
    // Broad basin to the south-west drops toward the water
    const basin = smoothstep(1800, 11000, Math.hypot(x + 7000, z - 6500));
    h -= (1 - basin) * 90;

    // Mountain ranges: strongest to the north and east, far from the field
    const far = smoothstep(2600, 15000, r);
    const northMask = smoothstep(-2000, -11000, z) * 0.9 + 0.35;
    const eastMask = smoothstep(4000, 16000, x) * 0.7;
    const mask = Math.min(1.4, far * (northMask + eastMask));
    h += ridged(x * 0.000105 + 5, z * 0.000105 - 9, 5) * 1750 * mask;
    h += fbm(x * 0.0016, z * 0.0016, 3) * 26 * smoothstep(400, 2500, r);

    // Airport plateau
    const airportBlend = smoothstep(1250, 4200, Math.hypot(x * 0.72, z));
    h = AIRPORT.elev + (h - AIRPORT.elev) * airportBlend;

    return h;
  }

  /** Surface friction properties at a world XZ position. */
  surfaceAt(x, z) {
    const A = AIRPORT;
    if (Math.abs(x) <= A.length / 2 + 30 && Math.abs(z) <= A.width / 2 + 1.5) return this.paved;
    // Parallel taxiway + apron
    if (Math.abs(x) <= 820 && z >= 84 && z <= 108) return this.paved;
    if (x >= -230 && x <= 130 && z >= 100 && z <= 235) return this.paved;
    if (x >= 690 && x <= 720 && z >= 20 && z <= 100) return this.paved;
    if (x >= -720 && x <= -690 && z >= 20 && z <= 100) return this.paved;
    return this.grass;
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const d = 4;
    const hL = this.heightAt(x - d, z), hR = this.heightAt(x + d, z);
    const hD = this.heightAt(x, z - d), hU = this.heightAt(x, z + d);
    return out.set(hL - hR, 2 * d, hD - hU).normalize();
  }

  /**
   * Radially graded mesh: ~27 m spacing near the field, ~280 m at 20 km.
   * One continuous surface, so there is no LOD seam anywhere.
   */
  buildMesh(divisions = 340, radius = 20000) {
    const N = divisions + 1;
    const pos = new Float32Array(N * N * 3);
    const col = new Float32Array(N * N * 3);
    const idx = [];
    const warp = (t) => {
      const s = Math.sign(t), a = Math.abs(t);
      return s * (0.24 * a + 0.76 * a * a * a) * radius;
    };

    const c = new THREE.Color();
    const nrm = new THREE.Vector3();
    let p = 0;
    for (let j = 0; j < N; j++) {
      const z = warp((j / divisions) * 2 - 1);
      for (let i = 0; i < N; i++, p++) {
        const x = warp((i / divisions) * 2 - 1);
        const h = this.heightAt(x, z);
        pos[p * 3] = x; pos[p * 3 + 1] = h; pos[p * 3 + 2] = z;

        this.normalAt(x, z, nrm);
        const slope = 1 - nrm.y;
        const snow = smoothstep(1250, 1750, h + fbm(x * 0.002, z * 0.002, 2) * 180);
        const rock = smoothstep(0.10, 0.30, slope) * 0.85 + smoothstep(900, 1400, h) * 0.5;
        const dry = smoothstep(0.55, 0.0, smoothstep(SEA, SEA + 60, h)) * 0.7;
        const shore = smoothstep(SEA + 26, SEA - 2, h);

        c.setRGB(0.29, 0.40, 0.19);
        const tint = fbm(x * 0.0009 + 7, z * 0.0009 + 3, 3);
        c.r += tint * 0.10 - 0.04; c.g += tint * 0.09 - 0.03; c.b += tint * 0.05 - 0.02;
        c.lerp(new THREE.Color(0.42, 0.37, 0.24), Math.min(1, dry + shore * 0.85));
        c.lerp(new THREE.Color(0.38, 0.35, 0.33), Math.min(1, rock));
        c.lerp(new THREE.Color(0.93, 0.95, 0.98), snow);
        // Field patchwork on the flats near the airport
        if (h < 420 && slope < 0.06) {
          const f = vnoise(x * 0.0035 + 40, z * 0.0035 + 90);
          c.offsetHSL(0, f * 0.14 - 0.05, f * 0.09 - 0.035);
        }
        col[p * 3] = c.r; col[p * 3 + 1] = c.g; col[p * 3 + 2] = c.b;
      }
    }
    for (let j = 0; j < divisions; j++) {
      for (let i = 0; i < divisions; i++) {
        const a = j * N + i, b = a + 1, d = a + N, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    return mesh;
  }
}

/* ------------------------------------------------------------------ */
/* Sky                                                                 */
/* ------------------------------------------------------------------ */

const SKY_VERT = `
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;
}`;

const SKY_FRAG = `
precision highp float;
varying vec3 vDir;
uniform vec3 uSun;
uniform float uTurbidity;
uniform float uNight;
uniform vec3 uGround;

float hash13(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main(){
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);
  float sunCos = clamp(dot(d, uSun), -1.0, 1.0);
  float sunUp = clamp(uSun.y, -0.4, 1.0);

  // Rayleigh-ish vertical gradient
  float zenith = pow(max(up, 0.0), 0.42);
  vec3 blue   = vec3(0.16, 0.33, 0.72);
  vec3 haze   = vec3(0.72, 0.80, 0.90);
  vec3 sky = mix(haze, blue, zenith);

  // Warm scattering near the sun and along the horizon at low sun angles
  float lowSun = 1.0 - smoothstep(-0.02, 0.42, sunUp);
  vec3 warm = vec3(1.0, 0.48, 0.18);
  float mie = pow(max(sunCos, 0.0), 6.0) * 0.55 + pow(max(sunCos, 0.0), 40.0) * 0.9;
  sky = mix(sky, mix(sky, warm, 0.80), lowSun * pow(max(sunCos, 0.0), 1.6) * 0.9);
  sky += warm * mie * (0.35 + lowSun * 1.3) * uTurbidity;
  sky = mix(sky, mix(haze, warm, lowSun * 0.7), pow(1.0 - abs(up), 7.0) * 0.85);

  // Sun disc with limb softening
  float disc = smoothstep(0.99965, 0.99992, sunCos);
  sky += vec3(1.0, 0.93, 0.80) * disc * 6.0 * (0.25 + sunUp);

  // Night: deep blue, stars, faint moon glow
  vec3 night = mix(vec3(0.012, 0.020, 0.045), vec3(0.03, 0.05, 0.10), zenith);
  vec3 sp = floor(d * 620.0);
  float star = step(0.9975, hash13(sp));
  float tw = 0.55 + 0.45 * sin(hash13(sp + 3.0) * 100.0);
  night += vec3(0.85, 0.90, 1.0) * star * tw * smoothstep(0.02, 0.25, up);
  sky = mix(sky, night, uNight);

  // Ground half-space
  sky = mix(sky, uGround, smoothstep(0.0, -0.09, up));

  sky = sky / (sky + vec3(0.85));
  sky = pow(sky, vec3(0.86));
  gl_FragColor = vec4(sky, 1.0);
}`;

export class Sky {
  constructor() {
    this.uniforms = {
      uSun: { value: new THREE.Vector3(0.4, 0.5, -0.75).normalize() },
      uTurbidity: { value: 1.0 },
      uNight: { value: 0.0 },
      uGround: { value: new THREE.Color(0.30, 0.32, 0.30) },
    };
    const geo = new THREE.SphereGeometry(1, 40, 24);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(1);
  }
  setSun(dir, night, turbidity) {
    this.uniforms.uSun.value.copy(dir).normalize();
    this.uniforms.uNight.value = night;
    this.uniforms.uTurbidity.value = turbidity;
  }
}

export const TIME_PRESETS = {
  dawn: { label: 'DAWN', elev: 6, azim: 78, night: 0.18, turb: 1.5, amb: 0.35, sun: 0xffc39a, sunI: 1.5, fog: 0xb9c2cf },
  day: { label: 'MIDDAY', elev: 62, azim: 140, night: 0, turb: 0.85, amb: 0.62, sun: 0xfff6e8, sunI: 2.6, fog: 0xb8c9dd },
  dusk: { label: 'GOLDEN HOUR', elev: 9, azim: 268, night: 0.10, turb: 1.7, amb: 0.32, sun: 0xff9d5c, sunI: 1.7, fog: 0xd8b294 },
  night: { label: 'NIGHT', elev: -12, azim: 290, night: 1.0, turb: 0.4, amb: 0.10, sun: 0x9fb6e0, sunI: 0.30, fog: 0x0a1020 },
};

export function sunDirection(elevDeg, azimDeg) {
  const e = (elevDeg * Math.PI) / 180;
  const a = (azimDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)).normalize();
}

/* ------------------------------------------------------------------ */
/* Water                                                               */
/* ------------------------------------------------------------------ */

export function buildWater() {
  const g = new THREE.PlaneGeometry(120000, 120000, 1, 1);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshStandardMaterial({
    color: 0x1d3a52, roughness: 0.16, metalness: 0.55, transparent: true, opacity: 0.94,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.y = SEA;
  mesh.renderOrder = -5;
  return mesh;
}

/* ------------------------------------------------------------------ */
/* Clouds                                                              */
/* ------------------------------------------------------------------ */

function puffTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = (x / s - 0.5) * 2, dy = (y / s - 0.5) * 2;
      const d = Math.hypot(dx, dy);
      let a = Math.max(0, 1 - d);
      a *= a * a;
      const n = fbm(x * 0.09, y * 0.09, 4);
      a *= 0.55 + n * 0.75;
      const i = (y * s + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.max(0, Math.min(255, a * 255));
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const CLOUD_VERT = `
attribute vec3 iOffset;
attribute vec2 iScale;
attribute float iShade;
varying vec2 vUv;
varying float vShade;
varying float vFade;
uniform vec3 uCamPos;
void main(){
  vUv = uv;
  vShade = iShade;
  vec3 toCam = uCamPos - iOffset;
  float dist = length(toCam);
  vec3 f = toCam / max(dist, 0.001);
  vec3 r = normalize(cross(vec3(0.0,1.0,0.0), f));
  vec3 u = cross(f, r);
  vec3 world = iOffset + r * (position.x * iScale.x) + u * (position.y * iScale.y);
  vFade = smoothstep(120.0, 700.0, dist) * (1.0 - smoothstep(24000.0, 42000.0, dist));
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const CLOUD_FRAG = `
precision highp float;
varying vec2 vUv;
varying float vShade;
varying float vFade;
uniform sampler2D uMap;
uniform vec3 uTop;
uniform vec3 uBase;
uniform float uOpacity;
void main(){
  vec4 t = texture2D(uMap, vUv);
  if (t.a < 0.01) discard;
  vec3 c = mix(uBase, uTop, vShade);
  gl_FragColor = vec4(c, t.a * uOpacity * vFade);
}`;

export class CloudLayer {
  constructor({ base = 1500, coverage = 0.4, count = 620, spread = 26000 }) {
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;

    const n = Math.max(40, Math.floor(count * (0.35 + coverage)));
    const off = new Float32Array(n * 3);
    const scl = new Float32Array(n * 2);
    const shd = new Float32Array(n);

    let i = 0;
    let rnd = 8123;
    const rand = () => {
      rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
      return rnd / 0x7fffffff;
    };
    while (i < n) {
      const cx = (rand() - 0.5) * spread;
      const cz = (rand() - 0.5) * spread;
      const cy = base + (rand() - 0.5) * 260;
      const puffs = 5 + Math.floor(rand() * 9);
      const w = 260 + rand() * 520;
      for (let k = 0; k < puffs && i < n; k++, i++) {
        off[i * 3] = cx + (rand() - 0.5) * w * 1.7;
        off[i * 3 + 1] = cy + (rand() - 0.5) * 110 + (k / puffs) * 60;
        off[i * 3 + 2] = cz + (rand() - 0.5) * w * 1.7;
        const s = w * (0.35 + rand() * 0.55);
        scl[i * 2] = s;
        scl[i * 2 + 1] = s * (0.5 + rand() * 0.28);
        shd[i] = Math.min(1, 0.25 + (k / puffs) * 0.9 + rand() * 0.2);
      }
    }
    geo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(off, 3));
    geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(scl, 2));
    geo.setAttribute('iShade', new THREE.InstancedBufferAttribute(shd, 1));
    geo.instanceCount = n;

    this.uniforms = {
      uMap: { value: puffTexture() },
      uCamPos: { value: new THREE.Vector3() },
      uTop: { value: new THREE.Color(0xffffff) },
      uBase: { value: new THREE.Color(0x8e9bb0) },
      uOpacity: { value: 0.72 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }
  update(camPos, tint, litTop) {
    this.uniforms.uCamPos.value.copy(camPos);
    this.uniforms.uTop.value.copy(litTop);
    this.uniforms.uBase.value.copy(tint);
  }
}

/* ------------------------------------------------------------------ */
/* Airport                                                             */
/* ------------------------------------------------------------------ */

function runwayTexture() {
  const W = 4096, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#2c2f33';
  g.fillRect(0, 0, W, H);
  // Asphalt grain
  for (let i = 0; i < 26000; i++) {
    const v = 28 + Math.random() * 34;
    g.fillStyle = `rgba(${v},${v + 2},${v + 4},0.55)`;
    g.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }
  // Rubber deposits in both touchdown zones
  for (const cx of [W * 0.815, W * 0.185]) {
    const grad = g.createLinearGradient(cx - 190, 0, cx + 190, 0);
    grad.addColorStop(0, 'rgba(20,20,22,0)');
    grad.addColorStop(0.5, 'rgba(18,18,20,0.65)');
    grad.addColorStop(1, 'rgba(20,20,22,0)');
    g.fillStyle = grad;
    g.fillRect(cx - 190, 40, 380, H - 80);
  }
  g.fillStyle = '#e9edf2';
  // Centreline: 30 m dash / 20 m gap over 1600 m
  const mToPx = W / AIRPORT.length;
  for (let x = 90; x < AIRPORT.length - 90; x += 50) {
    g.fillRect(x * mToPx, H / 2 - 4, 30 * mToPx, 8);
  }
  // Threshold bars at both ends
  const barW = 22 * mToPx;
  for (let k = 0; k < 8; k++) {
    const y = 18 + k * 28;
    if (k === 3 || k === 4) continue;
    g.fillRect(8 * mToPx, y, barW, 18);
    g.fillRect(W - 8 * mToPx - barW, y, barW, 18);
  }
  // Touchdown-zone stripes at 150 m / 300 m / 450 m from each threshold
  for (const d of [150, 300, 450]) {
    for (const side of [-1, 1]) {
      const x = side < 0 ? d * mToPx : W - d * mToPx - 22 * mToPx;
      g.fillRect(x, H / 2 - 46, 22 * mToPx, 12);
      g.fillRect(x, H / 2 + 34, 22 * mToPx, 12);
    }
  }
  // Aiming point blocks at 300 m
  for (const side of [-1, 1]) {
    const x = side < 0 ? 300 * mToPx : W - 300 * mToPx - 45 * mToPx;
    g.fillRect(x, H / 2 - 74, 45 * mToPx, 26);
    g.fillRect(x, H / 2 + 48, 45 * mToPx, 26);
  }
  // Runway designators
  g.save();
  g.font = 'bold 92px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#e9edf2';
  g.translate(64 * mToPx, H / 2);
  g.rotate(-Math.PI / 2);
  g.fillText('09', 0, 0);
  g.restore();
  g.save();
  g.translate(W - 64 * mToPx, H / 2);
  g.rotate(Math.PI / 2);
  g.font = 'bold 92px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#e9edf2';
  g.fillText('27', 0, 0);
  g.restore();
  // Side edge lines
  g.fillStyle = '#dfe4ea';
  g.fillRect(0, 6, W, 5);
  g.fillRect(0, H - 11, W, 5);

  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function lightSpriteTexture(color) {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.22, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const LIGHT_VERT = `
attribute vec3 iOffset;
attribute vec3 iColor;
attribute float iSize;
varying vec2 vUv;
varying vec3 vCol;
varying float vAtt;
uniform vec3 uCamPos;
void main(){
  vUv = uv; vCol = iColor;
  vec3 toCam = uCamPos - iOffset;
  float dist = length(toCam);
  vec3 f = toCam / max(dist, 0.001);
  vec3 r = normalize(cross(vec3(0.0,1.0,0.0), f));
  vec3 u = cross(f, r);
  float size = iSize * (1.0 + dist * 0.010);
  vec3 world = iOffset + r * position.x * size + u * position.y * size;
  vAtt = 1.0 - smoothstep(9000.0, 16000.0, dist);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const LIGHT_FRAG = `
precision highp float;
varying vec2 vUv; varying vec3 vCol; varying float vAtt;
uniform sampler2D uMap; uniform float uIntensity;
void main(){
  float a = texture2D(uMap, vUv).a;
  if (a < 0.02) discard;
  gl_FragColor = vec4(vCol, a * uIntensity * vAtt);
}`;

class LightField {
  constructor(count) {
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    this.off = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.attrOff = new THREE.InstancedBufferAttribute(this.off, 3);
    this.attrCol = new THREE.InstancedBufferAttribute(this.col, 3);
    this.attrSize = new THREE.InstancedBufferAttribute(this.size, 1);
    geo.setAttribute('iOffset', this.attrOff);
    geo.setAttribute('iColor', this.attrCol);
    geo.setAttribute('iSize', this.attrSize);
    geo.instanceCount = 0;
    this.geo = geo;
    this.n = 0;
    this.uniforms = {
      uMap: { value: lightSpriteTexture('rgba(255,255,255,0.95)') },
      uCamPos: { value: new THREE.Vector3() },
      uIntensity: { value: 1 },
    };
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: LIGHT_VERT,
        fragmentShader: LIGHT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
  }
  add(x, y, z, r, g, b, size) {
    const i = this.n++;
    this.off[i * 3] = x; this.off[i * 3 + 1] = y; this.off[i * 3 + 2] = z;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.size[i] = size;
    return i;
  }
  setColor(i, r, g, b) {
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.attrCol.needsUpdate = true;
  }
  commit() {
    this.geo.instanceCount = this.n;
    this.attrOff.needsUpdate = true;
    this.attrCol.needsUpdate = true;
    this.attrSize.needsUpdate = true;
  }
}

export class Airport {
  constructor(terrain) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.name = 'airport';
    const E = AIRPORT.elev;

    /* --- runway --- */
    const rw = new THREE.Mesh(
      new THREE.PlaneGeometry(AIRPORT.length, AIRPORT.width),
      new THREE.MeshLambertMaterial({ map: runwayTexture() })
    );
    rw.rotation.x = -Math.PI / 2;
    rw.position.set(0, E + 0.06, 0);
    rw.receiveShadow = true;
    this.group.add(rw);

    /* --- overrun / shoulders --- */
    const shoulder = new THREE.Mesh(
      new THREE.PlaneGeometry(AIRPORT.length + 120, AIRPORT.width + 34),
      new THREE.MeshLambertMaterial({ color: 0x4a4a42 })
    );
    shoulder.rotation.x = -Math.PI / 2;
    shoulder.position.set(0, E + 0.03, 0);
    this.group.add(shoulder);

    /* --- taxiway + apron --- */
    const taxiMat = new THREE.MeshLambertMaterial({ color: 0x3a3d42 });
    const taxi = new THREE.Mesh(new THREE.PlaneGeometry(1640, 24), taxiMat);
    taxi.rotation.x = -Math.PI / 2;
    taxi.position.set(0, E + 0.04, 96);
    this.group.add(taxi);
    for (const cx of [-705, 705]) {
      const link = new THREE.Mesh(new THREE.PlaneGeometry(24, 84), taxiMat);
      link.rotation.x = -Math.PI / 2;
      link.position.set(cx, E + 0.04, 60);
      this.group.add(link);
    }
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(360, 135), taxiMat);
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(-50, E + 0.04, 167);
    this.group.add(apron);

    /* --- buildings --- */
    const hangarMat = new THREE.MeshLambertMaterial({ color: 0x8b939c });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x545b66 });
    for (let i = 0; i < 4; i++) {
      const x = -190 + i * 92;
      const w = 62, d = 40, h = 11;
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), hangarMat);
      body.position.set(x, E + h / 2, 212);
      body.castShadow = true; body.receiveShadow = true;
      this.group.add(body);
      const roof = new THREE.Mesh(new THREE.CylinderGeometry(d * 0.52, d * 0.52, w, 12, 1, false, 0, Math.PI), roofMat);
      roof.rotation.z = Math.PI / 2;
      roof.position.set(x, E + h, 212);
      roof.castShadow = true;
      this.group.add(roof);
    }
    // Control tower
    const tw = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 5.4, 24, 12), hangarMat);
    shaft.position.y = 12;
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(7.5, 6.2, 6, 12), new THREE.MeshLambertMaterial({ color: 0x2a3340 }));
    cab.position.y = 26;
    const cabGlass = new THREE.Mesh(
      new THREE.CylinderGeometry(7.6, 6.3, 3.4, 12, 1, true),
      new THREE.MeshLambertMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.65, side: THREE.DoubleSide })
    );
    cabGlass.position.y = 26.4;
    tw.add(shaft, cab, cabGlass);
    tw.position.set(150, E, 140);
    tw.traverse((o) => { o.castShadow = true; });
    this.group.add(tw);

    /* --- windsock --- */
    this.windsock = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 8, 6), new THREE.MeshLambertMaterial({ color: 0xd8dde3 }));
    pole.position.y = 4;
    this.sock = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 1.15, 3.6, 10, 1, true),
      new THREE.MeshLambertMaterial({ color: 0xff6a00, side: THREE.DoubleSide })
    );
    this.sock.rotation.z = Math.PI / 2;
    this.sock.position.set(-1.8, 7.6, 0);
    this.sockPivot = new THREE.Group();
    this.sockPivot.position.set(0, 0, 0);
    this.sockPivot.add(this.sock);
    this.windsock.add(pole, this.sockPivot);
    this.windsock.position.set(-320, E, 62);
    this.group.add(this.windsock);

    /* --- lighting --- */
    const lf = new LightField(1200);
    this.lights = lf;
    const half = AIRPORT.length / 2;
    const edgeZ = AIRPORT.width / 2 + 2;
    // Edge lights every 60 m, white; last 600 m amber (caution zone)
    for (let x = -half; x <= half; x += 60) {
      const amber = x > half - 600;
      for (const z of [-edgeZ, edgeZ]) {
        lf.add(x, E + 0.45, z, amber ? 1.0 : 0.95, amber ? 0.72 : 0.95, amber ? 0.28 : 0.88, 2.2);
      }
    }
    // Threshold (green) / runway end (red) bars
    for (let k = -3; k <= 3; k++) {
      const z = k * 7;
      lf.add(half, E + 0.45, z, 0.15, 1.0, 0.35, 2.6);   // RWY 27 threshold (green from the approach)
      lf.add(-half, E + 0.45, z, 1.0, 0.12, 0.12, 2.6);  // far end red
    }
    // Approach lights for RWY 27: 900 m of centreline strobes/bars
    this.approach = [];
    for (let d = 60; d <= 900; d += 60) {
      const x = half + d;
      const y = this.terrain.heightAt(x, 0) + 1.2;
      this.approach.push(lf.add(x, y, 0, 1, 1, 0.94, 3.0));
      if (d % 300 === 0) {
        for (const z of [-14, -7, 7, 14]) this.approach.push(lf.add(x, y, z, 1, 1, 0.94, 2.4));
      }
    }
    // Taxiway edge (blue)
    for (let x = -800; x <= 800; x += 90) {
      for (const z of [96 - 14, 96 + 14]) lf.add(x, E + 0.4, z, 0.15, 0.35, 1.0, 1.6);
    }
    // PAPI: four units left of the runway at the aiming point
    this.papi = [];
    for (let k = 0; k < 4; k++) {
      this.papi.push(lf.add(AIRPORT.papiX, E + 0.9, AIRPORT.papiZ - k * 9, 1, 1, 1, 3.2));
    }
    // Rotating beacon on the tower
    this.beacon = lf.add(150, E + 30, 140, 1, 1, 1, 4.5);
    lf.commit();
    this.group.add(lf.mesh);

    /* --- runway-adjacent detail: cones, markers --- */
    const markMat = new THREE.MeshLambertMaterial({ color: 0xe8e8e8 });
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 6; k++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(3, 0.9, 0.6), markMat);
        m.position.set(sx * (half + 40 + k * 0), E + 0.5, -30 + k * 12);
        this.group.add(m);
      }
    }
  }

  /** PAPI logic: 4 units, each switches red/white at its own glide angle. */
  updatePAPI(acPos) {
    const dx = acPos.x - AIRPORT.papiX;
    const dy = acPos.y - (AIRPORT.elev + 0.9);
    if (dx <= 5) {
      for (let k = 0; k < 4; k++) this.lights.setColor(this.papi[k], 0.25, 0.25, 0.3);
      return null;
    }
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    // Standard 3.0 deg PAPI: 2.5 / 2.833 / 3.167 / 3.5
    const thresholds = [3.5, 3.167, 2.833, 2.5];
    let whites = 0;
    for (let k = 0; k < 4; k++) {
      const white = angle > thresholds[k];
      if (white) whites++;
      if (white) this.lights.setColor(this.papi[k], 1, 1, 0.95);
      else this.lights.setColor(this.papi[k], 1, 0.13, 0.13);
    }
    return { angle, whites };
  }

  update(t, acPos, windDirDeg, windSpeed, nightFactor) {
    this.lights.uniforms.uCamPos.value.copy(acPos);
    this.lights.uniforms.uIntensity.value = 0.28 + nightFactor * 0.95;
    this.updatePAPI(acPos);
    // Rotating beacon flash
    const flash = (Math.sin(t * 3.4) > 0.86) ? 1 : 0.05;
    this.lights.setColor(this.beacon, flash, flash * 0.9, flash * 0.35);
    // Approach strobe run-in
    const phase = (t * 2.2) % 1;
    for (let i = 0; i < this.approach.length; i++) {
      const f = 1 - Math.min(1, Math.abs(phase - i / this.approach.length) * 12);
      const v = 0.55 + Math.max(0, f) * 0.9;
      this.lights.setColor(this.approach[i], v, v, v * 0.95);
    }
    // Windsock points downwind and lifts with wind speed
    this.sockPivot.rotation.y = -((windDirDeg + 180) * Math.PI) / 180;
    const lift = Math.min(1, windSpeed / 11);
    this.sock.rotation.x = -(1 - lift) * 0.9;
    this.sock.scale.setScalar(0.6 + lift * 0.5);
  }
}

/* ------------------------------------------------------------------ */
/* Scenery                                                             */
/* ------------------------------------------------------------------ */

export function buildScenery(terrain) {
  const group = new THREE.Group();
  group.name = 'scenery';

  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3.2, 5);
  trunkGeo.translate(0, 1.6, 0);
  const crownGeo = new THREE.ConeGeometry(2.9, 8.5, 6);
  crownGeo.translate(0, 7.2, 0);

  const COUNT = 5200;
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x4a3626 }), COUNT);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ color: 0x2f4a24 }), COUNT);
  crowns.castShadow = true;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const col = new THREE.Color();
  let rnd = 424242;
  const rand = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x7fffffff; };

  let placed = 0, tries = 0;
  while (placed < COUNT && tries < COUNT * 14) {
    tries++;
    const a = rand() * Math.PI * 2;
    const r = 260 + Math.pow(rand(), 0.55) * 9200;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.abs(x) < 1050 && Math.abs(z) < 260) continue;   // runway corridor
    if (x > -280 && x < 200 && z > 70 && z < 260) continue;  // apron
    const h = terrain.heightAt(x, z);
    if (h < SEA + 8 || h > 1350) continue;
    terrain.normalAt(x, z, nrm);
    if (nrm.y < 0.80) continue;
    const density = fbm(x * 0.00055 + 12, z * 0.00055 - 4, 3);
    if (density < 0.44) continue;

    const sc = 0.65 + rand() * 1.15;
    p.set(x, h, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * 6.28);
    s.set(sc, sc * (0.8 + rand() * 0.55), sc);
    m.compose(p, q, s);
    trunks.setMatrixAt(placed, m);
    crowns.setMatrixAt(placed, m);
    const tint = 0.7 + rand() * 0.55;
    col.setRGB(0.18 * tint, 0.30 * tint, 0.14 * tint);
    crowns.setColorAt(placed, col);
    placed++;
  }
  trunks.count = placed;
  crowns.count = placed;
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  group.add(trunks, crowns);

  /* --- a small town to the east, for scale and orientation --- */
  const townGeo = new THREE.BoxGeometry(1, 1, 1);
  const town = new THREE.InstancedMesh(townGeo, new THREE.MeshLambertMaterial({ color: 0xb9b3a6 }), 420);
  let tn = 0;
  for (let i = 0; i < 420; i++) {
    const x = 3400 + (rand() - 0.5) * 1500;
    const z = 900 + (rand() - 0.5) * 1500;
    const h = terrain.heightAt(x, z);
    if (h < SEA + 6) continue;
    const w = 9 + rand() * 16, d = 9 + rand() * 16, ht = 5 + rand() * 16;
    p.set(x, h + ht / 2, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.round(rand() * 4) * 0.4);
    s.set(w, ht, d);
    m.compose(p, q, s);
    town.setMatrixAt(tn, m);
    col.setRGB(0.55 + rand() * 0.3, 0.52 + rand() * 0.3, 0.48 + rand() * 0.28);
    town.setColorAt(tn, col);
    tn++;
  }
  town.count = tn;
  town.castShadow = true;
  town.instanceMatrix.needsUpdate = true;
  if (town.instanceColor) town.instanceColor.needsUpdate = true;
  group.add(town);

  return group;
}
