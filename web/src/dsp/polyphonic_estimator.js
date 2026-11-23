import { midiToHz, midiToNoteName, PIANO_MIN_MIDI, PIANO_MAX_MIDI } from './yin.js';

/**
 * Upgraded Milestone 5+ Polyphonic Piano Pitch Estimator:
 *  - Full 88-key piano coverage: A0 (21) .. C8 (108)
 *  - Supports 8192-point high-resolution FFT (5.86 Hz/bin @ 48kHz) for crisp bass separation
 *  - Missing/weak-fundamental bass support via odd-harmonic evidence (H2+H3+H4+H5)
 *  - Envelope-bounded harmonic cancellation + sub-harmonic octave correction
 */
export class PolyphonicPitchEstimator {
  constructor(options = {}) {
    this.minMidi = options.minMidi ?? PIANO_MIN_MIDI; // A0 (27.5 Hz)
    this.maxMidi = options.maxMidi ?? PIANO_MAX_MIDI; // C8 (4186 Hz)
    this.maxPolyphony = options.maxPolyphony ?? 6;
    this.maxHarmonics = options.maxHarmonics ?? 8;
    this.relativeThreshold = options.relativeThreshold ?? 0.18;
    this.a4ReferenceHz = options.a4ReferenceHz ?? 440.0;
  }

