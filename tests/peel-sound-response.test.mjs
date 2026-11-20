import test from "node:test";
import assert from "node:assert/strict";
import { peelSoundLoad, releaseSoundGain } from "../lib/peel/PeelSoundResponse.ts";

const held = { pulling: true, torn: false, detached: false, stress: 0.2, tearThreshold: 0.4 };

test("sound uses the closest normalized tear threshold and follows physics tuning", () => {
  assert.equal(peelSoundLoad(held, 21, 84), 0.5, "tension is closer");
  assert.equal(peelSoundLoad(held, 63, 84), 0.75, "grip distance is closer");
  assert.equal(peelSoundLoad({ ...held, stress: 0.3 }, 63, 84), 0.75, "loads do not double-count");
  assert.equal(peelSoundLoad({ ...held, tearThreshold: 0.25 }, 21, 84), 0.8, "lower tear threshold increases urgency");
  assert.equal(peelSoundLoad(held, 63, 126), 0.5, "grip cap defines its own units");
  assert.equal(peelSoundLoad(held, null, 84), 0.5, "unavailable grip measurement still uses tension");
  assert.equal(peelSoundLoad({ ...held, stress: 4 }, 840, 84), 1, "overshoots are bounded");
});

test("unheld, torn and detached material has no tear-response load", () => {
  for (const state of [{ pulling: false }, { torn: true }, { detached: true }]) {
    assert.equal(peelSoundLoad({ ...held, ...state }, 84, 84), 0);
  }
});

test("zero thresholds and invalid readings cannot produce invalid sound parameters", () => {
  assert.equal(peelSoundLoad({ ...held, stress: 0, tearThreshold: 0 }, 0, 84), 0);
  assert.equal(peelSoundLoad({ ...held, stress: 0.01, tearThreshold: 0 }, null, 84), 1);
  assert.equal(peelSoundLoad({ ...held, stress: NaN }, 42, 84), 0.5);
  assert.equal(peelSoundLoad(held, Infinity, 84), 0.5);
  assert.equal(peelSoundLoad({ ...held, stress: -1 }, -10, 84), 0);
});

test("release volume response grows with the adhesive freed in a single step and caps peaks", () => {
  assert.equal(releaseSoundGain(NaN), releaseSoundGain(0));
  assert.ok(releaseSoundGain(0) < releaseSoundGain(0.005));
  assert.ok(releaseSoundGain(0.005) < releaseSoundGain(0.035));
  assert.equal(releaseSoundGain(0.04), releaseSoundGain(1));
});
