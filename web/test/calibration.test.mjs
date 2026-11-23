import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CalibrationStore,
  KEYBOARD_RANGES,
  buildCalibrationKeyList,
  buildKeyCalibrationRecord,
} from '../src/calibration/calibration_store.js';
import { AudioPipeline } from '../src/dsp/audio_engine.js';
import { midiToHz } from '../src/dsp/yin.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/**
 * Synthesizes a realistic acoustic piano note with:
 *  - Configurable detuning in cents (e.g. -35 cents flat upright piano)
 *  - Weak/missing fundamental in the low register (f0 < 120 Hz)
 *  - Rich upper harmonics (H2..H7) + slight inharmonicity
 *  - Realistic attack transient + exponential decay + ambient room noise
 */
function synthDetunedPianoNote(midi, {
  sampleRate = 48000,
  durationSec = 0.85,
  detuneCents = -35,
  weakBassFundamental = true,
  noiseAmp = 0.002,
} = {}) {
  const n = Math.floor(sampleRate * durationSec);
  const out = new Float32Array(n);
  const f0 = midiToHz(midi, 440) * Math.pow(2, detuneCents / 1200);
  const isLow = midi < 48;
  const isHigh = midi >= 84;

  // Harmonic weights: bass notes on upright/small pianos have weak H1 and strong H2..H5
  const weights = isLow && weakBassFundamental
    ? [0.06, 1.0, 0.72, 0.55, 0.42, 0.28, 0.18]
    : isHigh
      ? [1.0, 0.35, 0.12]
      : [0.85, 0.70, 0.45, 0.30, 0.18, 0.10];

  const B = isLow ? 0.00018 : 0.00035; // Piano string stiffness inharmonicity

  let seed = (midi * 2654435761) >>> 0;
  const rand = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.008);
    const decay = Math.exp(-t * (isHigh ? 4.5 : 2.2));
    const env = attack * decay;

    let sample = 0;
    for (let k = 1; k <= weights.length; k++) {
      const fk = k * f0 * Math.sqrt(1 + B * k * k);
      if (fk >= sampleRate * 0.45) break;
      const hDecay = Math.exp(-t * (k - 1) * 0.7);
      sample += weights[k - 1] * hDecay * Math.sin(2 * Math.PI * fk * t);
    }
    out[i] = 0.32 * env * sample + noiseAmp * rand();
  }
  return out;
}

function measureNoteWithPipeline(pipeline, midi, synthOpts) {
  const buf = synthDetunedPianoNote(midi, synthOpts);
  const chunk = 1024;
  let lastSnap = null;
  const detectedMidis = [];
  const centsErrors = [];
  const harmonics = [];

  for (let i = 0; i + chunk <= buf.length; i += chunk) {
    pipeline.pushSamples(buf.subarray(i, i + chunk));
    const s = pipeline.latestSnapshot;
    // Skip attack transient (first ~150 ms)
    if (i > 7 * chunk && s.hasPitch && s.confidence >= 0.55) {
      lastSnap = s;
      detectedMidis.push(s.midiNote);
      centsErrors.push(s.centsOffset);
      if (s.harmonicProfile?.length) harmonics.push(s.harmonicProfile);
    }
  }

  // Feed silence to release note cleanly before next test note
  const silence = new Float32Array(chunk);
  for (let k = 0; k < 10; k++) pipeline.pushSamples(silence);

  if (detectedMidis.length === 0) {
    return { detectedMidi: -1, hz: 0, centsOffset: 999, confidence: 0, harmonicProfile: [] };
  }
  // Mode MIDI
  const counts = new Map();
  for (const m of detectedMidis) counts.set(m, (counts.get(m) || 0) + 1);
  let modeMidi = -1;
  let best = 0;
  for (const [m, c] of counts.entries()) {
    if (c > best) { best = c; modeMidi = m; }
  }
  const medCents = centsErrors.slice().sort((a, b) => a - b)[Math.floor(centsErrors.length / 2)];
  return {
    detectedMidi: modeMidi,
    hz: lastSnap.frequencyHz,
    centsOffset: medCents,
    confidence: lastSnap.confidence,
    harmonicProfile: harmonics[Math.floor(harmonics.length / 2)] || [],
  };
}

