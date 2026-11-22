#pragma once

#include <stdint.h>

#ifdef _WIN32
  #define PIANO_DSP_API __declspec(dllexport)
#else
  #define PIANO_DSP_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct PianoDspEngine PianoDspEngine;

typedef struct PianoDspSnapshot {
    int32_t has_pitch;
    float frequency_hz;
    int32_t midi_note;
    float cents_offset;
    float confidence;
    float rms_db;
    float noise_floor_db;
    float spectral_flux;
    int32_t is_onset;
    int32_t active_note_midi;
    double timestamp_sec;
    float spectrum_bins[64];
} PianoDspSnapshot;

typedef struct PianoDspNoteEvent {
    int32_t type;          // 0=None, 1=NoteOn, 2=NoteOff
    int32_t midi_note;
    float frequency_hz;
    float confidence;
    float velocity_est;
    double timestamp_sec;
} PianoDspNoteEvent;

// Create/destroy DSP engine (supports 44100 or 48000 Hz; frame_size defaults to 4096, hop to 512).
PIANO_DSP_API PianoDspEngine* piano_dsp_create(int32_t sample_rate,
                                               int32_t frame_size,
                                               int32_t hop_size);
PIANO_DSP_API void piano_dsp_destroy(PianoDspEngine* engine);
PIANO_DSP_API void piano_dsp_reset(PianoDspEngine* engine);

// Configuration setters.
PIANO_DSP_API void piano_dsp_set_noise_gate_db(PianoDspEngine* engine, float noise_gate_db);
PIANO_DSP_API void piano_dsp_set_yin_threshold(PianoDspEngine* engine, float yin_threshold);

// Push raw mono float32 PCM samples [-1.0, 1.0] (used by Android/Flutter capture or tests).
PIANO_DSP_API int32_t piano_dsp_push_audio(PianoDspEngine* engine,
                                           const float* samples,
                                           int32_t sample_count);

// Process buffered audio hops; returns number of analysis frames processed.
PIANO_DSP_API int32_t piano_dsp_process(PianoDspEngine* engine);

// Start/stop built-in native microphone capture (Linux PulseAudio / Windows WASAPI).
// Returns 0 on success, non-zero error code on failure.
PIANO_DSP_API int32_t piano_dsp_start_mic(PianoDspEngine* engine, const char* device_id);
PIANO_DSP_API void piano_dsp_stop_mic(PianoDspEngine* engine);
PIANO_DSP_API int32_t piano_dsp_is_mic_running(PianoDspEngine* engine);
PIANO_DSP_API const char* piano_dsp_last_error(PianoDspEngine* engine);

typedef struct PianoDspRecordedNote {
    int32_t midi_note;
    float frequency_hz;
    double start_sec;
    double end_sec;
    double duration_sec;
    float confidence;
    float velocity_est;
} PianoDspRecordedNote;

// Read latest snapshot and pop note events.
PIANO_DSP_API void piano_dsp_get_snapshot(PianoDspEngine* engine, PianoDspSnapshot* out_snapshot);
PIANO_DSP_API int32_t piano_dsp_pop_note_event(PianoDspEngine* engine, PianoDspNoteEvent* out_event);

// Milestone 2: Melody sequence recording.
PIANO_DSP_API void piano_dsp_start_recording(PianoDspEngine* engine);
PIANO_DSP_API void piano_dsp_stop_recording(PianoDspEngine* engine);
PIANO_DSP_API int32_t piano_dsp_is_recording(PianoDspEngine* engine);
PIANO_DSP_API int32_t piano_dsp_get_recorded_count(PianoDspEngine* engine);
PIANO_DSP_API int32_t piano_dsp_get_recorded_note(PianoDspEngine* engine,
                                                  int32_t index,
                                                  PianoDspRecordedNote* out_note);

// Utility: format MIDI note to scientific name (e.g. 60 -> "C4").
PIANO_DSP_API void piano_dsp_midi_to_name(int32_t midi_note, char* out_buf, int32_t buf_len);

#ifdef __cplusplus
}
#endif
