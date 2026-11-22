import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioPipeline } from '../src/dsp/audio_engine.js';
import { midiToHz, hzToMidi, midiToNoteName } from '../src/dsp/yin.js';
import { parseMidiSong } from '../src/songs/midi_parser.js';
import { parseAbcSong } from '../src/songs/abc_parser.js';
import { TutorEngine } from '../src/tutor/tutor_engine.js';
import { computePianoLayout } from '../src/ui/piano_layout.js';
import { ProgressStore } from '../src/storage/progress_store.js';

function synthPianoNote(midi, sampleRate, durationSec, weakFundamental = false) {
  const n = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(n);
  const f0 = midiToHz(midi);
  const B = midi < 48 ? 0.00015 : (midi < 72 ? 0.00035 : 0.0012);
  const numPartials = f0 > 1500 ? 3 : 8;

  // Deterministic LCG PRNG for reproducible tests
  let seed = 1337 + midi;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.005);
    let sample = 0;
    for (let h = 1; h <= numPartials; h++) {
      const fn = h * f0 * Math.sqrt(1 + B * h * h);
      if (fn >= sampleRate * 0.45) break;
      let amp = 1 / Math.pow(h, 0.85);
      if (weakFundamental && h === 1) amp *= 0.25;
      const decay = Math.exp(-t * (1.2 + 0.65 * h));
      sample += amp * decay * Math.sin(2 * Math.PI * fn * t);
    }
    const hammer = 0.2 * Math.exp(-t / 0.004) * rand();
    out[i] = 0.65 * attack * (sample * 0.45 + hammer) + 0.001 * rand();
  }
  return out;
}

test('Pitch conversion utilities (Hz <-> MIDI <-> NoteName)', () => {
  assert.equal(hzToMidi(440.0).midi, 69);
  assert.equal(hzToMidi(261.6256).midi, 60);
  assert.equal(midiToNoteName(21), 'A0');
  assert.equal(midiToNoteName(60), 'C4');
  assert.equal(midiToNoteName(108), 'C8');
});

test('Web AudioPipeline + YIN detects realistic acoustic piano tones across octaves (48kHz & 44.1kHz)', () => {
  for (const sr of [48000, 44100]) {
    for (const midi of [21, 36, 48, 60, 69, 84, 96, 108]) {
      const pipe = new AudioPipeline({ mode: 'monophonic', sampleRate: sr });
      const audio = synthPianoNote(midi, sr, 0.5, midi <= 36);
      pipe.pushSamples(audio);
      const snap = pipe.latestSnapshot;
      assert.equal(snap.hasPitch, true, `Expected pitch for MIDI ${midi} @ ${sr}Hz`);
      assert.equal(snap.midiNote, midi, `Expected MIDI ${midi} @ ${sr}Hz, got ${snap.midiNote} (${snap.frequencyHz.toFixed(1)}Hz)`);
      assert.ok(snap.confidence >= 0.65);
    }
  }
});

test('Web AudioPipeline records repeated-key Twinkle Twinkle with zero duplicates', () => {
  const sr = 48000;
  const score = [
    { midi: 60, start: 0.10, dur: 0.42 },
    { midi: 60, start: 0.55, dur: 0.42 },
    { midi: 67, start: 1.00, dur: 0.42 },
    { midi: 67, start: 1.45, dur: 0.42 },
    { midi: 69, start: 1.90, dur: 0.42 },
    { midi: 69, start: 2.35, dur: 0.42 },
    { midi: 67, start: 2.80, dur: 0.70 },
  ];
  const mix = new Float32Array(Math.floor(4.0 * sr));
  for (const n of score) {
    const tone = synthPianoNote(n.midi, sr, n.dur + 0.06, false);
    const sIdx = Math.floor(n.start * sr);
    for (let i = 0; i < tone.length && sIdx + i < mix.length; i++) mix[sIdx + i] += tone[i];
  }

  const pipe = new AudioPipeline({ mode: 'monophonic', sampleRate: sr });
  pipe.startRecording();
  pipe.pushSamples(mix);
  const rec = pipe.stopRecording();
  assert.deepEqual(
    rec.map((r) => r.midiNote),
    score.map((s) => s.midi),
  );
});

