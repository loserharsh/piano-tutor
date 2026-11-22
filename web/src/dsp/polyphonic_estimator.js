import { midiToHz, midiToNoteName } from './yin.js';

/**
 * Milestone 5 — Polyphonic Piano Pitch Estimator.
 *
 * Uses Iterative Harmonic Summation with Spectral Harmonic Cancellation (Klapuri-style multi-F0):
 *  1. Builds a residual magnitude spectrum from the Hann-windowed FFT.
 *  2. Evaluates harmonic salience across piano notes (E1=28 .. G7=103), accounting for
 *     piano stiff-string inharmonicity f_h = h * f0 * sqrt(1 + B * h^2).
 *  3. Picks the strongest fundamental, verifies fundamental + harmonic support, and
 *     subtracts its harmonic comb from the residual spectrum before extracting the next note.
 *
 * This suppresses harmonic ghosts (octave/12th overtones of a single note) while accurately
 * resolving simultaneous intervals, 3-4 note chords, and two-hand overlapping passages.
 */
export class PolyphonicPitchEstimator {
  constructor(options = {}) {
    this.minMidi = options.minMidi ?? 28; // E1 (41.2 Hz)
    this.maxMidi = options.maxMidi ?? 103; // G7 (3136 Hz)
    this.maxPolyphony = options.maxPolyphony ?? 6;
    this.maxHarmonics = options.maxHarmonics ?? 8;
    this.relativeThreshold = options.relativeThreshold ?? 0.18;
    this.minSalience = options.minSalience ?? 0.018;
    this.a4ReferenceHz = options.a4ReferenceHz ?? 440.0;
  }

  estimate(magnitudeSpec, sampleRate, fftSize, config = {}) {
    if (!magnitudeSpec || magnitudeSpec.length === 0) return [];

    const a4 = config.a4ReferenceHz ?? this.a4ReferenceHz;
    const binHz = sampleRate / fftSize;
    const maxBin = magnitudeSpec.length - 1;

    // Copy magnitude spectrum into mutable residual spectrum.
    const residual = new Float32Array(magnitudeSpec);

    // Estimate median/mean spectral noise floor to avoid picking broadband noise.
    let specSum = 0;
    let specPeak = 0;
    for (let b = 2; b <= maxBin; b++) {
      specSum += residual[b];
      if (residual[b] > specPeak) specPeak = residual[b];
    }
    const meanBin = specSum / Math.max(1, maxBin - 1);
    const binFloor = Math.max(meanBin * 1.8, specPeak * 0.035);
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

    const scoreMidi = (midi) => {
      const f0 = midiToHz(midi, a4);
      const B = midi < 48 ? 0.00015 : (midi < 72 ? 0.00035 : 0.0010);

      let salience = 0;
      let weightSum = 0;
      let supportedHarmonics = 0;
      let f0Amp = 0;
      let h2Amp = 0;
      let h3Amp = 0;

      for (let h = 1; h <= this.maxHarmonics; h++) {
        const fh = h * f0 * Math.sqrt(1 + B * h * h);
        if (fh > Math.min(sampleRate * 0.45, 5200)) break;

        // For h=1, use exact fractional-bin interpolation so adjacent semitones (e.g. B3 vs C4)
        // cannot steal each other's fundamental peak across +/- 1 bin.
        let amp;
        if (h === 1) {
          amp = interpAt(fh);
        } else {
          const radius = h === 2 ? 1 : Math.min(2, Math.ceil((fh * 0.015) / binHz));
          amp = peakNear(fh, radius).amp;
        }
        const w = 1 / Math.pow(h, 0.65);

        if (h === 1) f0Amp = amp;
        else if (h === 2) h2Amp = amp;
        else if (h === 3) h3Amp = amp;

        if (amp > binFloor) {
          salience += amp * w;
          supportedHarmonics++;
        }
        weightSum += w;
      }

      if (weightSum <= 0) return 0;

      // Fundamental guard: reject phantom sub-harmonics that have zero f0 energy.
      // (For bass notes < C3, allow weak fundamental if both H2 and H3 are strong.)
      const hasFundamental = f0Amp > binFloor * 1.1;
      const hasBassHarmonics = midi < 48 && h2Amp > binFloor * 1.6 && h3Amp > binFloor * 1.6;
      if (!hasFundamental && !hasBassHarmonics) return 0;

      // Require at least 2 supported partials, OR a very strong standalone fundamental peak
      // (e.g. a fifth whose H2 was partially consumed by the root's H3 during subtraction).
      const minHarmonics = f0 > 1800 ? 1 : 2;
      if (supportedHarmonics < minHarmonics && f0Amp < binFloor * 2.5) return 0;

      // Normalize salience and slightly reward notes with clear fundamental energy.
      const baseScore = salience / Math.sqrt(weightSum);
      const f0Bonus = hasFundamental ? 1.0 : 0.72;
      return baseScore * f0Bonus;
    };

    const subtractHarmonics = (midi) => {
      const f0 = midiToHz(midi, a4);
      const B = midi < 48 ? 0.00015 : (midi < 72 ? 0.00035 : 0.0010);

      // Estimate the note's fundamental reference amplitude A1 from H1 (or H2 if bass weak f0).
      const h1 = peakNear(f0, 1);
      const h2 = peakNear(2 * f0, 1);
      const refA1 = h1.amp > binFloor ? h1.amp : h2.amp * 1.4;
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

        // Envelope-bounded subtraction: only subtract this note's expected harmonic share
        // so a real simultaneously-played octave (C3+C4) or fifth (C4+G4) retains its energy!
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

      // Suppress weak octave/12th residual ghosts of already-picked lower notes,
      // while allowing genuine played octaves/fifths whose post-subtraction residual is strong.
      const isOvertoneOfPicked = pickedSet.has(bestMidi - 12) || pickedSet.has(bestMidi - 19);
      if (isOvertoneOfPicked && bestScore < topSalience * 0.36) {
        subtractHarmonics(bestMidi);
        continue;
      }

      // Suppress semitone skirt leakage adjacent to a much stronger picked note.
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

    // Sort by MIDI pitch ascending for clean display & chord consistency.
    detected.sort((a, b) => a.midiNote - b.midiNote);
    return detected;
  }
}

/**
 * Polyphonic per-key NoteOn / NoteOff state tracker.
 * Tracks each MIDI pitch independently so sustained bass notes can overlap with moving treble melodies.
 */
export class PolyphonicNoteTracker {
  constructor() {
    this.reset();
  }

  reset() {
    // midi -> { active, stableCount, absentCount, lastFreq, lastConf }
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

    // 1. Update currently present notes
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

    // 2. Age out absent notes
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
