#pragma once

#include <string>

namespace piano_dsp {

/**
 * Musical pitch conversion utilities.
 * Note: MIDI note numbers are strictly an internal pitch representation (A0=21 .. C8=108).
 * No MIDI hardware or MIDI input is ever used.
 */
class PitchUtils {
public:
    // Convert frequency in Hz to fractional MIDI note number.
    static float hz_to_midi_float(float hz, float a4_hz = 440.0f);

    // Convert frequency in Hz to nearest integer MIDI note and cents deviation (-50..+50).
    static int hz_to_midi(float hz, float& cents_out, float a4_hz = 440.0f);

    // Convert integer MIDI note number to equal-temperament frequency in Hz.
    static float midi_to_hz(int midi_note, float a4_hz = 440.0f);

    // Format integer MIDI note as scientific pitch notation (e.g. 60 -> "C4", 69 -> "A4").
    static std::string midi_to_note_name(int midi_note);

    // Check if MIDI note is within standard 88-key piano range (A0=21 to C8=108).
    static bool is_piano_midi(int midi_note);
};

} // namespace piano_dsp
