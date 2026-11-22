#include "piano_dsp/melody_recorder.h"
#include "piano_dsp/pitch_utils.h"
#include <iomanip>
#include <sstream>

namespace piano_dsp {

MelodyRecorder::MelodyRecorder(double min_note_duration_sec)
    : min_note_duration_sec_(min_note_duration_sec) {}

void MelodyRecorder::start(double stream_time_sec) {
    notes_.clear();
    has_active_ = false;
    active_note_ = RecordedNote{};
    start_origin_sec_ = stream_time_sec;
    recording_ = true;
}

void MelodyRecorder::stop(double stream_time_sec) {
    if (!recording_) return;
    if (has_active_) {
        finalize_active_note(stream_time_sec);
    }
    recording_ = false;
}

void MelodyRecorder::clear() {
    notes_.clear();
    has_active_ = false;
    active_note_ = RecordedNote{};
    recording_ = false;
}

void MelodyRecorder::on_note_event(const NoteEvent& evt) {
    if (!recording_) return;

    if (evt.type == NoteEventType::NoteOff) {
        if (has_active_ && active_note_.midi_note == evt.midi_note) {
            finalize_active_note(evt.timestamp_sec);
        }
        return;
    }

    if (evt.type == NoteEventType::NoteOn) {
        // Close any previously open monophonic note.
        if (has_active_) {
            finalize_active_note(evt.timestamp_sec);
        }
        active_note_ = RecordedNote{};
        active_note_.midi_note = evt.midi_note;
        active_note_.frequency_hz = evt.frequency_hz;
        active_note_.start_sec = evt.timestamp_sec - start_origin_sec_;
        if (active_note_.start_sec < 0.0) active_note_.start_sec = 0.0;
        active_note_.confidence = evt.confidence;
        active_note_.velocity_est = evt.velocity_est;
        has_active_ = true;
    }
}

void MelodyRecorder::finalize_active_note(double end_time_sec) {
    if (!has_active_) return;
    double rel_end = end_time_sec - start_origin_sec_;
    if (rel_end < active_note_.start_sec) {
        rel_end = active_note_.start_sec;
    }
    active_note_.end_sec = rel_end;
    active_note_.duration_sec = rel_end - active_note_.start_sec;

    if (active_note_.duration_sec >= min_note_duration_sec_) {
        notes_.push_back(active_note_);
    }
    has_active_ = false;
}

std::string MelodyRecorder::to_csv() const {
    std::ostringstream oss;
    oss << "index,note,midi,start_sec,duration_sec,hz,confidence,velocity\n";
    oss << std::fixed;
    for (size_t i = 0; i < notes_.size(); ++i) {
        const auto& n = notes_[i];
        oss << i << ","
            << PitchUtils::midi_to_note_name(n.midi_note) << ","
            << n.midi_note << ","
            << std::setprecision(4) << n.start_sec << ","
            << std::setprecision(4) << n.duration_sec << ","
            << std::setprecision(2) << n.frequency_hz << ","
            << std::setprecision(3) << n.confidence << ","
            << std::setprecision(3) << n.velocity_est << "\n";
    }
    return oss.str();
}

} // namespace piano_dsp