test('Milestone 5 Polyphonic Estimator recognizes single notes (no harmonic ghosts), 3-note triads & 4-note chords', () => {
  const sr = 48000;
  const mixChord = (midis) => {
    const len = Math.floor(0.55 * sr);
    const mix = new Float32Array(len);
    const scale = 1 / Math.sqrt(midis.length);
    for (const m of midis) {
      const tone = synthPianoNote(m, sr, 0.55, false);
      for (let i = 0; i < len; i++) mix[i] += tone[i] * scale;
    }
    return mix;
  };

  const cases = [
    { name: 'Single C4 (no octave/12th ghosts)', midis: [60] },
    { name: 'C Major Triad (C4-E4-G4)', midis: [60, 64, 67] },
    { name: 'F Major Triad (F4-A4-C5)', midis: [65, 69, 72] },
    { name: 'G Major Triad (G4-B4-D5)', midis: [67, 71, 74] },
    { name: 'A Minor Triad (A3-C4-E4)', midis: [57, 60, 64] },
    { name: 'C Major 7th (C4-E4-G4-B4)', midis: [60, 64, 67, 71] },
  ];

  for (const c of cases) {
    const pipe = new AudioPipeline({ mode: 'polyphonic', sampleRate: sr });
    pipe.pushSamples(mixChord(c.midis));
    const got = pipe.latestSnapshot.activeNotesMidi;
    assert.deepEqual(got, c.midis, `${c.name}: expected [${c.midis}], got [${got}]`);
  }
});

test('Milestone 5 Polyphonic Two-Hand Overlapping Test (sustained LH C3 + moving RH C4-D4-E4-F4)', () => {
  const sr = 48000;
  const totalSec = 2.0;
  const mix = new Float32Array(Math.floor(totalSec * sr));

  // Left hand holds C3 (48) continuously from 0.1s to 1.8s
  const bass = synthPianoNote(48, sr, 1.7, false);
  const bassStart = Math.floor(0.1 * sr);
  for (let i = 0; i < bass.length && bassStart + i < mix.length; i++) {
    mix[bassStart + i] += bass[i] * 0.75;
  }

  // Right hand plays C4 (60), D4 (62), E4 (64), F4 (65) sequentially while C3 rings
  const rhNotes = [
    { midi: 60, start: 0.10, dur: 0.36 },
    { midi: 62, start: 0.50, dur: 0.36 },
    { midi: 64, start: 0.90, dur: 0.36 },
    { midi: 65, start: 1.30, dur: 0.40 },
  ];
  for (const n of rhNotes) {
    const tone = synthPianoNote(n.midi, sr, n.dur, false);
    const sIdx = Math.floor(n.start * sr);
    for (let i = 0; i < tone.length && sIdx + i < mix.length; i++) {
      mix[sIdx + i] += tone[i] * 0.75;
    }
  }

  const pipe = new AudioPipeline({ mode: 'polyphonic', sampleRate: sr });
  pipe.startRecording();
  pipe.pushSamples(mix);
  const rec = pipe.stopRecording();
  const recordedMidis = rec.map((r) => r.midiNote);

  // Expect LH C3 (48) AND all 4 RH melody notes (60, 62, 64, 65) recorded!
  for (const expectedMidi of [48, 60, 62, 64, 65]) {
    assert.ok(
      recordedMidis.includes(expectedMidi),
      `Two-hand overlapping test missing MIDI ${expectedMidi} (recorded: [${recordedMidis}])`,
    );
  }
});

