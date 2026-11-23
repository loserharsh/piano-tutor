import { midiToHz, midiToNoteName } from '../dsp/yin.js';
import {
  CalibrationStore,
  KEYBOARD_RANGES,
  buildCalibrationKeyList,
  buildKeyCalibrationRecord,
} from './calibration_store.js';
import { renderPianoKeyboard } from '../ui/piano_keyboard.js';
import { computePianoLayout } from '../ui/piano_layout.js';

/**
 * Interactive "Calibrate Your Piano" Wizard Controller.
 *
 * Manages:
 *  - Multi-keyboard profile switching / creation / deletion
 *  - Setup steps (Piano Type, Audio Input, Keyboard Range, Quick/Full Mode)
 *  - Individual key capture (press-and-hold audio aggregation, median f0, harmonic profile,
 *    attack peak & decay rate, octave-error warning, separate Expected vs Detected panels)
 *  - Manual confirmation / retry / skip (never assumes or fakes calibration)
 *  - Visual calibration keyboard (click any key to recalibrate that key)
 *  - Calibration quality report (Low / Mid / High register accuracy, avg confidence, retry count)
 */
export class PianoCalibrationWizard {
  constructor({ store, onProfileChanged, ensureMicRunning }) {
    this.store = store;
    this.onProfileChanged = onProfileChanged;
    this.ensureMicRunning = ensureMicRunning;

    this.activeProfile = this.store.getActiveProfile();
    this.queue = [];
    this.queueIndex = 0;
    this.isCapturing = false;
    this.capturedFrames = [];
    this.pendingResult = null;
    this.captureStartMs = 0;
  }

  $ (id) { return document.getElementById(id); }

  init() {
    this._wireEvents();
    this._renderProfileSelector();
    this._renderQualityReport();
    this._renderKeyboard();
  }

  _wireEvents() {
    this.$('selCalProfile').addEventListener('change', (e) => {
      const id = e.target.value;
      this.store.setActiveProfileId(id || null);
      this.activeProfile = this.store.getActiveProfile();
      this.queue = [];
      this.pendingResult = null;
      this.isCapturing = false;
      this._renderQualityReport();
      this._renderKeyboard();
      this._renderActiveKeyCard();
      this.onProfileChanged?.(this.activeProfile);
    });

    this.$('btnCalDeleteProfile').addEventListener('click', () => {
      if (!this.activeProfile) return;
      this.store.deleteProfile(this.activeProfile.id);
      this.activeProfile = this.store.getActiveProfile();
      this.queue = [];
      this.pendingResult = null;
      this.isCapturing = false;
      this._renderProfileSelector();
      this._renderQualityReport();
      this._renderKeyboard();
      this._renderActiveKeyCard();
      this.onProfileChanged?.(this.activeProfile);
    });

    this.$('selCalRange').addEventListener('change', (e) => {
      const isCustom = e.target.value === 'custom';
      this.$('calCustomRangeRow').classList.toggle('hidden', !isCustom);
    });

    this.$('btnCalBegin').addEventListener('click', async () => {
      const ok = await this.ensureMicRunning?.();
      if (!ok) return;

      const pianoType = this.$('selCalPianoType').value;
      const audioInputType = this.$('selCalAudioInput').value;
      const rangeVal = this.$('selCalRange').value;
      const mode = this.$('selCalMode').value;
      const customName = this.$('inpCalProfileName').value.trim();

      let minMidi = 21;
      let maxMidi = 108;
      if (rangeVal === 'custom') {
        minMidi = Math.max(21, Math.min(108, Number(this.$('inpCalMinMidi').value) || 36));
        maxMidi = Math.max(minMidi, Math.min(108, Number(this.$('inpCalMaxMidi').value) || 96));
      } else {
        const preset = KEYBOARD_RANGES[rangeVal] || KEYBOARD_RANGES[88];
        minMidi = preset.minMidi;
        maxMidi = preset.maxMidi;
      }

      this.activeProfile = this.store.createProfile({
        name: customName || undefined,
        pianoType,
        audioInputType,
        rangePreset: rangeVal,
        minMidi,
        maxMidi,
        mode,
      });

      this.queue = buildCalibrationKeyList(minMidi, maxMidi, mode);
      this.queueIndex = 0;
      this.pendingResult = null;
      this._renderProfileSelector();
      this._startKeyCapture(this.queue[0]);
      this.onProfileChanged?.(this.activeProfile);
    });

    this.$('btnCalRecalAll').addEventListener('click', async () => {
      if (!this.activeProfile) return;
      const ok = await this.ensureMicRunning?.();
      if (!ok) return;
      this.activeProfile.keys = {};
      this.store.upsertProfile(this.activeProfile);
      this.queue = buildCalibrationKeyList(
        this.activeProfile.minMidi,
        this.activeProfile.maxMidi,
        this.activeProfile.mode || 'quick',
      );
      this.queueIndex = 0;
      this.pendingResult = null;
      this._startKeyCapture(this.queue[0]);
      this._renderQualityReport();
      this.onProfileChanged?.(this.activeProfile);
    });

    this.$('btnCalConfirm').addEventListener('click', () => this._confirmCurrentKey('calibrated'));
    this.$('btnCalMarkRetry').addEventListener('click', () => this._confirmCurrentKey('retry'));
    this.$('btnCalRetryKey').addEventListener('click', () => {
      if (this.queue.length > 0 && this.queueIndex < this.queue.length) {
        this._startKeyCapture(this.queue[this.queueIndex]);
      }
    });
    this.$('btnCalSkipKey').addEventListener('click', () => this._advanceQueue());

    // Click any key on the visual calibration keyboard to recalibrate that individual key
    this.$('calKeyboardCanvas').addEventListener('click', async (e) => {
      if (!this.activeProfile) return;
      const canvas = this.$('calKeyboardCanvas');
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const layout = computePianoLayout(this.activeProfile.minMidi, this.activeProfile.maxMidi, rect.width);

      let clickedMidi = null;
      if (y <= rect.height * 0.62) {
        for (const bk of layout.blackKeys) {
          if (x >= bk.left && x <= bk.left + bk.width) { clickedMidi = bk.midi; break; }
        }
      }
      if (clickedMidi === null) {
        for (const wk of layout.whiteKeys) {
          if (x >= wk.left && x <= wk.left + wk.width) { clickedMidi = wk.midi; break; }
        }
      }
      if (clickedMidi !== null) {
        const ok = await this.ensureMicRunning?.();
        if (!ok) return;
        this.queue = [clickedMidi];
        this.queueIndex = 0;
        this._startKeyCapture(clickedMidi);
      }
    });
  }