test('buildCalibrationKeyList supports Quick & Full modes across 61/76/88/custom ranges', () => {
  const quick88 = buildCalibrationKeyList(KEYBOARD_RANGES[88].minMidi, KEYBOARD_RANGES[88].maxMidi, 'quick');
  assert.ok(quick88.length >= 10 && quick88.length <= 20, `Quick 88 should have ~12-16 anchors, got ${quick88.length}`);
  assert.equal(quick88[0], 21);
  assert.equal(quick88[quick88.length - 1], 108);

  const full61 = buildCalibrationKeyList(KEYBOARD_RANGES[61].minMidi, KEYBOARD_RANGES[61].maxMidi, 'full');
  assert.equal(full61.length, 61);
  assert.equal(full61[0], 36);
  assert.equal(full61[60], 96);

  const full76 = buildCalibrationKeyList(KEYBOARD_RANGES[76].minMidi, KEYBOARD_RANGES[76].maxMidi, 'full');
  assert.equal(full76.length, 76);
});

test('CalibrationStore manages multiple profiles, cautious interpolation, and quality reports', () => {
  const store = new CalibrationStore(createMemoryStorage());

  const p1 = store.createProfile({
    name: 'Upright Piano',
    pianoType: 'acoustic',
    audioInputType: 'built-in-mic',
    rangePreset: '88',
    minMidi: 21,
    maxMidi: 108,
    mode: 'quick',
  });
  const p2 = store.createProfile({
    name: 'Stage Keyboard',
    pianoType: 'electronic',
    audioInputType: 'wired-interface',
    rangePreset: '61',
    minMidi: 36,
    maxMidi: 96,
    mode: 'full',
  });

  assert.equal(store.loadProfiles().length, 2);
  assert.equal(store.getActiveProfile().id, p2.id);

  store.setActiveProfileId(p1.id);
  assert.equal(store.getActiveProfile().id, p1.id);

  // Add two calibrated anchors on p1: C3 (-20¢) and C4 (-30¢)
  p1.keys['48'] = buildKeyCalibrationRecord({
    expectedMidi: 48,
    detectedMidi: 48,
    measuredHz: midiToHz(48) * Math.pow(2, -20 / 1200),
    harmonicProfile: [0.10, 1.0, 0.7, 0.5, 0.4, 0.2],
    confidence: 0.92,
    noiseFloorDb: -62,
    inputLevelDb: -18,
    status: 'calibrated',
  });
  p1.keys['60'] = buildKeyCalibrationRecord({
    expectedMidi: 60,
    detectedMidi: 60,
    measuredHz: midiToHz(60) * Math.pow(2, -30 / 1200),
    harmonicProfile: [0.85, 0.7, 0.4, 0.25, 0.15, 0.1],
    confidence: 0.96,
    noiseFloorDb: -62,
    inputLevelDb: -16,
    status: 'calibrated',
  });
  // Add one retry key
  p1.keys['24'] = buildKeyCalibrationRecord({
    expectedMidi: 24,
    detectedMidi: 36,
    measuredHz: midiToHz(36),
    harmonicProfile: [0.05, 1.0, 0.6, 0.4, 0.3, 0.2],
    confidence: 0.61,
    noiseFloorDb: -62,
    inputLevelDb: -22,
    status: 'retry',
  });
  store.upsertProfile(p1);

  // Direct evidence for C3 (48)
  const evDirect = CalibrationStore.getEvidenceForMidi(p1, 48);
  assert.equal(evDirect.source, 'direct');
  assert.equal(evDirect.weakFundamentalExpected, true);
  assert.ok(Math.abs(evDirect.expectedCentsOffset - (-20)) < 1);

  // Cautious interpolation halfway between C3 (48) and C4 (60) => F#3 (54) should be ~ -25 cents
  const evInterp = CalibrationStore.getEvidenceForMidi(p1, 54);
  assert.equal(evInterp.source, 'interpolated');
  assert.ok(Math.abs(evInterp.expectedCentsOffset - (-25)) < 1);

  // Far away key (C7 = 96) with only 2 calibrated keys should return null (no reckless extrapolation)
  assert.equal(CalibrationStore.getEvidenceForMidi(p1, 96), null);

  // Quality report
  const rep = CalibrationStore.computeQualityReport(p1);
  assert.equal(rep.calibratedCount, 2);
  assert.equal(rep.retryCount, 1);
  assert.equal(rep.registers.mid.pct, 100);
  assert.equal(rep.registers.low.accurate, 0);

  // Delete profile
  store.deleteProfile(p1.id);
  assert.equal(store.loadProfiles().length, 1);
  assert.equal(store.getActiveProfile().id, p2.id);
});