test('parseMidiSong parses SMF Type 1 with tempo change and two hands', () => {
  const chunk = (id, payload) => {
    const len = payload.length;
    return [...id].map((c) => c.charCodeAt(0)).concat([
      (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...payload,
    ]);
  };
  const bytes = new Uint8Array([
    ...chunk('MThd', [0x00, 0x01, 0x00, 0x02, 0x01, 0xe0]),
    ...chunk('MTrk', [
      0x00, 0xff, 0x03, 0x0a, ...[...'Right Hand'].map((c) => c.charCodeAt(0)),
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      0x00, 0x90, 60, 100,
      0x83, 0x60, 60, 0,
      0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,
      0x00, 0x90, 64, 90,
      0x83, 0x60, 0x80, 64, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]),
    ...chunk('MTrk', [
      0x00, 0xff, 0x03, 0x09, ...[...'Left Hand'].map((c) => c.charCodeAt(0)),
      0x00, 0x90, 48, 80,
      0x83, 0x60, 0x80, 48, 0,
      0x00, 0xff, 0x2f, 0x00,
    ]),
  ]);

  const song = parseMidiSong(bytes.buffer);
  assert.equal(song.notes.length, 3);
  assert.equal(song.notes[0].hand, 'left');
  assert.equal(song.notes[1].hand, 'right');
  assert.ok(Math.abs(song.notes[2].durationSec - 1.0) < 1e-4);
});

test('parseAbcSong parses ABC notation into unified SongModel', () => {
  const abc = `
T:Test Tune
M:4/4
L:1/4
Q:120
K:C
C D E F | G ^G A c |
`;
  const song = parseAbcSong(abc);
  assert.equal(song.title, 'Test Tune');
  assert.deepEqual(
    song.notes.map((n) => n.midiPitch),
    [60, 62, 64, 65, 67, 68, 69, 72],
  );
  assert.equal(song.notes[4].measureNumber, 2);
});

test('Milestone 4 & 5 TutorEngine grades Flow Mode and Polyphonic Wait-Until-Correct Mode', () => {
  const notes = [
    { midiPitch: 60, startSec: 1.0, durationSec: 0.4, endSec: 1.4 },
    { midiPitch: 64, startSec: 2.0, durationSec: 0.4, endSec: 2.4 },
    { midiPitch: 67, startSec: 3.0, durationSec: 0.4, endSec: 3.4 },
  ];

  // Flow Mode: play C4 at 1.065s (perfect after 65ms latency), miss E4, play wrong key F4, play G4 on time
  const flow = new TutorEngine(notes, { timingToleranceMs: 150, latencyMs: 65, waitMode: false });
  flow.tick(1.05);
  const fb1 = flow.onDetectedNote(60, 1.065);
  assert.equal(fb1.type, 'correct');
  assert.equal(fb1.timingMs, 0);

  flow.tick(2.30); // Past E4 tolerance -> missed
  const fbWrong = flow.onDetectedNote(65, 2.50);
  assert.equal(fbWrong.type, 'wrong');

  flow.tick(3.05);
  const fb3 = flow.onDetectedNote(67, 3.080);
  assert.equal(fb3.type, 'correct');

  const summary = flow.getSummary();
  assert.equal(summary.correctCount, 2);
  assert.equal(summary.missedCount, 1);
  assert.equal(summary.extraCount, 1);

  // Polyphonic Wait-Until-Correct Mode: simultaneous two-hand chord (C3 + C4 at t=1.0s)
  const chordNotes = [
    { midiPitch: 48, startSec: 1.0, durationSec: 0.5, endSec: 1.5 },
    { midiPitch: 60, startSec: 1.0, durationSec: 0.5, endSec: 1.5 },
  ];
  const waitTutor = new TutorEngine(chordNotes, { waitMode: true });
  const hold1 = waitTutor.tick(1.05);
  assert.equal(hold1.shouldHold, true);
  assert.deepEqual(hold1.waitingMidis, [48, 60]);

  // Play first chord tone (48) -> still waits for 60
  assert.equal(waitTutor.onDetectedNote(48, 1.0).type, 'correct');
  assert.equal(waitTutor.waitingChordIndices.length, 1);

  // Play wrong tone (62) -> still waits for 60
  assert.equal(waitTutor.onDetectedNote(62, 1.0).type, 'wrong');
  assert.equal(waitTutor.waitingChordIndices.length, 1);

  // Play second chord tone (60) -> released!
  assert.equal(waitTutor.onDetectedNote(60, 1.0).type, 'correct');
  assert.equal(waitTutor.waitingForIndex, -1);
});

test('PianoKeyLayout spans 88 keys cleanly', () => {
  const layout = computePianoLayout(21, 108, 1040);
  assert.equal(layout.whiteKeys.length, 52);
  assert.equal(layout.blackKeys.length, 36);
  assert.ok(Math.abs(layout.whiteKeys[51].left + layout.whiteKeys[51].width - 1040) < 1e-6);
});

test('Milestone 6 ProgressStore persists settings, best song accuracy, session history, and custom songs', () => {
  const mem = new Map();
  const mockStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
  };
  const store = new ProgressStore(mockStorage);

  store.saveSettings({ noiseGateDb: -42, latencyMs: 80, recognitionMode: 'polyphonic' });
  const loaded = store.loadSettings({ noiseGateDb: -50, latencyMs: 65, a4ReferenceHz: 440 });
  assert.equal(loaded.noiseGateDb, -42);
  assert.equal(loaded.latencyMs, 80);
  assert.equal(loaded.a4ReferenceHz, 440);

  store.recordSession({
    songId: 'builtin_twinkle',
    songTitle: 'Twinkle',
    accuracyPct: 82.5,
    f1Score: 0.85,
    correctCount: 12,
    totalNotes: 14,
    meanAbsTimingMs: 31,
    handFilter: 'right',
    tempoScale: 1.0,
  });
  const p2 = store.recordSession({
    songId: 'builtin_twinkle',
    songTitle: 'Twinkle',
    accuracyPct: 95.0,
    f1Score: 0.96,
    correctCount: 13,
    totalNotes: 14,
    meanAbsTimingMs: 18,
    handFilter: 'right',
    tempoScale: 1.0,
  });

  assert.equal(p2.bySong.builtin_twinkle.plays, 2);
  assert.equal(p2.bySong.builtin_twinkle.bestAccuracyPct, 95.0);
  assert.equal(p2.recentSessions.length, 2);

  store.saveCustomSongs([
    { id: 'builtin_1', sourceFormat: 'builtin', title: 'Built-in' },
    { id: 'abc_1', sourceFormat: 'abc', title: 'Custom ABC' },
  ]);
  const custom = store.loadCustomSongs();
  assert.equal(custom.length, 1);
  assert.equal(custom[0].id, 'abc_1');
});
