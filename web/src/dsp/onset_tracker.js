import { PIANO_MIN_MIDI, PIANO_MAX_MIDI } from './yin.js';

/**
 * Spectral-flux + decay-trough onset and sustained-note tracker.
 * Prevents duplicate sustain triggers while accurately catching repeated same-key strikes.
 */
export class OnsetAndNoteTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.prevMag = null;
    this.fluxEma = 0;
    this.prevRmsDb = -100;
    this.minRmsSinceOnset = 0;
    this.framesSinceNoteOn = 0;
    this.reboundConfirmFrames = 0;
    this.onsetCooldownFrames = 0;
    this.activeMidi = -1;
    this.pendingMidi = -1;
    this.pendingCount = 0;
    this.silentCount = 0;
  }

  process(magSpec, candidate, rmsDb, timestampSec, config) {
    const events = [];
    let flux = 0;
    if (this.prevMag && this.prevMag.length === magSpec.length) {
      for (let i = 1; i < magSpec.length; i++) {
        const diff = magSpec[i] - this.prevMag[i];
        if (diff > 0) flux += diff;
      }
    }
    this.prevMag = new Float32Array(magSpec);

    if (this.onsetCooldownFrames > 0) this.onsetCooldownFrames--;

    const prevEma = this.fluxEma;
    this.fluxEma = this.fluxEma === 0 ? flux : (0.85 * this.fluxEma + 0.15 * flux);

    const rmsDeltaDb = rmsDb - this.prevRmsDb;
    this.prevRmsDb = rmsDb;

    const isOnset = rmsDb > config.noiseGateDb &&
      prevEma > 1e-4 &&
      flux > prevEma * config.onsetFluxThreshold &&
      flux > 0.04 &&
      rmsDeltaDb > 0.6;

    const vel = Math.max(0.05, Math.min(1.0, (rmsDb + 50) / 44));
    const hasValidPitch = candidate &&
      candidate.midiNote >= PIANO_MIN_MIDI &&
      candidate.midiNote <= PIANO_MAX_MIDI &&
      candidate.confidence >= config.minConfidence;

    if (!hasValidPitch) {
      this.pendingMidi = -1;
      this.pendingCount = 0;
      this.reboundConfirmFrames = 0;
      if (this.activeMidi !== -1) {
        this.silentCount++;
        if (this.silentCount >= config.releaseFramesRequired) {
          events.push({ type: 'noteOff', midiNote: this.activeMidi, timestampSec });
          this.activeMidi = -1;
          this.silentCount = 0;
          this.framesSinceNoteOn = 0;
        }
      }
      return { activeMidi: this.activeMidi, flux, isOnset, events };
    }

    this.silentCount = 0;

    if (candidate.midiNote === this.activeMidi) {
      this.pendingMidi = -1;
      this.pendingCount = 0;
      this.framesSinceNoteOn++;

      if (this.framesSinceNoteOn <= 10) {
        this.minRmsSinceOnset = rmsDb;
        this.reboundConfirmFrames = 0;
      } else {
        if (rmsDb < this.minRmsSinceOnset) {
          this.minRmsSinceOnset = rmsDb;
          this.reboundConfirmFrames = 0;
        }
        const aboveTrough = rmsDb >= this.minRmsSinceOnset + 2.5;
        if (this.onsetCooldownFrames === 0 && aboveTrough &&
            (this.reboundConfirmFrames > 0 || rmsDeltaDb > 0.5)) {
          this.reboundConfirmFrames++;
          if (this.reboundConfirmFrames >= 4) {
            events.push({ type: 'noteOff', midiNote: this.activeMidi, timestampSec });
            events.push({
              type: 'noteOn',
              midiNote: candidate.midiNote,
              frequencyHz: candidate.frequencyHz,
              confidence: candidate.confidence,
              velocityEst: vel,
              timestampSec,
            });
            this.onsetCooldownFrames = 14;
            this.framesSinceNoteOn = 0;
            this.reboundConfirmFrames = 0;
            this.minRmsSinceOnset = rmsDb;
          }
        } else {
          this.reboundConfirmFrames = 0;
        }
      }
      return { activeMidi: this.activeMidi, flux, isOnset, events };
    }

    this.reboundConfirmFrames = 0;
    if (candidate.midiNote === this.pendingMidi) {
      this.pendingCount++;
    } else {
      this.pendingMidi = candidate.midiNote;
      this.pendingCount = 1;
    }

    if (this.pendingCount >= config.stableFramesRequired) {
      if (this.activeMidi !== -1) {
        events.push({ type: 'noteOff', midiNote: this.activeMidi, timestampSec });
      }
      this.activeMidi = this.pendingMidi;
      this.pendingMidi = -1;
      this.pendingCount = 0;
      this.onsetCooldownFrames = 12;
      this.framesSinceNoteOn = 0;
      this.minRmsSinceOnset = rmsDb;

      events.push({
        type: 'noteOn',
        midiNote: this.activeMidi,
        frequencyHz: candidate.frequencyHz,
        confidence: candidate.confidence,
        velocityEst: vel,
        timestampSec,
      });
    }

    return { activeMidi: this.activeMidi, flux, isOnset, events };
  }
}