  _startKeyCapture(midi) {
    this.isCapturing = true;
    this.capturedFrames = [];
    this.pendingResult = null;
    this.captureStartMs = performance.now();
    this._renderActiveKeyCard();
    this._renderKeyboard();
  }

  /**
   * Called on live AudioPipeline snapshots while the user is on the Calibrate screen.
   */
  onAudioSnapshot(snap) {
    if (!this.isCapturing || !this.activeProfile || this.queueIndex >= this.queue.length) return;

    // Collect voiced frames above noise gate; wait until we have >= 14 stable frames (~300–600 ms hold)
    if (snap.hasPitch && snap.confidence >= 0.55) {
      this.capturedFrames.push({
        midi: snap.midiNote,
        hz: snap.frequencyHz,
        confidence: snap.confidence,
        rmsDb: snap.rmsDb,
        noiseFloorDb: snap.noiseFloorDb,
        harmonicProfile: snap.harmonicProfile || [],
        timeMs: performance.now(),
      });

      const progressPct = Math.min(100, Math.round((this.capturedFrames.length / 16) * 100));
      this.$('calHoldBar').style.width = `${progressPct}%`;
      this.$('calLiveDetected').textContent = `${midiToNoteName(snap.midiNote)} (${snap.frequencyHz.toFixed(2)} Hz · ${Math.round(snap.confidence * 100)}%)`;

      if (this.capturedFrames.length >= 16) {
        this._finalizeKeyCapture();
      }
    }
  }

