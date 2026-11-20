import { clampSoundLoad } from "./PeelSoundResponse.ts";

// Three synthesized interpretations of the reference's bass-heavy, irregular rasp.
// No recording is used at runtime. Seeds make previews repeatable for comparison.
export const REFERENCE_PEEL_SOUNDS = [
  { id: "rubber", label: "Rubber rasp", description: "Elastic bass with a throaty bend and fine, rough flutter." },
  { id: "burble", label: "Sticky burble", description: "Round, overlapping pulses with a wet, bubbling wobble." },
  { id: "zipper", label: "Zipper growl", description: "A coarse, low buzz with uneven stick-and-slip chatter." },
] as const;

export type ReferencePeelSound = (typeof REFERENCE_PEEL_SOUNDS)[number]["id"];
export const REFERENCE_GRAIN_GAP = 0.085;
export const REFERENCE_GRAIN_DURATION = 0.21;
export const REFERENCE_PREVIEW_PATTERN = [0, 0.085, 0.17, 0.255, 0.35, 0.44, 0.525, 0.61, 0.70, 0.79, 0.88, 0.98, 1.08, 1.18, 1.28];

export function isReferencePeelSound(sound: string): sound is ReferencePeelSound {
  return REFERENCE_PEEL_SOUNDS.some(({ id }) => id === sound);
}

export function synthesizeReferenceGrain(sound: ReferencePeelSound, sampleRate: number, strength: number, seed: number, tearLoad = 0) {
  const samples = new Float32Array(Math.ceil(sampleRate * REFERENCE_GRAIN_DURATION));
  const energy = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
  const load = clampSoundLoad(tearLoad);
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const tau = Math.PI * 2;
  const color = random();
  let phase = 0;
  let modPhase = color * tau;
  let slipPhase = 0;
  let slipRate = 78;
  let slipAmplitude = 1;
  let bubbleAge = 1;
  let bubblePitch = 110;
  let bubblePhase = 0;
  let nextBubble = 0;
  let lowNoise = 0;
  let previousNoise = 0;
  let body = 0;
  let dc = 0;
  const noiseAlpha = 1 - Math.exp(-tau * 1100 / sampleRate);
  const bodyAlpha = 1 - Math.exp(-tau * (1800 + load * 2200) / sampleRate);
  const dcAlpha = 1 - Math.exp(-tau * 24 / sampleRate);

  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    const u = i / (samples.length - 1);
    const n = random() * 2 - 1;
    lowNoise += noiseAlpha * (n - lowNoise);
    const grit = lowNoise - previousNoise;
    previousNoise = lowNoise;
    modPhase += tau * (19 + energy * 17 + color * 7 + load * 48) / sampleRate;
    // A 65–110 Hz body, moving harmonics, and irregular amplitude replace a
    // steady pitched note. Tear proximity tightens the pitch independently of speed.
    const pitch = (66 + energy * 27 + 10 * Math.sin(u * Math.PI) - 15 * u) * (1 + load * 0.8);
    phase += tau * pitch * (1 + 0.055 * Math.sin(modPhase)) / sampleRate;
    let value: number;

    if (sound === "rubber") {
      // Nonlinear FM: a vibrating elastic edge with a moving, throaty overtone.
      const bend = phase + (0.22 + energy * 0.18 + load * 0.55) * Math.sin(phase * 2 + Math.sin(modPhase));
      const bass = Math.sin(bend);
      const throat = Math.sin(phase * 3 + 1.5 * Math.sin(u * 7 + color));
      value = 0.73 * Math.tanh(bass * 1.8) + 0.19 * throat
        + (0.09 + load * 0.10) * Math.sin(phase * 7 + Math.sin(modPhase)) + grit * (0.28 + load * 0.65);
      value *= 0.78 + 0.22 * Math.sin(modPhase + 0.6 * Math.sin(phase * 0.31));
    } else if (sound === "burble") {
      // Stochastic damped resonances: each tiny release excites a new cavity.
      if (t >= nextBubble) {
        bubbleAge = 0;
        bubblePitch = (100 + energy * 55 + random() * 85) * (1 + load * 0.9);
        nextBubble = t + (0.018 + random() * 0.026) / (1 + load);
      }
      bubbleAge += 1 / sampleRate;
      bubblePhase += tau * bubblePitch * Math.exp(-bubbleAge * 12) / sampleRate;
      const bubble = Math.exp(-bubbleAge * 42) * Math.sin(bubblePhase);
      value = 0.76 * Math.sin(phase + 0.44 * Math.sin(modPhase * 0.47))
        + (0.32 + load * 0.18) * bubble + 0.10 * Math.sin(phase * 2 + bubble * 2) + grit * (0.10 + load * 0.4);
      value *= 0.82 + 0.18 * Math.sin(modPhase * 0.63);
    } else {
      // Stick/slip excitation: a noisy impulse train, with every tooth changing
      // spacing and force, excites a low body and two short rasp resonances.
      slipPhase += slipRate / sampleRate;
      if (slipPhase >= 1) {
        slipPhase -= 1;
        slipRate = pitch * (0.8 + random() * 0.45);
        slipAmplitude = 0.65 + random() * 0.35;
      }
      const tooth = Math.exp(-slipPhase * 9) * slipAmplitude;
      const rasp = tooth * (Math.sin(slipPhase * tau * 4.8) + 0.5 * Math.sin(slipPhase * tau * 11.3));
      value = 0.72 * Math.sin(phase) + (0.30 + load * 0.32) * rasp + 0.16 * (tooth - 0.1) + grit * tooth * (0.65 + load * 1.4);
      value *= 0.84 + 0.16 * Math.sin(modPhase * 1.13);
    }

    body += bodyAlpha * (value - body);
    dc += dcAlpha * (body - dc);
    // Smooth overlap and a short release prevent clicks and long idle tails.
    const attack = Math.min(1, t / 0.014);
    const release = Math.min(1, (samples.length - 1 - i) / (sampleRate * 0.09));
    const envelope = Math.sin(attack * Math.PI / 2) ** 2 * Math.sin(release * Math.PI / 2) ** 2;
    samples[i] = Math.tanh((body - dc) * 1.3) * envelope * 0.19 * energy;
  }
  return samples;
}
