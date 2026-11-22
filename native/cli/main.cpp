#include "piano_dsp/piano_dsp_ffi.h"
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

namespace {

std::atomic<bool> g_running{true};

void handle_signal(int) {
    g_running.store(false);
}

// Minimal 16-bit PCM WAV reader for offline testing with real piano recordings.
bool read_wav_mono_float(const std::string& path,
                         std::vector<float>& samples_out,
                         int& sample_rate_out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;

    char riff[4];
    f.read(riff, 4);
    if (std::memcmp(riff, "RIFF", 4) != 0) return false;
    f.seekg(8);
    char wave[4];
    f.read(wave, 4);
    if (std::memcmp(wave, "WAVE", 4) != 0) return false;

    uint16_t audio_format = 0, num_channels = 0, bits_per_sample = 0;
    uint32_t sample_rate = 0;

    while (f && !f.eof()) {
        char chunk_id[4];
        uint32_t chunk_size = 0;
        f.read(chunk_id, 4);
        f.read(reinterpret_cast<char*>(&chunk_size), 4);
        if (!f) break;

        if (std::memcmp(chunk_id, "fmt ", 4) == 0) {
            f.read(reinterpret_cast<char*>(&audio_format), 2);
            f.read(reinterpret_cast<char*>(&num_channels), 2);
            f.read(reinterpret_cast<char*>(&sample_rate), 4);
            f.seekg(6, std::ios::cur); // byte_rate + block_align
            f.read(reinterpret_cast<char*>(&bits_per_sample), 2);
            if (chunk_size > 16) f.seekg(chunk_size - 16, std::ios::cur);
        } else if (std::memcmp(chunk_id, "data", 4) == 0) {
            if (audio_format != 1 || bits_per_sample != 16 || num_channels == 0) {
                return false;
            }
            const size_t total_frames = chunk_size / (num_channels * 2);
            std::vector<int16_t> raw(total_frames * num_channels);
            f.read(reinterpret_cast<char*>(raw.data()), chunk_size);
            samples_out.resize(total_frames);
            for (size_t i = 0; i < total_frames; ++i) {
                float sum = 0.0f;
                for (uint16_t c = 0; c < num_channels; ++c) {
                    sum += static_cast<float>(raw[i * num_channels + c]) / 32768.0f;
                }
                samples_out[i] = sum / static_cast<float>(num_channels);
            }
            sample_rate_out = static_cast<int>(sample_rate);
            return true;
        } else {
            f.seekg(chunk_size, std::ios::cur);
        }
    }
    return false;
}

std::string render_spectrum_bar(const float bins[64]) {
    static constexpr const char* kLevels[] = {" ", ".", ":", "-", "=", "+", "*", "#", "@"};
    std::string bar;
    bar.reserve(64);
    for (int i = 0; i < 64; ++i) {
        int idx = static_cast<int>(bins[i] * 8.0f);
        if (idx < 0) idx = 0;
        if (idx > 8) idx = 8;
        bar += kLevels[idx];
    }
    return bar;
}

void print_usage() {
    std::cout << "PianoTutor Milestone 1 & 2 — Microphone Piano Pitch & Melody Detector\n"
              << "Usage:\n"
              << "  piano_dsp_cli [--rate 48000|44100] [--gate -50] [--device default] [--record melody.csv]\n"
              << "  piano_dsp_cli --wav <piano_recording.wav> [--record melody.csv]\n";
}

void print_and_save_recording(PianoDspEngine* engine, const std::string& csv_path) {
    const int32_t count = piano_dsp_get_recorded_count(engine);
    std::cout << "\nRecorded Melody (" << count << " notes):\n";
    std::ofstream out;
    if (!csv_path.empty()) {
        out.open(csv_path);
        if (out) {
            out << "index,note,midi,start_sec,duration_sec,hz,confidence,velocity\n";
        }
    }
    for (int32_t i = 0; i < count; ++i) {
        PianoDspRecordedNote rn{};
        if (!piano_dsp_get_recorded_note(engine, i, &rn)) continue;
        char name[8];
        piano_dsp_midi_to_name(rn.midi_note, name, sizeof(name));
        std::printf("  #%02d  %-3s (MIDI %3d) | start %6.2fs | dur %5.2fs | %7.2f Hz | conf %3.0f%%\n",
                    i + 1, name, rn.midi_note, rn.start_sec, rn.duration_sec,
                    rn.frequency_hz, rn.confidence * 100.0f);
        if (out) {
            out << i << "," << name << "," << rn.midi_note << ","
                << rn.start_sec << "," << rn.duration_sec << ","
                << rn.frequency_hz << "," << rn.confidence << "," << rn.velocity_est << "\n";
        }
    }
    if (!csv_path.empty() && out) {
        std::cout << "Saved recorded melody CSV to: " << csv_path << "\n";
    }
}

} // namespace

