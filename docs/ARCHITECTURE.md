# PianoTutor — System Architecture & DSP Design

## 1. Architectural Overview

PianoTutor uses a **shared C++17 DSP core** exposed over a stable **C-ABI FFI boundary** to a **Flutter** cross-platform UI (Android, Linux, Windows).

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         Flutter UI (Dart / Material 3)                    │
│  M1: PitchDetectorScreen  │  M3: Falling-Note Canvas  │  M4+: Tutor/OMR   │
└──────────────────┬───────────────────────────────────┬────────────────────┘
                   │ Dart FFI (30 ms snapshot poll)    │ Unified SongModel
                   ▼                                   ▼
┌─────────────────────────────────────────┐  ┌──────────────────────────────┐
│     C-ABI Bridge (piano_dsp_ffi.h)      │  │   Song Importers (M3+)       │
│  push_audio / process / get_snapshot /  │  │  • MIDI (song data only)     │
│  pop_note_event / start_mic / stop_mic  │  │  • MusicXML (.xml/.mxl)      │
└──────────────────┬──────────────────────┘  │  • ABC Notation              │
                   │                         │  • PDF/Image -> Audiveris    │
                   ▼                         │    OMR -> MusicXML -> Review │
┌─────────────────────────────────────────┐  └──────────────────────────────┘
│       C++17 AudioPipeline (native/)     │
│  1. Lock-free SPSC RingBuffer           │
│  2. Overlapping 4096-sample / 512-hop   │
│  3. Continuous Biquad HP (25Hz)/LP(4.5k)│
│  4. Adaptive Noise Floor & RMS Gate     │
│  5. Hann-Windowed Radix-2 FFT           │
│  6. Pluggable IPitchEstimator           │
│     • M1: YinPitchEstimator (FFT-YIN)   │
│     • M5: PolyphonicEstimator (planned) │
│  7. Spectral Flux Onset & Note Tracker  │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│    Platform Microphone Capture Layer    │
│  • Linux:   PulseAudio / PipeWire       │
│  • Windows: WASAPI / Flutter PCM stream │
│  • Android: AAudio / Flutter PCM stream │
│  (NO MIDI hardware input anywhere)      │
└─────────────────────────────────────────┘
```

## 2. Audio DSP Pipeline Justification (Real Piano Acoustics)

Real acoustic pianos and digital pianos played through speakers differ significantly from pure sine waves:
- **Stiff-string inharmonicity**: Overtones are stretched sharp according to $f_n = n f_0 \sqrt{1 + B n^2}$.
- **Weak/missing bass fundamentals**: On upright pianos and phone/laptop microphones, notes below C2 (65.4 Hz) often have stronger 2nd and 3rd harmonics than fundamentals.
- **Percussive hammer transient**: The first 10–20 ms contains broadband felt/wood impact noise.
- **Long sustain decay**: A single key rings for 1–6 seconds; naive frame-by-frame pitch reporting spams duplicate note events.

### Pipeline Stages
1. **Sample Rates**: Supports **44.1 kHz** and **48 kHz** mono `float32` PCM.
2. **Lock-Free Buffering**: `RingBuffer<float>` decouples the real-time audio capture thread from the DSP processing loop without locks or heap allocations on the audio callback.
3. **Framing**: `frame_size = 4096` (~85.3 ms at 48 kHz, ~92.9 ms at 44.1 kHz) provides >2 full periods at piano A0 (27.5 Hz, period ~1745 samples). `hop_size = 512` (87.5% overlap, ~10.7 ms step) yields low-latency onset and pitch updates.
4. **Continuous Band-Pass Filtering**: Direct-Form-II Transposed Butterworth biquads (25 Hz high-pass to reject DC/HVAC rumble, 4500 Hz low-pass to suppress hiss while preserving fundamentals up to C8 = 4186 Hz) run continuously on each incoming hop to avoid overlap discontinuities.
5. **FFT-Accelerated YIN (`YinPitchEstimator`)**:
   - Computes the YIN difference function $d(\tau)$ via size-$N$ Radix-2 FFT cross-correlation in $O(N \log N)$ instead of $O(N^2)$ (zero circular wrap-around because $W = N/2$).
   - Computes CMNDF $d'(\tau)$, finds the first local minimum below `yin_threshold` (0.15), and applies parabolic interpolation for sub-sample frequency precision.
   - **Spectral Octave Disambiguation**:
     - *Sub-octave guard*: Compares odd partial energy ($f, 3f, 5f$) against even partial energy ($2f, 4f, 6f$) to catch half-integer lag sub-octave locks (e.g., C8 at 4186 Hz).
     - *Bass weak-fundamental guard*: Verifies genuine local spectral maxima (rejecting Hann main-lobe skirts) before accepting a lower-octave candidate.
6. **Onset & Note State Tracker (`OnsetAndNoteTracker`)**:
   - Half-wave rectified spectral flux with exponential moving baseline and RMS-delta gating.
   - Hysteresis state machine (`stable_frames_required = 2`, `release_frames_required = 4`, 12-frame post-NoteOn refractory cooldown) prevents sustained piano notes from emitting duplicate `NoteOn` events while still capturing distinct re-strikes.

## 3. Pluggable Polyphonic Upgrade Path (Milestone 5)

`AudioPipeline` depends only on `IPitchEstimator`, which returns `std::vector<PitchCandidate>`.
Milestone 1 plugs in `YinPitchEstimator` (monophonic). Milestone 5 will introduce a polyphonic estimator (e.g., multi-pitch harmonic summation / NMF or an ONNX-backed piano transcription model such as Onsets-and-Frames / BasicPitch) behind the exact same `IPitchEstimator` interface without rewriting the pipeline, FFI bridge, or Flutter UI.

## 4. Unified Song Model & OMR Pipeline (Milestones 3–6)

All imported formats (MIDI files as **song data only**, MusicXML, ABC, and PDF/image scores processed via Audiveris OMR -> MusicXML) normalize into `SongModel` (`app/lib/models/song_model.dart`). Uncertain OMR notes carry `confidence < 1.0` so the Milestone 4+ score-correction screen can flag them for user review before practice.
