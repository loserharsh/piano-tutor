import { WebMicrophoneCapture } from './dsp/audio_engine.js';
import { midiToNoteName } from './dsp/yin.js';
import { getBuiltinLessons } from './songs/builtin_lessons.js';
import { parseMidiSong } from './songs/midi_parser.js';
import { parseMusicXmlSong } from './songs/musicxml_parser.js';
import { parseAbcSong } from './songs/abc_parser.js';
import { TutorEngine } from './tutor/tutor_engine.js';
import { ProgressStore } from './storage/progress_store.js';
import { PianoPreviewSynth } from './audio/synth_preview.js';
import { renderFallingNotes } from './ui/falling_notes.js';
import { renderPianoKeyboard } from './ui/piano_keyboard.js';
import { renderSpectrum } from './ui/spectrum_canvas.js';

const mic = new WebMicrophoneCapture();
const store = new ProgressStore();
const previewSynth = new PianoPreviewSynth();

const savedSettings = store.loadSettings({
  recognitionMode: 'polyphonic',
  noiseGateDb: -50,
  timingToleranceMs: 180,
  latencyMs: 65,
  a4ReferenceHz: 440,
});

const state = {
  view: 'library',
  songs: [...store.loadCustomSongs(), ...getBuiltinLessons()],
  progress: store.loadProgress(),
  currentSong: null,
  filteredNotes: [],
  tutor: null,

  // Persisted settings
  recognitionMode: savedSettings.recognitionMode,
  noiseGateDb: savedSettings.noiseGateDb,
  timingToleranceMs: savedSettings.timingToleranceMs,
  latencyMs: savedSettings.latencyMs,
  a4ReferenceHz: savedSettings.a4ReferenceHz,

  // Practice transport
  isPlaying: false,
  currentTimeSec: -1.5,
  lastFrameMs: 0,
  tempoScale: 1.0,
  fallSpeedPx: 180,
  handFilter: 'both',
  minMidi: 48,
  maxMidi: 84,
  loopEnabled: false,
  loopStartMeasure: 1,
  loopEndMeasure: 2,
  waitMode: false,
  waitingForMidis: [],
  soundEnabled: false,
  soundedNotes: new Set(),

  // Live mic feedback flashes on keyboard
  flashKeys: new Map(), // midi -> { state: 'correct'|'wrong', untilMs }
  latestSnapshot: null,
  recentEvents: [],
  recordedNotes: [],
  calibratingNoise: false,
  noiseSamples: [],
};

const $ = (id) => document.getElementById(id);

function showError(msg) {
  const el = $('errorBanner');
  if (!msg) {
    el.classList.add('hidden');
    el.textContent = '';
  } else {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
}

function switchView(viewName) {
  state.view = viewName;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === `view-${viewName}`);
  });
}

// ---------------- Microphone Lifecycle ----------------

async function toggleMic() {
  showError('');
  if (mic.isRunning) {
    mic.stop();
    $('micDot').classList.remove('on');
    $('micStatusText').textContent = 'Mic Off';
    $('globalMicBtn').textContent = 'Enable Mic';
    return;
  }

  try {
    const pipeline = await mic.start({
      mode: state.recognitionMode,
      noiseGateDb: state.noiseGateDb,
      a4ReferenceHz: state.a4ReferenceHz,
      onSnapshot: handleAudioSnapshot,
      onNoteEvent: handleAudioNoteEvent,
    });
    $('micDot').classList.add('on');
    $('micStatusText').textContent = `${pipeline.config.sampleRate} Hz`;
    $('globalMicBtn').textContent = 'Disable Mic';
  } catch (err) {
    showError(err.message);
  }
}

