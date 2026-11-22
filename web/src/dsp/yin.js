import { FFT } from './fft.js';

export const PIANO_MIN_MIDI = 21;  // A0 (27.50 Hz)
export const PIANO_MAX_MIDI = 108; // C8 (4186.01 Hz)
export const MIN_PIANO_HZ = 26.0;
export const MAX_PIANO_HZ = 4300.0;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToHz(midi, a4Hz = 440.0) {
  return a4Hz * Math.pow(2, (midi - 69) / 12);
}

export function hzToMidi(hz, a4Hz = 440.0) {
  if (hz <= 0 || a4Hz <= 0) return { midi: -1, cents: 0 };
  const midiFloat = 69 + 12 * Math.log2(hz / a4Hz);
  const midi = Math.round(midiFloat);
  const cents = (midiFloat - midi) * 100;
  return { midi, cents };
}

export function midiToNoteName(midi) {
  if (midi < 0 || midi > 127) return '--';
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/**
 * FFT-accelerated YIN pitch estimator with parabolic interpolation and spectral
 * octave disambiguation (exact JS mirror of native/src/yin_estimator.cpp).
 */
export class YinPitchEstimator {
  constructor(frameSize = 4096) {
    this.frameSize = frameSize;
    this.half = frameSize >> 1;
    this.fft = new FFT(frameSize);
    this.reA = new Float32Array(frameSize);
    this.imA = new Float32Array(frameSize);
    this.reB = new Float32Array(frameSize);
    this.imB = new Float32Array(frameSize);
    this.cumSq = new Float64Array(frameSize + 1);
    this.cmndf = new Float32Array(this.half);
  }

  estimate(frame, magnitudeSpec, sampleRate, config) {
    const n = this.frameSize;
    const half = this.half;

    this.cumSq[0] = 0;
    for (let i = 0; i < n; i++) {
      const s = frame[i];
      this.cumSq[i + 1] = this.cumSq[i] + s * s;
    }
    const energyFirstHalf = this.cumSq[half];
    if (energyFirstHalf < 1e-12) return null;

    // FFT cross-correlation: r(tau) = sum_{j=0}^{W-1} x[j] * x[j+tau]
    this.reA.fill(0);
    this.imA.fill(0);
    this.reB.set(frame);
    this.imB.fill(0);
    for (let i = 0; i < half; i++) this.reA[i] = frame[i];

    this.fft.transform(this.reA, this.imA, false);
    this.fft.transform(this.reB, this.imB, false);
    for (let i = 0; i < n; i++) {
      // conj(A) * B
      const aRe = this.reA[i];
      const aIm = -this.imA[i];
      const bRe = this.reB[i];
      const bIm = this.imB[i];
      this.reA[i] = aRe * bRe - aIm * bIm;
      this.imA[i] = aRe * bIm + aIm * bRe;
    }
    this.fft.transform(this.reA, this.imA, true);

    this.cmndf[0] = 1.0;
    let runningSum = 0;
    for (let tau = 1; tau < half; tau++) {
      const energyShifted = this.cumSq[tau + half] - this.cumSq[tau];
      let d = energyFirstHalf + energyShifted - 2 * this.reA[tau];
      if (d < 0) d = 0;
      runningSum += d;
      this.cmndf[tau] = runningSum > 1e-12 ? (d * tau) / runningSum : 1.0;
    }

    const minTau = Math.max(2, Math.floor(sampleRate / MAX_PIANO_HZ));
    const maxTau = Math.min(half - 2, Math.ceil(sampleRate / MIN_PIANO_HZ));
    if (minTau >= maxTau) return null;

    let bestTau = -1;
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (this.cmndf[tau] < config.yinThreshold) {
        while (tau + 1 <= maxTau && this.cmndf[tau + 1] < this.cmndf[tau]) tau++;
        bestTau = tau;
        break;
      }
    }

    if (bestTau === -1) {
      let minVal = 1.0;
      for (let tau = minTau; tau <= maxTau; tau++) {
        if (this.cmndf[tau] < minVal) {
          minVal = this.cmndf[tau];
          bestTau = tau;
        }
      }
      if (bestTau === -1 || minVal > 0.35) return null;
    }

    // Parabolic interpolation before spectral octave disambiguation
    let refinedTau = bestTau;
    if (bestTau > 1 && bestTau < half - 1) {
      const y0 = this.cmndf[bestTau - 1];
      const y1 = this.cmndf[bestTau];
      const y2 = this.cmndf[bestTau + 1];
      const denom = 2 * (y0 - 2 * y1 + y2);
      if (Math.abs(denom) > 1e-9) {
        const delta = (y0 - y2) / denom;
        if (delta > -1 && delta < 1) refinedTau += delta;
      }
    }

    let freqHz = sampleRate / refinedTau;

    // Spectral octave disambiguation (sub-octave guard + local-peak bass guard)
    if (magnitudeSpec && magnitudeSpec.length > 0) {
      const binHz = sampleRate / n;
      const maxBin = magnitudeSpec.length - 1;

      const peakNear = (hz) => {
        const c = hz / binHz;
        if (c < 1 || c > maxBin) return 0;
        const lo = Math.max(1, Math.floor(c) - 1);
        const hi = Math.min(maxBin, Math.ceil(c) + 1);
        let p = 0;
        for (let b = lo; b <= hi; b++) if (magnitudeSpec[b] > p) p = magnitudeSpec[b];
        return p;
      };

      const localPeakNear = (hz) => {
        const b = Math.round(hz / binHz);
        if (b <= 1 || b >= maxBin) return 0;
        if (magnitudeSpec[b] > magnitudeSpec[b - 1] && magnitudeSpec[b] >= magnitudeSpec[b + 1]) {
          return magnitudeSpec[b];
        }
        return 0;
      };

      const oddE = peakNear(freqHz) + peakNear(3 * freqHz) + peakNear(5 * freqHz);
      const evenE = peakNear(2 * freqHz) + peakNear(4 * freqHz) + peakNear(6 * freqHz);

      if (2 * freqHz <= MAX_PIANO_HZ && evenE > 1e-6 && oddE < 0.15 * evenE) {
        freqHz *= 2;
      } else {
        const doubleTau = bestTau * 2;
        const fSub = freqHz * 0.5;
        if (doubleTau >= minTau && doubleTau <= maxTau - 2 && fSub >= MIN_PIANO_HZ &&
            (freqHz - fSub) > 2.5 * binHz) {
          let subTau = doubleTau;
          const lo = Math.max(minTau, doubleTau - 3);
          const hi = Math.min(maxTau, doubleTau + 3);
          for (let t = lo; t <= hi; t++) {
            if (this.cmndf[t] < this.cmndf[subTau]) subTau = t;
          }
          if (this.cmndf[subTau] < config.yinThreshold * 1.1) {
            const eCurr = peakNear(freqHz);
            const eRef = Math.max(eCurr, peakNear(2 * freqHz));
            const eSub = localPeakNear(fSub);
            const e3Sub = localPeakNear(3 * fSub);
            const e5Sub = localPeakNear(5 * fSub);
            if (eRef > 1e-6 && eSub > 0.15 * eRef && e3Sub > 0.25 * eRef &&
                (eSub + e3Sub + e5Sub) > 0.55 * eRef) {
              freqHz = sampleRate / subTau;
            }
          }
        }
      }
    }

    const { midi, cents } = hzToMidi(freqHz, config.a4ReferenceHz);
    if (midi < PIANO_MIN_MIDI || midi > PIANO_MAX_MIDI) return null;

    const confidence = Math.max(0, Math.min(1, 1 - this.cmndf[bestTau]));
    if (confidence < config.minConfidence) return null;

    return { frequencyHz: freqHz, midiNote: midi, centsOffset: cents, confidence };
  }
}
