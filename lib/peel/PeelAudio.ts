import { isReferencePeelSound, REFERENCE_GRAIN_GAP, REFERENCE_PEEL_SOUNDS, REFERENCE_PREVIEW_PATTERN, synthesizeReferenceGrain, type ReferencePeelSound } from "./ReferencePeelSound.ts";
import { clampSoundLoad, DEFAULT_SOUND_RESPONSE, type PeelSoundResponse } from "./PeelSoundResponse.ts";

export const PEEL_SOUNDS = [
  { id: "off", label: "Off" },
  { id: "silk", label: "Silk peel (ASMR)" },
  { id: "paper", label: "Paper crackle (ASMR)" },
  { id: "chime", label: "Soft chime" },
  { id: "bass", label: "Deep bass" },
  { id: "psychedelic", label: "Psychedelic bass" },
  ...REFERENCE_PEEL_SOUNDS,
] as const;

export type PeelSound = (typeof PEEL_SOUNDS)[number]["id"];
const STORAGE_KEY = "peel.sound";
const VOLUME_STORAGE_KEY = "peel.sound.volume";
export const DEFAULT_PEEL_VOLUME = 0.8;
const MAX_OUTPUT_GAIN = 3.25;
const GRAIN_GAP = 0.04;
const BASS_GRAIN_GAP = 0.12;

const profiles = {
  silk: { frequency: 900, q: 0.52, duration: 0.115, volume: 0.16 },
  paper: { frequency: 2650, q: 0.8, duration: 0.048, volume: 0.20 },
  chime: { frequency: 1350, q: 0.7, duration: 0.10, volume: 0.075 },
};

export function readPeelSound(): PeelSound {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return PEEL_SOUNDS.find(({ id }) => id === saved)?.id ?? "off";
  } catch {
    return "off";
  }
}

export function savePeelSound(sound: PeelSound) {
  try { localStorage.setItem(STORAGE_KEY, sound); } catch { /* Storage is optional. */ }
}

export function readPeelVolume() {
  try {
    const saved = localStorage.getItem(VOLUME_STORAGE_KEY);
    const value = saved === null ? NaN : Number(saved);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_PEEL_VOLUME;
  } catch { return DEFAULT_PEEL_VOLUME; }
}

export function savePeelVolume(volume: number) {
  try { localStorage.setItem(VOLUME_STORAGE_KEY, String(volume)); } catch { /* Storage is optional. */ }
}

export class PeelAudio {
  private context: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private output: GainNode | null = null;
  private volume = DEFAULT_PEEL_VOLUME;
  private muted = false;
  private accumulated = 0;
  private nextGrain = 0;
  private previewingUntil = 0;
  private voices = new Set<AudioScheduledSourceNode>();
  private response: PeelSoundResponse = DEFAULT_SOUND_RESPONSE;
  private soundLoad = 0;
  private lastLoadTime: number | null = null;

  unlock() {
    try {
      if (!this.context) {
        const context = new AudioContext();
        const noise = context.createBuffer(1, Math.ceil(context.sampleRate * 0.3), context.sampleRate);
        const samples = noise.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
        const output = context.createGain();
        output.gain.value = this.muted ? 0 : this.volume * MAX_OUTPUT_GAIN;
        // Leave individual grains dynamic, but catch peaks when several overlap.
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -6;
        limiter.knee.value = 3;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.10;
        output.connect(limiter).connect(context.destination);
        this.context = context;
        this.noise = noise;
        this.output = output;
      }
      if (this.context.state !== "running") void this.context.resume().catch(() => {});
    } catch { /* Peeling can continue on devices with audio unavailable. */ }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.updateVolume();
  }

  setVolume(volume: number) {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.max(0, Math.min(1, volume));
    this.updateVolume();
  }

  setResponse(response: PeelSoundResponse) {
    this.stop();
    this.response = response;
  }

  private updateVolume() {
    if (this.context && this.output) {
      this.output.gain.setTargetAtTime(this.muted ? 0 : this.volume * MAX_OUTPUT_GAIN, this.context.currentTime, 0.016);
    }
  }

  beginGesture() {
    this.stop();
  }

  stop() {
    for (const voice of this.voices) {
      try { voice.stop(); } catch { /* An ended voice may await its callback. */ }
    }
    this.voices.clear();
    this.accumulated = 0;
    this.nextGrain = 0;
    this.previewingUntil = 0;
    this.soundLoad = 0;
    this.lastLoadTime = null;
  }

  private track(voice: AudioScheduledSourceNode, cleanup: () => void) {
    this.voices.add(voice);
    voice.onended = () => { this.voices.delete(voice); cleanup(); };
  }

  playProgress(sound: PeelSound, progress: number, tearLoad = 0) {
    if (!this.context || this.context.state !== "running" || sound === "off" || !Number.isFinite(progress) || progress < 0) return;
    const now = this.context.currentTime;
    const target = this.response === "tension" ? clampSoundLoad(tearLoad) : 0;
    const blend = this.lastLoadTime === null ? 1 : 1 - Math.exp(-Math.max(0, now - this.lastLoadTime) / 0.045);
    this.soundLoad += (target - this.soundLoad) * blend;
    this.lastLoadTime = now;
    this.accumulated += progress;
    if ((this.accumulated < 0.002 && target < 0.08) || now < this.nextGrain) return;
    const strength = this.accumulated >= 0.002 ? Math.min(1, 0.34 + Math.sqrt(this.accumulated) * 3.1) : 0.2 + this.soundLoad * 0.45;
    this.grain(sound, now, strength, undefined, this.soundLoad);
    const gap = isReferencePeelSound(sound) ? REFERENCE_GRAIN_GAP : sound === "bass" || sound === "psychedelic" ? BASS_GRAIN_GAP : GRAIN_GAP;
    this.nextGrain = now + gap / (1 + this.soundLoad * 0.4);
    this.accumulated = 0;
  }

