/**
 * Milestone 4 — Real-Time Tutor & Scoring Engine.
 *
 * Compares live microphone-detected piano notes against expected SongModel notes in real time.
 * Supports:
 *  - Configurable timing tolerance (default +/- 180 ms)
 *  - Calibrated microphone/DSP latency compensation (default 65 ms)
 *  - Flow Mode (continuous playback with real-time grading)
 *  - Wait-Until-Correct Mode (pauses at strike line until user plays expected key)
 *  - Per-note states (upcoming, active, correct, missed), extra-note tracking, streak & results summary.
 */
export class TutorEngine {
  constructor(notes, options = {}) {
    this.notes = notes;
    this.timingToleranceSec = (options.timingToleranceMs ?? 180) / 1000;
    this.latencyOffsetSec = (options.latencyMs ?? 65) / 1000;
    this.waitMode = options.waitMode ?? false;
    this.reset();
  }

  reset() {
    this.noteStates = new Array(this.notes.length).fill('upcoming');
    this.timingErrorsMs = [];
    this.correctCount = 0;
    this.missedCount = 0;
    this.extraCount = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.waitingForIndex = -1;
    this.waitingChordIndices = [];
    this.lastFeedback = null; // { label, color, timingMs, midi, atWallMs }
  }

  updateConfig({ timingToleranceMs, latencyMs, waitMode }) {
    if (timingToleranceMs !== undefined) this.timingToleranceSec = timingToleranceMs / 1000;
    if (latencyMs !== undefined) this.latencyOffsetSec = latencyMs / 1000;
    if (waitMode !== undefined) {
      this.waitMode = waitMode;
      if (!waitMode) {
        this.waitingForIndex = -1;
        this.waitingChordIndices = [];
      }
    }
  }

  /**
   * Advance tutor state to [songTimeSec].
   * In Wait-Until-Correct mode, holds until ALL simultaneous chord notes at the strike line are played.
   */
  tick(songTimeSec, tempoScale = 1.0) {
    const tol = this.timingToleranceSec / Math.max(0.25, tempoScale);

    if (this.waitMode) {
      // Find earliest ungraded note whose startSec has reached the strike line,
      // and collect any simultaneous chord notes starting within 35 ms of it.
      const pending = [];
      let anchorStart = null;
      for (let i = 0; i < this.notes.length; i++) {
        if (this.noteStates[i] !== 'upcoming' && this.noteStates[i] !== 'active') continue;
        const n = this.notes[i];
        if (anchorStart === null) {
          if (songTimeSec >= n.startSec) {
            anchorStart = n.startSec;
            this.noteStates[i] = 'active';
            pending.push(i);
          } else {
            break;
          }
        } else if (n.startSec - anchorStart <= 0.035) {
          this.noteStates[i] = 'active';
          pending.push(i);
        } else {
          break;
        }
      }

      if (pending.length > 0) {
        this.waitingChordIndices = pending;
        this.waitingForIndex = pending[0];
        return {
          shouldHold: true,
          holdTimeSec: anchorStart,
          waitingMidi: this.notes[pending[0]].midiPitch,
          waitingMidis: pending.map((idx) => this.notes[idx].midiPitch),
        };
      }
      this.waitingForIndex = -1;
      this.waitingChordIndices = [];
      return { shouldHold: false };
    }

    // Flow Mode: mark notes active inside strike window, or missed once past startSec + tol.
    for (let i = 0; i < this.notes.length; i++) {
      const state = this.noteStates[i];
      if (state === 'correct' || state === 'missed') continue;
      const n = this.notes[i];
      if (songTimeSec > n.startSec + tol) {
        this.noteStates[i] = 'missed';
        this.missedCount++;
        this.streak = 0;
        this.lastFeedback = { label: 'MISSED', type: 'missed', midi: n.midiPitch, timingMs: null };
      } else if (songTimeSec >= n.startSec - tol) {
        this.noteStates[i] = 'active';
      }
    }
    return { shouldHold: false };
  }

