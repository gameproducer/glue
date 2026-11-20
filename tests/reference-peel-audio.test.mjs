import test from "node:test";
import assert from "node:assert/strict";
import { PeelAudio, readPeelSound, savePeelSound } from "../lib/peel/PeelAudio.ts";
import { REFERENCE_PEEL_SOUNDS, synthesizeReferenceGrain } from "../lib/peel/ReferencePeelSound.ts";

const rms = samples => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);

test("reference voices have bass-dominant energy, headroom, and click-free endpoints at device sample rates", () => {
  for (const { id } of REFERENCE_PEEL_SOUNDS) {
    for (const sampleRate of [22050, 44100, 48000]) {
      for (const strength of [0.35, 1]) {
        const samples = synthesizeReferenceGrain(id, sampleRate, strength, 137);
        let low = 0, lowEnergy = 0, energy = 0, sum = 0, maxStep = 0;
        const alpha = 1 - Math.exp(-2 * Math.PI * 300 / sampleRate);
        for (let i = 0; i < samples.length; i++) {
          const value = samples[i];
          assert.ok(Number.isFinite(value) && Math.abs(value) <= 0.19);
          low += alpha * (value - low);
          lowEnergy += low * low;
          energy += value * value;
          sum += value;
          if (i) maxStep = Math.max(maxStep, Math.abs(value - samples[i - 1]));
        }
        assert.ok(rms(samples) > 0.012, `${id}: audible signal`);
        assert.ok(lowEnergy / energy > 0.60, `${id}: low body dominates`);
        assert.ok(Math.abs(sum / samples.length) < 0.004, `${id}: no significant DC offset`);
        assert.ok(maxStep < 0.055, `${id}: no abrupt waveform jumps`);
        assert.equal(Math.abs(samples[0]), 0);
        assert.equal(Math.abs(samples.at(-1)), 0);
      }
    }
  }
});

test("voices are distinct and repeatable, while pull strength changes their response", () => {
  const voices = REFERENCE_PEEL_SOUNDS.map(({ id }) => {
    const loud = synthesizeReferenceGrain(id, 22050, 1, 137);
    assert.deepEqual(loud, synthesizeReferenceGrain(id, 22050, 1, 137));
    assert.notDeepEqual(loud, synthesizeReferenceGrain(id, 22050, 1, 138));
    assert.ok(rms(loud) > rms(synthesizeReferenceGrain(id, 22050, 0.35, 137)) * 2);
    assert.equal(rms(synthesizeReferenceGrain(id, 22050, 0, 137)), 0);
    return loud;
  });
  for (let i = 0; i < voices.length; i++) for (let j = i + 1; j < voices.length; j++) {
    assert.ok(rms(voices[i].map((v, k) => v - voices[j][k])) > 0.025, "audibly distinct waveforms");
  }
});

test("reference previews and gameplay use the output chain, throttle progress, and cancel scheduled voices", () => {
  const oldContext = globalThis.AudioContext;
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let context;
  const node = () => ({ connect(target) { this.target = target; return target; }, disconnect() { this.disconnected = true; } });
  class AudioContext {
    state = "running";
    sampleRate = 22050;
    currentTime = 0;
    sources = [];
    destination = node();
    constructor() { context = this; }
    createBuffer(_, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    createGain() { return this.output = { ...node(), gain: { value: 0, setTargetAtTime(value) { this.value = value; } } }; }
    createDynamicsCompressor() { return { ...node(), ...Object.fromEntries(["threshold", "knee", "ratio", "attack", "release"].map(key => [key, {}])) }; }
    createBufferSource() {
      const source = { ...node(), start(time) { this.time = time; }, stop() { this.stopped = true; this.onended?.(); } };
      this.sources.push(source);
      return source;
    }
    close() { return Promise.resolve(); }
  }
  const saved = new Map();
  globalThis.AudioContext = AudioContext;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) } });
  try {
    const audio = new PeelAudio();
    audio.setVolume(0.5);
    for (const { id } of REFERENCE_PEEL_SOUNDS) {
      savePeelSound(id);
      assert.equal(readPeelSound(), id);
      audio.preview(id);
      const sources = context.sources.splice(0);
      assert.ok(sources.length >= 10);
      assert.ok(sources.at(-1).time > 1.2);
      assert.ok(sources.every(source => source.target === context.output && rms(source.buffer.getChannelData(0)) > 0));
      audio.preview(id);
      assert.equal(context.sources.length, 0, "repeated preview cannot stack");
      audio.beginGesture();
      assert.ok(sources.every(source => source.stopped && source.disconnected));
      audio.playProgress(id, 0);
      audio.playProgress(id, NaN);
      assert.equal(context.sources.length, 0, "stationary or invalid progress is silent");
      audio.playProgress(id, 0.02);
      audio.playProgress(id, 0.02);
      assert.equal(context.sources.length, 1, "progress is rate-limited");
      context.currentTime += 0.09;
      audio.playProgress(id, 0.02);
      assert.equal(context.sources.length, 2);
      audio.stop();
      assert.ok(context.sources.every(source => source.stopped));
      context.sources = [];
      context.currentTime = 0;
    }
    audio.preview("rubber");
    audio.dispose();
    assert.ok(context.sources.every(source => source.stopped));
  } finally {
    if (oldContext === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = oldContext;
    if (oldStorage === undefined) delete globalThis.localStorage; else Object.defineProperty(globalThis, "localStorage", oldStorage);
  }
});
