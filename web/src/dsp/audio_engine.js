import { FFT } from './fft.js';
import { BiquadFilter } from './biquad.js';
import { YinPitchEstimator, midiToNoteName, midiRegister } from './yin.js';
import { OnsetAndNoteTracker } from './onset_tracker.js';
import { PolyphonicPitchEstimator, PolyphonicNoteTracker } from './polyphonic_estimator.js';

/**
 * Pure-JS real-time AudioPipeline with:
 *  - Gentle 18 Hz high-pass (preserves A0 = 27.5 Hz fundamental with 0 dB loss)
 *  - Adaptive dual-window analysis:
 *      • 4096-sample fast window (~85 ms @ 48 kHz) for mid & treble notes
 *      • 8192-sample long window (~170 ms @ 48 kHz) activated adaptively for low-frequency notes
 *  - Attack transient separation (spectral flux / high-freq broadband transient guard)
 *  - Low-latency 3-frame temporal pitch smoother (eliminates 1-frame octave glitches)
 *  - Full DSP debug telemetry (raw Hz, corrected fundamental Hz, octave candidates, latency ms)
 */
export class AudioPipeline {
  constructor(options = {}) {
    this.config = {
      mode: options.mode || 'monophonic', // 'monophonic' (Adaptive YIN) | 'polyphonic'
      sampleRate: options.sampleRate || 48000,
      frameSize: options.frameSize || 4096,
      longFrameSize: options.longFrameSize || 8192,
      hopSize: options.hopSize || 512,
      yinThreshold: options.yinThreshold ?? 0.15,
      noiseGateDb: options.noiseGateDb ?? -50.0,
      minConfidence: options.minConfidence ?? 0.60,
      a4ReferenceHz: options.a4ReferenceHz ?? 440.0,
      onsetFluxThreshold: options.onsetFluxThreshold ?? 1.8,
      stableFramesRequired: options.stableFramesRequired ?? 2,
      releaseFramesRequired: options.releaseFramesRequired ?? 4,
    };

    this.fftFast = new FFT(this.config.frameSize);
    this.fftLong = new FFT(this.config.longFrameSize);
    this.yinFast = new YinPitchEstimator(this.config.frameSize);
    this.yinLong = new YinPitchEstimator(this.config.longFrameSize);
    this.polyEstimator = new PolyphonicPitchEstimator({ a4ReferenceHz: this.config.a4ReferenceHz });

    // Gentle 18 Hz high-pass preserves piano A0 (27.5 Hz) while removing DC & sub-audible rumble.
    this.highpass = new BiquadFilter();
    this.lowpass = new BiquadFilter();
    this.highpass.configureHighpass(this.config.sampleRate, 18.0);
    this.lowpass.configureLowpass(this.config.sampleRate, 4600.0);

    this.monoTracker = new OnsetAndNoteTracker();
    this.polyTracker = new PolyphonicNoteTracker();

    // Maintain an 8192-sample rolling buffer; the most recent 4096 samples form the fast window.
    this.longWindow = new Float32Array(this.config.longFrameSize);
    this.magSpecFast = new Float32Array((this.config.frameSize >> 1) + 1);
    this.magSpecLong = new Float32Array((this.config.longFrameSize >> 1) + 1);
    this.prevMagFast = null;
    this.spectrumBins = new Float32Array(64);
    this.lowSpectrumBins = new Float32Array(64); // Linear 20..500 Hz zoom bins for bass inspection
    this.pendingBuffer = new Float32Array(this.config.hopSize);
    this.pendingFill = 0;
    this.samplesAccumulated = 0;
    this.totalSamplesProcessed = 0;
    this.noiseFloorDb = -65.0;

    // 3-frame low-latency temporal pitch smoother (eliminates isolated 1-frame octave glitches)
    this.recentMidiHistory = [];

    this.latestSnapshot = this._emptySnapshot();
    this.onNoteEvent = null;
    this.onSnapshot = null;

    this.isRecording = false;
    this.recordOriginSec = 0;
    this.activeRecNotes = new Map();
    this.recordedNotes = [];
  }

  setMode(mode) {
    if (mode !== 'monophonic' && mode !== 'polyphonic') return;
    this.config.mode = mode;
    this.monoTracker.reset();
    this.polyTracker.reset();
    this.recentMidiHistory = [];
  }