  estimate(magnitudeSpec, sampleRate, fftSize, config = {}) {
    if (!magnitudeSpec || magnitudeSpec.length === 0) return [];

    const a4 = config.a4ReferenceHz ?? this.a4ReferenceHz;
    const binHz = sampleRate / fftSize;
    const maxBin = magnitudeSpec.length - 1;
    const residual = new Float32Array(magnitudeSpec);

    let specSum = 0;
    let specPeak = 0;
    for (let b = 2; b <= maxBin; b++) {
      specSum += residual[b];
      if (residual[b] > specPeak) specPeak = residual[b];
    }
    const meanBin = specSum / Math.max(1, maxBin - 1);
    const binFloor = Math.max(meanBin * 1.8, specPeak * 0.025);
    if (specPeak < 1e-4) return [];

    const peakNear = (hz, searchBins = 1) => {
      const c = hz / binHz;
      if (c < 1 || c > maxBin) return { amp: 0, bin: -1 };
      const lo = Math.max(1, Math.round(c) - searchBins);
      const hi = Math.min(maxBin, Math.round(c) + searchBins);
      let bestAmp = 0;
      let bestBin = -1;
      for (let b = lo; b <= hi; b++) {
        if (residual[b] > bestAmp) {
          bestAmp = residual[b];
          bestBin = b;
        }
      }
      return { amp: bestAmp, bin: bestBin };
    };

    const interpAt = (hz) => {
      const c = hz / binHz;
      if (c < 1 || c >= maxBin) return 0;
      const b0 = Math.floor(c);
      const frac = c - b0;
      return residual[b0] * (1 - frac) + residual[b0 + 1] * frac;
    };

    const localPeakNear = (hz, radius = 1) => {
      const c = hz / binHz;
      if (c < 1 || c >= maxBin) return 0;
      const lo = Math.max(2, Math.round(c) - radius);
      const hi = Math.min(maxBin - 1, Math.round(c) + radius);
      let best = 0;
      for (let b = lo; b <= hi; b++) {
        if (residual[b] > residual[b - 1] && residual[b] >= residual[b + 1] && residual[b] > binFloor) {
          if (residual[b] > best) best = residual[b];
        }
      }
      return best;
    };

    const scoreMidi = (midi) => {
      const f0 = midiToHz(midi, a4);
      const B = midi < 36 ? 0.00025 : (midi < 48 ? 0.00018 : (midi < 72 ? 0.00038 : 0.0012));

      let salience = 0;
      let weightSum = 0;
      let supportedHarmonics = 0;
      let oddSupport = 0;
      let f0Amp = 0;
      let h2Amp = 0;
      let h3Amp = 0;

      for (let h = 1; h <= this.maxHarmonics; h++) {
        const fh = h * f0 * Math.sqrt(1 + B * h * h);
        if (fh > Math.min(sampleRate * 0.45, 5200)) break;

        let amp;
        if (h === 1) {
          amp = interpAt(fh);
        } else {
          const radius = h <= 2 ? 1 : Math.min(2, Math.ceil((fh * 0.015) / binHz));
          amp = peakNear(fh, radius).amp;
        }
        const w = 1 / Math.pow(h, 0.62);

        if (h === 1) f0Amp = amp;
        else if (h === 2) h2Amp = amp;
        else if (h === 3) h3Amp = amp;

        if (amp > binFloor) {
          salience += amp * w;
          supportedHarmonics++;
          if (h >= 3 && h % 2 === 1) oddSupport++;
        }
        weightSum += w;
      }

      if (weightSum <= 0) return 0;

      // Fundamental guard:
      //  - Mid/High (>= C3): require fundamental energy.
      //  - Low bass (< C3): allow missing/weak fundamental when H2, H3, and at least one
      //    higher odd harmonic (H5/H7) are present (prevents 2nd-harmonic confusion!).
      const hasFundamental = f0Amp > binFloor * 1.1;
      const hasBassMissingF0 = midi < 48 && h2Amp > binFloor * 1.4 && h3Amp > binFloor * 1.1 && oddSupport >= 2;
      if (!hasFundamental && !hasBassMissingF0) return 0;

      const minHarmonics = f0 > 1800 ? 1 : 2;
      if (supportedHarmonics < minHarmonics && f0Amp < binFloor * 2.5) return 0;

      const baseScore = salience / Math.sqrt(weightSum);
      // Slight bonus for bass notes explaining odd harmonics cleanly
      const bonus = hasFundamental ? 1.0 : 0.92;
      return baseScore * bonus;
    };

    const subtractHarmonics = (midi) => {
      const f0 = midiToHz(midi, a4);
      const B = midi < 36 ? 0.00025 : (midi < 48 ? 0.00018 : (midi < 72 ? 0.00038 : 0.0012));

      const h1 = peakNear(f0, 1);
      const h2 = peakNear(2 * f0, 1);
      const refA1 = h1.amp > binFloor ? h1.amp : h2.amp * 1.35;
      if (refA1 <= 0) return;

      for (let h = 1; h <= 10; h++) {
        const fh = h * f0 * Math.sqrt(1 + B * h * h);
        if (fh > sampleRate * 0.45) break;
        const centerBin = fh / binHz;
        const radius = h <= 2 ? 1 : 2;
        const lo = Math.max(1, Math.round(centerBin) - radius);
        const hi = Math.min(maxBin, Math.round(centerBin) + radius);

        let peak = 0;
        let peakBin = Math.round(centerBin);
        for (let b = lo; b <= hi; b++) {
          if (residual[b] > peak) {
            peak = residual[b];
            peakBin = b;
          }
        }
        if (peak <= 0) continue;

        const expectedPartial = h === 1 ? peak : refA1 * (0.85 / Math.pow(h, 1.05));
        const subAmp = Math.min(peak, expectedPartial);

        for (let b = Math.max(1, peakBin - 2); b <= Math.min(maxBin, peakBin + 2); b++) {
          const dist = Math.abs(b - peakBin);
          const shape = dist === 0 ? 1.0 : (dist === 1 ? 0.65 : 0.20);
          residual[b] = Math.max(0, residual[b] - subAmp * shape);
        }
      }
    };

    const detected = [];
    const pickedSet = new Set();
    let topSalience = 0;

    for (let iter = 0; iter < this.maxPolyphony; iter++) {
      let bestMidi = -1;
      let bestScore = 0;

      for (let m = this.minMidi; m <= this.maxMidi; m++) {
        if (pickedSet.has(m)) continue;
        const score = scoreMidi(m);
        if (score > bestScore) {
          bestScore = score;
          bestMidi = m;
        }
      }

      const dynamicMinSalience = Math.max(0.004, specPeak * 0.12);
      if (bestMidi === -1 || bestScore < dynamicMinSalience) break;
      if (iter === 0) {
        topSalience = bestScore;
      } else if (bestScore < topSalience * this.relativeThreshold) {
        break;
      }

      // Check if bestMidi (A1..B3) is actually the 2nd harmonic of an unpicked low-bass note
      // (subMidi <= B2 = 47) whose odd partials (3*f_sub, 5*f_sub, 7*f_sub) are genuine local peaks!
      if (bestMidi >= 33 && bestMidi <= 59 && !pickedSet.has(bestMidi - 12)) {
        const subMidi = bestMidi - 12;
        const fSub = midiToHz(subMidi, a4);
        const B = subMidi < 36 ? 0.00025 : 0.00018;
        let oddPeaks = 0;
        let oddSum = 0;
        for (const h of [3, 5, 7]) {
          const fh = h * fSub * Math.sqrt(1 + B * h * h);
          const lp = localPeakNear(fh, 1);
          if (lp > binFloor * 1.2) {
            oddPeaks++;
            oddSum += lp;
          }
        }
        const currE = Math.max(peakNear(midiToHz(bestMidi, a4), 1).amp, 1e-6);
        if (oddPeaks >= 2 && oddSum > 0.14 * currE) {
          bestMidi = subMidi;
        }
      }

      const isOvertoneOfPicked = pickedSet.has(bestMidi - 12) || pickedSet.has(bestMidi - 19);
      if (isOvertoneOfPicked && bestScore < topSalience * 0.36) {
        subtractHarmonics(bestMidi);
        continue;
      }

      const isSemitoneNeighbor = pickedSet.has(bestMidi - 1) || pickedSet.has(bestMidi + 1);
      if (isSemitoneNeighbor && bestScore < topSalience * 0.45) {
        subtractHarmonics(bestMidi);
        continue;
      }

      pickedSet.add(bestMidi);
      const f0 = midiToHz(bestMidi, a4);
      const confidence = Math.max(0.6, Math.min(0.99, bestScore / Math.max(topSalience, 1e-6)));

      detected.push({
        midiNote: bestMidi,
        noteName: midiToNoteName(bestMidi),
        frequencyHz: f0,
        centsOffset: 0,
        confidence,
        salience: bestScore,
      });

      subtractHarmonics(bestMidi);
    }

    detected.sort((a, b) => a.midiNote - b.midiNote);
    return detected;
  }
}

