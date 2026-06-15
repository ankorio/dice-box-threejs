// Determinism spike for the shared-world re-prediction plan.
// Question: is cannon-es reproducible across a hand-rolled snapshot/restore, so a
// blocking prediction can match the live run exactly? Mirrors the engine's world
// config (gravity, NaiveBroadphase, solver.iterations=14, allowSleep) with box dice.
// Run: node scripts/determinism-spike.mjs
import * as CANNON from 'cannon-es';

const DT = 1 / 60;
const N_DICE = 8;

// tiny deterministic PRNG so the scene setup is identical run-to-run (the test itself
// compares two runs from the SAME captured state, so this only aids debugging).
let seed = 1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function makeWorld() {
  const world = new CANNON.World();
  world.gravity.set(0, 0, -9.8 * 800);          // engine uses a big gravity multiplier
  world.broadphase = new CANNON.NaiveBroadphase();
  world.solver.iterations = 14;
  world.allowSleep = true;

  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  world.addBody(ground);

  const dice = [];
  for (let i = 0; i < N_DICE; i++) {
    const body = new CANNON.Body({
      mass: 300,
      shape: new CANNON.Box(new CANNON.Vec3(50, 50, 50)),
      allowSleep: true,
      sleepSpeedLimit: 100,
      sleepTimeLimit: 0.1,
      position: new CANNON.Vec3((rnd() - 0.5) * 600, (rnd() - 0.5) * 600, 200 + rnd() * 200),
    });
    body.velocity.set((rnd() - 0.5) * 4000, (rnd() - 0.5) * 4000, -10);
    body.angularVelocity.set((rnd() - 0.5) * 40, (rnd() - 0.5) * 40, (rnd() - 0.5) * 40);
    body.quaternion.setFromEuler(rnd() * 6, rnd() * 6, rnd() * 6);
    world.addBody(body);
    dice.push(body);
  }
  return { world, dice };
}

// --- candidate snapshot/restore (the fields the plan proposes) ---
function snapshot(world) {
  return {
    time: world.time, stepnumber: world.stepnumber,
    bodies: world.bodies.map((b) => ({
      ref: b,
      position: b.position.clone(),
      quaternion: b.quaternion.clone(),
      velocity: b.velocity.clone(),
      angularVelocity: b.angularVelocity.clone(),
      sleepState: b.sleepState,
      timeLastSleepy: b.timeLastSleepy,
      type: b.type,
    })),
  };
}
function restore(world, snap) {
  world.time = snap.time; world.stepnumber = snap.stepnumber;
  for (const s of snap.bodies) {
    const b = s.ref;
    b.position.copy(s.position);
    b.quaternion.copy(s.quaternion);
    b.velocity.copy(s.velocity);
    b.angularVelocity.copy(s.angularVelocity);
    b.previousPosition.copy(s.position);
    b.interpolatedPosition.copy(s.position);
    b.interpolatedQuaternion.copy(s.quaternion);
    b.force.setZero(); b.torque.setZero();
    b.sleepState = s.sleepState;
    b.timeLastSleepy = s.timeLastSleepy;
    b.type = s.type;
    b.vlambda.setZero(); b.wlambda.setZero();
  }
}

const stateOf = (dice) => dice.map((b) => [
  b.position.x, b.position.y, b.position.z,
  b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w,
]);
function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a[i].length; j++) m = Math.max(m, Math.abs(a[i][j] - b[i][j]));
  return m;
}
const step = (world, n) => { for (let i = 0; i < n; i++) world.step(DT); };

// Test 1 — full restore round-trip: run, restore to start, run again, compare.
function test1() {
  const { world, dice } = makeWorld();
  const s0 = snapshot(world);
  step(world, 240);
  const f1 = stateOf(dice);
  restore(world, s0);
  step(world, 240);
  const f2 = stateOf(dice);
  return maxDiff(f1, f2);
}

// Test 2 — mid-flight snapshot (the real scenario): run K, snapshot, run M; then
// restore the mid snapshot and run M again — must reproduce the same final state.
function test2() {
  const { world, dice } = makeWorld();
  step(world, 30);              // some dice still in the air, some maybe contacting
  const mid = snapshot(world);
  step(world, 300);            // run to rest
  const ffull = stateOf(dice);
  restore(world, mid);
  step(world, 300);
  const f2 = stateOf(dice);
  return maxDiff(ffull, f2);
}

// Test 3 — restore AFTER some dice have slept, then continue.
function test3() {
  const { world, dice } = makeWorld();
  step(world, 200);            // most settle + sleep
  const mid = snapshot(world);
  step(world, 120);
  const ffull = stateOf(dice);
  restore(world, mid);
  step(world, 120);
  return maxDiff(ffull, stateOf(dice));
}

for (const [name, fn] of [['full round-trip', test1], ['mid-flight snapshot', test2], ['post-sleep restore', test3]]) {
  const d = fn();
  const verdict = d === 0 ? 'EXACT' : d < 1e-6 ? 'near-exact' : 'DIVERGES';
  console.log(`${name.padEnd(22)} maxDiff=${d.toExponential(3)}  → ${verdict}`);
}
