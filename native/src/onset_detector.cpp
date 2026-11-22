#include "piano_dsp/onset_detector.h"
#include <algorithm>
#include <cmath>

namespace piano_dsp {

void OnsetAndNoteTracker::reset() {
    prev_mag_.clear();
    flux_ema_ = 0.0f;
    prev_rms_db_ = -100.0f;
    min_rms_since_onset_ = 0.0f;
    frames_since_note_on_ = 0;
    rebound_confirm_frames_ = 0;
    onset_cooldown_frames_ = 0;
    active_midi_ = -1;
    pending_midi_ = -1;
    pending_count_ = 0;
    silent_count_ = 0;
}

int OnsetAndNoteTracker::process(const std::vector<float>& mag_spec,
                                 const PitchCandidate& candidate,
                                 float rms_db,
                                 double timestamp_sec,
                                 const PipelineConfig& config,
                                 float& out_flux,
                                 bool& out_is_onset,
                                 std::vector<NoteEvent>& out_events) {
    out_flux = 0.0f;
    out_is_onset = false;

    // 1. Half-wave rectified spectral flux.
    if (prev_mag_.size() == mag_spec.size()) {
        float flux = 0.0f;
        for (size_t i = 1; i < mag_spec.size(); ++i) {
            const float diff = mag_spec[i] - prev_mag_[i];
            if (diff > 0.0f) {
                flux += diff;
            }
        }
        out_flux = flux;
    }
    prev_mag_ = mag_spec;

    if (onset_cooldown_frames_ > 0) {
        --onset_cooldown_frames_;
    }

    // Adaptive spectral flux baseline.
    const float prev_ema = flux_ema_;
    flux_ema_ = (flux_ema_ == 0.0f) ? out_flux : (0.85f * flux_ema_ + 0.15f * out_flux);

    const float rms_delta_db = rms_db - prev_rms_db_;
    prev_rms_db_ = rms_db;

    const bool above_gate = (rms_db > config.noise_gate_db);
    if (above_gate && prev_ema > 1e-4f &&
        out_flux > prev_ema * config.onset_flux_threshold && out_flux > 0.04f &&
        rms_delta_db > 0.6f) {
        out_is_onset = true;
    }

    // Normalize velocity estimate roughly from [-50 dB, -6 dB] -> [0.05, 1.0].
    const float vel = std::clamp((rms_db + 50.0f) / 44.0f, 0.05f, 1.0f);

    const bool has_valid_pitch = (candidate.midi_note >= kPianoMinMidi &&
                                  candidate.midi_note <= kPianoMaxMidi &&
                                  candidate.confidence >= config.min_confidence);

    if (!has_valid_pitch) {
        pending_midi_ = -1;
        pending_count_ = 0;
        if (active_midi_ != -1) {
            ++silent_count_;
            if (silent_count_ >= config.release_frames_required) {
                NoteEvent off_evt;
                off_evt.type = NoteEventType::NoteOff;
                off_evt.midi_note = active_midi_;
                off_evt.timestamp_sec = timestamp_sec;
                out_events.push_back(off_evt);
                active_midi_ = -1;
                silent_count_ = 0;
                frames_since_note_on_ = 0;
            }
        }
        return active_midi_;
    }

    // Valid pitch detected.
    silent_count_ = 0;

    if (candidate.midi_note == active_midi_) {
        // Same sustained note: track post-attack decay trough, and only re-trigger if
        // a genuine re-strike raises energy sharply above the decay trough after cooldown.
        pending_midi_ = -1;
        pending_count_ = 0;
        ++frames_since_note_on_;

        if (frames_since_note_on_ <= 10) {
            // Wait for initial ~85ms analysis window to finish filling before tracking decay trough.
            min_rms_since_onset_ = rms_db;
            rebound_confirm_frames_ = 0;
        } else {
            if (rms_db < min_rms_since_onset_) {
                min_rms_since_onset_ = rms_db;
                rebound_confirm_frames_ = 0;
            }
            const bool above_trough = (rms_db >= min_rms_since_onset_ + 2.5f);
            if (onset_cooldown_frames_ == 0 && above_trough &&
                (rebound_confirm_frames_ > 0 || rms_delta_db > 0.5f)) {
                ++rebound_confirm_frames_;
                // Wait 4 frames (~45 ms) to confirm pitch remains on active_midi_
                // rather than transitioning to a different newly-struck key.
                if (rebound_confirm_frames_ >= 4) {
                    NoteEvent off_evt;
                    off_evt.type = NoteEventType::NoteOff;
                    off_evt.midi_note = active_midi_;
                    off_evt.timestamp_sec = timestamp_sec;
                    out_events.push_back(off_evt);

                    NoteEvent on_evt;
                    on_evt.type = NoteEventType::NoteOn;
                    on_evt.midi_note = candidate.midi_note;
                    on_evt.frequency_hz = candidate.frequency_hz;
                    on_evt.confidence = candidate.confidence;
                    on_evt.velocity_est = vel;
                    on_evt.timestamp_sec = timestamp_sec;
                    out_events.push_back(on_evt);
                    onset_cooldown_frames_ = 14;
                    frames_since_note_on_ = 0;
                    rebound_confirm_frames_ = 0;
                    min_rms_since_onset_ = rms_db;
                }
            } else {
                rebound_confirm_frames_ = 0;
            }
        }
        return active_midi_;
    }

    // Candidate differs from currently active note: cancel any pending same-note rebound.
    rebound_confirm_frames_ = 0;
    if (candidate.midi_note == pending_midi_) {
        ++pending_count_;
    } else {
        pending_midi_ = candidate.midi_note;
        pending_count_ = 1;
    }

    if (pending_count_ >= config.stable_frames_required) {
        if (active_midi_ != -1) {
            NoteEvent off_evt;
            off_evt.type = NoteEventType::NoteOff;
            off_evt.midi_note = active_midi_;
            off_evt.timestamp_sec = timestamp_sec;
            out_events.push_back(off_evt);
        }
        active_midi_ = pending_midi_;
        pending_midi_ = -1;
        pending_count_ = 0;
        onset_cooldown_frames_ = 12;
        frames_since_note_on_ = 0;
        min_rms_since_onset_ = rms_db;

        NoteEvent on_evt;
        on_evt.type = NoteEventType::NoteOn;
        on_evt.midi_note = active_midi_;
        on_evt.frequency_hz = candidate.frequency_hz;
        on_evt.confidence = candidate.confidence;
        on_evt.velocity_est = vel;
        on_evt.timestamp_sec = timestamp_sec;
        out_events.push_back(on_evt);
    }

    return active_midi_;
}

} // namespace piano_dsp