/**
 * Polyphonic per-key NoteOn / NoteOff state tracker.
 */
export class PolyphonicNoteTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.keys = new Map();
  }

  process(candidates, rmsDb, timestampSec, config) {
    const events = [];
    const present = new Map();
    for (const c of candidates) {
      if (c.confidence >= config.minConfidence) {
        present.set(c.midiNote, c);
      }
    }

    const vel = Math.max(0.05, Math.min(1.0, (rmsDb + 50) / 44));
    const stableReq = config.stableFramesRequired ?? 2;
    const releaseReq = config.releaseFramesRequired ?? 4;

    for (const [midi, cand] of present.entries()) {
      let st = this.keys.get(midi);
      if (!st) {
        st = { active: false, stableCount: 0, absentCount: 0, lastFreq: cand.frequencyHz, lastConf: cand.confidence };
        this.keys.set(midi, st);
      }
      st.absentCount = 0;
      st.lastFreq = cand.frequencyHz;
      st.lastConf = cand.confidence;

      if (!st.active) {
        st.stableCount++;
        if (st.stableCount >= stableReq) {
          st.active = true;
          events.push({
            type: 'noteOn',
            midiNote: midi,
            frequencyHz: cand.frequencyHz,
            confidence: cand.confidence,
            velocityEst: vel,
            timestampSec,
          });
        }
      }
    }

    for (const [midi, st] of this.keys.entries()) {
      if (present.has(midi)) continue;
      st.stableCount = 0;
      if (st.active) {
        st.absentCount++;
        if (st.absentCount >= releaseReq) {
          st.active = false;
          events.push({ type: 'noteOff', midiNote: midi, timestampSec });
          this.keys.delete(midi);
        }
      } else {
        this.keys.delete(midi);
      }
    }

    const activeMidis = [];
    for (const [midi, st] of this.keys.entries()) {
      if (st.active) activeMidis.push(midi);
    }
    activeMidis.sort((a, b) => a - b);

    return { activeMidis, events };
  }
}
