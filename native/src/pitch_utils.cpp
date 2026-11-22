#include "piano_dsp/pitch_utils.h"
#include "piano_dsp/types.h"
#include <cmath>

namespace piano_dsp {

namespace {
constexpr const char* kNoteNames[12] = {
    "C", "C#", "D", "D#", "E", "F",
    "F#", "G", "G#", "A", "A#", "B"
};
}

float PitchUtils::hz_to_midi_float(float hz, float a4_hz) {
    if (hz <= 0.0f || a4_hz <= 0.0f) return -1.0f;
    return 69.0f + 12.0f * std::log2(hz / a4_hz);
}

int PitchUtils::hz_to_midi(float hz, float& cents_out, float a4_hz) {
    if (hz <= 0.0f || a4_hz <= 0.0f) {
        cents_out = 0.0f;
        return -1;
    }
    const float midi_f = hz_to_midi_float(hz, a4_hz);
    const int midi_i = static_cast<int>(std::lround(midi_f));
    cents_out = (midi_f - static_cast<float>(midi_i)) * 100.0f;
    return midi_i;
}

float PitchUtils::midi_to_hz(int midi_note, float a4_hz) {
    return a4_hz * std::pow(2.0f, static_cast<float>(midi_note - 69) / 12.0f);
}

std::string PitchUtils::midi_to_note_name(int midi_note) {
    if (midi_note < 0 || midi_note > 127) {
        return "--";
    }
    const int pitch_class = midi_note % 12;
    const int octave = (midi_note / 12) - 1;
    return std::string(kNoteNames[pitch_class]) + std::to_string(octave);
}

bool PitchUtils::is_piano_midi(int midi_note) {
    return midi_note >= kPianoMinMidi && midi_note <= kPianoMaxMidi;
}

} // namespace piano_dsp