  /**
   * Process a live microphone NoteOn event at the current [songTimeSec].
   * Returns feedback object for immediate UI rendering.
   */
  onDetectedNote(midiNote, songTimeSec, tempoScale = 1.0) {
    // Compensate for microphone + DSP frame latency.
    const compensatedSongTime = songTimeSec - this.latencyOffsetSec * tempoScale;
    const tol = this.timingToleranceSec / Math.max(0.25, tempoScale);

    if (this.waitMode && this.waitingChordIndices.length > 0) {
      const matchPos = this.waitingChordIndices.findIndex(
        (idx) => this.noteStates[idx] !== 'correct' && this.notes[idx].midiPitch === midiNote,
      );
      if (matchPos !== -1) {
        const idx = this.waitingChordIndices[matchPos];
        this.noteStates[idx] = 'correct';
        this.correctCount++;
        this.streak++;
        if (this.streak > this.bestStreak) this.bestStreak = this.streak;
        this.timingErrorsMs.push(0);
        this.waitingChordIndices.splice(matchPos, 1);
        this.waitingForIndex = this.waitingChordIndices.length > 0 ? this.waitingChordIndices[0] : -1;
        this.lastFeedback = { label: 'CORRECT', type: 'correct', midi: midiNote, timingMs: 0 };
        return this.lastFeedback;
      } else {
        this.extraCount++;
        this.streak = 0;
        this.lastFeedback = { label: 'WRONG KEY', type: 'wrong', midi: midiNote, timingMs: null };
        return this.lastFeedback;
      }
    }

    // Flow Mode: find closest unmatched expected note of the same pitch within +/- tol.
    let bestIdx = -1;
    let bestAbsErr = Infinity;
    let bestSignedErr = 0;

    for (let i = 0; i < this.notes.length; i++) {
      const state = this.noteStates[i];
      if (state === 'correct' || state === 'missed') continue;
      const n = this.notes[i];
      if (n.midiPitch !== midiNote) continue;
      const signedErr = compensatedSongTime - n.startSec;
      const absErr = Math.abs(signedErr);
      if (absErr <= tol && absErr < bestAbsErr) {
        bestAbsErr = absErr;
        bestSignedErr = signedErr;
        bestIdx = i;
      }
    }

    if (bestIdx !== -1) {
      this.noteStates[bestIdx] = 'correct';
      this.correctCount++;
      this.streak++;
      if (this.streak > this.bestStreak) this.bestStreak = this.streak;
      const errMs = Math.round((bestSignedErr / Math.max(0.25, tempoScale)) * 1000);
      this.timingErrorsMs.push(errMs);
      const label = Math.abs(errMs) <= 45 ? 'PERFECT' : (errMs < 0 ? `EARLY ${errMs}ms` : `LATE +${errMs}ms`);
      this.lastFeedback = { label, type: 'correct', midi: midiNote, timingMs: errMs };
      return this.lastFeedback;
    }

    // No matching expected note in window -> extra/wrong note.
    this.extraCount++;
    this.streak = 0;
    this.lastFeedback = { label: 'WRONG / EXTRA', type: 'wrong', midi: midiNote, timingMs: null };
    return this.lastFeedback;
  }

  getSummary() {
    const total = this.notes.length;
    const accuracy = total > 0 ? (this.correctCount / total) * 100 : 100;
    const meanAbsMs = this.timingErrorsMs.length > 0
      ? this.timingErrorsMs.reduce((a, b) => a + Math.abs(b), 0) / this.timingErrorsMs.length
      : 0;
    const meanSignedMs = this.timingErrorsMs.length > 0
      ? this.timingErrorsMs.reduce((a, b) => a + b, 0) / this.timingErrorsMs.length
      : 0;
    const precision = (this.correctCount + this.extraCount) > 0
      ? this.correctCount / (this.correctCount + this.extraCount)
      : 0;
    const recall = total > 0 ? this.correctCount / total : 0;
    const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    return {
      totalNotes: total,
      correctCount: this.correctCount,
      missedCount: this.missedCount,
      extraCount: this.extraCount,
      streak: this.streak,
      bestStreak: this.bestStreak,
      accuracyPct: accuracy,
      f1Score: f1,
      meanAbsTimingMs: meanAbsMs,
      meanSignedTimingMs: meanSignedMs,
    };
  }
}