  preview(sound: PeelSound) {
    if (sound === "off") return;
    this.unlock();
    if (!this.context) return;
    const now = this.context.currentTime;
    if (now < this.previewingUntil) return;
    const pattern = isReferencePeelSound(sound) ? REFERENCE_PREVIEW_PATTERN : sound === "bass" || sound === "psychedelic"
      ? [0, 0.17, 0.32, 0.51]
      : [0, 0.07, 0.13, 0.17, 0.205, 0.255, 0.32, 0.41, 0.52];
    for (const [index, offset] of pattern.entries()) {
      const load = this.response === "tension" ? index / (pattern.length - 1) : 0;
      this.grain(sound, now + offset + 0.025, Math.sin((index + 2) / (pattern.length + 3) * Math.PI) * 0.7 + 0.2, index + 137, load);
    }
    this.previewingUntil = now + (isReferencePeelSound(sound) ? 1.55 : 0.7);
  }

  private grain(sound: Exclude<PeelSound, "off">, time: number, strength: number, seed = Math.floor(Math.random() * 0xffffffff), load = 0) {
    const { context, noise, output } = this;
    if (!context || !noise || !output) return;
    if (isReferencePeelSound(sound)) {
      this.referenceGrain(context, output, sound, time, strength, seed, load);
      return;
    }
    if (sound === "bass" || sound === "psychedelic") {
      this.bassGrain(context, output, sound === "psychedelic", time, strength, load);
      return;
    }
    const profile = profiles[sound];
    const duration = profile.duration * (0.85 + Math.random() * 0.3);
    const source = context.createBufferSource();
    source.buffer = noise;
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = profile.frequency * (0.82 + Math.random() * 0.4) * 2 ** (load * 1.25);
    filter.Q.value = profile.q + load * 0.7;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(profile.volume * strength, time + (sound === "paper" ? 0.003 : 0.012));
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    source.connect(filter).connect(envelope).connect(output);
    source.start(time, Math.random() * 0.13, duration);
    this.track(source, () => { source.disconnect(); filter.disconnect(); envelope.disconnect(); });

    if (sound === "chime") {
      const tone = context.createOscillator();
      const toneEnvelope = context.createGain();
      const pitch = (330 + 220 * strength + Math.random() * 24) * (1 + load * 0.65);
      tone.frequency.setValueAtTime(pitch, time);
      tone.frequency.exponentialRampToValueAtTime(pitch * 0.84, time + 0.12);
      toneEnvelope.gain.setValueAtTime(0, time);
      toneEnvelope.gain.linearRampToValueAtTime(0.025 * strength, time + 0.016);
      toneEnvelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.14);
      tone.connect(toneEnvelope).connect(output);
      tone.start(time);
      tone.stop(time + 0.14);
      this.track(tone, () => { tone.disconnect(); toneEnvelope.disconnect(); });
    }
  }

  private referenceGrain(context: AudioContext, output: GainNode, sound: ReferencePeelSound, time: number, strength: number, seed: number, load: number) {
    const samples = synthesizeReferenceGrain(sound, context.sampleRate, strength, seed, load);
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    this.track(source, () => source.disconnect());
    // Synthesis takes a little time; never start a voice behind the audio clock.
    source.start(Math.max(time, context.currentTime));
  }

  private bassGrain(context: AudioContext, output: GainNode, psychedelic: boolean, time: number, strength: number, load: number) {
    const tone = context.createOscillator();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    const modulator = psychedelic ? context.createOscillator() : null;
    const modulation = modulator ? context.createGain() : null;
    const pitch = (52 + strength * 15 + Math.random() * 4) * (1 + load * 0.9);
    const duration = psychedelic ? 0.24 : 0.16;
    const end = time + duration;

    tone.type = psychedelic ? "sawtooth" : "triangle";
    tone.frequency.setValueAtTime(pitch, time);
    tone.frequency.exponentialRampToValueAtTime(pitch * (psychedelic ? 0.72 : 0.87), end);
    filter.type = "lowpass";
    filter.frequency.value = (psychedelic ? 215 : 175) * (1 + load * 2.5);
    filter.Q.value = (psychedelic ? 4 : 0.65) + load * 0.8;
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime((psychedelic ? 0.105 : 0.14) * strength, time + 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    tone.connect(filter).connect(envelope).connect(output);

    if (modulator && modulation) {
      modulator.frequency.setValueAtTime(8 + 4 * strength + load * 15, time);
      modulation.gain.value = 125;
      modulator.connect(modulation).connect(filter.frequency);
      modulator.start(time);
      modulator.stop(end);
    }

    tone.start(time);
    tone.stop(end);
    this.track(tone, () => {
      tone.disconnect();
      filter.disconnect();
      envelope.disconnect();
      modulator?.disconnect();
      modulation?.disconnect();
    });
  }

  dispose() {
    this.stop();
    const context = this.context;
    this.context = null;
    this.noise = null;
    this.output = null;
    this.previewingUntil = 0;
    if (context) void context.close().catch(() => {});
  }
}