test('Piano Calibration improves recognition & tuning accuracy across Low, Middle, and High registers on a detuned piano', () => {
  const detuneCents = -38; // Noticeably flat acoustic upright (~430.4 Hz A4)
  const synthOpts = { sampleRate: 48000, detuneCents, weakBassFundamental: true, noiseAmp: 0.002 };

  const lowKeys = [24, 28, 31, 36, 40, 45];      // C1..A2
  const midKeys = [48, 53, 57, 60, 64, 69, 76, 81]; // C3..A5
  const highKeys = [84, 88, 91, 96, 100, 105];   // C6..A7

  // 1. Baseline: Uncalibrated AudioPipeline
  const uncalPipe = new AudioPipeline({ sampleRate: 48000, mode: 'monophonic', noiseGateDb: -55 });
  const evalRegister = (pipe, keys) => {
    let exact = 0;
    let absCentsSum = 0;
    for (const m of keys) {
      const r = measureNoteWithPipeline(pipe, m, synthOpts);
      if (r.detectedMidi === m) exact++;
      absCentsSum += Math.abs(r.centsOffset);
    }
    return {
      exact,
      total: keys.length,
      pct: Math.round((exact / keys.length) * 100),
      meanAbsCents: Math.round((absCentsSum / keys.length) * 10) / 10,
    };
  };

  const beforeLow = evalRegister(uncalPipe, lowKeys);
  const beforeMid = evalRegister(uncalPipe, midKeys);
  const beforeHigh = evalRegister(uncalPipe, highKeys);

  // 2. Quick Calibration on distributed anchor keys
  const store = new CalibrationStore(createMemoryStorage());
  const profile = store.createProfile({
    name: 'Flat Upright (-38c)',
    pianoType: 'acoustic',
    audioInputType: 'built-in-mic',
    rangePreset: '88',
    minMidi: 21,
    maxMidi: 108,
    mode: 'quick',
  });
  const anchors = buildCalibrationKeyList(21, 108, 'quick');
  for (const anchorMidi of anchors) {
    const r = measureNoteWithPipeline(uncalPipe, anchorMidi, synthOpts);
    if (r.detectedMidi === anchorMidi) {
      profile.keys[String(anchorMidi)] = buildKeyCalibrationRecord({
        expectedMidi: anchorMidi,
        detectedMidi: r.detectedMidi,
        measuredHz: r.hz,
        harmonicProfile: r.harmonicProfile,
        confidence: r.confidence,
        noiseFloorDb: -60,
        inputLevelDb: -18,
        status: 'calibrated',
      });
    }
  }
  store.upsertProfile(profile);

  // 3. Calibrated AudioPipeline using calibration evidence (not frequency memorization)
  const calPipe = new AudioPipeline({ sampleRate: 48000, mode: 'monophonic', noiseGateDb: -55 });
  calPipe.setCalibration({
    evidenceProvider: (m) => CalibrationStore.getEvidenceForMidi(profile, m),
    calibratedA4Hz: CalibrationStore.computeCalibratedA4Hz(profile, 440),
    noiseFloorDb: -60,
  });

  const afterLow = evalRegister(calPipe, lowKeys);
  const afterMid = evalRegister(calPipe, midKeys);
  const afterHigh = evalRegister(calPipe, highKeys);

  console.log('\n=== Piano Calibration Register Benchmark (-38 cents flat upright + weak bass f0) ===');
  console.log(`Low  (A0-B2): Uncalibrated ${beforeLow.pct}% (avg |¢|=${beforeLow.meanAbsCents}) -> Calibrated ${afterLow.pct}% (avg |¢|=${afterLow.meanAbsCents})`);
  console.log(`Mid  (C3-B5): Uncalibrated ${beforeMid.pct}% (avg |¢|=${beforeMid.meanAbsCents}) -> Calibrated ${afterMid.pct}% (avg |¢|=${afterMid.meanAbsCents})`);
  console.log(`High (C6-C8): Uncalibrated ${beforeHigh.pct}% (avg |¢|=${beforeHigh.meanAbsCents}) -> Calibrated ${afterHigh.pct}% (avg |¢|=${afterHigh.meanAbsCents})`);

  assert.equal(afterLow.pct, 100, 'Calibrated Low register accuracy should be 100%');
  assert.equal(afterMid.pct, 100, 'Calibrated Middle register accuracy should be 100%');
  assert.equal(afterHigh.pct, 100, 'Calibrated High register accuracy should be 100%');

  // Verify tuning offset error dropped dramatically (< 8 cents vs ~38 cents uncalibrated)
  assert.ok(afterLow.meanAbsCents < 10, `Expected low meanAbsCents < 10, got ${afterLow.meanAbsCents}`);
  assert.ok(afterMid.meanAbsCents < 8, `Expected mid meanAbsCents < 8, got ${afterMid.meanAbsCents}`);
  assert.ok(afterHigh.meanAbsCents < 8, `Expected high meanAbsCents < 8, got ${afterHigh.meanAbsCents}`);
});
