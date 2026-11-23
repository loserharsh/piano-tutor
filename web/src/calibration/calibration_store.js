import { midiToHz, midiToNoteName, midiRegister } from '../dsp/yin.js';

const PROFILES_KEY = 'pianotutor_calibration_profiles_v1';
const ACTIVE_PROFILE_KEY = 'pianotutor_active_calibration_id_v1';

export const KEYBOARD_RANGES = {
  61: { label: '61 Keys (C2–C7)', minMidi: 36, maxMidi: 96 },
  76: { label: '76 Keys (E1–G7)', minMidi: 28, maxMidi: 103 },
  88: { label: '88 Keys (A0–C8)', minMidi: 21, maxMidi: 108 },
};

/**
 * Generate the sequence of MIDI keys to calibrate for Quick or Full mode.
 * Quick mode selects reference anchor notes across low, middle, and high registers
 * (roughly every ~7–9 semitones, always including lowest, C's, A4, and highest).
 */
export function buildCalibrationKeyList(minMidi, maxMidi, mode = 'quick') {
  const lo = Math.max(21, Math.min(108, minMidi));
  const hi = Math.max(lo, Math.min(108, maxMidi));
  if (mode === 'full') {
    const all = [];
    for (let m = lo; m <= hi; m++) all.push(m);
    return all;
  }

  // Quick Calibration: distributed anchors across registers (A0/C1/C2/G2/C3/G3/C4/A4/C5/C6/C7/C8 etc.)
  const preferredAnchors = [21, 24, 28, 33, 36, 43, 48, 55, 60, 69, 72, 79, 84, 91, 96, 103, 108];
  const selected = new Set([lo, hi]);
  for (const m of preferredAnchors) {
    if (m >= lo && m <= hi) selected.add(m);
  }
  return Array.from(selected).sort((a, b) => a - b);
}

/**
 * Pure data/evidence layer for Piano Calibration Profiles.
 * Kept strictly separate from the core DSP engine; supplies optional instrument evidence
 * (tuning/stretch cents offset, calibrated harmonic profile, and room noise floor).
 */
export class CalibrationStore {
  constructor(storage = null) {
    this.storage = storage || (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null);
  }