int main(int argc, char** argv) {
    int sample_rate = 48000;
    float noise_gate_db = -50.0f;
    std::string device_id = "default";
    std::string wav_path;
    std::string record_csv_path;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--rate" && i + 1 < argc) {
            sample_rate = std::atoi(argv[++i]);
        } else if (arg == "--gate" && i + 1 < argc) {
            noise_gate_db = std::strtof(argv[++i], nullptr);
        } else if (arg == "--device" && i + 1 < argc) {
            device_id = argv[++i];
        } else if (arg == "--wav" && i + 1 < argc) {
            wav_path = argv[++i];
        } else if (arg == "--record" && i + 1 < argc) {
            record_csv_path = argv[++i];
        } else if (arg == "--help" || arg == "-h") {
            print_usage();
            return 0;
        }
    }

    if (!wav_path.empty()) {
        std::vector<float> samples;
        int wav_rate = 0;
        if (!read_wav_mono_float(wav_path, samples, wav_rate)) {
            std::cerr << "Error: Could not read 16-bit PCM WAV file: " << wav_path << "\n";
            return 1;
        }
        std::cout << "Analyzing WAV: " << wav_path << " (" << wav_rate << " Hz, "
                  << samples.size() << " frames)\n";

        PianoDspEngine* engine = piano_dsp_create(wav_rate, 4096, 512);
        piano_dsp_set_noise_gate_db(engine, noise_gate_db);
        piano_dsp_start_recording(engine);

        const size_t chunk = 512;
        for (size_t pos = 0; pos < samples.size(); pos += chunk) {
            const size_t n = std::min(chunk, samples.size() - pos);
            piano_dsp_push_audio(engine, samples.data() + pos, static_cast<int32_t>(n));
            piano_dsp_process(engine);
        }
        piano_dsp_stop_recording(engine);
        print_and_save_recording(engine, record_csv_path);
        piano_dsp_destroy(engine);
        return 0;
    }

    std::signal(SIGINT, handle_signal);
    std::signal(SIGTERM, handle_signal);

    PianoDspEngine* engine = piano_dsp_create(sample_rate, 4096, 512);
    piano_dsp_set_noise_gate_db(engine, noise_gate_db);

    const int32_t rc = piano_dsp_start_mic(engine, device_id.c_str());
    if (rc != 0) {
        std::cerr << "Failed to start microphone capture (code " << rc << "): "
                  << piano_dsp_last_error(engine) << "\n";
        piano_dsp_destroy(engine);
        return 1;
    }

    piano_dsp_start_recording(engine);
    std::cout << "PianoTutor Live Microphone Pitch & Melody Detector (" << sample_rate
              << " Hz, gate " << noise_gate_db << " dBFS)\n"
              << "Play a melody on your piano. Press Ctrl+C to stop and print recorded notes.\n\n";

    while (g_running.load() && piano_dsp_is_mic_running(engine)) {
        piano_dsp_process(engine);

        PianoDspNoteEvent evt{};
        while (piano_dsp_pop_note_event(engine, &evt)) {
            char name[8];
            piano_dsp_midi_to_name(evt.midi_note, name, sizeof(name));
            if (evt.type == 1) {
                std::printf("\n[%6.2fs] >>> NOTE ON  %-3s (MIDI %3d) | %7.2f Hz | conf %3.0f%%\n",
                            evt.timestamp_sec, name, evt.midi_note, evt.frequency_hz,
                            evt.confidence * 100.0f);
            }
        }

        PianoDspSnapshot snap{};
        piano_dsp_get_snapshot(engine, &snap);

        char note_name[8] = "--";
        if (snap.has_pitch) {
            piano_dsp_midi_to_name(snap.midi_note, note_name, sizeof(note_name));
        }

        const std::string spec = render_spectrum_bar(snap.spectrum_bins);
        std::printf("\rNote: %-3s | %7.2f Hz | %+5.1f c | Conf: %3.0f%% | RMS: %5.1f dB | [%s]",
                    note_name,
                    snap.has_pitch ? snap.frequency_hz : 0.0f,
                    snap.has_pitch ? snap.cents_offset : 0.0f,
                    snap.confidence * 100.0f,
                    snap.rms_db,
                    spec.c_str());
        std::fflush(stdout);

        std::this_thread::sleep_for(std::chrono::milliseconds(30));
    }

    std::cout << "\nStopping microphone capture...\n";
    piano_dsp_stop_mic(engine);
    piano_dsp_stop_recording(engine);
    print_and_save_recording(engine, record_csv_path);
    piano_dsp_destroy(engine);
    return 0;
}