  _finalizeKeyCapture() {
    this.isCapturing = false;
    const expectedMidi = this.queue[this.queueIndex];
    const frames = this.capturedFrames;

    // Median measured frequency across captured hold frames
    const sortedHz = frames.map((f) => f.hz).sort((a, b) => a - b);
    const measuredHz = sortedHz[Math.floor(sortedHz.length / 2)];

    // Mode detected MIDI
    const counts = new Map();
    for (const f of frames) counts.set(f.midi, (counts.get(f.midi) || 0) + 1);
    let detectedMidi = -1;
    let bestC = 0;
    for (const [m, c] of counts.entries()) {
      if (c > bestC) { bestC = c; detectedMidi = m; }
    }

    const avgConf = frames.reduce((a, f) => a + f.confidence, 0) / frames.length;
    const avgFloor = frames.reduce((a, f) => a + f.noiseFloorDb, 0) / frames.length;
    const avgRms = frames.reduce((a, f) => a + f.rmsDb, 0) / frames.length;
    const attackPeakDb = Math.max(...frames.map((f) => f.rmsDb));
    const dtSec = Math.max(0.05, (frames[frames.length - 1].timeMs - frames[0].timeMs) / 1000);
    const decayDbPerSec = Math.round(((attackPeakDb - frames[frames.length - 1].rmsDb) / dtSec) * 10) / 10;

    // Average normalized harmonic profile [H1..H6]
    const hLen = 6;
    const avgHarm = new Array(hLen).fill(0);
    let hCount = 0;
    for (const f of frames) {
      if (f.harmonicProfile && f.harmonicProfile.length >= hLen) {
        for (let i = 0; i < hLen; i++) avgHarm[i] += f.harmonicProfile[i];
        hCount++;
      }
    }
    const harmonicProfile = hCount > 0
      ? avgHarm.map((v) => Math.round((v / hCount) * 1000) / 1000)
      : [];

    this.pendingResult = buildKeyCalibrationRecord({
      expectedMidi,
      detectedMidi,
      measuredHz,
      harmonicProfile,
      confidence: avgConf,
      noiseFloorDb: avgFloor,
      inputLevelDb: avgRms,
      attackPeakDb,
      decayDbPerSec,
      status: 'calibrated',
    });

    this._renderActiveKeyCard();
  }

  _confirmCurrentKey(status) {
    if (!this.activeProfile || !this.pendingResult) return;
    this.pendingResult.status = status;
    this.activeProfile.keys[String(this.pendingResult.expectedMidi)] = this.pendingResult;
    this.activeProfile.noiseFloorDb = this.pendingResult.noiseFloorDb;
    this.store.upsertProfile(this.activeProfile);

    this.onProfileChanged?.(this.activeProfile);
    this._renderQualityReport();
    this._advanceQueue();
  }

  _advanceQueue() {
    this.pendingResult = null;
    this.queueIndex++;
    if (this.queueIndex < this.queue.length) {
      this._startKeyCapture(this.queue[this.queueIndex]);
    } else {
      this.isCapturing = false;
      this._renderActiveKeyCard();
      this._renderKeyboard();
    }
  }

  _renderProfileSelector() {
    const sel = this.$('selCalProfile');
    const profiles = this.store.loadProfiles();
    sel.innerHTML = '<option value="">No Calibration Profile (Default)</option>';
    for (const p of profiles) {
      sel.add(new Option(`${p.name} [${p.mode}]`, p.id));
    }
    sel.value = this.activeProfile ? this.activeProfile.id : '';
    this.$('btnCalDeleteProfile').disabled = !this.activeProfile;
    this.$('btnCalRecalAll').disabled = !this.activeProfile;
  }