function handleAudioSnapshot(snap) {
  state.latestSnapshot = snap;

  if (state.calibratingNoise) {
    state.noiseSamples.push(snap.rmsDb);
  }

  // Update Calibration screen
  if (state.view === 'calibrate') {
    $('calRms').textContent = `${snap.rmsDb.toFixed(1)} dB`;
    $('calFloor').textContent = `${snap.noiseFloorDb.toFixed(1)} dB`;
    $('calGate').textContent = `${state.noiseGateDb.toFixed(1)} dB`;
    $('calNote').textContent = snap.noteName;
    $('calFreq').textContent = snap.hasPitch ? `${snap.frequencyHz.toFixed(2)} Hz` : '0.00 Hz';
    $('calConf').textContent = `Confidence: ${Math.round(snap.confidence * 100)}%`;
    if (snap.hasPitch && snap.midiNote === 60 && snap.confidence >= 0.75) {
      $('calVerifyBadge').textContent = `Middle C (C4) verified! (${snap.frequencyHz.toFixed(1)} Hz · ${Math.round(snap.confidence * 100)}%)`;
      $('calVerifyBadge').classList.add('ok');
    }
  }

  // Update Mic Tester screen
  if (state.view === 'tester') {
    $('testNote').textContent = snap.noteName;
    $('testMidi').textContent = snap.detectedNotes?.length
      ? `MIDI ${snap.detectedNotes.map((n) => n.midiNote).join(', ')}`
      : 'MIDI --';
    $('testFreq').textContent = snap.hasPitch ? `${snap.frequencyHz.toFixed(2)} Hz` : '0.00 Hz';
    $('testCents').textContent = snap.hasPitch
      ? `${snap.centsOffset >= 0 ? '+' : ''}${snap.centsOffset.toFixed(1)} ¢`
      : '0.0 ¢';
    const pct = Math.round(snap.confidence * 100);
    $('testConf').textContent = `${pct}%`;
    $('testConfBar').style.width = `${pct}%`;
    $('testRms').textContent = `${snap.rmsDb.toFixed(1)} / ${snap.noiseFloorDb.toFixed(1)} dB`;
    renderSpectrum($('spectrumCanvas'), snap.spectrumBins);
  }

  // Practice HUD live heard note(s)
  if (state.view === 'practice') {
    $('hudDetectedNote').textContent = `Heard: ${snap.noteName}`;
  }
}

function handleAudioNoteEvent(evt) {
  if (evt.type !== 'noteOn') return;
  const noteName = midiToNoteName(evt.midiNote);

  state.recentEvents.unshift({
    noteName,
    midi: evt.midiNote,
    hz: evt.frequencyHz,
    conf: evt.confidence,
    time: evt.timestampSec,
  });
  if (state.recentEvents.length > 25) state.recentEvents.pop();
  if (state.view === 'tester' && state.recordedNotes.length === 0) {
    renderTesterEvents();
  }

  // Milestone 4 & 5 Real-Time Tutor Grading (Monophonic + Polyphonic Chords)
  if (state.view === 'practice' && state.tutor && state.isPlaying) {
    const fb = state.tutor.onDetectedNote(evt.midiNote, state.currentTimeSec, state.tempoScale);
    if (fb) {
      updateFeedbackBadge(fb);
      state.flashKeys.set(evt.midiNote, {
        state: fb.type === 'correct' ? 'correct' : 'wrong',
        untilMs: performance.now() + 260,
      });
      if (state.waitMode && fb.type === 'correct') {
        state.waitingForMidis = state.tutor.waitingChordIndices.map((idx) => state.filteredNotes[idx].midiPitch);
        if (state.waitingForMidis.length === 0) {
          state.currentTimeSec += 0.04; // advance past satisfied chord
        }
      }
      updateHudMetrics();
    }
  }
}

function updateFeedbackBadge(fb) {
  const el = $('hudFeedback');
  el.textContent = fb.label;
  el.className = `feedback-badge ${fb.type}`;
}

