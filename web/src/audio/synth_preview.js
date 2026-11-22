import { midiToHz } from '../dsp/yin.js';

/**
 * Lightweight Web Audio API piano-like reference preview synthesizer.
 * Used ONLY when the user clicks "Preview Song" (to hear how a lesson sounds before playing);
 * never plays while live microphone grading is active so speakers don't trigger the mic.
 */
export class PianoPreviewSynth {
  constructor() {
    this.ctx = null;
    this.activeNodes = [];
    this.isPlaying = false;
    this.stopTimer = null;
  }

  stop() {
    this.isPlaying = false;
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    for (const node of this.activeNodes) {
      try { node.stop(); } catch {}
      try { node.disconnect(); } catch {}
    }
    this.activeNodes = [];
  }

  async playSong(notes, tempoScale = 1.0, onEnded = null) {
    this.stop();
    if (!notes || notes.length === 0) return;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!this.ctx) this.ctx = new AudioCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const now = this.ctx.currentTime + 0.05;
    const scale = Math.max(0.25, tempoScale);
    let maxEnd = 0;

    this.isPlaying = true;
    for (const n of notes) {
      const start = now + n.startSec / scale;
      const dur = Math.max(0.08, n.durationSec / scale);
      if (n.endSec / scale > maxEnd) maxEnd = n.endSec / scale;
      this._scheduleTone(n.midiPitch, start, dur, (n.velocity ?? 0.8) * 0.22);
    }

    this.stopTimer = setTimeout(() => {
      this.stop();
      if (onEnded) onEnded();
    }, Math.ceil((maxEnd + 0.4) * 1000));
  }

  _scheduleTone(midi, startTime, durationSec, gainPeak) {
    const f0 = midiToHz(midi);
    const master = this.ctx.createGain();
    master.gain.setValueAtTime(0.0001, startTime);
    master.gain.linearRampToValueAtTime(gainPeak, startTime + 0.008);
    master.gain.exponentialRampToValueAtTime(Math.max(0.0005, gainPeak * 0.25), startTime + durationSec);
    master.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec + 0.12);
    master.connect(this.ctx.destination);

    // Warm piano-like blend: fundamental triangle + gentle 2nd harmonic sine
    const osc1 = this.ctx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(f0, startTime);
    osc1.connect(master);

    const osc2 = this.ctx.createOscillator();
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.35, startTime);
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(f0 * 2, startTime);
    osc2.connect(g2);
    g2.connect(master);

    osc1.start(startTime);
    osc2.start(startTime);
    osc1.stop(startTime + durationSec + 0.14);
    osc2.stop(startTime + durationSec + 0.14);

    this.activeNodes.push(osc1, osc2);
  }
}
