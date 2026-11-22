#pragma once

#include <string>
#include <vector>

namespace piano_dsp {

enum class PianoHand : int {
    Unknown = 0,
    Right = 1,
    Left = 2
};

struct SongNote {
    int midi_pitch = -1;
    double start_sec = 0.0;
    double duration_sec = 0.0;
    float velocity = 0.8f;      // Normalized 0.0..1.0
    int track_index = 0;
    PianoHand hand = PianoHand::Unknown;
    int measure_number = 1;
    int voice = 1;
    float confidence = 1.0f;    // < 1.0 flags uncertain OMR notes for user review
};

struct TempoEvent {
    int tick = 0;
    double time_sec = 0.0;
    double bpm = 120.0;
    int microseconds_per_quarter = 500000;
};

struct SongData {
    std::string title;
    std::string source_format;  // "midi", "musicxml", "abc", "omr", "builtin"
    int ticks_per_quarter = 480;
    int time_sig_numerator = 4;
    int time_sig_denominator = 4;
    int key_sig_fifths = 0;
    std::vector<TempoEvent> tempo_map;
    std::vector<SongNote> notes;

    double total_duration_sec() const {
        double end = 0.0;
        for (const auto& n : notes) {
            const double e = n.start_sec + n.duration_sec;
            if (e > end) end = e;
        }
        return end;
    }
};

} // namespace piano_dsp