function updateHudMetrics() {
  if (!state.tutor) return;
  const s = state.tutor.getSummary();
  $('hudAccuracy').textContent = `${Math.round(s.accuracyPct)}%`;
  $('hudCorrect').textContent = String(s.correctCount);
  $('hudMissed').textContent = String(s.missedCount);
  $('hudExtra').textContent = String(s.extraCount);
  $('hudStreak').textContent = String(s.streak);
}

// ---------------- Song Library & Importers ----------------

function saveCurrentSettings() {
  store.saveSettings({
    recognitionMode: state.recognitionMode,
    noiseGateDb: state.noiseGateDb,
    timingToleranceMs: state.timingToleranceMs,
    latencyMs: state.latencyMs,
    a4ReferenceHz: state.a4ReferenceHz,
  });
}

function renderProgressSummary() {
  const sessions = state.progress.recentSessions || [];
  const bySong = state.progress.bySong || {};
  $('progSessions').textContent = String(sessions.length);
  if (sessions.length > 0) {
    const avg = sessions.reduce((a, s) => a + s.accuracyPct, 0) / sessions.length;
    $('progAvgAcc').textContent = `${avg.toFixed(1)}%`;
  } else {
    $('progAvgAcc').textContent = '--';
  }
  const mastered = Object.values(bySong).filter((p) => p.bestAccuracyPct >= 90).length;
  $('progMastered').textContent = String(mastered);

  const card = $('recentSessionsCard');
  const list = $('recentSessionsList');
  if (sessions.length === 0) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  list.innerHTML = '';
  for (const s of sessions.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'event-row';
    row.innerHTML = `<span><strong>${s.songTitle}</strong> (${s.handFilter.toUpperCase()} · ${s.tempoPct}%)</span><span>${s.accuracyPct}% · ${s.correctCount}/${s.totalNotes} · ±${s.meanAbsTimingMs}ms</span>`;
    list.appendChild(row);
  }
}

function renderSongLibrary() {
  renderProgressSummary();
  const grid = $('songGrid');
  grid.innerHTML = '';
  for (const song of state.songs) {
    const hasLeft = song.notes.some((n) => n.hand === 'left');
    const prog = state.progress.bySong?.[song.id];
    const bestBadge = prog
      ? `<span class="badge" style="color:#22c55e;border-color:#15803d;">Best ${Math.round(prog.bestAccuracyPct)}% · ${prog.plays}x</span>`
      : '';
    const card = document.createElement('div');
    card.className = 'card song-card';
    card.innerHTML = `
      <div>
        <h3>${song.title}</h3>
        <div class="muted" style="font-size:12px;margin-bottom:8px;">${song.composer}</div>
        <div class="song-meta mono">
          <span>${song.notes.length} notes</span>
          <span>${song.bpm} BPM</span>
          <span>${hasLeft ? 'Both Hands' : 'Right Hand'}</span>
        </div>
      </div>
      <div class="song-card-footer">
        <div style="display:flex;gap:6px;align-items:center;">
          <span class="badge">${song.sourceFormat}</span>
          ${bestBadge}
        </div>
        <button class="btn btn-primary">Practice</button>
      </div>
    `;
    card.querySelector('button').addEventListener('click', () => {
      loadSongIntoPractice(song);
      switchView('practice');
    });
    grid.appendChild(card);
  }
}

function addImportedSong(song) {
  state.songs.unshift(song);
  store.saveCustomSongs(state.songs);
  renderSongLibrary();
  loadSongIntoPractice(song);
  switchView('practice');
}

