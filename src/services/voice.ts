/**
 * Spoken guidance. Tesla's Linux Chromium may expose no speech voices, so every prompt
 * falls back to a soft two-tone chime (Web Audio) — the visual banner carries the detail.
 */
export class Voice {
  muted = false;
  private voice: SpeechSynthesisVoice | null = null;
  private ctx: AudioContext | null = null;
  private lang = 'en';

  constructor() {
    if ('speechSynthesis' in window) {
      const pick = () => {
        const voices = speechSynthesis.getVoices();
        const want = voices.filter((v) => v.lang.toLowerCase().startsWith(this.lang));
        this.voice = want.find((v) => /natural|premium|enhanced|google/i.test(v.name)) || want[0] || null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  get canSpeak() { return !!this.voice; }

  /** Must run inside a user gesture once (autoplay policy). */
  unlock() {
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!this.ctx && AC) this.ctx = new AC();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* no audio */ }
  }

  say(text: string, urgent = false) {
    if (this.muted) return;
    if (this.voice) {
      if (urgent) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = this.voice;
      u.lang = this.voice.lang;
      u.rate = 1.02;
      u.pitch = 1;
      speechSynthesis.speak(u);
    } else {
      this.chime(urgent);
    }
  }

  chime(urgent = false) {
    if (this.muted || !this.ctx) return;
    const ctx = this.ctx;
    const tones = urgent ? [784, 1175] : [659, 988];
    tones.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.16;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.35);
    });
  }

  stop() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
}
