#include "piano_dsp/midi_song_parser.h"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <fstream>
#include <map>

namespace piano_dsp {

namespace {

uint16_t read_be16(const uint8_t* p) {
    return static_cast<uint16_t>((static_cast<uint16_t>(p[0]) << 8) | p[1]);
}

uint32_t read_be32(const uint8_t* p) {
    return (static_cast<uint32_t>(p[0]) << 24) |
           (static_cast<uint32_t>(p[1]) << 16) |
           (static_cast<uint32_t>(p[2]) << 8) |
           static_cast<uint32_t>(p[3]);
}

bool read_vlq(const uint8_t* data, size_t end, size_t& pos, uint32_t& out_val) {
    out_val = 0;
    for (int i = 0; i < 4; ++i) {
        if (pos >= end) return false;
        const uint8_t b = data[pos++];
        out_val = (out_val << 7) | (b & 0x7Fu);
        if ((b & 0x80u) == 0) return true;
    }
    return false;
}

struct RawNoteTick {
    int midi_pitch = 0;
    int start_tick = 0;
    int end_tick = 0;
    float velocity = 0.8f;
    int track_index = 0;
    std::string track_name;
};

struct RawTempoTick {
    int tick = 0;
    int usec_per_quarter = 500000;
};

std::string to_lower_copy(const std::string& s) {
    std::string out = s;
    for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return out;
}

PianoHand infer_hand(const std::string& track_name, int track_index, int note_tracks, int midi_pitch) {
    const std::string lower = to_lower_copy(track_name);
    if (lower.find("right") != std::string::npos || lower.find("rh") != std::string::npos ||
        lower.find("treble") != std::string::npos) {
        return PianoHand::Right;
    }
    if (lower.find("left") != std::string::npos || lower.find("lh") != std::string::npos ||
        lower.find("bass") != std::string::npos) {
        return PianoHand::Left;
    }
    if (note_tracks == 2) {
        return (track_index == 0) ? PianoHand::Right : PianoHand::Left;
    }
    // Single-track piano fallback: split around Middle C (MIDI 60).
    return (midi_pitch >= 60) ? PianoHand::Right : PianoHand::Left;
}

double tick_to_seconds(int tick, int tpq, const std::vector<TempoEvent>& tempo_map) {
    if (tempo_map.empty() || tpq <= 0) {
        return (static_cast<double>(tick) / 480.0) * 0.5;
    }
    // Find last tempo event with event.tick <= tick.
    size_t idx = 0;
    for (size_t i = 1; i < tempo_map.size(); ++i) {
        if (tempo_map[i].tick <= tick) {
            idx = i;
        } else {
            break;
        }
    }
    const auto& t = tempo_map[idx];
    const int dt = tick - t.tick;
    const double sec_per_tick = (static_cast<double>(t.microseconds_per_quarter) * 1e-6) /
                                static_cast<double>(tpq);
    return t.time_sec + static_cast<double>(dt) * sec_per_tick;
}

} // namespace

bool MidiSongParser::parse_bytes(const uint8_t* data,
                                 size_t size,
                                 SongData& out_song,
                                 std::string& out_error) {
    out_song = SongData{};
    out_song.source_format = "midi";
    out_error.clear();

    if (!data || size < 14) {
        out_error = "MIDI data is too short (< 14 bytes).";
        return false;
    }
    if (std::memcmp(data, "MThd", 4) != 0) {
        out_error = "Invalid MIDI header: missing 'MThd' magic bytes.";
        return false;
    }

    const uint32_t hdr_len = read_be32(data + 4);
    if (hdr_len < 6 || 8 + hdr_len > size) {
        out_error = "Invalid MIDI header length.";
        return false;
    }

    const uint16_t format = read_be16(data + 8);
    const uint16_t num_tracks = read_be16(data + 10);
    const uint16_t division = read_be16(data + 12);

    if (format > 1) {
        out_error = "Unsupported MIDI format (only SMF Format 0 and 1 are supported).";
        return false;
    }
    if ((division & 0x8000u) != 0 || division == 0) {
        out_error = "SMPTE timecode MIDI division is not supported; use ticks-per-quarter-note.";
        return false;
    }

    out_song.ticks_per_quarter = static_cast<int>(division);
    std::vector<RawTempoTick> raw_tempos;
    raw_tempos.push_back({0, 500000}); // Default 120 BPM at tick 0

    std::vector<RawNoteTick> raw_notes;
    std::map<int, int> note_track_map;

    size_t pos = 8 + hdr_len;
    for (uint16_t trk = 0; trk < num_tracks && pos + 8 <= size; ++trk) {
        if (std::memcmp(data + pos, "MTrk", 4) != 0) {
            out_error = "Expected 'MTrk' chunk header at byte " + std::to_string(pos);
            return false;
        }
        const uint32_t trk_len = read_be32(data + pos + 4);
        pos += 8;
        const size_t trk_end = std::min(size, pos + static_cast<size_t>(trk_len));

        int abs_tick = 0;
        uint8_t running_status = 0;
        std::string track_name;

        // Track active notes per (channel, pitch) to pair NoteOn with NoteOff.
        struct OpenNote {
            int start_tick;
            float velocity;
        };
        std::map<int, std::vector<OpenNote>> active_notes;

        while (pos < trk_end) {
            uint32_t delta = 0;
            if (!read_vlq(data, trk_end, pos, delta)) break;
            abs_tick += static_cast<int>(delta);
            if (pos >= trk_end) break;

            uint8_t status = data[pos];
            if ((status & 0x80u) != 0) {
                ++pos;
                if (status < 0xF0u) {
                    running_status = status;
                }
            } else {
                if (running_status == 0) break;
                status = running_status;
            }

            if (status == 0xFFu) {
                // Meta event.
                if (pos >= trk_end) break;
                const uint8_t meta_type = data[pos++];
                uint32_t meta_len = 0;
                if (!read_vlq(data, trk_end, pos, meta_len)) break;
                if (pos + meta_len > trk_end) break;

                if (meta_type == 0x03u && meta_len > 0) {
                    track_name.assign(reinterpret_cast<const char*>(data + pos), meta_len);
                    if (out_song.title.empty() && trk == 0) {
                        out_song.title = track_name;
                    }
                } else if (meta_type == 0x51u && meta_len == 3) {
                    const int usec = (static_cast<int>(data[pos]) << 16) |
                                     (static_cast<int>(data[pos + 1]) << 8) |
                                     static_cast<int>(data[pos + 2]);
                    if (usec > 0) {
                        raw_tempos.push_back({abs_tick, usec});
                    }
                } else if (meta_type == 0x58u && meta_len >= 2) {
                    out_song.time_sig_numerator = data[pos];
                    out_song.time_sig_denominator = 1 << data[pos + 1];
                } else if (meta_type == 0x59u && meta_len >= 1) {
                    out_song.key_sig_fifths = static_cast<int8_t>(data[pos]);
                } else if (meta_type == 0x2Fu) {
                    // End of Track
                    pos = trk_end;
                    break;
                }
                pos += meta_len;
            } else if (status == 0xF0u || status == 0xF7u) {
                // SysEx event: skip payload.
                uint32_t sysex_len = 0;
                if (!read_vlq(data, trk_end, pos, sysex_len)) break;
                pos = std::min(trk_end, pos + static_cast<size_t>(sysex_len));
            } else {
                const uint8_t cmd = status & 0xF0u;
                const uint8_t ch = status & 0x0Fu;

                if (cmd == 0xC0u || cmd == 0xD0u) {
                    // 1-byte channel messages (Program Change, Channel Pressure).
                    if (pos < trk_end) ++pos;
                } else if (cmd == 0x80u || cmd == 0x90u || cmd == 0xA0u || cmd == 0xB0u || cmd == 0xE0u) {
                    if (pos + 2 > trk_end) break;
                    const uint8_t d1 = data[pos++];
                    const uint8_t d2 = data[pos++];

                    // Ignore percussion channel (GM channel 10 -> index 9).
                    if (ch != 9 && (cmd == 0x90u || cmd == 0x80u)) {
                        const int key = (static_cast<int>(ch) << 8) | static_cast<int>(d1);
                        const bool is_note_on = (cmd == 0x90u && d2 > 0);

                        if (is_note_on) {
                            active_notes[key].push_back({abs_tick, static_cast<float>(d2) / 127.0f});
                        } else {
                            auto it = active_notes.find(key);
                            if (it != active_notes.end() && !it->second.empty()) {
                                const OpenNote open = it->second.front();
                                it->second.erase(it->second.begin());
                                if (abs_tick > open.start_tick) {
                                    raw_notes.push_back({
                                        static_cast<int>(d1),
                                        open.start_tick,
                                        abs_tick,
                                        open.velocity,
                                        static_cast<int>(trk),
                                        track_name
                                    });
                                    note_track_map[static_cast<int>(trk)] = 1;
                                }
                            }
                        }
                    }
                } else {
                    break;
                }
            }
        }
        pos = trk_end;
    }

    // Build sorted, deduplicated tempo map with cumulative timestamps.
    std::sort(raw_tempos.begin(), raw_tempos.end(),
              [](const RawTempoTick& a, const RawTempoTick& b) { return a.tick < b.tick; });

    std::vector<RawTempoTick> merged_tempos;
    for (const auto& rt : raw_tempos) {
        if (!merged_tempos.empty() && merged_tempos.back().tick == rt.tick) {
            merged_tempos.back().usec_per_quarter = rt.usec_per_quarter;
        } else {
            merged_tempos.push_back(rt);
        }
    }

    double accum_sec = 0.0;
    int prev_tick = 0;
    int prev_usec = 500000;
    for (const auto& rt : merged_tempos) {
        const int dt = rt.tick - prev_tick;
        accum_sec += static_cast<double>(dt) *
                     (static_cast<double>(prev_usec) * 1e-6 / static_cast<double>(out_song.ticks_per_quarter));
        TempoEvent te;
        te.tick = rt.tick;
        te.time_sec = accum_sec;
        te.microseconds_per_quarter = rt.usec_per_quarter;
        te.bpm = 60000000.0 / static_cast<double>(rt.usec_per_quarter);
        out_song.tempo_map.push_back(te);
        prev_tick = rt.tick;
        prev_usec = rt.usec_per_quarter;
    }

    // Re-index tracks that actually contain notes (0, 1, ...) for clean 2-hand assignment.
    std::map<int, int> compact_track_idx;
    int next_idx = 0;
    for (const auto& kv : note_track_map) {
        compact_track_idx[kv.first] = next_idx++;
    }
    const int num_note_tracks = next_idx;

    const double beats_per_measure = static_cast<double>(out_song.time_sig_numerator) *
                                     (4.0 / static_cast<double>(out_song.time_sig_denominator));
    const double ticks_per_measure = std::max(1.0, beats_per_measure * static_cast<double>(out_song.ticks_per_quarter));

    out_song.notes.reserve(raw_notes.size());
    for (const auto& rn : raw_notes) {
        SongNote sn;
        sn.midi_pitch = rn.midi_pitch;
        sn.start_sec = tick_to_seconds(rn.start_tick, out_song.ticks_per_quarter, out_song.tempo_map);
        const double end_sec = tick_to_seconds(rn.end_tick, out_song.ticks_per_quarter, out_song.tempo_map);
        sn.duration_sec = std::max(0.01, end_sec - sn.start_sec);
        sn.velocity = rn.velocity;
        sn.track_index = compact_track_idx[rn.track_index];
        sn.hand = infer_hand(rn.track_name, sn.track_index, num_note_tracks, sn.midi_pitch);
        sn.measure_number = static_cast<int>(std::floor(static_cast<double>(rn.start_tick) / ticks_per_measure)) + 1;
        out_song.notes.push_back(sn);
    }

    std::sort(out_song.notes.begin(), out_song.notes.end(),
              [](const SongNote& a, const SongNote& b) {
                  if (std::fabs(a.start_sec - b.start_sec) > 1e-6) return a.start_sec < b.start_sec;
                  return a.midi_pitch < b.midi_pitch;
              });

    return true;
}

bool MidiSongParser::parse_file(const std::string& file_path,
                                SongData& out_song,
                                std::string& out_error) {
    std::ifstream f(file_path, std::ios::binary | std::ios::ate);
    if (!f) {
        out_error = "Could not open MIDI file: " + file_path;
        return false;
    }
    const std::streamsize sz = f.tellg();
    if (sz <= 0) {
        out_error = "MIDI file is empty: " + file_path;
        return false;
    }
    f.seekg(0, std::ios::beg);
    std::vector<uint8_t> buf(static_cast<size_t>(sz));
    if (!f.read(reinterpret_cast<char*>(buf.data()), sz)) {
        out_error = "Failed reading MIDI file: " + file_path;
        return false;
    }
    return parse_bytes(buf.data(), buf.size(), out_song, out_error);
}

} // namespace piano_dsp
