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

export function midiRegister(midi) {
  if (midi < 48) return 'LOW';
  if (midi < 84) return 'MID';
  return 'HIGH';
}

/**
 * FFT-accelerated YIN fundamental-frequency estimator with:
 *  - Support for adaptive window lengths (4096 fast mid/high, 8192 high-res bass)
 *  - Parabolic sub-sample lag interpolation
 *  - Missing/weak-fundamental harmonic comb analysis (H3, H5, H7 odd-partial proof)
 *  - Candidate octave alternative comparison (f/2, f, 2f) with full debug telemetry
 */
export class YinPitchEstimator {
  constructor(frameSize = 4096) {
    this._initBuffers(frameSize);
  }

  _initBuffers(frameSize) {
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
    const n = frame.length;
    if (n !== this.frameSize) this._initBuffers(n);
    const half = this.half;

    this.cumSq[0] = 0;
    for (let i = 0; i < n; i++) {
      const s = frame[i];
      this.cumSq[i + 1] = this.cumSq[i] + s * s;
    }
    const energyFirstHalf = this.cumSq[half];
    if (energyFirstHalf < 1e-12) return null;

    // 1. FFT-accelerated cross-correlation: r(tau) = sum_{j=0}^{W-1} x[j] * x[j+tau]
    this.reA.fill(0);
    this.imA.fill(0);
    this.reB.set(frame);
    this.imB.fill(0);
    for (let i = 0; i < half; i++) this.reA[i] = frame[i];

    this.fft.transform(this.reA, this.imA, false);
    this.fft.transform(this.reB, this.imB, false);
    for (let i = 0; i < n; i++) {
      const aRe = this.reA[i];
      const aIm = -this.imA[i];
      const bRe = this.reB[i];
      const bIm = this.imB[i];
      this.reA[i] = aRe * bRe - aIm * bIm;
      this.imA[i] = aRe * bIm + aIm * bRe;
    }
    this.fft.transform(this.reA, this.imA, true);

    // 2. Cumulative Mean Normalized Difference Function d'(tau)
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

    // 3. First local minimum below yinThreshold
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

    const refineTau = (tauIdx) => {
      let refined = tauIdx;
      if (tauIdx > 1 && tauIdx < half - 1) {
        const y0 = this.cmndf[tauIdx - 1];
        const y1 = this.cmndf[tauIdx];
        const y2 = this.cmndf[tauIdx + 1];
        const denom = 2 * (y0 - 2 * y1 + y2);
        if (Math.abs(denom) > 1e-9) {
          const delta = (y0 - y2) / denom;
          if (delta > -1 && delta < 1) refined += delta;
        }
      }
      return refined;
    };

    const rawFreqHz = sampleRate / refineTau(bestTau);
    let finalFreqHz = rawFreqHz;
    let finalTau = bestTau;
    let correction = 'none';
    const candidates = [];

    // 4. Harmonic structure analysis & candidate octave alternative comparison (f/2, f, 2f)
    if (magnitudeSpec && magnitudeSpec.length > 0) {
      const binHz = sampleRate / n;
      const maxBin = magnitudeSpec.length - 1;

      // Estimate spectral noise floor for local peak verification
      let specSum = 0;
      let specPeak = 0;
      for (let b = 2; b <= maxBin; b++) {
        specSum += magnitudeSpec[b];
        if (magnitudeSpec[b] > specPeak) specPeak = magnitudeSpec[b];
      }
      const binFloor = Math.max((specSum / Math.max(1, maxBin - 1)) * 1.8, specPeak * 0.015);

      const peakNear = (hz, radius = 1) => {
        const c = hz / binHz;
        if (c < 1 || c > maxBin) return 0;
        const lo = Math.max(1, Math.round(c) - radius);
        const hi = Math.min(maxBin, Math.round(c) + radius);
        let p = 0;
        for (let b = lo; b <= hi; b++) if (magnitudeSpec[b] > p) p = magnitudeSpec[b];
        return p;
      };

      // Strict local spectral peak detector (rejects Hann main-lobe skirts of neighboring harmonics)
      const localPeakNear = (hz, radius = 1) => {
        const c = hz / binHz;
        if (c < 1 || c >= maxBin) return 0;
        const lo = Math.max(2, Math.round(c) - radius);
        const hi = Math.min(maxBin - 1, Math.round(c) + radius);
        let best = 0;
        for (let b = lo; b <= hi; b++) {
          if (magnitudeSpec[b] > magnitudeSpec[b - 1] &&
              magnitudeSpec[b] >= magnitudeSpec[b + 1] &&
              magnitudeSpec[b] > binFloor) {
            if (magnitudeSpec[b] > best) best = magnitudeSpec[b];
          }
        }
        return best;
      };

      const evaluateCandidate = (label, hz, tauApprox) => {
        if (hz < MIN_PIANO_HZ || hz > MAX_PIANO_HZ) return null;
        const { midi } = hzToMidi(hz, config.a4ReferenceHz);
        if (midi < PIANO_MIN_MIDI || midi > PIANO_MAX_MIDI) return null;
        const B = midi < 36 ? 0.00025 : (midi < 48 ? 0.00018 : (midi < 72 ? 0.00038 : 0.0012));

        let harmonicSum = 0;
        let oddPeakCount = 0;
        let oddEnergy = 0;
        let evenEnergy = 0;

        for (let h = 1; h <= 8; h++) {
          const fh = h * hz * Math.sqrt(1 + B * h * h);
          if (fh > sampleRate * 0.45) break;
          const r = h <= 3 ? 1 : 2;
          const amp = h === 1 ? peakNear(fh, 1) : localPeakNear(fh, r);
          const w = 1 / Math.pow(h, 0.55);
          harmonicSum += amp * w;
          if (h % 2 === 1) {
            oddEnergy += amp;
            if (h >= 3 && amp > binFloor * 1.2) oddPeakCount++;
          } else {
            evenEnergy += amp;
          }
        }

        // Find local CMNDF minimum near tauApprox
        let cTau = Math.round(tauApprox);
        let cmndfVal = 1.0;
        if (cTau >= minTau && cTau <= maxTau) {
          const lo = Math.max(minTau, cTau - 4);
          const hi = Math.min(maxTau, cTau + 4);
          for (let t = lo; t <= hi; t++) {
            if (this.cmndf[t] < cmndfVal) {
              cmndfVal = this.cmndf[t];
              cTau = t;
            }
          }
        }

        return {
          label,
          frequencyHz: cTau >= minTau && cTau <= maxTau ? sampleRate / refineTau(cTau) : hz,
          midiNote: midi,
          noteName: midiToNoteName(midi),
          tau: cTau,
          cmndf: cmndfVal,
          harmonicSum,
          oddEnergy,
          evenEnergy,
          oddPeakCount,
        };
      };

      const candBase = evaluateCandidate('raw (f)', rawFreqHz, bestTau);
      const candDown = evaluateCandidate('octave-down (f/2)', rawFreqHz * 0.5, bestTau * 2);
      const candUp = evaluateCandidate('octave-up (2f)', rawFreqHz * 2.0, bestTau * 0.5);

      if (candDown) candidates.push(candDown);
      if (candBase) candidates.push(candBase);
      if (candUp) candidates.push(candUp);

      // (a) Treble / Sub-octave guard: if odd partials of rawFreqHz (1x, 3x, 5x) carry almost no
      //     energy compared to even partials (2x, 4x, 6x), true fundamental is 2 * rawFreqHz.
      const oddRaw = peakNear(rawFreqHz) + peakNear(3 * rawFreqHz) + peakNear(5 * rawFreqHz);
      const evenRaw = peakNear(2 * rawFreqHz) + peakNear(4 * rawFreqHz) + peakNear(6 * rawFreqHz);

      if (candUp && evenRaw > 1e-6 && oddRaw < 0.14 * evenRaw) {
        finalFreqHz = rawFreqHz * 2.0;
        correction = 'octave-up (sub-octave guard)';
      } else if (candDown && candBase && (rawFreqHz - candDown.frequencyHz) > 2.2 * binHz) {
        // (b) Missing / Weak Fundamental Bass Correction (2nd-harmonic confusion fix!):
        //     If f/2 has a strong YIN CMNDF dip AND explains >= 2 genuine odd harmonics (H3, H5, H7)
        //     that rawFreqHz CANNOT explain (since 3*(f/2), 5*(f/2), 7*(f/2) are half-integers of f),
        //     then rawFreqHz was the 2nd harmonic and f/2 is the true fundamental!
        const refE = Math.max(peakNear(rawFreqHz), peakNear(2 * rawFreqHz), 1e-6);
        const oddRatio = candDown.oddEnergy / refE;
        const cmndfGood = candDown.cmndf < Math.max(config.yinThreshold * 1.45, 0.22) &&
                          candDown.cmndf <= this.cmndf[bestTau] + 0.14;

        // Works even when H1 is 100% missing (phone mic rolloff) because H3/H5/H7 prove f/2!
        const calEvidence = config.getCalibrationEvidence ? config.getCalibrationEvidence(candDown.midiNote) : null;
        const oddThreshold = calEvidence?.weakFundamentalExpected ? 0.08 : 0.12;
        const hasMissingF0Proof = candDown.oddPeakCount >= 2 && oddRatio > oddThreshold;
        const hasWeakF0Proof = candDown.oddPeakCount >= 1 && localPeakNear(candDown.frequencyHz, 1) > 0.12 * refE;

        if (cmndfGood && (hasMissingF0Proof || hasWeakF0Proof)) {
          finalFreqHz = candDown.frequencyHz;
          finalTau = candDown.tau;
          correction = calEvidence ? 'octave-down (calibrated f0 evidence)' : 'octave-down (missing/weak f0)';
        }
      }
    }

    // Apply cautious calibrated local stretch-tuning offset if available for this instrument
    const rawMap = hzToMidi(finalFreqHz, config.a4ReferenceHz);
    let midi = rawMap.midi;
    let cents = rawMap.cents;
    if (config.getCalibrationEvidence && midi >= PIANO_MIN_MIDI && midi <= PIANO_MAX_MIDI) {
      const ev = config.getCalibrationEvidence(midi);
      if (ev && Math.abs(ev.expectedCentsOffset) > 1.0) {
        const baseA4 = config.baseA4ReferenceHz || config.a4ReferenceHz;
        const adjustedHz = finalFreqHz * Math.pow(2, -ev.expectedCentsOffset / 1200);
        const adjMap = hzToMidi(adjustedHz, baseA4);
        midi = adjMap.midi;
        cents = adjMap.cents;
      }
    }
    if (midi < PIANO_MIN_MIDI || midi > PIANO_MAX_MIDI) return null;

    const bestCmndf = finalTau >= 1 && finalTau < half ? this.cmndf[finalTau] : this.cmndf[bestTau];
    const confidence = Math.max(0, Math.min(1, 1 - bestCmndf));
    if (confidence < config.minConfidence) return null;

    // Mark winning candidate for Debug Screen
    for (const c of candidates) {
      c.selected = c.midiNote === midi;
    }

    return {
      rawFrequencyHz: rawFreqHz,
      frequencyHz: finalFreqHz,
      midiNote: midi,
      noteName: midiToNoteName(midi),
      register: midiRegister(midi),
      centsOffset: cents,
      confidence,
      windowSizeUsed: n,
      correction,
      candidates,
    };
  }
}
