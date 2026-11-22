#pragma once

#include "piano_dsp/types.h"
#include <vector>

namespace piano_dsp {

/**
 * Spectral-flux onset detector paired with a note state machine.
 * Prevents sustained piano notes from repeatedly triggering duplicate NoteOn events,
 * while still catching re-articulated (repeated) strikes of the same key via flux spikes.
 */
class OnsetAndNoteTracker {
public:
    OnsetAndNoteTracker() = default;

    void reset();

    /**
     * Update state with the current frame's spectrum and top pitch candidate.
     *
     * @param mag_spec        FFT magnitude spectrum of current frame.
     * @param candidate       Best pitch candidate (midi_note == -1 if unvoiced/silent).
     * @param rms_db          Current frame RMS in dBFS.
     * @param timestamp_sec   Current stream time in seconds.
     * @param config          Pipeline configuration.
     * @param out_flux        Receives computed positive spectral flux.
     * @param out_is_onset    Receives true if a percussive/harmonic onset spike was detected.
     * @param out_events      Appends any NoteOff / NoteOn events emitted on this frame.
     * @return                Currently active (sustained) MIDI note, or -1 if none.
     */
    int process(const std::vector<float>& mag_spec,
                const PitchCandidate& candidate,
                float rms_db,
                double timestamp_sec,
                const PipelineConfig& config,
                float& out_flux,
                bool& out_is_onset,
                std::vector<NoteEvent>& out_events);

    int active_midi() const { return active_midi_; }

private:
    std::vector<float> prev_mag_;
    float flux_ema_ = 0.0f;
    float prev_rms_db_ = -100.0f;
    float min_rms_since_onset_ = 0.0f;
    int frames_since_note_on_ = 0;
    int rebound_confirm_frames_ = 0;
    int onset_cooldown_frames_ = 0;

    int active_midi_ = -1;
    int pending_midi_ = -1;
    int pending_count_ = 0;
    int silent_count_ = 0;
};

} // namespace piano_dsp