async function handleSongFileImport(file) {
  if (!file) return;
  showError('');
  const name = file.name.toLowerCase();
  const baseTitle = file.name.replace(/\.[^.]+$/, '');
  try {
    let song;
    if (name.endsWith('.mid') || name.endsWith('.midi')) {
      const buf = await file.arrayBuffer();
      song = parseMidiSong(buf, baseTitle);
    } else if (name.endsWith('.xml') || name.endsWith('.musicxml')) {
      const text = await file.text();
      song = parseMusicXmlSong(text, baseTitle);
    } else if (name.endsWith('.abc')) {
      const text = await file.text();
      song = parseAbcSong(text, baseTitle);
    } else {
      throw new Error('Unsupported format. Please import .mid, .musicxml, .xml, or .abc.');
    }
    if (song.notes.length === 0) {
      throw new Error('No playable notes found in imported file.');
    }
    addImportedSong(song);
  } catch (err) {
    showError(`Import failed: ${err.message}`);
  }
}

// ---------------- Practice Screen & Animation Loop ----------------

function populateLoopMeasureSelectors(song) {
  const maxM = song.notes.reduce((m, n) => Math.max(m, n.measureNumber || 1), 1);
  const startSel = $('selLoopStart');
  const endSel = $('selLoopEnd');
  startSel.innerHTML = '';
  endSel.innerHTML = '';
  for (let m = 1; m <= maxM; m++) {
    startSel.add(new Option(`M${m}`, String(m)));
    endSel.add(new Option(`M${m}`, String(m)));
  }
  state.loopStartMeasure = 1;
  state.loopEndMeasure = Math.min(2, maxM);
  startSel.value = String(state.loopStartMeasure);
  endSel.value = String(state.loopEndMeasure);
}

function loadSongIntoPractice(song) {
  previewSynth.stop();
  state.soundedNotes.clear();
  state.currentSong = song;
  state.isPlaying = false;
  $('btnPlayPause').textContent = 'Play';
  $('hudSongTitle').textContent = `${song.title} (${song.bpm} BPM)`;

  populateLoopMeasureSelectors(song);

  // Auto-select 5 octaves if notes go outside C3..C6
  if (song.notes.some((n) => n.midiPitch < 48 || n.midiPitch > 84)) {
    $('selRange').value = '36,96';
    state.minMidi = 36;
    state.maxMidi = 96;
  }

  rebuildFilteredTutor();
  restartPractice();
}

function rebuildFilteredTutor() {
  if (!state.currentSong) return;
  state.filteredNotes = state.currentSong.notes.filter((n) => {
    if (state.handFilter === 'right') return n.hand === 'right' || n.hand === 'unknown';
    if (state.handFilter === 'left') return n.hand === 'left';
    return true;
  });
  state.tutor = new TutorEngine(state.filteredNotes, {
    timingToleranceMs: state.timingToleranceMs,
    latencyMs: state.latencyMs,
    waitMode: state.waitMode,
  });
  const totalDur = Math.max(1, state.currentSong.totalDurationSec);
  $('rngScrub').max = (totalDur + 0.5).toFixed(2);
  $('lblTotalTime').textContent = `${totalDur.toFixed(1)}s`;
  updateHudMetrics();
}

function getLoopBounds() {
  const inLoop = state.filteredNotes.filter(
    (n) => n.measureNumber >= state.loopStartMeasure && n.measureNumber <= state.loopEndMeasure,
  );
  if (inLoop.length === 0) return [0, state.currentSong?.totalDurationSec || 4];
  const start = Math.min(...inLoop.map((n) => n.startSec));
  const end = Math.max(...inLoop.map((n) => n.endSec)) + 0.15;
  return [start, end];
}

function restartPractice() {
  previewSynth.stop();
  state.soundedNotes.clear();
  state.isPlaying = false;
  $('btnPlayPause').textContent = 'Play';
  state.waitingForMidis = [];
  state.tutor?.reset();
  state.currentTimeSec = state.loopEnabled ? getLoopBounds()[0] - 0.6 : -1.5;
  $('hudFeedback').textContent = 'Ready';
  $('hudFeedback').className = 'feedback-badge';
  updateHudMetrics();
}

