#pragma once

#include "piano_dsp/types.h"
#include <string>
#include <vector>

namespace piano_dsp {

struct RecordedNote {
    int midi_note = -1;
    float frequency_hz = 0.0f;
    double start_sec = 0.0;
    double end_sec = 0.0;
    double duration_sec = 0.0;
    float confidence = 0.0f;
    float velocity_est = 0.0f;
};

/**
 * Records a sequence of detected NoteOn / NoteOff events into clean RecordedNote entries.
 * Filters out ultra-short transient glitches (< min_note_duration_sec) and merges/closes
 * active notes cleanly when recording stops.
 */
class MelodyRecorder {
public:
    explicit MelodyRecorder(double min_note_duration_sec = 0.045);

    void start(double stream_time_sec = 0.0);
    void stop(double stream_time_sec);
    void clear();

    bool is_recording() const { return recording_; }

    // Feed a NoteEvent emitted by AudioPipeline.
    void on_note_event(const NoteEvent& evt);

    const std::vector<RecordedNote>& notes() const { return notes_; }

    // Export recorded notes as CSV (index,note,midi,start_sec,duration_sec,hz,confidence,velocity).
    std::string to_csv() const;

private:
    void finalize_active_note(double end_time_sec);

    double min_note_duration_sec_;
    bool recording_ = false;
    double start_origin_sec_ = 0.0;
    bool has_active_ = false;
    RecordedNote active_note_{};
    std::vector<RecordedNote> notes_;
};

} // namespace piano_dsp
