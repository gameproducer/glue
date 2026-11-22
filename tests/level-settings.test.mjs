import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LEVEL_SETTINGS, RELEASE_JUMP_CONTROL_MAX, TENSION_CONTROL_MAX,
  readLevelSelection, readLevelSettings, saveLevelSelection, saveLevelSettings, sensitivityToThreshold, thresholdToSensitivity,
} from "../lib/peel/LevelSettings.ts";
import { BACKGROUNDS, FACE_FINISHES, RELEASE_FINISHES, shadowVisible, SPACE, SURFACE_TEXTURE, usesFrontRefraction } from "../lib/render/PeelAppearance.ts";
import { readTouchCamera, saveTouchCamera } from "../lib/render/TouchCamera.ts";

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
      appearance: { face: 23, sticker: 3, colorIntensity: 0, back: 7, optics: 4, filmFilter: 2, released: 5, ridge: 1, gripCurl: 1,
        background: 7, space: SPACE.lightbox, surfaceTexture: SURFACE_TEXTURE.paper, shadow: 2, keepCrease: 1 },
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

test("legacy glass depth migrates to Space and automatic shadow follows the space", () => {
  withStorage([["peel.level.bread.settings", '{"appearance":{"face":0,"background":0,"glassDepth":1}}']], () => {
    const fresh = readLevelSettings("fresh").appearance;
    assert.equal(FACE_FINISHES[fresh.face], "Brushed foil");
    assert.equal(RELEASE_FINISHES[fresh.released], "Transparent");
    assert.equal(BACKGROUNDS[fresh.background].name, "Dark blue");
    assert.equal(fresh.gripCurl, 1);
    assert.equal(fresh.space, SPACE.original);
    assert.equal(fresh.surfaceTexture, SURFACE_TEXTURE.original);
    assert.equal(shadowVisible(fresh), false);
    assert.equal(shadowVisible({ ...fresh, shadow: 2 }), true);
    assert.equal(shadowVisible({ ...fresh, space: SPACE.paper }), true);
    assert.equal(shadowVisible({ ...fresh, space: SPACE.darkroom }), false);
    assert.equal(shadowVisible({ ...fresh, space: SPACE.lightbox }), false);
    const existing = readLevelSettings("bread").appearance;
    assert.equal(existing.face, 0);
    assert.equal(existing.background, 0);
    assert.equal(existing.colorIntensity, 65);
    assert.equal(existing.space, SPACE.glass);
    assert.equal(shadowVisible(existing), true);
    assert.equal(shadowVisible({ ...existing, shadow: 1 }), false);
    assert.equal(usesFrontRefraction(FACE_FINISHES.indexOf("Clear tape")), true);
    assert.equal(usesFrontRefraction(FACE_FINISHES.indexOf("Security hologram")), false);
    assert.equal(usesFrontRefraction(FACE_FINISHES.indexOf("Caramel")), true);
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

test("an uncustomized level inherits the last played level and retains that view on reload", () => {
  withStorage([
    ["peel.selectedLevel", "bread"],
    ["peel.level.legacy.tearThreshold", "0"],
    ["peel.level.legacy.settings", '{"zoom":75}'],
  ], storage => {
    assert.deepEqual(readLevelSelection(), { id: "bread" });
    const bread = {
      ...DEFAULT_LEVEL_SETTINGS, profile: "cone", zoom: 108, edgeClick: false,
      appearance: { ...DEFAULT_LEVEL_SETTINGS.appearance, keepCrease: 1, background: 5 },
    };
    saveLevelSettings("bread", bread);
    const active = readLevelSettings("bread");
    saveLevelSelection("ruler", active);
    assert.deepEqual(readLevelSelection(), { id: "ruler", previous: bread });
    assert.deepEqual(readLevelSettings("ruler", readLevelSelection().previous), bread);
    assert.equal(storage.has("peel.level.ruler.settings"), false);
    assert.deepEqual(readLevelSettings("pencil", readLevelSettings("ruler", active)), bread);
    assert.equal(readLevelSettings("legacy", bread).tearThreshold, 0);
    assert.equal(readLevelSettings("legacy", bread).zoom, 75);

    const newRuler = { ...bread, zoom: 90 };
    saveLevelSettings("ruler", newRuler);
    assert.deepEqual(readLevelSettings("ruler", DEFAULT_LEVEL_SETTINGS), newRuler);
  });
});

test("touch focus follows the curl by default and an explicit choice still wins", () => {
  withStorage([], storage => {
    assert.deepEqual(readTouchCamera(), { mode: "focus", miniMap: false, followCurl: true });
    storage.set("peel.touchCamera", '{"mode":"manual","miniMap":true}');
    assert.deepEqual(readTouchCamera(), { mode: "manual", miniMap: true, followCurl: true });
    saveTouchCamera({ mode: "focus", miniMap: true, followCurl: false });
    assert.deepEqual(readTouchCamera(), { mode: "focus", miniMap: true, followCurl: false });
  });
});
