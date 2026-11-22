import { FFT } from './fft.js';
import { BiquadFilter } from './biquad.js';
import { YinPitchEstimator, midiToNoteName } from './yin.js';
import { OnsetAndNoteTracker } from './onset_tracker.js';
import { PolyphonicPitchEstimator, PolyphonicNoteTracker } from './polyphonic_estimator.js';

/**
 * Pure-JS real-time AudioPipeline (usable in both Browser Web Audio API and Node.js tests).
 * Supports pluggable 'monophonic' (FFT-YIN) and 'polyphonic' (Iterative Harmonic Summation + Cancellation) modes.
 */
export class AudioPipeline {
  constructor(options = {}) {
    this.config = {
      mode: options.mode || 'polyphonic', // 'monophonic' | 'polyphonic'
      sampleRate: options.sampleRate || 48000,
      frameSize: options.frameSize || 4096,
      hopSize: options.hopSize || 512,
      yinThreshold: options.yinThreshold ?? 0.15,
      noiseGateDb: options.noiseGateDb ?? -50.0,
      minConfidence: options.minConfidence ?? 0.60,
      a4ReferenceHz: options.a4ReferenceHz ?? 440.0,
      onsetFluxThreshold: options.onsetFluxThreshold ?? 1.8,
      stableFramesRequired: options.stableFramesRequired ?? 2,
      releaseFramesRequired: options.releaseFramesRequired ?? 4,
    };

    this.fft = new FFT(this.config.frameSize);
    this.monoEstimator = new YinPitchEstimator(this.config.frameSize);
    this.polyEstimator = new PolyphonicPitchEstimator({ a4ReferenceHz: this.config.a4ReferenceHz });
    this.highpass = new BiquadFilter();
    this.lowpass = new BiquadFilter();
    this.highpass.configureHighpass(this.config.sampleRate, 25.0);
    this.lowpass.configureLowpass(this.config.sampleRate, 4500.0);
    this.monoTracker = new OnsetAndNoteTracker();
    this.polyTracker = new PolyphonicNoteTracker();

    this.rollingWindow = new Float32Array(this.config.frameSize);
    this.magSpec = new Float32Array((this.config.frameSize >> 1) + 1);
    this.spectrumBins = new Float32Array(64);
    this.pendingBuffer = new Float32Array(this.config.hopSize);
    this.pendingFill = 0;
    this.samplesAccumulated = 0;
    this.totalSamplesProcessed = 0;
    this.noiseFloorDb = -65.0;

    this.latestSnapshot = this._emptySnapshot();
    this.onNoteEvent = null;
    this.onSnapshot = null;

    // Polyphonic-capable melody/chord recording state (midi -> open note)
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
  }

  _emptySnapshot() {
    return {
      mode: this.config?.mode || 'polyphonic',
      hasPitch: false,
      frequencyHz: 0,
      midiNote: -1,
      noteName: '--',
      centsOffset: 0,
      confidence: 0,
      detectedNotes: [], // Array of { midiNote, noteName, frequencyHz, confidence }
      rmsDb: -100,
      noiseFloorDb: -65,
      spectralFlux: 0,
      isOnset: false,
      activeNoteMidi: -1,
      activeNotesMidi: [],
      timestampSec: 0,
      spectrumBins: new Float32Array(64),
    };
  }

  reset() {
    this.highpass.reset();
    this.lowpass.reset();
    this.monoTracker.reset();
    this.polyTracker.reset();
    this.rollingWindow.fill(0);
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
    const frameSize = this.config.frameSize;
    const filtered = new Float32Array(hopSamples);
    this.highpass.processBlock(filtered);
    this.lowpass.processBlock(filtered);

    this.rollingWindow.copyWithin(0, hop);
    this.rollingWindow.set(filtered, frameSize - hop);

    this.totalSamplesProcessed += hop;
    this.samplesAccumulated = Math.min(frameSize, this.samplesAccumulated + hop);
    if (this.samplesAccumulated >= frameSize) {
      this._processFrame();
    }
  }

