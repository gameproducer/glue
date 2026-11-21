import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LEVEL_SETTINGS, RELEASE_JUMP_CONTROL_MAX, TENSION_CONTROL_MAX,
  readLevelSettings, saveLevelSettings, sensitivityToThreshold, thresholdToSensitivity,
} from "../lib/peel/LevelSettings.ts";

function withStorage(entries, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map(entries);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  });
  try { run(storage); } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
}

test("each increase in tear sensitivity lowers the corresponding failure limit", () => {
  for (const maxThreshold of [TENSION_CONTROL_MAX, RELEASE_JUMP_CONTROL_MAX]) {
    assert.equal(sensitivityToThreshold(0, maxThreshold), maxThreshold);
    assert.equal(sensitivityToThreshold(100, maxThreshold), 0);
    let previous = maxThreshold;
    for (let sensitivity = 1; sensitivity <= 100; sensitivity++) {
      const threshold = sensitivityToThreshold(sensitivity, maxThreshold);
      assert.ok(threshold < previous);
      assert.equal(thresholdToSensitivity(threshold, maxThreshold), sensitivity);
      previous = threshold;
    }
  }
});

test("whole settings round-trip by level and keep intentional zero values", () => {
  withStorage([], () => {
    const first = {
      profile: "cone", tearThreshold: 0, releaseJumpThreshold: 0.46, tearWarning: false,
      tearFactors: { outward: 0, bottleneck: 0.82 }, liftedTransparency: 0.88,
      appearance: { face: 23, sticker: 3, back: 7, optics: 4, filmFilter: 2, released: 5, ridge: 1, gripCurl: 1, background: 7, glassDepth: 1 },
      camera: { pan: false, edgeClearance: 76 }, zoom: 115,
      peelSound: "silk", peelVolume: 0, soundResponse: "peel", edgeClick: false, releaseDynamics: true,
    };
    const second = { ...DEFAULT_LEVEL_SETTINGS, zoom: 75, releaseJumpThreshold: 0 };
    saveLevelSettings("bread", first);
    saveLevelSettings("ruler", second);
    assert.deepEqual(readLevelSettings("bread"), first);
    assert.deepEqual(readLevelSettings("ruler"), second);
    assert.deepEqual(readLevelSettings("unvisited"), DEFAULT_LEVEL_SETTINGS);
  });
});

test("the old ridge preset keeps its relief after becoming an independent toggle", () => {
  withStorage([["peel.level.bread.settings", '{"appearance":{"released":4}}']], () => {
    const settings = readLevelSettings("bread");
    assert.equal(settings.appearance.released, 5);
    assert.equal(settings.appearance.ridge, 1);
    assert.equal(settings.edgeClick, true);
    assert.equal(settings.tearWarning, true);
    assert.equal(settings.releaseDynamics, false);
    settings.appearance.ridge = 0;
    saveLevelSettings("bread", settings);
    assert.equal(readLevelSettings("bread").appearance.ridge, 0);
  });
});

test("older visual, audio, camera and level settings seed a level once", () => {
  withStorage([
    ["peel.appearance", '{"face":19,"back":6,"optics":3}'],
    ["peel.camera", '{"pan":false,"edgeClearance":64}'],
    ["peel.sound", "bass"],
    ["peel.sound.volume", "0"],
    ["peel.sound.response", "peel"],
    ["peel.level.bread.tearThreshold", "0.24"],
    ["peel.level.bread.tearFactors.outward", "0.18"],
    ["peel.level.bread.liftedTransparency", "0.77"],
  ], storage => {
    const old = readLevelSettings("bread");
    assert.equal(old.tearThreshold, 0.24);
    assert.equal(old.tearFactors.outward, 0.18);
    assert.equal(old.liftedTransparency, 0.77);
    assert.equal(old.appearance.face, 19);
    assert.equal(old.appearance.filmFilter, 0);
    assert.deepEqual(old.camera, { pan: false, edgeClearance: 64 });
    assert.equal(old.peelSound, "bass");
    assert.equal(old.peelVolume, 0);
    assert.equal(old.soundResponse, "peel");
    assert.equal(readLevelSettings("ruler").tearThreshold, DEFAULT_LEVEL_SETTINGS.tearThreshold);

    saveLevelSettings("bread", old);
    storage.set("peel.appearance", '{"face":23}');
    assert.equal(readLevelSettings("bread").appearance.face, 19);
    assert.equal(readLevelSettings("ruler").appearance.face, 23);
  });
});