  loadProfiles() {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(PROFILES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  saveProfiles(profiles) {
    if (!this.storage) return;
    try {
      this.storage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    } catch {
      // Ignore quota errors
    }
  }

  getActiveProfileId() {
    if (!this.storage) return null;
    return this.storage.getItem(ACTIVE_PROFILE_KEY) || null;
  }

  setActiveProfileId(id) {
    if (!this.storage) return;
    if (!id) this.storage.removeItem(ACTIVE_PROFILE_KEY);
    else this.storage.setItem(ACTIVE_PROFILE_KEY, id);
  }

  getActiveProfile() {
    const id = this.getActiveProfileId();
    if (!id) return null;
    return this.loadProfiles().find((p) => p.id === id) || null;
  }

  createProfile({
    name,
    pianoType = 'acoustic',
    audioInputType = 'builtin_mic',
    rangePreset = '88',
    minMidi = 21,
    maxMidi = 108,
    mode = 'quick',
    noiseFloorDb = -65,
    latencyMs = 65,
  }) {
    const now = new Date().toISOString();
    const profile = {
      id: `cal_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      name: name || `${pianoType === 'acoustic' ? 'Acoustic Piano' : 'Electronic Keyboard'} (${rangePreset} keys)`,
      pianoType,
      audioInputType,
      rangePreset: String(rangePreset),
      minMidi,
      maxMidi,
      mode,
      noiseFloorDb,
      latencyMs,
      createdAt: now,
      updatedAt: now,
      keys: {}, // midi (string) -> KeyCalibrationRecord
    };
    const all = this.loadProfiles();
    all.unshift(profile);
    this.saveProfiles(all);
    this.setActiveProfileId(profile.id);
    return profile;
  }

  upsertProfile(profile) {
    profile.updatedAt = new Date().toISOString();
    const all = this.loadProfiles();
    const idx = all.findIndex((p) => p.id === profile.id);
    if (idx >= 0) all[idx] = profile;
    else all.unshift(profile);
    this.saveProfiles(all);
    return profile;
  }

  deleteProfile(id) {
    const all = this.loadProfiles().filter((p) => p.id !== id);
    this.saveProfiles(all);
    if (this.getActiveProfileId() === id) {
      this.setActiveProfileId(all.length > 0 ? all[0].id : null);
    }
    return all;
  }

  /**
   * Compute quality report across Low (A0–B2), Middle (C3–B5), and High (C6–C8) registers.
   */
  static computeQualityReport(profile) {
    if (!profile) {
      return {
        totalKeysInRange: 0,
        calibratedCount: 0,
        retryCount: 0,
        averageConfidence: 0,
        meanCentsOffset: 0,
        registers: {
          low: { total: 0, accurate: 0, pct: null },
          mid: { total: 0, accurate: 0, pct: null },
          high: { total: 0, accurate: 0, pct: null },
        },
      };
    }

    const totalKeysInRange = Math.max(1, profile.maxMidi - profile.minMidi + 1);
    const records = Object.values(profile.keys || {});
    let calibratedCount = 0;
    let retryCount = 0;
    let confSum = 0;
    let centsSum = 0;
    let centsCount = 0;

    const regs = {
      low: { total: 0, accurate: 0, pct: null },
      mid: { total: 0, accurate: 0, pct: null },
      high: { total: 0, accurate: 0, pct: null },
    };

    for (const r of records) {
      const regKey = r.expectedMidi < 48 ? 'low' : (r.expectedMidi < 84 ? 'mid' : 'high');
      regs[regKey].total++;

      if (r.status === 'calibrated') {
        calibratedCount++;
        confSum += r.confidence || 0;
        if (typeof r.centsDeviation === 'number' && Number.isFinite(r.centsDeviation)) {
          centsSum += r.centsDeviation;
          centsCount++;
        }
        if (!r.octaveErrorDetected && r.detectedMidi === r.expectedMidi) {
          regs[regKey].accurate++;
        }
      } else if (r.status === 'retry') {
        retryCount++;
      }
    }

    for (const k of ['low', 'mid', 'high']) {
      regs[k].pct = regs[k].total > 0 ? Math.round((regs[k].accurate / regs[k].total) * 100) : null;
    }

    return {
      totalKeysInRange,
      calibratedCount,
      retryCount,
      averageConfidence: calibratedCount > 0 ? (confSum / calibratedCount) * 100 : 0,
      meanCentsOffset: centsCount > 0 ? centsSum / centsCount : 0,
      registers: regs,
    };
  }

  /**
   * Cautious evidence lookup for the pitch estimator.
   * Does NOT memorize/classify sounds directly; instead provides:
   *  - expectedCentsOffset: local tuning/stretch offset of this instrument (clamped to +/- 45 cents)
   *  - harmonicProfile: calibrated [H1..H6] relative amplitudes (direct or cautiously interpolated <= 14 semitones)
   *  - weakFundamentalExpected: true if this instrument's calibrated bass H1/H2 ratio is low
   */
  static getEvidenceForMidi(profile, midi) {
    if (!profile || !profile.keys) return null;

    const direct = profile.keys[String(midi)];
    if (direct && direct.status === 'calibrated' && direct.measuredHz > 0) {
      const h = direct.harmonicProfile || [];
      const h1 = h[0] || 0;
      const h2 = h[1] || 0;
      return {
        source: 'direct',
        expectedCentsOffset: Math.max(-45, Math.min(45, direct.centsDeviation || 0)),
        harmonicProfile: h,
        weakFundamentalExpected: h2 > 0.01 && (h1 / h2) < 0.35,
      };
    }

    // Cautious piecewise linear interpolation between nearest calibrated lower & upper anchors
    // (only if both anchors exist within <= 14 semitones so we never extrapolate blindly).
    let loRec = null;
    let hiRec = null;
    for (const r of Object.values(profile.keys)) {
      if (r.status !== 'calibrated' || !r.measuredHz) continue;
      if (r.expectedMidi < midi && (!loRec || r.expectedMidi > loRec.expectedMidi)) loRec = r;
      if (r.expectedMidi > midi && (!hiRec || r.expectedMidi < hiRec.expectedMidi)) hiRec = r;
    }

    if (loRec && hiRec && (hiRec.expectedMidi - loRec.expectedMidi) <= 14) {
      const t = (midi - loRec.expectedMidi) / (hiRec.expectedMidi - loRec.expectedMidi);
      const cents = (loRec.centsDeviation || 0) * (1 - t) + (hiRec.centsDeviation || 0) * t;
      const hLo = loRec.harmonicProfile || [];
      const hHi = hiRec.harmonicProfile || [];
      const len = Math.min(hLo.length, hHi.length);
      const harmonicProfile = [];
      for (let i = 0; i < len; i++) {
        harmonicProfile.push(hLo[i] * (1 - t) + hHi[i] * t);
      }
      const h1 = harmonicProfile[0] || 0;
      const h2 = harmonicProfile[1] || 0;
      return {
        source: 'interpolated',
        expectedCentsOffset: Math.max(-45, Math.min(45, cents)),
        harmonicProfile,
        weakFundamentalExpected: h2 > 0.01 && (h1 / h2) < 0.35,
      };
    }

    // Fallback: global mean cents offset if >= 3 keys calibrated (helps detuned uprights)
    const report = CalibrationStore.computeQualityReport(profile);
    if (report.calibratedCount >= 3) {
      return {
        source: 'global_mean',
        expectedCentsOffset: Math.max(-45, Math.min(45, report.meanCentsOffset)),
        harmonicProfile: [],
        weakFundamentalExpected: midi < 48,
      };
    }

    return null;
  }

  /**
   * Compute global effective A4 reference Hz from calibrated keys (only if >= 3 keys calibrated).
   */
  static computeCalibratedA4Hz(profile, baseA4 = 440.0) {
    const report = CalibrationStore.computeQualityReport(profile);
    if (report.calibratedCount < 3) return baseA4;
    const clampedCents = Math.max(-45, Math.min(45, report.meanCentsOffset));
    return baseA4 * Math.pow(2, clampedCents / 1200);
  }
}

export function buildKeyCalibrationRecord({
  expectedMidi,
  detectedMidi,
  measuredHz,
  harmonicProfile,
  confidence,
  noiseFloorDb,
  inputLevelDb,
  attackPeakDb,
  decayDbPerSec,
  status = 'calibrated',
}) {
  const nominalHz = midiToHz(expectedMidi, 440.0);
  const centsDeviation = measuredHz > 0 ? 1200 * Math.log2(measuredHz / nominalHz) : 0;
  const octaveErrorDetected =
    detectedMidi !== -1 &&
    detectedMidi !== expectedMidi &&
    Math.abs(detectedMidi - expectedMidi) % 12 === 0;

  return {
    expectedMidi,
    noteName: midiToNoteName(expectedMidi),
    register: midiRegister(expectedMidi),
    detectedMidi,
    measuredHz,
    centsDeviation: Math.round(centsDeviation * 10) / 10,
    harmonicProfile: harmonicProfile || [],
    confidence,
    noiseFloorDb,
    inputLevelDb,
    attackPeakDb,
    decayDbPerSec,
    octaveErrorDetected,
    status,
    timestamp: new Date().toISOString(),
  };
}