  _renderActiveKeyCard() {
    const box = this.$('calKeyWorkflowCard');
    if (!this.activeProfile || this.queue.length === 0) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');

    if (this.queueIndex >= this.queue.length) {
      this.$('calStepCounter').textContent = 'Calibration session complete! Click any key below to recalibrate individually.';
      this.$('calExpectedKey').textContent = 'DONE';
      this.$('calExpectedHz').textContent = '--';
      this.$('calLiveDetected').textContent = 'Review quality report below';
      this.$('calOctaveWarn').classList.add('hidden');
      this.$('btnCalConfirm').disabled = true;
      this.$('btnCalMarkRetry').disabled = true;
      this.$('btnCalRetryKey').disabled = true;
      this.$('btnCalSkipKey').disabled = true;
      return;
    }

    const targetMidi = this.queue[this.queueIndex];
    this.$('calStepCounter').textContent = `Key ${this.queueIndex + 1} of ${this.queue.length} · Press and hold briefly`;
    this.$('calExpectedKey').textContent = midiToNoteName(targetMidi);
    this.$('calExpectedHz').textContent = `${midiToHz(targetMidi).toFixed(2)} Hz (MIDI ${targetMidi})`;

    if (this.isCapturing) {
      this.$('calHoldBar').style.width = '0%';
      this.$('calLiveDetected').textContent = 'Listening... press & hold key on your piano';
      this.$('calHarmonicsText').textContent = 'Harmonics: --';
      this.$('calOctaveWarn').classList.add('hidden');
      this.$('btnCalConfirm').disabled = true;
      this.$('btnCalMarkRetry').disabled = true;
      this.$('btnCalRetryKey').disabled = false;
      this.$('btnCalSkipKey').disabled = false;
    } else if (this.pendingResult) {
      const r = this.pendingResult;
      this.$('calHoldBar').style.width = '100%';
      this.$('calLiveDetected').textContent =
        `${midiToNoteName(r.detectedMidi)} · ${r.measuredHz.toFixed(2)} Hz (${r.centsDeviation >= 0 ? '+' : ''}${r.centsDeviation}¢ · ${Math.round(r.confidence * 100)}%)`;
      const hStr = r.harmonicProfile.length
        ? r.harmonicProfile.map((v, i) => `H${i + 1}:${v.toFixed(2)}`).join('  ')
        : '--';
      this.$('calHarmonicsText').textContent = `Harmonic Profile: ${hStr} | Peak ${r.attackPeakDb.toFixed(1)} dB · Decay ${r.decayDbPerSec} dB/s`;

      const warnEl = this.$('calOctaveWarn');
      if (r.octaveErrorDetected) {
        warnEl.textContent = `OCTAVE ERROR DETECTED: Expected ${r.noteName}, detected ${midiToNoteName(r.detectedMidi)}. Retry or adjust mic placement before confirming.`;
        warnEl.classList.remove('hidden');
      } else if (r.detectedMidi !== r.expectedMidi) {
        warnEl.textContent = `PITCH MISMATCH: Expected ${r.noteName}, detected ${midiToNoteName(r.detectedMidi)}. Please verify you pressed the right key or Retry.`;
        warnEl.classList.remove('hidden');
      } else {
        warnEl.classList.add('hidden');
      }

      this.$('btnCalConfirm').disabled = false;
      this.$('btnCalMarkRetry').disabled = false;
      this.$('btnCalRetryKey').disabled = false;
      this.$('btnCalSkipKey').disabled = false;
    }
  }

  _renderQualityReport() {
    const rep = CalibrationStore.computeQualityReport(this.activeProfile);
    this.$('calRepCount').textContent = `${rep.calibratedCount} / ${rep.totalKeysInRange}`;
    this.$('calRepRetry').textContent = String(rep.retryCount);
    this.$('calRepConf').textContent = rep.calibratedCount > 0 ? `${rep.averageConfidence.toFixed(1)}%` : '--';
    this.$('calRepCents').textContent = rep.calibratedCount > 0
      ? `${rep.meanCentsOffset >= 0 ? '+' : ''}${rep.meanCentsOffset.toFixed(1)} ¢`
      : '--';
    this.$('calRepLow').textContent = rep.registers.low.pct !== null ? `${rep.registers.low.pct}% (${rep.registers.low.accurate}/${rep.registers.low.total})` : '--';
    this.$('calRepMid').textContent = rep.registers.mid.pct !== null ? `${rep.registers.mid.pct}% (${rep.registers.mid.accurate}/${rep.registers.mid.total})` : '--';
    this.$('calRepHigh').textContent = rep.registers.high.pct !== null ? `${rep.registers.high.pct}% (${rep.registers.high.accurate}/${rep.registers.high.total})` : '--';
  }

  _renderKeyboard() {
    const canvas = this.$('calKeyboardCanvas');
    if (!canvas) return;
    const minMidi = this.activeProfile ? this.activeProfile.minMidi : 21;
    const maxMidi = this.activeProfile ? this.activeProfile.maxMidi : 108;
    const keyStates = new Map();

    if (this.activeProfile && this.activeProfile.keys) {
      for (const r of Object.values(this.activeProfile.keys)) {
        if (r.status === 'calibrated') keyStates.set(r.expectedMidi, 'correct');
        else if (r.status === 'retry') keyStates.set(r.expectedMidi, 'expectedLeft');
      }
    }
    if (this.queue.length > 0 && this.queueIndex < this.queue.length) {
      keyStates.set(this.queue[this.queueIndex], 'expectedRight');
    }

    renderPianoKeyboard(canvas, { minMidi, maxMidi, keyStates });
  }
}