function showPracticeResults() {
  if (!state.tutor || !state.currentSong) return;
  state.isPlaying = false;
  $('btnPlayPause').textContent = 'Play';
  const s = state.tutor.getSummary();

  // Persist practice session when at least 1 note was attempted
  if (s.correctCount > 0 || s.missedCount > 0) {
    state.progress = store.recordSession({
      songId: state.currentSong.id,
      songTitle: state.currentSong.title,
      accuracyPct: s.accuracyPct,
      f1Score: s.f1Score,
      correctCount: s.correctCount,
      totalNotes: s.totalNotes,
      meanAbsTimingMs: s.meanAbsTimingMs,
      handFilter: state.handFilter,
      tempoScale: state.tempoScale,
    });
    renderSongLibrary();
  }

  $('resSongTitle').textContent = `${state.currentSong.title} · ${state.handFilter.toUpperCase()} · ${Math.round(state.tempoScale * 100)}% tempo`;
  $('resAccuracy').textContent = `${s.accuracyPct.toFixed(1)}%`;
  $('resF1').textContent = s.f1Score.toFixed(2);
  $('resCorrect').textContent = `${s.correctCount} / ${s.totalNotes}`;
  $('resMissed').textContent = String(s.missedCount);
  $('resExtra').textContent = String(s.extraCount);
  $('resTiming').textContent = `${Math.round(s.meanAbsTimingMs)} ms`;
  $('resultsModal').classList.remove('hidden');
}

function animationLoop(nowMs) {
  requestAnimationFrame(animationLoop);

  if (state.view !== 'practice' || !state.currentSong) {
    state.lastFrameMs = nowMs;
    return;
  }

  const dtSec = state.lastFrameMs ? Math.min(0.1, (nowMs - state.lastFrameMs) / 1000) : 0;
  state.lastFrameMs = nowMs;

  if (state.isPlaying) {
    const prevTime = state.currentTimeSec;
    const nextTime = state.currentTimeSec + dtSec * state.tempoScale;
    const tickRes = state.tutor.tick(nextTime, state.tempoScale);

    if (tickRes.shouldHold) {
      state.currentTimeSec = tickRes.holdTimeSec;
      state.waitingForMidis = tickRes.waitingMidis || [tickRes.waitingMidi];
    } else {
      state.waitingForMidis = [];
      state.currentTimeSec = nextTime;

      // Play synchronized reference piano audio for each note crossing the strike line
      if (state.soundEnabled) {
        for (let i = 0; i < state.filteredNotes.length; i++) {
          if (state.soundedNotes.has(i)) continue;
          const n = state.filteredNotes[i];
          if (n.startSec >= prevTime - 0.05 && n.startSec <= state.currentTimeSec) {
            state.soundedNotes.add(i);
            previewSynth.playNoteNow(n.midiPitch, n.durationSec / state.tempoScale, n.velocity ?? 0.8);
          }
        }
      }

      if (state.loopEnabled) {
        const [lStart, lEnd] = getLoopBounds();
        if (state.currentTimeSec >= lEnd) {
          state.currentTimeSec = lStart;
          state.soundedNotes.clear();
          state.tutor.reset();
        }
      } else if (state.currentTimeSec >= state.currentSong.totalDurationSec + 0.6) {
        showPracticeResults();
      }
    }
    updateHudMetrics();
  }

  $('lblCurTime').textContent = `${Math.max(0, state.currentTimeSec).toFixed(1)}s`;
  $('rngScrub').value = String(state.currentTimeSec);

  // Build keyboard highlight map (supports multiple simultaneous notes!)
  const keyStates = new Map();
  for (const n of state.filteredNotes) {
    if (state.currentTimeSec >= n.startSec && state.currentTimeSec <= n.endSec) {
      keyStates.set(n.midiPitch, n.hand === 'left' ? 'expectedLeft' : 'expectedRight');
    }
  }
  for (const wm of state.waitingForMidis) {
    keyStates.set(wm, 'expectedRight');
  }
  if (state.latestSnapshot?.detectedNotes?.length) {
    for (const dn of state.latestSnapshot.detectedNotes) {
      keyStates.set(dn.midiNote, 'detected');
    }
  }
  for (const [midi, info] of state.flashKeys.entries()) {
    if (nowMs < info.untilMs) keyStates.set(midi, info.state);
    else state.flashKeys.delete(midi);
  }

  renderFallingNotes($('fallingCanvas'), {
    notes: state.filteredNotes,
    noteStates: state.tutor?.noteStates,
    currentTimeSec: state.currentTimeSec,
    minMidi: state.minMidi,
    maxMidi: state.maxMidi,
    pixelsPerSecond: state.fallSpeedPx,
    bpm: state.currentSong.bpm,
    waitingForMidis: state.waitingForMidis,
  });

  renderPianoKeyboard($('keyboardCanvas'), {
    minMidi: state.minMidi,
    maxMidi: state.maxMidi,
    keyStates,
  });
}

