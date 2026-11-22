# PianoTutor — Microphone-Based Real Piano Learning App

PianoTutor is a cross-platform piano learning application inspired by Synthesia, built around one core requirement: **it listens to a real physical acoustic piano or electronic keyboard using ONLY a microphone — no MIDI cables, USB MIDI interfaces, or external sensors required.**

> **Status**: **All Core Milestones Complete (Web PWA + Native C++17 Engine)**
> - **Web PWA (`web/`)**: Runs immediately in Chrome, Firefox, Edge, and Android browsers — installable offline PWA with real-time Web Audio microphone DSP (Polyphonic Chords & Monophonic YIN), falling-note tutor, Wait-Until-Correct mode, MIDI (song data only) / MusicXML / ABC import + Paste ABC, reference audio preview, mic calibration, and persistent progress tracking.
> - **Native C++17 Engine (`native/`)**: Shared `libpiano_dsp.so` with Linux PulseAudio/PipeWire capture, terminal live pitch/melody detector (`piano_dsp_cli`), and 64 passing unit/acoustic/integration tests.
> - **Flutter App (`app/`)**: Cross-platform Dart FFI bindings and falling-note UI ready for native Android/Linux/Windows builds when Flutter SDK is installed.

---

## Quick Start (Web App — Recommended)

### 1. Run Locally (Linux / Windows / macOS)
```bash
cd /home/harsh/.gemini/antigravity/scratch/piano_tutor/web
node server.mjs
```
Open **`http://localhost:8080`** in your browser and click **Enable Mic**.

### 2. Access from an Android Phone on Local Wi-Fi
```bash
cd /home/harsh/.gemini/antigravity/scratch/piano_tutor/web
node server.mjs --lan
```
*(Note: mobile browsers require `localhost` or HTTPS for `getUserMedia` microphone access; use Chrome's USB port-forwarding `adb reverse tcp:8080 tcp:8080` or host over HTTPS to use the microphone on Android and install the PWA to your home screen.)*

### 3. Run All Automated Web Tests (10/10 verified)
```bash
cd /home/harsh/.gemini/antigravity/scratch/piano_tutor/web
node --test test/dsp_and_tutor.test.mjs
```

---

## Native C++17 Engine (Linux CLI & Tests)

### Build & Run Native Tests (64/64 verified)
```bash
cd /home/harsh/.gemini/antigravity/scratch/piano_tutor/native
make && make test
```

### Live Terminal Pitch & Melody Recorder
```bash
./build/piano_dsp_cli --rate 48000 --gate -50 --record my_melody.csv
./build/piano_dsp_cli --wav /path/to/piano_recording.wav --record detected.csv
```

---

## Project Structure

```
piano_tutor/
├── docs/ARCHITECTURE.md              # System architecture & DSP pipeline documentation
├── web/                              # Production Web App & Offline PWA (Zero npm dependencies)
│   ├── index.html, styles.css, manifest.json, sw.js, icon.svg, server.mjs
│   ├── src/
│   │   ├── app.js                    # Full UI controller (Library, Practice, Calibrate, Tester, Settings)
│   │   ├── dsp/                      # fft.js, biquad.js, yin.js, onset_tracker.js, polyphonic_estimator.js, audio_engine.js
│   │   ├── songs/                    # midi_parser.js (song data only), musicxml_parser.js, abc_parser.js, builtin_lessons.js
│   │   ├── tutor/tutor_engine.js     # Real-time Flow & Polyphonic Wait-Until-Correct grading engine
│   │   ├── storage/progress_store.js # localStorage persistence for progress, settings & imported songs
│   │   ├── audio/synth_preview.js    # Reference song preview synthesizer (auto-mutes mic)
│   │   └── ui/                       # piano_layout.js, falling_notes.js, piano_keyboard.js, spectrum_canvas.js
│   └── test/dsp_and_tutor.test.mjs   # 10 automated Node.js DSP, parser, tutor & storage tests
├── native/                           # Shared C++17 DSP engine, PulseAudio capture, CLI & 64 tests
└── app/                              # Flutter Dart FFI cross-platform client
```

---

## Known Limitations

1. **Dense Low-Bass Chords (< C2)**: Below ~65 Hz, a 4096-sample FFT (~11.7 Hz/bin) has limited semitone separation for dense adjacent bass clusters.
2. **Heavy Sustain Pedal Reverb**: Continuous sustain pedal across 6+ voices in a reverberant room can introduce overtone bleed; switching to **Monophonic (YIN)** in the top bar provides maximum single-line accuracy.
3. **PDF / Image OMR**: Intentionally omitted per project scope; `.mid` (song data only), `.musicxml`/`.xml`, and `.abc` (file or pasted text) are supported directly in the browser.
