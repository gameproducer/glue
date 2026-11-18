export const PEEL_SOUNDS = [
  { id: "off", label: "Off" },
  { id: "silk", label: "Silk peel (ASMR)" },
  { id: "paper", label: "Paper crackle (ASMR)" },
  { id: "chime", label: "Soft chime" },
] as const;

export type PeelSound = (typeof PEEL_SOUNDS)[number]["id"];
const STORAGE_KEY = "peel.sound";
const GRAIN_GAP = 0.04;

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

export class PeelAudio {
  private context: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private output: GainNode | null = null;
  private accumulated = 0;
  private nextGrain = 0;
  private previewingUntil = 0;

  unlock() {
    try {
      if (!this.context) {
        const context = new AudioContext();
        const noise = context.createBuffer(1, Math.ceil(context.sampleRate * 0.3), context.sampleRate);
        const samples = noise.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
        const output = context.createGain();
        output.gain.value = 0.65;
        output.connect(context.destination);
        this.context = context;
        this.noise = noise;
        this.output = output;
      }
      if (this.context.state !== "running") void this.context.resume().catch(() => {});
    } catch { /* Peeling can continue on devices with audio unavailable. */ }
  }

  setMuted(muted: boolean) {
    if (this.context && this.output) {
      this.output.gain.setTargetAtTime(muted ? 0 : 0.65, this.context.currentTime, 0.016);
    }
  }

  beginGesture() {
    this.accumulated = 0;
    this.nextGrain = 0;
  }

  playProgress(sound: PeelSound, progress: number) {
    if (!this.context || this.context.state !== "running" || sound === "off" || progress <= 0) return;
    const now = this.context.currentTime;
    this.accumulated += progress;
    if (this.accumulated < 0.002 || now < this.nextGrain) return;
    const strength = Math.min(1, 0.34 + Math.sqrt(this.accumulated) * 3.1);
    this.grain(sound, now, strength);
    this.nextGrain = now + GRAIN_GAP;
    this.accumulated = 0;
  }

  preview(sound: PeelSound) {
    if (sound === "off") return;
    this.unlock();
    if (!this.context) return;
    const now = this.context.currentTime;
    if (now < this.previewingUntil) return;
    const pattern = [0, 0.07, 0.13, 0.17, 0.205, 0.255, 0.32, 0.41, 0.52];
    for (const [index, offset] of pattern.entries()) {
      this.grain(sound, now + offset + 0.025, Math.sin((index + 2) / 12 * Math.PI) * 0.7 + 0.2);
    }
    this.previewingUntil = now + 0.7;
  }

  private grain(sound: Exclude<PeelSound, "off">, time: number, strength: number) {
    const { context, noise, output } = this;
    if (!context || !noise || !output) return;
    const profile = profiles[sound];
    const duration = profile.duration * (0.85 + Math.random() * 0.3);
    const source = context.createBufferSource();
    source.buffer = noise;
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = profile.frequency * (0.82 + Math.random() * 0.4);
    filter.Q.value = profile.q;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(profile.volume * strength, time + (sound === "paper" ? 0.003 : 0.012));
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    source.connect(filter).connect(envelope).connect(output);
    source.start(time, Math.random() * 0.13, duration);
    source.onended = () => { source.disconnect(); filter.disconnect(); envelope.disconnect(); };

    if (sound === "chime") {
      const tone = context.createOscillator();
      const toneEnvelope = context.createGain();
      const pitch = 330 + 220 * strength + Math.random() * 24;
      tone.frequency.setValueAtTime(pitch, time);
      tone.frequency.exponentialRampToValueAtTime(pitch * 0.84, time + 0.12);
      toneEnvelope.gain.setValueAtTime(0, time);
      toneEnvelope.gain.linearRampToValueAtTime(0.025 * strength, time + 0.016);
      toneEnvelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.14);
      tone.connect(toneEnvelope).connect(output);
      tone.start(time);
      tone.stop(time + 0.14);
      tone.onended = () => { tone.disconnect(); toneEnvelope.disconnect(); };
    }
  }

  dispose() {
    const context = this.context;
    this.context = null;
    this.noise = null;
    this.output = null;
    this.previewingUntil = 0;
    if (context) void context.close().catch(() => {});
  }
}
