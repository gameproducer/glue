import test from "node:test";
import assert from "node:assert/strict";
import { PeelAudio, DEFAULT_PEEL_VOLUME, readPeelVolume, savePeelVolume } from "../lib/peel/PeelAudio.ts";
import { DEFAULT_SOUND_RESPONSE, readSoundResponse, saveSoundResponse } from "../lib/peel/PeelSoundResponse.ts";

const withGlobal = (key, value, run) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  try { run(); } finally {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else delete globalThis[key];
  }
};

test("sound volume survives audio unlock and muting without bypassing the peak limiter", () => {
  let context;
  const node = () => ({ connections: [], connect(target) { this.connections.push(target); return target; } });
  class AudioContext {
    state = "running";
    sampleRate = 1000;
    currentTime = 0;
    destination = node();
    constructor() { context = this; }
    createBuffer(_, size) { return { getChannelData: () => new Float32Array(size) }; }
    createGain() {
      this.output = { ...node(), gain: { value: 0, setTargetAtTime(value) { this.value = value; } } };
      return this.output;
    }
    createDynamicsCompressor() {
      this.limiter = { ...node(), ...Object.fromEntries(["threshold", "knee", "ratio", "attack", "release"].map(key => [key, { value: 0 }])) };
      return this.limiter;
    }
    close() { return Promise.resolve(); }
  }
  withGlobal("AudioContext", AudioContext, () => {
    const audio = new PeelAudio();
    audio.setVolume(0.5);
    audio.setMuted(true);
    audio.unlock();
    assert.equal(context.output.gain.value, 0);
    assert.deepEqual(context.output.connections, [context.limiter]);
    assert.deepEqual(context.limiter.connections, [context.destination]);
    assert.ok(context.limiter.threshold.value < 0 && context.limiter.ratio.value >= 10);
    audio.setMuted(false);
    const halfVolume = context.output.gain.value;
    assert.ok(halfVolume > 0.65);
    audio.setMuted(true);
    audio.setVolume(1);
    assert.equal(context.output.gain.value, 0);
    audio.setMuted(false);
    assert.equal(context.output.gain.value, halfVolume * 2);
    audio.setVolume(0);
    assert.equal(context.output.gain.value, 0);
    audio.dispose();
  });
});

test("sound volume remembers zero and falls back for invalid saved values", () => {
  const data = new Map();
  withGlobal("localStorage", { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }, () => {
    assert.equal(readPeelVolume(), DEFAULT_PEEL_VOLUME);
    savePeelVolume(0);
    assert.equal(readPeelVolume(), 0);
    savePeelVolume(0.65);
    assert.equal(readPeelVolume(), 0.65);
    for (const invalid of [NaN, -1, 2]) {
      savePeelVolume(invalid);
      assert.equal(readPeelVolume(), DEFAULT_PEEL_VOLUME);
    }
  });
});

test("sound response persists across sessions and tolerates unavailable or invalid storage", () => {
  const data = new Map();
  withGlobal("localStorage", { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }, () => {
    assert.equal(readSoundResponse(), DEFAULT_SOUND_RESPONSE);
    for (const mode of ["peel", "tension"]) {
      saveSoundResponse(mode);
      assert.equal(readSoundResponse(), mode);
    }
    data.set("peel.sound.response", "invalid");
    assert.equal(readSoundResponse(), DEFAULT_SOUND_RESPONSE);
  });
  withGlobal("localStorage", { getItem() { throw Error(); }, setItem() { throw Error(); } }, () => {
    assert.equal(readSoundResponse(), DEFAULT_SOUND_RESPONSE);
    assert.doesNotThrow(() => saveSoundResponse("tension"));
  });
});
