/**
 * OpenFlight Sim — 6-DOF Flight Model (T1 boundary stub, OFS-002 fills).
 *
 * Contract: `createFlightModel(airframeKey)` returns a model handle. Each
 * fixed step the orchestrator calls `model.step(dt, sim, env, controls)`,
 * which integrates the rigid body in body axes and writes the result back
 * onto `sim` (pos, vel, quat, derived scalar state). `model.forces()` and
 * `model.aeroState()` expose the last computed coefficients for instruments.
 * T2 replaces this kinematic placeholder with the full derivative-based
 * integrator (lift/drag/side-force/damping/control derivatives, inertia
 * tensor, CG offset, ground reaction). The call sites here are frozen.
 */

export const AIRFRAMES = Object.freeze({
  trainer: Object.freeze({
    id: "trainer",
    name: "Skyliner T-76",
    type: "light trainer",
    mass: 1200,
    referenceArea: 16.2,
    wingspan: 10.2,
    stallSpeed: 28,
    cruiseSpeed: 62,
    maxThrust: 4200,
    inertia: Object.freeze({ x: 1300, y: 1700, z: 2600 }),
  }),
  aerobatic: Object.freeze({
    id: "aerobatic",
    name: "Voltige X1",
    type: "aerobatic",
    mass: 900,
    referenceArea: 11.5,
    wingspan: 8.6,
    stallSpeed: 24,
    cruiseSpeed: 70,
    maxThrust: 3600,
    inertia: Object.freeze({ x: 900, y: 1100, z: 1500 }),
  }),
  jet: Object.freeze({
    id: "jet",
    name: "Lumina J-7",
    type: "light jet",
    mass: 6500,
    referenceArea: 24.0,
    wingspan: 13.4,
    stallSpeed: 58,
    cruiseSpeed: 160,
    maxThrust: 18000,
    inertia: Object.freeze({ x: 9000, y: 14000, z: 21000 }),
  }),
});

export function airframeList() {
  return Object.keys(AIRFRAMES).map((id) => AIRFRAMES[id]);
}

export function createFlightModel(airframeKey) {
  let airframe = AIRFRAMES[airframeKey] || AIRFRAMES.trainer;
  let lastForces = { lift: 0, drag: 0, thrust: 0, side: 0, weight: 0 };
  let lastAero = { alpha: 0, beta: 0, aoa: 0, loadFactor: 1, stalled: false };

  return {
    get airframe() { return airframe; },

    /**
     * Re-bind the model to a different airframe so the briefing screen's
     * selection is what actually flies (ZOU-920 remediation #1).
     */
    setAirframe(airframeKey) {
      airframe = AIRFRAMES[airframeKey] || AIRFRAMES.trainer;
      lastForces = { lift: 0, drag: 0, thrust: 0, side: 0, weight: 0 };
      lastAero = { alpha: 0, beta: 0, aoa: 0, loadFactor: 1, stalled: false };
    },

    /**
     * Integrate one fixed step. Stub holds a stable trimmed cruise: it
     * maintains altitude and heading and moves the body forward at the
     * airframe cruise speed scaled by throttle. This keeps the T1 shell
     * airborne and the integrator bounded; T2 replaces it wholesale.
     */
    step(dt, sim, env, controls) {
      const a = airframe;
      const rho = (env && env.density) || 1.225;
      const throttle = clamp(controls.throttle, 0, 1);
      const targetSpeed = a.cruiseSpeed * (0.25 + 0.75 * throttle);

      const forward = unitForward(sim.quat);
      const speed = sim.vel.length();
      const nextSpeed = approach(speed, targetSpeed, 4 * dt);

      // Finite guard (ZOU-920 remediation #7): compute candidate state into
      // locals and commit only if every component is finite, so one bad
      // frame (NaN/Infinity) cannot permanently corrupt the simulation.
      const newVx = forward.x * nextSpeed;
      const newVy = forward.y * nextSpeed;
      const newVz = forward.z * nextSpeed;
      const newPx = sim.pos.x + newVx * dt;
      const newPy = sim.pos.y + newVy * dt;
      const newPz = sim.pos.z + newVz * dt;
      if (
        !Number.isFinite(newVx) || !Number.isFinite(newVy) || !Number.isFinite(newVz) ||
        !Number.isFinite(newPx) || !Number.isFinite(newPy) || !Number.isFinite(newPz)
      ) {
        return;
      }
      sim.vel.set(newVx, newVy, newVz);
      sim.pos.set(newPx, newPy, newPz);

      const lift = 0.5 * rho * a.referenceArea * nextSpeed * nextSpeed * 0.4;
      const drag = 0.5 * rho * a.referenceArea * nextSpeed * nextSpeed * 0.03;
      const thrust = a.maxThrust * throttle;
      const weight = a.mass * 9.80665;
      lastForces = { lift, drag, thrust, side: 0, weight };
      lastAero = {
        alpha: 2 * throttle,
        beta: 0,
        aoa: 2 * throttle,
        loadFactor: lift / Math.max(1, weight),
        stalled: nextSpeed < a.stallSpeed,
      };
    },

    forces() { return lastForces; },
    aeroState() { return lastAero; },
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function approach(v, target, maxDelta) {
  const d = target - v;
  if (Math.abs(d) <= maxDelta) return target;
  return v + Math.sign(d) * maxDelta;
}
function unitForward(q) {
  const x = 2 * (q.w * q.y + q.x * q.z);
  const y = 2 * (q.y * q.z - q.w * q.x);
  const z = 1 - 2 * (q.x * q.x + q.y * q.y);
  const n = Math.hypot(x, y, z) || 1;
  return { x: x / n, y: y / n, z: z / n };
}

export const __OFS_BOUNDARY__ = "flight-model";
