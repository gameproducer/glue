import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LEVEL_SETTINGS, readLevelSettings, saveLevelSettings } from "../lib/peel/LevelSettings.ts";

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

test("whole settings round-trip by level and keep intentional zero values", () => {
  withStorage([], () => {
    const first = {
      profile: "cone", tearThreshold: 0, releaseJumpThreshold: 0.46,
      tearFactors: { outward: 0, bottleneck: 0.82 }, liftedTransparency: 0.88,
      appearance: { face: 23, sticker: 3, back: 7, optics: 4, filmFilter: 2, released: 4, gripCurl: 1, background: 7, glassDepth: 1 },
      camera: { pan: false, edgeClearance: 76 }, zoom: 115,
      peelSound: "silk", peelVolume: 0, soundResponse: "peel",
    };
    const second = { ...DEFAULT_LEVEL_SETTINGS, zoom: 75, releaseJumpThreshold: 0 };
    saveLevelSettings("bread", first);
    saveLevelSettings("ruler", second);
    assert.deepEqual(readLevelSettings("bread"), first);
    assert.deepEqual(readLevelSettings("ruler"), second);
    assert.deepEqual(readLevelSettings("unvisited"), DEFAULT_LEVEL_SETTINGS);
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
