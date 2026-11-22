#pragma once

#include <cstdint>
#include <cstddef>

namespace piano_dsp {

constexpr int kPianoMinMidi = 21;   // A0 (27.50 Hz)
constexpr int kPianoMaxMidi = 108;  // C8 (4186.01 Hz)
constexpr float kMinPianoHz = 26.0f;
constexpr float kMaxPianoHz = 4300.0f;
constexpr int kSpectrumBins = 64;   // Log-spaced visualization bins (27.5 Hz - 4500 Hz)
constexpr int kMaxPolyphony = 12;   // Reserved for Milestone 5 polyphonic recognition

struct PipelineConfig {
    int sample_rate = 48000;          // 44100 or 48000 Hz
    int frame_size = 4096;            // Must be power of 2 (>= 4096 for A0 resolution)
    int hop_size = 512;               // Overlap step (~10.7 ms @ 48 kHz)
    float yin_threshold = 0.15f;      // CMNDF threshold (lower = stricter)
    float noise_gate_db = -50.0f;     // Minimum RMS level in dBFS to run pitch detection
    float min_confidence = 0.60f;     // Minimum confidence to report an active pitch
    float a4_reference_hz = 440.0f;   // Concert pitch reference (configurable)
    float onset_flux_threshold = 1.8f;// Relative spectral flux multiplier for note onset
    int stable_frames_required = 2;   // Consecutive frames before emitting NoteOn
    int release_frames_required = 4;  // Consecutive silent/changed frames before NoteOff
};

struct PitchCandidate {
    float frequency_hz = 0.0f;
    int midi_note = -1;               // 21..108, or -1 if invalid
    float cents_offset = 0.0f;        // Deviation from equal temperament (-50..+50)
    float confidence = 0.0f;          // 0.0..1.0
    float energy = 0.0f;              // Relative spectral energy
};

enum class NoteEventType : int32_t {
    None = 0,
    NoteOn = 1,
    NoteOff = 2
};

struct NoteEvent {
    NoteEventType type = NoteEventType::None;
    int midi_note = -1;
    float frequency_hz = 0.0f;
    float confidence = 0.0f;
    float velocity_est = 0.0f;        // Estimated loudness 0.0..1.0 from RMS
    double timestamp_sec = 0.0;       // Stream time in seconds
};

struct AnalysisSnapshot {
    bool has_pitch = false;
    float frequency_hz = 0.0f;
    int midi_note = -1;
    float cents_offset = 0.0f;
    float confidence = 0.0f;
    float rms_db = -100.0f;
    float noise_floor_db = -70.0f;
    float spectral_flux = 0.0f;
    bool is_onset = false;
    int active_note_midi = -1;        // Currently sustained note tracked by state machine
    double timestamp_sec = 0.0;
    float spectrum_bins[kSpectrumBins] = {0.0f}; // Normalized 0..1 log-frequency magnitudes
};

} // namespace piano_dsp
