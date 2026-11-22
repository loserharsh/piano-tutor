#include "piano_dsp/piano_dsp_ffi.h"
#include "piano_dsp/audio_capture.h"
#include "piano_dsp/audio_pipeline.h"
#include "piano_dsp/pitch_utils.h"
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

struct PianoDspEngine {
    std::unique_ptr<piano_dsp::AudioPipeline> pipeline;
    std::unique_ptr<piano_dsp::IAudioCapture> capture;
    std::string last_error;
};

extern "C" {

PIANO_DSP_API PianoDspEngine* piano_dsp_create(int32_t sample_rate,
                                               int32_t frame_size,
                                               int32_t hop_size) {
    piano_dsp::PipelineConfig cfg;
    cfg.sample_rate = (sample_rate == 44100 || sample_rate == 48000) ? sample_rate : 48000;
    cfg.frame_size = (frame_size >= 1024 && (frame_size & (frame_size - 1)) == 0) ? frame_size : 4096;
    cfg.hop_size = (hop_size >= 128 && hop_size <= cfg.frame_size / 2) ? hop_size : 512;

    auto* engine = new PianoDspEngine();
    engine->pipeline = std::make_unique<piano_dsp::AudioPipeline>(cfg);
    engine->capture = piano_dsp::create_native_audio_capture();
    return engine;
}

PIANO_DSP_API void piano_dsp_destroy(PianoDspEngine* engine) {
    if (!engine) return;
    if (engine->capture && engine->capture->is_running()) {
        engine->capture->stop();
    }
    delete engine;
}

PIANO_DSP_API void piano_dsp_reset(PianoDspEngine* engine) {
    if (!engine || !engine->pipeline) return;
    engine->pipeline->reset();
}

PIANO_DSP_API void piano_dsp_set_noise_gate_db(PianoDspEngine* engine, float noise_gate_db) {
    if (!engine || !engine->pipeline) return;
    engine->pipeline->update_noise_gate_db(noise_gate_db);
}

PIANO_DSP_API void piano_dsp_set_yin_threshold(PianoDspEngine* engine, float yin_threshold) {
    if (!engine || !engine->pipeline) return;
    engine->pipeline->update_yin_threshold(yin_threshold);
}

PIANO_DSP_API int32_t piano_dsp_push_audio(PianoDspEngine* engine,
                                           const float* samples,
                                           int32_t sample_count) {
    if (!engine || !engine->pipeline || !samples || sample_count <= 0) return 0;
    return static_cast<int32_t>(
        engine->pipeline->push_audio(samples, static_cast<size_t>(sample_count)));
}

PIANO_DSP_API int32_t piano_dsp_process(PianoDspEngine* engine) {
    if (!engine || !engine->pipeline) return 0;
    return engine->pipeline->process_available();
}

PIANO_DSP_API int32_t piano_dsp_start_mic(PianoDspEngine* engine, const char* device_id) {
    if (!engine || !engine->pipeline || !engine->capture) return -1;

    const std::string dev = device_id ? std::string(device_id) : std::string();
    const auto& cfg = engine->pipeline->config();
    auto res = engine->capture->start(
        cfg.sample_rate,
        cfg.hop_size,
        dev,
        [pipeline = engine->pipeline.get()](const float* samples, size_t count) {
            pipeline->push_audio(samples, count);
        });

    if (res.status != piano_dsp::CaptureStatus::Ok) {
        engine->last_error = res.message;
        return static_cast<int32_t>(res.status);
    }
    engine->last_error.clear();
    return 0;
}

PIANO_DSP_API void piano_dsp_stop_mic(PianoDspEngine* engine) {
    if (!engine || !engine->capture) return;
    engine->capture->stop();
}

PIANO_DSP_API int32_t piano_dsp_is_mic_running(PianoDspEngine* engine) {
    if (!engine || !engine->capture) return 0;
    return engine->capture->is_running() ? 1 : 0;
}

PIANO_DSP_API const char* piano_dsp_last_error(PianoDspEngine* engine) {
    if (!engine) return "Engine handle is null";
    return engine->last_error.c_str();
}

PIANO_DSP_API void piano_dsp_get_snapshot(PianoDspEngine* engine, PianoDspSnapshot* out_snapshot) {
    if (!out_snapshot) return;
    std::memset(out_snapshot, 0, sizeof(PianoDspSnapshot));
    if (!engine || !engine->pipeline) return;

    const auto snap = engine->pipeline->latest_snapshot();
    out_snapshot->has_pitch = snap.has_pitch ? 1 : 0;
    out_snapshot->frequency_hz = snap.frequency_hz;
    out_snapshot->midi_note = snap.midi_note;
    out_snapshot->cents_offset = snap.cents_offset;
    out_snapshot->confidence = snap.confidence;
    out_snapshot->rms_db = snap.rms_db;
    out_snapshot->noise_floor_db = snap.noise_floor_db;
    out_snapshot->spectral_flux = snap.spectral_flux;
    out_snapshot->is_onset = snap.is_onset ? 1 : 0;
    out_snapshot->active_note_midi = snap.active_note_midi;
    out_snapshot->timestamp_sec = snap.timestamp_sec;
    std::memcpy(out_snapshot->spectrum_bins, snap.spectrum_bins, sizeof(snap.spectrum_bins));
}

PIANO_DSP_API int32_t piano_dsp_pop_note_event(PianoDspEngine* engine, PianoDspNoteEvent* out_event) {
    if (!engine || !engine->pipeline || !out_event) return 0;
    piano_dsp::NoteEvent evt;
    if (!engine->pipeline->pop_note_event(evt)) {
        return 0;
    }
    out_event->type = static_cast<int32_t>(evt.type);
    out_event->midi_note = evt.midi_note;
    out_event->frequency_hz = evt.frequency_hz;
    out_event->confidence = evt.confidence;
    out_event->velocity_est = evt.velocity_est;
    out_event->timestamp_sec = evt.timestamp_sec;
    return 1;
}

PIANO_DSP_API void piano_dsp_start_recording(PianoDspEngine* engine) {
    if (!engine || !engine->pipeline) return;
    engine->pipeline->start_recording();
}

PIANO_DSP_API void piano_dsp_stop_recording(PianoDspEngine* engine) {
    if (!engine || !engine->pipeline) return;
    engine->pipeline->stop_recording();
}

PIANO_DSP_API int32_t piano_dsp_is_recording(PianoDspEngine* engine) {
    if (!engine || !engine->pipeline) return 0;
    return engine->pipeline->is_recording() ? 1 : 0;
}

PIANO_DSP_API int32_t piano_dsp_get_recorded_count(PianoDspEngine* engine) {
    if (!engine || !engine->pipeline) return 0;
    return static_cast<int32_t>(engine->pipeline->recorded_notes().size());
}

PIANO_DSP_API int32_t piano_dsp_get_recorded_note(PianoDspEngine* engine,
                                                  int32_t index,
                                                  PianoDspRecordedNote* out_note) {
    if (!engine || !engine->pipeline || !out_note || index < 0) return 0;
    const auto notes = engine->pipeline->recorded_notes();
    if (static_cast<size_t>(index) >= notes.size()) return 0;
    const auto& n = notes[static_cast<size_t>(index)];
    out_note->midi_note = n.midi_note;
    out_note->frequency_hz = n.frequency_hz;
    out_note->start_sec = n.start_sec;
    out_note->end_sec = n.end_sec;
    out_note->duration_sec = n.duration_sec;
    out_note->confidence = n.confidence;
    out_note->velocity_est = n.velocity_est;
    return 1;
}

PIANO_DSP_API void piano_dsp_midi_to_name(int32_t midi_note, char* out_buf, int32_t buf_len) {
    if (!out_buf || buf_len <= 0) return;
    const std::string name = piano_dsp::PitchUtils::midi_to_note_name(midi_note);
    std::snprintf(out_buf, static_cast<size_t>(buf_len), "%s", name.c_str());
}

} // extern "C"
