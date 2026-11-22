#pragma once

#include "piano_dsp/song_types.h"
#include <cstdint>
#include <string>
#include <vector>

namespace piano_dsp {

/**
 * Standard MIDI File (SMF Type 0 and Type 1) parser — SONG DATA ONLY.
 *
 * Strictly extracts expected musical notes, velocities, timings, tempo changes,
 * time/key signatures, and hand assignments into the unified SongData model.
 * Never interacts with MIDI hardware or MIDI keyboard input.
 */
class MidiSongParser {
public:
    static bool parse_bytes(const uint8_t* data,
                            size_t size,
                            SongData& out_song,
                            std::string& out_error);

    static bool parse_file(const std::string& file_path,
                           SongData& out_song,
                           std::string& out_error);
};

} // namespace piano_dsp