// ---------------- Tester & Calibration Helpers ----------------

function renderTesterEvents() {
  const list = $('testEventsList');
  list.innerHTML = '';
  if (state.recordedNotes.length > 0) {
    $('testEventsTitle').textContent = `RECORDED MELODY (${state.recordedNotes.length} NOTES)`;
    for (let i = 0; i < state.recordedNotes.length; i++) {
      const r = state.recordedNotes[i];
      const row = document.createElement('div');
      row.className = 'event-row';
      row.innerHTML = `<span>#${i + 1} <strong>${r.noteName}</strong> (${r.frequencyHz.toFixed(1)} Hz)</span><span>start ${r.startSec.toFixed(2)}s · dur ${r.durationSec.toFixed(2)}s</span>`;
      list.appendChild(row);
    }
  } else {
    $('testEventsTitle').textContent = 'DETECTED NOTE EVENTS';
    for (const e of state.recentEvents) {
      const row = document.createElement('div');
      row.className = 'event-row';
      row.innerHTML = `<span><strong>${e.noteName}</strong> (${e.hz.toFixed(1)} Hz)</span><span>t=${e.time.toFixed(2)}s · ${Math.round(e.conf * 100)}%</span>`;
      list.appendChild(row);
    }
  }
}

function downloadRecordedCsv() {
  if (state.recordedNotes.length === 0) return;
  const lines = ['index,note,midi,start_sec,duration_sec,hz,confidence,velocity'];
  state.recordedNotes.forEach((n, i) => {
    lines.push(`${i},${n.noteName},${n.midiNote},${n.startSec.toFixed(4)},${n.durationSec.toFixed(4)},${n.frequencyHz.toFixed(2)},${n.confidence.toFixed(3)},${n.velocityEst.toFixed(3)}`);
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'piano_tutor_melody.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- Event Bindings ----------------

function wireEvents() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $('selRecognitionMode').addEventListener('change', (e) => {
    state.recognitionMode = e.target.value;
    if (mic.pipeline) mic.pipeline.setMode(state.recognitionMode);
    saveCurrentSettings();
  });

  $('globalMicBtn').addEventListener('click', toggleMic);
  $('songFileInput').addEventListener('change', (e) => handleSongFileImport(e.target.files[0]));

  // Paste ABC modal
  $('btnPasteAbc').addEventListener('click', () => $('abcModal').classList.remove('hidden'));
  $('btnAbcClose').addEventListener('click', () => $('abcModal').classList.add('hidden'));
  $('btnAbcImport').addEventListener('click', () => {
    try {
      const song = parseAbcSong($('abcInput').value, 'Pasted ABC Tune');
      if (song.notes.length === 0) throw new Error('No playable notes found in ABC text.');
      $('abcModal').classList.add('hidden');
      addImportedSong(song);
    } catch (err) {
      showError(`ABC import failed: ${err.message}`);
    }
  });

  // Practice controls
  $('btnPlayPause').addEventListener('click', async () => {
    if (state.soundEnabled) await previewSynth.ensureContext();
    if (!state.isPlaying && !mic.isRunning && !state.soundEnabled) {
      await toggleMic();
    }
    state.isPlaying = !state.isPlaying;
    $('btnPlayPause').textContent = state.isPlaying ? 'Pause' : 'Play';
  });
  $('btnRestart').addEventListener('click', restartPractice);
  $('btnPlaySound').addEventListener('click', async () => {
    state.soundEnabled = !state.soundEnabled;
    const btn = $('btnPlaySound');
    if (state.soundEnabled) {
      await previewSynth.ensureContext();
      btn.textContent = 'Play Sound: On';
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-primary');
      // If not already playing, start playback immediately so the user hears it right away!
      if (!state.isPlaying) {
        state.isPlaying = true;
        $('btnPlayPause').textContent = 'Pause';
      }
    } else {
      previewSynth.stop();
      btn.textContent = 'Play Sound: Off';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-secondary');
    }
  });
  $('btnFinish').addEventListener('click', showPracticeResults);

  $('chkWaitMode').addEventListener('change', (e) => {
    state.waitMode = e.target.checked;
    state.tutor?.updateConfig({ waitMode: state.waitMode });
  });
  $('selHand').addEventListener('change', (e) => {
    state.handFilter = e.target.value;
    rebuildFilteredTutor();
    restartPractice();
  });
  $('selRange').addEventListener('change', (e) => {
    const [lo, hi] = e.target.value.split(',').map(Number);
    state.minMidi = lo;
    state.maxMidi = hi;
  });
  $('rngTempo').addEventListener('input', (e) => {
    state.tempoScale = Number(e.target.value) / 100;
    $('lblTempo').textContent = `${e.target.value}%`;
  });
  $('rngSpeed').addEventListener('input', (e) => {
    state.fallSpeedPx = Number(e.target.value);
    $('lblSpeed').textContent = e.target.value;
  });
  $('chkLoop').addEventListener('change', (e) => {
    state.loopEnabled = e.target.checked;
  });
  $('selLoopStart').addEventListener('change', (e) => {
    state.loopStartMeasure = Number(e.target.value);
    if (state.loopEndMeasure < state.loopStartMeasure) {
      state.loopEndMeasure = state.loopStartMeasure;
      $('selLoopEnd').value = String(state.loopEndMeasure);
    }
  });
  $('selLoopEnd').addEventListener('change', (e) => {
    state.loopEndMeasure = Number(e.target.value);
    if (state.loopStartMeasure > state.loopEndMeasure) {
      state.loopStartMeasure = state.loopEndMeasure;
      $('selLoopStart').value = String(state.loopStartMeasure);
    }
  });
  $('rngScrub').addEventListener('input', (e) => {
    state.currentTimeSec = Number(e.target.value);
    state.soundedNotes.clear();
  });

  // Calibration
  $('btnAutoNoise').addEventListener('click', async () => {
    if (!mic.isRunning) await toggleMic();
    if (!mic.isRunning) return;
    state.calibratingNoise = true;
    state.noiseSamples = [];
    $('calNoiseMsg').textContent = 'Measuring ambient noise for 3 seconds... please stay quiet.';
    setTimeout(() => {
      state.calibratingNoise = false;
      if (state.noiseSamples.length > 0) {
        const avg = state.noiseSamples.reduce((a, b) => a + b, 0) / state.noiseSamples.length;
        const recommendedGate = Math.max(-68, Math.min(-25, Math.round(avg + 8)));
        state.noiseGateDb = recommendedGate;
        if (mic.pipeline) mic.pipeline.config.noiseGateDb = recommendedGate;
        $('setGate').value = String(recommendedGate);
        $('setGateVal').textContent = `${recommendedGate} dBFS`;
        $('calGate').textContent = `${recommendedGate.toFixed(1)} dB`;
        $('calNoiseMsg').textContent = `Done! Avg room noise ${avg.toFixed(1)} dB → Noise gate set to ${recommendedGate} dB.`;
        saveCurrentSettings();
      }
    }, 3000);
  });

  const syncLatency = (val) => {
    state.latencyMs = Number(val);
    $('calLatencyVal').textContent = `${val} ms`;
    $('calLatencySlider').value = String(val);
    $('setLatVal').textContent = `${val} ms`;
    $('setLat').value = String(val);
    state.tutor?.updateConfig({ latencyMs: state.latencyMs });
    saveCurrentSettings();
  };
  $('calLatencySlider').addEventListener('input', (e) => syncLatency(e.target.value));
  $('setLat').addEventListener('input', (e) => syncLatency(e.target.value));

  // Settings
  $('setGate').addEventListener('input', (e) => {
    state.noiseGateDb = Number(e.target.value);
    $('setGateVal').textContent = `${state.noiseGateDb} dBFS`;
    if (mic.pipeline) mic.pipeline.config.noiseGateDb = state.noiseGateDb;
    saveCurrentSettings();
  });
  $('setTol').addEventListener('input', (e) => {
    state.timingToleranceMs = Number(e.target.value);
    $('setTolVal').textContent = `±${state.timingToleranceMs} ms`;
    state.tutor?.updateConfig({ timingToleranceMs: state.timingToleranceMs });
    saveCurrentSettings();
  });
  $('setA4').addEventListener('input', (e) => {
    state.a4ReferenceHz = Number(e.target.value);
    $('setA4Val').textContent = `${state.a4ReferenceHz} Hz`;
    if (mic.pipeline) mic.pipeline.config.a4ReferenceHz = state.a4ReferenceHz;
    saveCurrentSettings();
  });

  // Mic Tester Recorder
  $('btnRecMelody').addEventListener('click', async () => {
    if (!mic.isRunning) await toggleMic();
    if (!mic.pipeline) return;
    if (!mic.pipeline.isRecording) {
      state.recordedNotes = [];
      mic.pipeline.startRecording();
      $('btnRecMelody').textContent = 'Stop Recording';
      $('btnExportCsv').disabled = true;
    } else {
      state.recordedNotes = mic.pipeline.stopRecording();
      $('btnRecMelody').textContent = 'Record Melody';
      $('btnExportCsv').disabled = state.recordedNotes.length === 0;
      renderTesterEvents();
    }
  });
  $('btnExportCsv').addEventListener('click', downloadRecordedCsv);

  // Results Modal
  $('btnResRetry').addEventListener('click', () => {
    $('resultsModal').classList.add('hidden');
    restartPractice();
  });
  $('btnResLibrary').addEventListener('click', () => {
    $('resultsModal').classList.add('hidden');
    switchView('library');
  });
  $('btnResClose').addEventListener('click', () => $('resultsModal').classList.add('hidden'));
}

function hydrateSettingsUi() {
  $('selRecognitionMode').value = state.recognitionMode;
  $('setGate').value = String(state.noiseGateDb);
  $('setGateVal').textContent = `${state.noiseGateDb} dBFS`;
  $('setTol').value = String(state.timingToleranceMs);
  $('setTolVal').textContent = `±${state.timingToleranceMs} ms`;
  $('setLat').value = String(state.latencyMs);
  $('setLatVal').textContent = `${state.latencyMs} ms`;
  $('calLatencySlider').value = String(state.latencyMs);
  $('calLatencyVal').textContent = `${state.latencyMs} ms`;
  $('setA4').value = String(state.a4ReferenceHz);
  $('setA4Val').textContent = `${state.a4ReferenceHz} Hz`;
}

// Register PWA service worker for offline & installable desktop/mobile support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Init
hydrateSettingsUi();
renderSongLibrary();
loadSongIntoPractice(state.songs[0]);
wireEvents();
requestAnimationFrame(animationLoop);