  _emptySnapshot() {
    return {
      mode: this.config?.mode || 'monophonic',
      status: 'Idle',
      hasPitch: false,
      rawFrequencyHz: 0,
      frequencyHz: 0,
      midiNote: -1,
      noteName: '--',
      register: '--',
      centsOffset: 0,
      confidence: 0,
      windowSizeUsed: this.config?.frameSize || 4096,
      octaveCorrection: 'none',
      isAttackTransient: false,
      octaveCandidates: [],
      spectrumPeaks: [],
      detectedNotes: [],
      rmsDb: -100,
      noiseFloorDb: -65,
      spectralFlux: 0,
      isOnset: false,
      activeNoteMidi: -1,
      activeNotesMidi: [],
      processingMs: 0,
      detectionLatencyMs: 0,
      timestampSec: 0,
      spectrumBins: new Float32Array(64),
      lowSpectrumBins: new Float32Array(64),
    };
  }

  reset() {
    this.highpass.reset();
    this.lowpass.reset();
    this.monoTracker.reset();
    this.polyTracker.reset();
    this.longWindow.fill(0);
    this.prevMagFast = null;
    this.recentMidiHistory = [];
    this.pendingFill = 0;
    this.samplesAccumulated = 0;
    this.totalSamplesProcessed = 0;
    this.noiseFloorDb = -65.0;
    this.latestSnapshot = this._emptySnapshot();
  }

  startRecording() {
    this.recordedNotes = [];
    this.activeRecNotes.clear();
    this.recordOriginSec = this.totalSamplesProcessed / this.config.sampleRate;
    this.isRecording = true;
  }

  stopRecording() {
    if (!this.isRecording) return this.recordedNotes;
    const nowSec = this.totalSamplesProcessed / this.config.sampleRate;
    for (const midi of Array.from(this.activeRecNotes.keys())) {
      this._finalizeRecNote(midi, nowSec);
    }
    this.recordedNotes.sort((a, b) => a.startSec - b.startSec || a.midiNote - b.midiNote);
    this.isRecording = false;
    return this.recordedNotes;
  }

  _finalizeRecNote(midi, endSec) {
    const open = this.activeRecNotes.get(midi);
    if (!open) return;
    const relEnd = Math.max(open.startSec, endSec - this.recordOriginSec);
    const dur = relEnd - open.startSec;
    if (dur >= 0.045) {
      this.recordedNotes.push({ ...open, endSec: relEnd, durationSec: dur });
    }
    this.activeRecNotes.delete(midi);
  }

  pushSamples(samples) {
    const hop = this.config.hopSize;
    let offset = 0;
    while (offset < samples.length) {
      const copyCount = Math.min(hop - this.pendingFill, samples.length - offset);
      this.pendingBuffer.set(samples.subarray(offset, offset + copyCount), this.pendingFill);
      this.pendingFill += copyCount;
      offset += copyCount;

      if (this.pendingFill === hop) {
        this._processHop(this.pendingBuffer);
        this.pendingFill = 0;
      }
    }
  }

  _processHop(hopSamples) {
    const hop = this.config.hopSize;
    const longSize = this.config.longFrameSize;
    const filtered = new Float32Array(hopSamples);
    this.highpass.processBlock(filtered);
    this.lowpass.processBlock(filtered);

    this.longWindow.copyWithin(0, hop);
    this.longWindow.set(filtered, longSize - hop);

    this.totalSamplesProcessed += hop;
    this.samplesAccumulated = Math.min(longSize, this.samplesAccumulated + hop);
    if (this.samplesAccumulated >= this.config.frameSize) {
      this._processFrame();
    }
  }

  _smoothPitchCandidate(candidate) {
    if (!candidate) {
      this.recentMidiHistory = [];
      return null;
    }
    this.recentMidiHistory.push(candidate.midiNote);
    if (this.recentMidiHistory.length > 3) this.recentMidiHistory.shift();

    // If we have 3 frames and the middle/older two agree on a pitch that differs from
    // an isolated 1-frame jump by an octave, smooth the glitch without adding latency.
    if (this.recentMidiHistory.length === 3) {
      const [a, b, c] = this.recentMidiHistory;
      if (a === b && c !== b && Math.abs(c - b) % 12 === 0 && candidate.confidence < 0.92) {
        return {
          ...candidate,
          midiNote: b,
          noteName: midiToNoteName(b),
          octaveCorrection: `${candidate.octaveCorrection} + smoothed`,
        };
      }
    }
    return candidate;
  }