  _processFrame() {
    const frameSize = this.config.frameSize;
    let sumSq = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = this.rollingWindow[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / frameSize);
    const rmsDb = rms > 1e-9 ? 20 * Math.log10(rms) : -100;

    if (rmsDb < this.noiseFloorDb + 6) {
      this.noiseFloorDb = 0.98 * this.noiseFloorDb + 0.02 * rmsDb;
    } else {
      this.noiseFloorDb = 0.999 * this.noiseFloorDb + 0.001 * rmsDb;
    }

    this.fft.realMagnitudeSpectrum(this.rollingWindow, this.magSpec, true);

    const effectiveGate = Math.max(this.config.noiseGateDb, this.noiseFloorDb + 6);
    const timestampSec = this.totalSamplesProcessed / this.config.sampleRate;

    let detectedNotes = [];
    let primary = null;
    let activeNotesMidi = [];
    let flux = 0;
    let isOnset = false;
    let events = [];

    if (this.config.mode === 'polyphonic') {
      if (rmsDb >= effectiveGate) {
        detectedNotes = this.polyEstimator.estimate(
          this.magSpec,
          this.config.sampleRate,
          frameSize,
          this.config,
        );
      }
      const res = this.polyTracker.process(detectedNotes, rmsDb, timestampSec, this.config);
      activeNotesMidi = res.activeMidis;
      events = res.events;
      if (detectedNotes.length > 0) {
        // Primary display note = highest-salience note
        primary = detectedNotes.reduce((a, b) => ((b.salience || 0) > (a.salience || 0) ? b : a), detectedNotes[0]);
      }
    } else {
      if (rmsDb >= effectiveGate) {
        primary = this.monoEstimator.estimate(
          this.rollingWindow,
          this.magSpec,
          this.config.sampleRate,
          this.config,
        );
      }
      if (primary) {
        detectedNotes = [{
          midiNote: primary.midiNote,
          noteName: midiToNoteName(primary.midiNote),
          frequencyHz: primary.frequencyHz,
          centsOffset: primary.centsOffset,
          confidence: primary.confidence,
        }];
      }
      const res = this.monoTracker.process(this.magSpec, primary, rmsDb, timestampSec, this.config);
      activeNotesMidi = res.activeMidi !== -1 ? [res.activeMidi] : [];
      flux = res.flux;
      isOnset = res.isOnset;
      events = res.events;
    }

    this._computeLogSpectrum();

    const chordLabel = detectedNotes.length > 0
      ? detectedNotes.map((n) => n.noteName).join(' + ')
      : '--';

    this.latestSnapshot = {
      mode: this.config.mode,
      hasPitch: primary !== null,
      frequencyHz: primary ? primary.frequencyHz : 0,
      midiNote: primary ? primary.midiNote : -1,
      noteName: chordLabel,
      centsOffset: primary ? (primary.centsOffset || 0) : 0,
      confidence: primary ? primary.confidence : 0,
      detectedNotes,
      rmsDb,
      noiseFloorDb: this.noiseFloorDb,
      spectralFlux: flux,
      isOnset,
      activeNoteMidi: activeNotesMidi.length > 0 ? activeNotesMidi[0] : -1,
      activeNotesMidi,
      timestampSec,
      spectrumBins: this.spectrumBins,
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

  _computeLogSpectrum() {
    const binHz = this.config.sampleRate / this.config.frameSize;
    const maxBin = this.magSpec.length - 1;
    const fMin = 27.5;
    const fMax = 4500.0;
    const logRatio = Math.log(fMax / fMin);

    for (let i = 0; i < 64; i++) {
      const f0 = fMin * Math.exp((logRatio * i) / 64);
      const f1 = fMin * Math.exp((logRatio * (i + 1)) / 64);
      const b0 = Math.max(1, Math.min(maxBin, Math.floor(f0 / binHz)));
      const b1 = Math.max(b0, Math.min(maxBin, Math.ceil(f1 / binHz)));
      let peak = 0;
      for (let b = b0; b <= b1; b++) if (this.magSpec[b] > peak) peak = this.magSpec[b];
      const db = peak > 1e-7 ? 20 * Math.log10(peak) : -140;
      this.spectrumBins[i] = Math.max(0, Math.min(1, (db + 75) / 65));
    }
  }
}

/**
 * Browser Web Audio API microphone capture manager (NO MIDI hardware).
 * Disables browser AEC/NS/AGC so natural piano harmonics remain intact.
 */
export class WebMicrophoneCapture {
  constructor() {
    this.audioCtx = null;
    this.stream = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.pipeline = null;
    this.isRunning = false;
  }

  async start(options = {}) {
    if (this.isRunning) return this.pipeline;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone API unavailable. Use localhost or HTTPS in a modern browser.');
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        throw new Error('Microphone permission denied. Please allow microphone access to listen to your piano.');
      }
      if (err.name === 'NotFoundError') {
        throw new Error('No microphone detected on this device.');
      }
      throw new Error(`Microphone error: ${err.message || err.name}`);
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioCtx({ latencyHint: 'interactive' });
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    this.pipeline = new AudioPipeline({
      mode: options.mode || 'polyphonic',
      sampleRate: this.audioCtx.sampleRate,
      frameSize: 4096,
      hopSize: 1024, // ~21 ms @ 48 kHz: low latency without saturating mobile main thread
      noiseGateDb: options.noiseGateDb ?? -50.0,
      a4ReferenceHz: options.a4ReferenceHz ?? 440.0,
    });
    this.pipeline.onNoteEvent = options.onNoteEvent || null;
    this.pipeline.onSnapshot = options.onSnapshot || null;

    this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
    this.processorNode = this.audioCtx.createScriptProcessor(2048, 1, 1);
    this.processorNode.onaudioprocess = (ev) => {
      if (!this.isRunning || !this.pipeline) return;
      const input = ev.inputBuffer.getChannelData(0);
      this.pipeline.pushSamples(input);
    };

    // Route through zero-gain node so mic audio never plays back through speakers (prevents feedback!).
    const muteGain = this.audioCtx.createGain();
    muteGain.gain.value = 0;

    this.sourceNode.connect(this.processorNode);
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
