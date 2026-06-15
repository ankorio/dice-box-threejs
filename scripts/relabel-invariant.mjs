// Validates the core invariant the shared-world prediction AND the at-rest backstop
// both depend on, against the REAL d20 geometry + real getFaceValue()/swapDiceFace():
//   for any orientation, if getFaceValue()==V then after swapDiceFace(target)
//   getFaceValue()==target  — and resetting to the pristine geometry restores V
//   (the idempotency predictAndRelabelAll() relies on).
// Stubs a minimal 2D canvas so DiceFactory can bake materials without WebGL.
// Run: node scripts/relabel-invariant.mjs

// ── minimal DOM/canvas stub (no GL; textures are never uploaded) ──
const ctx = new Proxy({}, {
  get: (_t, p) => (p === 'measureText' ? () => ({ width: 10 }) : () => {}),
  set: () => true,
});
globalThis.document = {
  createElement: (tag) => (tag === 'canvas'
    ? { width: 0, height: 0, style: {}, getContext: () => ctx }
    : { style: {}, getContext: () => ctx }),
};
globalThis.HTMLImageElement = class {};   // for instanceof checks in createTextMaterial

const THREE = await import('three');
const { DiceFactory } = await import('../src/DiceFactory.js');
const { DiceBox } = await import('../src/DiceBox.js');

const factory = new DiceFactory({ baseScale: 100, bumpMapping: false });
factory.applyColorSet({
  foreground: '#ffffff', background: '#222222', outline: '#000000', edge: '#000000',
  texture: { name: 'none', material: 'none', composite: 'source-over' },
});

// Borrow the real swapDiceFace (+ its d4 helper) without constructing a full DiceBox.
const box = { DiceFactory: factory, swapDiceFace_D4: DiceBox.prototype.swapDiceFace_D4 };
const swap = (mesh, target) => DiceBox.prototype.swapDiceFace.call(box, mesh, target);

const die = factory.create('d20');
die.notation = { type: 'd20' };
die.body = { quaternion: new THREE.Quaternion() };
const values = factory.get('d20').values.slice();   // legal face values

const pristine = factory.geometries['d20'];          // base (un-swapped) geometry
const faceValue = () => die.getFaceValue().value;

let relabelOk = 0, relabelBad = 0, idemOk = 0, idemBad = 0;
const TRIALS = 2000;
for (let t = 0; t < TRIALS; t++) {
  // fresh random orientation on the pristine geometry
  die.geometry = pristine;
  die.result = [];
  die.body.quaternion.random();

  const natural = faceValue();                       // V in base labels
  const target = values[Math.floor(Math.random() * values.length)];

  die.result = [{ value: natural, label: '', reason: 'natural' }]; // swapDiceFace reads getLastValue()
  swap(die, target);
  die.result = [];
  const shown = faceValue();
  if (shown == target) relabelOk++; else { relabelBad++; if (relabelBad <= 5) console.log(`  relabel FAIL: natural=${natural} target=${target} shown=${shown}`); }

  // idempotency: reset to pristine at the same orientation → base value returns
  die.geometry = pristine;
  if (faceValue() == natural) idemOk++; else { idemBad++; if (idemBad <= 5) console.log(`  reset FAIL: expected ${natural} got ${faceValue()}`); }
}

console.log(`relabel invariant : ${relabelOk}/${TRIALS} ok, ${relabelBad} bad  → ${relabelBad === 0 ? 'PASS' : 'FAIL'}`);
console.log(`pristine-reset    : ${idemOk}/${TRIALS} ok, ${idemBad} bad  → ${idemBad === 0 ? 'PASS' : 'FAIL'}`);
process.exit(relabelBad === 0 && idemBad === 0 ? 0 : 1);