  _processFrame() {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const fastSize = this.config.frameSize;
    const longSize = this.config.longFrameSize;
    const fastWindow = this.longWindow.subarray(longSize - fastSize);

    // 1. Frame RMS & adaptive noise floor
    let sumSq = 0;
    for (let i = 0; i < fastSize; i++) {
      const s = fastWindow[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / fastSize);
    const rmsDb = rms > 1e-9 ? 20 * Math.log10(rms) : -100;

    if (rmsDb < this.noiseFloorDb + 6) {
      this.noiseFloorDb = 0.98 * this.noiseFloorDb + 0.02 * rmsDb;
    } else {
      this.noiseFloorDb = 0.999 * this.noiseFloorDb + 0.001 * rmsDb;
    }

    // 2. Fast 4096-point FFT + Attack Transient & Low-Frequency Energy Detection
    this.fftFast.realMagnitudeSpectrum(fastWindow, this.magSpecFast, true);

    let fastFlux = 0;
    if (this.prevMagFast) {
      for (let b = 1; b < this.magSpecFast.length; b++) {
        const d = this.magSpecFast[b] - this.prevMagFast[b];
        if (d > 0) fastFlux += d;
      }
    }
    this.prevMagFast = new Float32Array(this.magSpecFast);

    const binHzFast = this.config.sampleRate / fastSize;
    const lowEndBin = Math.min(this.magSpecFast.length - 1, Math.ceil(340 / binHzFast));
    const midEndBin = Math.min(this.magSpecFast.length - 1, Math.ceil(2000 / binHzFast));
    let lowBandEnergy = 0;
    let totalBandEnergy = 0;
    let highBroadbandEnergy = 0;
    for (let b = 2; b < this.magSpecFast.length; b++) {
      const m = this.magSpecFast[b];
      totalBandEnergy += m;
      if (b <= lowEndBin) lowBandEnergy += m;
      if (b > midEndBin) highBroadbandEnergy += m;
    }
    const lowEnergyRatio = totalBandEnergy > 1e-6 ? lowBandEnergy / totalBandEnergy : 0;
    const isAttackTransient = fastFlux > 0.35 && totalBandEnergy > 1e-4 && (highBroadbandEnergy / totalBandEnergy) > 0.25;

    const effectiveGate = Math.max(this.config.noiseGateDb, this.noiseFloorDb + 6);
    const timestampSec = this.totalSamplesProcessed / this.config.sampleRate;
    const canUseLongWindow = this.samplesAccumulated >= longSize;

    // 3. Adaptive Window Selection & Pitch Estimation
    let detectedNotes = [];
    let primary = null;
    let activeNotesMidi = [];
    let flux = fastFlux;
    let isOnset = false;
    let events = [];
    let windowSizeUsed = fastSize;
    let rawFrequencyHz = 0;
    let octaveCorrection = 'none';
    let octaveCandidates = [];

    // Use stricter confidence gate during percussive hammer attack transient
    const frameConfig = isAttackTransient
      ? { ...this.config, minConfidence: Math.max(this.config.minConfidence, 0.72) }
      : this.config;

    if (this.config.mode === 'polyphonic') {
      if (rmsDb >= effectiveGate) {
        // Use 8192-point high-resolution FFT whenever available so low bass notes (A0..B2)
        // have 5.86 Hz/bin resolution instead of 11.7 Hz/bin.
        const useLong = canUseLongWindow && lowEnergyRatio > 0.12;
        if (useLong) {
          this.fftLong.realMagnitudeSpectrum(this.longWindow, this.magSpecLong, true);
          windowSizeUsed = longSize;
          detectedNotes = this.polyEstimator.estimate(this.magSpecLong, this.config.sampleRate, longSize, frameConfig);
          // Also run YIN on the long window to populate octave-alternative debug info
          const yinDebug = this.yinLong.estimate(this.longWindow, this.magSpecLong, this.config.sampleRate, frameConfig);
          if (yinDebug) {
            rawFrequencyHz = yinDebug.rawFrequencyHz;
            octaveCandidates = yinDebug.candidates;
            octaveCorrection = yinDebug.correction;
            // If only 1 note is active and YIN proved a missing-fundamental low bass note,
            // align single-note bass detection with YIN's octave-corrected fundamental!
            if (detectedNotes.length === 1 && yinDebug.midiNote < 48 &&
                Math.abs(detectedNotes[0].midiNote - yinDebug.midiNote) === 12) {
              detectedNotes[0] = {
                ...detectedNotes[0],
                midiNote: yinDebug.midiNote,
                noteName: yinDebug.noteName,
                frequencyHz: yinDebug.frequencyHz,
              };
            }
          }
        } else {
          detectedNotes = this.polyEstimator.estimate(this.magSpecFast, this.config.sampleRate, fastSize, frameConfig);
        }
      }
      const res = this.polyTracker.process(detectedNotes, rmsDb, timestampSec, this.config);
      activeNotesMidi = res.activeMidis;
      events = res.events;
      if (detectedNotes.length > 0) {
        primary = detectedNotes.reduce((a, b) => ((b.salience || 0) > (a.salience || 0) ? b : a), detectedNotes[0]);
        if (!rawFrequencyHz) rawFrequencyHz = primary.frequencyHz;
      }
    } else {
      // Adaptive Monophonic YIN:
      // Run fast 4096-sample YIN first; if low-frequency energy is prominent OR fast pitch < 280 Hz,
      // escalate to the 8192-sample long window for high-resolution bass harmonic disambiguation!
      if (rmsDb >= effectiveGate) {
        let est = this.yinFast.estimate(fastWindow, this.magSpecFast, this.config.sampleRate, frameConfig);
        const needsLongBassWindow = canUseLongWindow && (
          lowEnergyRatio > 0.22 ||
          (est && est.frequencyHz < 280) ||
          (!est && lowEnergyRatio > 0.15)
        );

        if (needsLongBassWindow) {
          this.fftLong.realMagnitudeSpectrum(this.longWindow, this.magSpecLong, true);
          const longEst = this.yinLong.estimate(this.longWindow, this.magSpecLong, this.config.sampleRate, frameConfig);
          if (longEst && (!est || longEst.frequencyHz < 300 || longEst.confidence >= est.confidence - 0.05)) {
            est = longEst;
            windowSizeUsed = longSize;
          }
        }

        primary = this._smoothPitchCandidate(est);
        if (primary) {
          rawFrequencyHz = primary.rawFrequencyHz;
          octaveCorrection = primary.correction;
          octaveCandidates = primary.candidates || [];
          detectedNotes = [{
            midiNote: primary.midiNote,
            noteName: primary.noteName,
            frequencyHz: primary.frequencyHz,
            centsOffset: primary.centsOffset,
            confidence: primary.confidence,
          }];
        }
      } else {
        this.recentMidiHistory = [];
      }

      const res = this.monoTracker.process(this.magSpecFast, primary, rmsDb, timestampSec, this.config);
      activeNotesMidi = res.activeMidi !== -1 ? [res.activeMidi] : [];
      flux = res.flux;
      isOnset = res.isOnset;
      events = res.events;
    }

    const activeMag = windowSizeUsed === longSize ? this.magSpecLong : this.magSpecFast;
    this._computeLogSpectrum(activeMag, windowSizeUsed);
    const spectrumPeaks = rmsDb >= effectiveGate
      ? this._extractSpectralPeaks(activeMag, windowSizeUsed, 6)
      : [];

    const processingMs = typeof performance !== 'undefined' ? (performance.now() - t0) : 0;
    const detectionLatencyMs = ((windowSizeUsed * 0.5 + this.config.hopSize) / this.config.sampleRate) * 1000 + processingMs;

    let status = 'Listening';
    if (rmsDb < effectiveGate) status = 'Below Noise Gate';
    else if (isAttackTransient) status = 'Attack Transient';
    else if (activeNotesMidi.length > 0) status = 'Confirmed Note';
    else if (primary) status = 'Estimating...';
    else status = 'Unvoiced / Low Confidence';

    const chordLabel = detectedNotes.length > 0
      ? detectedNotes.map((n) => n.noteName).join(' + ')
      : '--';

    this.latestSnapshot = {
      mode: this.config.mode,
      status,
      hasPitch: primary !== null,
      rawFrequencyHz,
      frequencyHz: primary ? primary.frequencyHz : 0,
      midiNote: primary ? primary.midiNote : -1,
      noteName: chordLabel,
      register: primary ? midiRegister(primary.midiNote) : '--',
      centsOffset: primary ? (primary.centsOffset || 0) : 0,
      confidence: primary ? primary.confidence : 0,
      windowSizeUsed,
      octaveCorrection,
      isAttackTransient,
      octaveCandidates,
      spectrumPeaks,
      detectedNotes,
      rmsDb,
      noiseFloorDb: this.noiseFloorDb,
      spectralFlux: flux,
      isOnset,
      activeNoteMidi: activeNotesMidi.length > 0 ? activeNotesMidi[0] : -1,
      activeNotesMidi,
      processingMs,
      detectionLatencyMs,
      timestampSec,
      spectrumBins: this.spectrumBins,
      lowSpectrumBins: this.lowSpectrumBins,
    };

    for (const evt of events) {
      if (this.isRecording) {
        if (evt.type === 'noteOff') {
          this._finalizeRecNote(evt.midiNote, evt.timestampSec);
        } else if (evt.type === 'noteOn') {
          if (this.activeRecNotes.has(evt.midiNote)) {
            this._finalizeRecNote(evt.midiNote, evt.timestampSec);
          }
          this.activeRecNotes.set(evt.midiNote, {
            midiNote: evt.midiNote,
            noteName: midiToNoteName(evt.midiNote),
            frequencyHz: evt.frequencyHz,
            startSec: Math.max(0, evt.timestampSec - this.recordOriginSec),
            confidence: evt.confidence,
            velocityEst: evt.velocityEst,
          });
        }
      }
      if (this.onNoteEvent) this.onNoteEvent(evt);
    }

    if (this.onSnapshot) this.onSnapshot(this.latestSnapshot);
  }

  _extractSpectralPeaks(magSpec, fftSize, maxPeaks = 6) {
    const binHz = this.config.sampleRate / fftSize;
    const minBin = Math.max(2, Math.floor(24 / binHz));
    const maxBin = Math.min(magSpec.length - 2, Math.ceil(4500 / binHz));

    let maxMag = 0;
    for (let b = minBin; b <= maxBin; b++) if (magSpec[b] > maxMag) maxMag = magSpec[b];
    if (maxMag < 1e-5) return [];

    const floor = maxMag * 0.08;
    const peaks = [];
    for (let b = minBin; b <= maxBin; b++) {
      const v = magSpec[b];
      if (v > floor && v > magSpec[b - 1] && v >= magSpec[b + 1]) {
        // Parabolic bin interpolation for accurate peak Hz
        const y0 = magSpec[b - 1];
        const y1 = v;
        const y2 = magSpec[b + 1];
        const denom = 2 * (y0 - 2 * y1 + y2);
        const delta = Math.abs(denom) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (y0 - y2) / denom)) : 0;
        const hz = (b + delta) * binHz;
        peaks.push({
          frequencyHz: hz,
          magnitude: v,
          magnitudeDb: 20 * Math.log10(Math.max(1e-7, v)),
        });
      }
    }
    peaks.sort((a, b) => b.magnitude - a.magnitude);
    return peaks.slice(0, maxPeaks).sort((a, b) => a.frequencyHz - b.frequencyHz);
  }

  _computeLogSpectrum(magSpec, fftSize) {
    const binHz = this.config.sampleRate / fftSize;
    const maxBin = magSpec.length - 1;
    const fMin = 27.5;
    const fMax = 4500.0;
    const logRatio = Math.log(fMax / fMin);

    for (let i = 0; i < 64; i++) {
      const f0 = fMin * Math.exp((logRatio * i) / 64);
      const f1 = fMin * Math.exp((logRatio * (i + 1)) / 64);
      const b0 = Math.max(1, Math.min(maxBin, Math.floor(f0 / binHz)));
      const b1 = Math.max(b0, Math.min(maxBin, Math.ceil(f1 / binHz)));
      let peak = 0;
      for (let b = b0; b <= b1; b++) if (magSpec[b] > peak) peak = magSpec[b];
      const db = peak > 1e-7 ? 20 * Math.log10(peak) : -140;
      this.spectrumBins[i] = Math.max(0, Math.min(1, (db + 75) / 65));
    }

    // Also compute linear 20..500 Hz zoom bins for low-frequency bass inspection
    const lowMin = 20.0;
    const lowMax = 500.0;
    const step = (lowMax - lowMin) / 64;
    for (let i = 0; i < 64; i++) {
      const f0 = lowMin + i * step;
      const f1 = f0 + step;
      const b0 = Math.max(1, Math.min(maxBin, Math.floor(f0 / binHz)));
      const b1 = Math.max(b0, Math.min(maxBin, Math.ceil(f1 / binHz)));
      let peak = 0;
      for (let b = b0; b <= b1; b++) if (magSpec[b] > peak) peak = magSpec[b];
      const db = peak > 1e-7 ? 20 * Math.log10(peak) : -140;
      this.lowSpectrumBins[i] = Math.max(0, Math.min(1, (db + 75) / 65));
    }
  }
}

/**
 * Browser Web Audio API microphone / wired audio interface capture manager (NO MIDI hardware).
 * Disables browser AEC/NS/AGC so natural piano fundamentals and harmonics remain intact.
 */
export class WebMicrophoneCapture {
  constructor() {
    this.audioCtx = null;
    this.stream = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.processorNode = null;
    this.pipeline = null;
    this.isRunning = false;
    this.inputGain = 1.0;
  }

  static async listInputDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, idx) => ({
        deviceId: d.deviceId,
        label: d.label || `Audio Input ${idx + 1}`,
      }));
  }

  setInputGain(gain) {
    this.inputGain = Math.max(0.2, Math.min(4.0, gain));
    if (this.gainNode && this.audioCtx) {
      this.gainNode.gain.setTargetAtTime(this.inputGain, this.audioCtx.currentTime, 0.015);
    }
  }

  async start(options = {}) {
    if (this.isRunning) return this.pipeline;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone API unavailable. Use localhost or HTTPS in a modern browser.');
    }

    const audioConstraints = {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    if (options.deviceId && options.deviceId !== 'default') {
      audioConstraints.deviceId = { exact: options.deviceId };
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        throw new Error('Microphone permission denied. Please allow microphone access to listen to your piano.');
      }
      if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
        throw new Error('Selected audio input device not found. Try System Default.');
      }
      throw new Error(`Audio input error: ${err.message || err.name}`);
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioCtx({ latencyHint: 'interactive' });
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    this.pipeline = new AudioPipeline({
      mode: options.mode || 'monophonic',
      sampleRate: this.audioCtx.sampleRate,
      frameSize: 4096,
      longFrameSize: 8192,
      hopSize: 1024,
      noiseGateDb: options.noiseGateDb ?? -50.0,
      minConfidence: options.minConfidence ?? 0.60,
      a4ReferenceHz: options.a4ReferenceHz ?? 440.0,
    });
    this.pipeline.onNoteEvent = options.onNoteEvent || null;
    this.pipeline.onSnapshot = options.onSnapshot || null;

    this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
    this.gainNode = this.audioCtx.createGain();
    this.inputGain = options.inputGain ?? this.inputGain;
    this.gainNode.gain.value = this.inputGain;

    this.processorNode = this.audioCtx.createScriptProcessor(2048, 1, 1);
    this.processorNode.onaudioprocess = (ev) => {
      if (!this.isRunning || !this.pipeline) return;
      const input = ev.inputBuffer.getChannelData(0);
      this.pipeline.pushSamples(input);
    };

    const muteGain = this.audioCtx.createGain();
    muteGain.gain.value = 0;

    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.processorNode);
    this.processorNode.connect(muteGain);
    muteGain.connect(this.audioCtx.destination);

    this.isRunning = true;
    return this.pipeline;
  }

  stop() {
    this.isRunning = false;
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}
