#include "piano_dsp/audio_capture.h"
#include "piano_dsp/audio_pipeline.h"
#include "piano_dsp/melody_evaluator.h"
#include "piano_dsp/melody_recorder.h"
#include "piano_dsp/midi_song_parser.h"
#include "piano_dsp/pitch_utils.h"
#include "piano_dsp/piano_dsp_ffi.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <random>
#include <string>
#include <thread>
#include <vector>

using namespace piano_dsp;

namespace {

int g_passed = 0;
int g_failed = 0;

#define CHECK(cond, msg)                                                      \
    do {                                                                      \
        if (cond) {                                                           \
            ++g_passed;                                                       \
        } else {                                                              \
            ++g_failed;                                                       \
            std::cerr << "  [FAIL] " << msg << " (line " << __LINE__ << ")\n";\
        }                                                                     \
    } while (0)

constexpr float kTwoPi = 6.28318530717958647692f;

/**
 * Physically-informed acoustic piano note synthesizer for realistic DSP testing:
 *  - Stiff-string inharmonicity: f_n = n * f0 * sqrt(1 + B * n^2)
 *  - Exponential per-partial decay (upper partials decay faster)
 *  - Optional weak fundamental (simulates bass notes on upright pianos / phone mics)
 *  - Broadband percussive hammer-strike transient in the first 15 ms
 *  - Additive room noise floor
 */
std::vector<float> synthesize_piano_note(int midi_note,
                                         int sample_rate,
                                         float duration_sec,
                                         float amplitude = 0.6f,
                                         bool weak_fundamental = false,
                                         float noise_rms = 0.002f) {
    const int n_samples = static_cast<int>(duration_sec * static_cast<float>(sample_rate));
    std::vector<float> out(n_samples, 0.0f);

    const float f0 = PitchUtils::midi_to_hz(midi_note);
    // Typical acoustic piano inharmonicity coefficient B (higher in treble).
    const float B = (midi_note < 48) ? 0.00015f : (midi_note < 72 ? 0.00035f : 0.0012f);
    const int num_partials = (f0 > 1500.0f) ? 3 : 8;

    std::mt19937 rng(42 + midi_note);
    std::normal_distribution<float> dist(0.0f, 1.0f);

    for (int i = 0; i < n_samples; ++i) {
        const float t = static_cast<float>(i) / static_cast<float>(sample_rate);
        // Fast attack envelope (5 ms).
        const float attack = std::min(1.0f, t / 0.005f);

        float sample = 0.0f;
        for (int h = 1; h <= num_partials; ++h) {
            const float fn = static_cast<float>(h) * f0 *
                             std::sqrt(1.0f + B * static_cast<float>(h * h));
            if (fn >= static_cast<float>(sample_rate) * 0.45f) break;

            float partial_amp = 1.0f / std::pow(static_cast<float>(h), 0.85f);
            if (weak_fundamental && h == 1) {
                partial_amp *= 0.25f; // Fundamental 12 dB weaker than 2nd harmonic
            }
            const float decay = std::exp(-t * (1.2f + 0.65f * static_cast<float>(h)));
            sample += partial_amp * decay * std::sin(kTwoPi * fn * t);
        }

        // Percussive felt/wood hammer transient in first 15 ms.
        const float hammer = 0.25f * std::exp(-t / 0.004f) * dist(rng);
        // Background room noise.
        const float noise = noise_rms * dist(rng);

        out[i] = amplitude * attack * (sample * 0.45f + hammer) + noise;
    }
    return out;
}

void test_pitch_utils() {
    std::cout << "[Test] PitchUtils Hz <-> MIDI <-> NoteName\n";
    float cents = 0.0f;
    CHECK(PitchUtils::hz_to_midi(440.0f, cents) == 69, "A4 should be MIDI 69");
    CHECK(std::fabs(cents) < 0.01f, "A4 cents should be ~0");

    CHECK(PitchUtils::hz_to_midi(261.625565f, cents) == 60, "C4 should be MIDI 60");
    CHECK(std::fabs(cents) < 0.1f, "C4 cents should be ~0");

    CHECK(PitchUtils::hz_to_midi(27.5f, cents) == 21, "A0 should be MIDI 21");
    CHECK(PitchUtils::hz_to_midi(4186.009f, cents) == 108, "C8 should be MIDI 108");

    // +25 cents sharp of A4 (~446.40 Hz)
    const float a4_plus_25c = 440.0f * std::pow(2.0f, 25.0f / 1200.0f);
    CHECK(PitchUtils::hz_to_midi(a4_plus_25c, cents) == 69, "A4+25c should still map to MIDI 69");
    CHECK(std::fabs(cents - 25.0f) < 0.2f, "A4+25c cents should be ~+25");

    CHECK(PitchUtils::midi_to_note_name(21) == "A0", "MIDI 21 -> A0");
    CHECK(PitchUtils::midi_to_note_name(60) == "C4", "MIDI 60 -> C4");
    CHECK(PitchUtils::midi_to_note_name(61) == "C#4", "MIDI 61 -> C#4");
    CHECK(PitchUtils::midi_to_note_name(69) == "A4", "MIDI 69 -> A4");
    CHECK(PitchUtils::midi_to_note_name(108) == "C8", "MIDI 108 -> C8");
    CHECK(PitchUtils::is_piano_midi(21) && PitchUtils::is_piano_midi(108), "Piano range bounds");
    CHECK(!PitchUtils::is_piano_midi(20) && !PitchUtils::is_piano_midi(109), "Out of piano range");
}

void test_piano_pitch_across_octaves(int sample_rate) {
    std::cout << "[Test] Realistic Piano Pitch Detection @ " << sample_rate << " Hz\n";
    const int test_notes[] = {21, 36, 48, 60, 69, 84, 96, 108}; // A0, C2, C3, C4, A4, C6, C7, C8

    for (int midi : test_notes) {
        PipelineConfig cfg;
        cfg.sample_rate = sample_rate;
        cfg.frame_size = 4096;
        cfg.hop_size = 512;
        AudioPipeline pipeline(cfg);

        const bool weak_f0 = (midi <= 36);
        auto audio = synthesize_piano_note(midi, sample_rate, 0.50f, 0.65f, weak_f0);
        pipeline.push_audio(audio.data(), audio.size());
        pipeline.process_available();

        const auto snap = pipeline.latest_snapshot();
        const std::string name = PitchUtils::midi_to_note_name(midi);
        const bool ok = snap.has_pitch && (snap.midi_note == midi) && (snap.confidence >= 0.65f);
        if (!ok) {
            std::cerr << "    Expected " << name << " (MIDI " << midi
                      << "), got MIDI " << snap.midi_note
                      << " (" << snap.frequency_hz << " Hz, conf=" << snap.confidence << ")\n";
        }
        CHECK(ok, "Detect piano note " + name + " @ " + std::to_string(sample_rate) + " Hz");
    }
}

void test_sustain_no_duplicate_triggers() {
    std::cout << "[Test] Sustained Piano Note De-Duplication (No False Re-triggers)\n";
    PipelineConfig cfg;
    cfg.sample_rate = 48000;
    AudioPipeline pipeline(cfg);

    auto audio = synthesize_piano_note(60, 48000, 1.5f, 0.65f, false);
    int note_on_count = 0;
    int first_midi = -1;

    const size_t chunk = 512;
    for (size_t pos = 0; pos < audio.size(); pos += chunk) {
        const size_t n = std::min(chunk, audio.size() - pos);
        pipeline.push_audio(audio.data() + pos, n);
        pipeline.process_available();

        NoteEvent evt;
        while (pipeline.pop_note_event(evt)) {
            if (evt.type == NoteEventType::NoteOn) {
                ++note_on_count;
                if (first_midi == -1) first_midi = evt.midi_note;
            }
        }
    }

    CHECK(first_midi == 60, "Sustained note detected as C4 (MIDI 60)");
    CHECK(note_on_count == 1, "1.5s sustained note must emit exactly 1 NoteOn (got " +
                                  std::to_string(note_on_count) + ")");
}

void test_background_noise_rejection() {
    std::cout << "[Test] Background Noise & Room Rumble Rejection\n";
    PipelineConfig cfg;
    cfg.sample_rate = 48000;
    cfg.noise_gate_db = -45.0f;
    AudioPipeline pipeline(cfg);

    std::mt19937 rng(123);
    std::normal_distribution<float> dist(0.0f, 0.001f); // ~ -60 dBFS noise
    std::vector<float> noise(24000);
    for (size_t i = 0; i < noise.size(); ++i) {
        // Add 15 Hz sub-audible room rumble + white noise.
        const float t = static_cast<float>(i) / 48000.0f;
        noise[i] = dist(rng) + 0.01f * std::sin(kTwoPi * 15.0f * t);
    }

    pipeline.push_audio(noise.data(), noise.size());
    pipeline.process_available();

    const auto snap = pipeline.latest_snapshot();
    CHECK(!snap.has_pitch, "Quiet room noise + 15 Hz rumble must not trigger pitch detection");
}

void test_sequential_melody_events() {
    std::cout << "[Test] Sequential Melody NoteOn/NoteOff Tracking (C4 -> E4 -> G4 -> C5)\n";
    PipelineConfig cfg;
    cfg.sample_rate = 48000;
    AudioPipeline pipeline(cfg);

    const std::vector<int> expected = {60, 64, 67, 72};
    std::vector<int> detected;

    for (int midi : expected) {
        auto note = synthesize_piano_note(midi, 48000, 0.35f, 0.65f);
        std::vector<float> gap(4800, 0.0f); // 100 ms silence between notes
        note.insert(note.end(), gap.begin(), gap.end());

        const size_t chunk = 512;
        for (size_t pos = 0; pos < note.size(); pos += chunk) {
            const size_t n = std::min(chunk, note.size() - pos);
            pipeline.push_audio(note.data() + pos, n);
            pipeline.process_available();

            NoteEvent evt;
            while (pipeline.pop_note_event(evt)) {
                if (evt.type == NoteEventType::NoteOn) {
                    detected.push_back(evt.midi_note);
                }
            }
        }
    }

    if (detected != expected) {
        std::cerr << "    Detected MIDI sequence:";
        for (int m : detected) std::cerr << " " << m;
        std::cerr << "\n";
    }
    CHECK(detected == expected, "Sequential melody C4-E4-G4-C5 detected cleanly in order");
}

void test_capture_integration() {
    std::cout << "[Test] Microphone Capture Integration & Error Handling\n";
    auto capture = create_native_audio_capture();
    CHECK(capture != nullptr, "create_native_audio_capture() returns valid adapter");

    // 1. Reject unsupported sample rate.
    auto bad_rate = capture->start(12345, 512, "default", [](const float*, size_t) {});
    CHECK(bad_rate.status == CaptureStatus::UnsupportedFormat ||
              bad_rate.status == CaptureStatus::BackendError,
          "Unsupported sample rate is cleanly rejected");

    // 2. Reject null callback.
    auto bad_cb = capture->start(48000, 512, "default", nullptr);
    CHECK(bad_cb.status == CaptureStatus::BackendError, "Null audio callback is cleanly rejected");

    // 3. Live capture test (250 ms) through C-ABI FFI engine.
    PianoDspEngine* engine = piano_dsp_create(48000, 4096, 512);
    const int32_t rc = piano_dsp_start_mic(engine, "default");
    if (rc == 0) {
        std::cout << "  [INFO] Live microphone opened via " << capture->backend_name()
                  << "; capturing 250 ms...\n";
        int total_frames = 0;
        for (int i = 0; i < 10; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(25));
            total_frames += piano_dsp_process(engine);
        }
        PianoDspSnapshot snap{};
        piano_dsp_get_snapshot(engine, &snap);
        piano_dsp_stop_mic(engine);
        std::cout << "  [INFO] Processed " << total_frames
                  << " overlapping DSP frames from live mic (RMS=" << snap.rms_db << " dBFS)\n";
        CHECK(total_frames > 0, "Live microphone produced real audio frames for DSP pipeline");
    } else {
        std::cout << "  [SKIP] Live audio daemon unavailable in this environment: "
                  << piano_dsp_last_error(engine) << "\n";
    }
    piano_dsp_destroy(engine);
}

void test_melody_recorder_unit() {
    std::cout << "[Test] MelodyRecorder Pairing, Glitch Filtering & CSV Export\n";
    MelodyRecorder rec(0.05); // 50 ms minimum duration
    rec.start(1.0);

    // Valid note: C4 from t=1.2 to t=1.6 (0.4s)
    rec.on_note_event({NoteEventType::NoteOn, 60, 261.63f, 0.95f, 0.7f, 1.2});
    rec.on_note_event({NoteEventType::NoteOff, 60, 0.0f, 0.0f, 0.0f, 1.6});

    // Ultra-short glitch: F#4 from t=1.7 to t=1.72 (20 ms -> must be filtered out)
    rec.on_note_event({NoteEventType::NoteOn, 66, 369.99f, 0.65f, 0.2f, 1.70});
    rec.on_note_event({NoteEventType::NoteOff, 66, 0.0f, 0.0f, 0.0f, 1.72});

    // Unclosed note: G4 from t=1.8 -> closed by stop(2.2)
    rec.on_note_event({NoteEventType::NoteOn, 67, 392.00f, 0.92f, 0.8f, 1.8});
    rec.stop(2.2);

    const auto& notes = rec.notes();
    CHECK(notes.size() == 2, "Glitch filtered out; 2 valid notes recorded");
    if (notes.size() == 2) {
        CHECK(notes[0].midi_note == 60 && std::fabs(notes[0].start_sec - 0.2) < 1e-4 &&
                  std::fabs(notes[0].duration_sec - 0.4) < 1e-4,
              "First recorded note relative start/duration exact");
        CHECK(notes[1].midi_note == 67 && std::fabs(notes[1].duration_sec - 0.4) < 1e-4,
              "Unclosed note cleanly finalized on stop()");
    }
    const std::string csv = rec.to_csv();
    CHECK(csv.find("C4,60") != std::string::npos && csv.find("G4,67") != std::string::npos,
          "CSV export contains formatted note names and MIDI numbers");
}

void test_melody_evaluator_unit() {
    std::cout << "[Test] MelodyEvaluator Matching, Latency Compensation & F1 Scoring\n";
    const std::vector<ExpectedNote> expected = {
        {60, 0.0, 0.5},
        {64, 0.5, 0.5},
        {67, 1.0, 0.5},
        {72, 1.5, 0.5},
    };

    // Case 1: Perfect play with +80 ms constant microphone latency.
    std::vector<RecordedNote> delayed;
    for (const auto& e : expected) {
        RecordedNote r;
        r.midi_note = e.midi_note;
        r.start_sec = e.start_sec + 0.080;
        r.duration_sec = e.duration_sec;
        delayed.push_back(r);
    }
    EvaluationConfig cfg;
    cfg.timing_tolerance_sec = 0.050; // Tight 50 ms window
    cfg.auto_estimate_latency = true;
    auto rep1 = MelodyEvaluator::evaluate(expected, delayed, cfg);
    CHECK(rep1.true_positives == 4 && std::fabs(rep1.f1_score - 1.0) < 1e-6,
          "Auto latency compensation recovers F1=1.0 on +80ms shifted performance");
    CHECK(std::fabs(rep1.estimated_latency_ms - 80.0) < 1.0,
          "Estimated latency matches +80 ms");
    CHECK(rep1.mean_abs_timing_error_ms < 1.0, "Residual timing error < 1 ms after compensation");

    // Case 2: 2 correct, 1 wrong pitch (65 instead of 67), 1 missed (72), 1 extra note (69 at 2.5s).
    std::vector<RecordedNote> mixed = {
        {60, 261.6f, 0.01, 0.45, 0.44, 0.9f, 0.7f},
        {64, 329.6f, 0.49, 0.95, 0.46, 0.9f, 0.7f},
        {65, 349.2f, 1.02, 1.45, 0.43, 0.9f, 0.7f}, // Wrong pitch (F4 instead of G4)
        {69, 440.0f, 2.50, 2.90, 0.40, 0.9f, 0.7f}, // Extra note
    };
    EvaluationConfig cfg2;
    cfg2.timing_tolerance_sec = 0.150;
    auto rep2 = MelodyEvaluator::evaluate(expected, mixed, cfg2);
    CHECK(rep2.true_positives == 2, "Mixed case: 2 true positives");
    CHECK(rep2.pitch_errors == 1, "Mixed case: 1 wrong pitch");
    CHECK(rep2.missed_notes == 1, "Mixed case: 1 missed note");
    CHECK(rep2.extra_notes == 1, "Mixed case: 1 extra note");
    CHECK(std::fabs(rep2.f1_score - 0.5) < 1e-6, "Mixed case: F1 = 0.50");
}

// Helper: render an acoustic melody (with realistic note overlap/decay) and evaluate recognition.
EvaluationReport run_acoustic_melody_benchmark(const std::string& label,
                                               const std::vector<ExpectedNote>& score,
                                               int sample_rate) {
    double total_sec = 0.0;
    for (const auto& n : score) {
        total_sec = std::max(total_sec, n.start_sec + n.duration_sec + 0.35);
    }
    std::vector<float> mix(static_cast<size_t>(total_sec * sample_rate), 0.0f);

    for (const auto& n : score) {
        // Render each note slightly longer than its nominal duration to simulate acoustic tail.
        auto tone = synthesize_piano_note(n.midi_note, sample_rate,
                                          static_cast<float>(n.duration_sec + 0.06), 0.65f, false, 0.001f);
        const size_t start_idx = static_cast<size_t>(n.start_sec * sample_rate);
        for (size_t i = 0; i < tone.size() && (start_idx + i) < mix.size(); ++i) {
            mix[start_idx + i] += tone[i];
        }
    }

    PipelineConfig pcfg;
    pcfg.sample_rate = sample_rate;
    AudioPipeline pipeline(pcfg);
    pipeline.start_recording();

    const size_t chunk = 512;
    for (size_t pos = 0; pos < mix.size(); pos += chunk) {
        const size_t n = std::min(chunk, mix.size() - pos);
        pipeline.push_audio(mix.data() + pos, n);
        pipeline.process_available();
    }
    pipeline.stop_recording();

    EvaluationConfig ecfg;
    ecfg.timing_tolerance_sec = 0.150;
    ecfg.auto_estimate_latency = true;
    auto report = MelodyEvaluator::evaluate(score, pipeline.recorded_notes(), ecfg);

    std::printf("  [%s @ %d Hz] TP=%d/%d | Extra=%d | PitchErr=%d | F1=%.3f | SeqAcc=%.3f | Lat=%.1fms | MAE=%.1fms\n",
                label.c_str(), sample_rate, report.true_positives, report.expected_count,
                report.extra_notes, report.pitch_errors, report.f1_score,
                report.sequence_accuracy, report.estimated_latency_ms, report.mean_abs_timing_error_ms);
    if (report.extra_notes > 0) {
        std::printf("    Recorded notes:");
        for (const auto& rn : pipeline.recorded_notes()) {
            std::printf(" %s(%.2fs,%.2fs)", PitchUtils::midi_to_note_name(rn.midi_note).c_str(),
                        rn.start_sec, rn.duration_sec);
        }
        std::printf("\n");
    }
    return report;
}

void test_melody_recognition_benchmarks() {
    std::cout << "[Test] Milestone 2 Acoustic Piano Melody Recognition Benchmarks\n";

    // 1. Twinkle Twinkle opening phrase with REPEATED same-key strikes: C4 C4 G4 G4 A4 A4 G4
    const std::vector<ExpectedNote> twinkle = {
        {60, 0.10, 0.42},
        {60, 0.55, 0.42},
        {67, 1.00, 0.42},
        {67, 1.45, 0.42},
        {69, 1.90, 0.42},
        {69, 2.35, 0.42},
        {67, 2.80, 0.70},
    };
    auto r_twinkle_48 = run_acoustic_melody_benchmark("Twinkle (Repeated Notes)", twinkle, 48000);
    CHECK(r_twinkle_48.f1_score >= 0.95, "Twinkle @ 48kHz F1 >= 0.95");
    CHECK(r_twinkle_48.extra_notes == 0, "Twinkle @ 48kHz zero duplicate/extra notes");
    CHECK(r_twinkle_48.mean_abs_timing_error_ms < 50.0, "Twinkle @ 48kHz timing MAE < 50 ms");

    auto r_twinkle_44 = run_acoustic_melody_benchmark("Twinkle (Repeated Notes)", twinkle, 44100);
    CHECK(r_twinkle_44.f1_score >= 0.95, "Twinkle @ 44.1kHz F1 >= 0.95");

    // 2. Fast legato C-major scale (zero silence gaps between notes, 280 ms/note)
    const int scale_midis[] = {60, 62, 64, 65, 67, 69, 71, 72};
    std::vector<ExpectedNote> scale;
    for (int i = 0; i < 8; ++i) {
        scale.push_back({scale_midis[i], 0.10 + i * 0.28, 0.28});
    }
    auto r_scale = run_acoustic_melody_benchmark("Legato C-Major Scale", scale, 48000);
    CHECK(r_scale.f1_score >= 0.95, "Legato C-Major scale F1 >= 0.95");
    CHECK(r_scale.sequence_accuracy >= 0.95, "Legato C-Major scale pitch sequence accuracy >= 95%");
}

void test_midi_song_parser_unit() {
    std::cout << "[Test] Milestone 3 MidiSongParser (SMF Type 1 Song Data Only, Tempo Change, Two Hands)\n";

    // Build a minimal valid SMF Format 1 binary file in memory:
    // TPQ = 480 (0x01E0), 2 tracks:
    //   Track 0 ("Right Hand"): 120 BPM at tick 0 -> C4 (0..480), tempo change to 60 BPM at tick 480 -> E4 (480..960, running status)
    //   Track 1 ("Left Hand"):  C3 (0..480)
    auto append_u32 = [](std::vector<uint8_t>& b, uint32_t v) {
        b.push_back((v >> 24) & 0xFF);
        b.push_back((v >> 16) & 0xFF);
        b.push_back((v >> 8) & 0xFF);
        b.push_back(v & 0xFF);
    };
    auto append_chunk = [&](std::vector<uint8_t>& b, const char id[4], const std::vector<uint8_t>& payload) {
        b.insert(b.end(), id, id + 4);
        append_u32(b, static_cast<uint32_t>(payload.size()));
        b.insert(b.end(), payload.begin(), payload.end());
    };

    std::vector<uint8_t> smf;
    // MThd: format=1, tracks=2, division=480 (0x01E0)
    append_chunk(smf, "MThd", {0x00, 0x01, 0x00, 0x02, 0x01, 0xE0});

    // Track 0: Track Name "Right Hand", Tempo 120 BPM (500000 = 0x07A120), NoteOn C4(60) vel 100 @0,
    //          delta 480 (VLQ 0x83 0x60) -> NoteOn C4 vel 0 (running status NoteOff),
    //          Tempo 60 BPM (1000000 = 0x0F4240) @480, NoteOn E4(64) vel 90 @480,
    //          delta 480 -> NoteOff E4 @960, End of Track.
    std::vector<uint8_t> trk0 = {
        0x00, 0xFF, 0x03, 0x0A, 'R','i','g','h','t',' ','H','a','n','d',
        0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20,       // 120 BPM at tick 0
        0x00, 0x90, 60, 100,                             // C4 on @ 0
        0x83, 0x60, 60, 0,                               // running status C4 off @ 480 (0.5s)
        0x00, 0xFF, 0x51, 0x03, 0x0F, 0x42, 0x40,       // 60 BPM at tick 480
        0x00, 0x90, 64, 90,                              // E4 on @ 480 (0.5s)
        0x83, 0x60, 0x80, 64, 0,                         // E4 off @ 960 (0.5s + 1.0s = 1.5s)
        0x00, 0xFF, 0x2F, 0x00
    };
    append_chunk(smf, "MTrk", trk0);

    // Track 1: Track Name "Left Hand", NoteOn C3(48) vel 80 @0, NoteOff @480.
    std::vector<uint8_t> trk1 = {
        0x00, 0xFF, 0x03, 0x09, 'L','e','f','t',' ','H','a','n','d',
        0x00, 0x90, 48, 80,
        0x83, 0x60, 0x80, 48, 0,
        0x00, 0xFF, 0x2F, 0x00
    };
    append_chunk(smf, "MTrk", trk1);

    SongData song;
    std::string err;
    const bool ok = MidiSongParser::parse_bytes(smf.data(), smf.size(), song, err);
    CHECK(ok, "SMF Type 1 parsed successfully: " + err);
    CHECK(song.tempo_map.size() == 2, "Extracted 2 tempo events (120 BPM -> 60 BPM)");
    CHECK(song.notes.size() == 3, "Extracted 3 notes across 2 hand tracks");

    if (song.notes.size() == 3) {
        // Sorted by start_sec then pitch: C3(48) @0.0s, C4(60) @0.0s, E4(64) @0.5s (dur 1.0s at 60 BPM)
        CHECK(song.notes[0].midi_pitch == 48 && song.notes[0].hand == PianoHand::Left &&
                  std::fabs(song.notes[0].duration_sec - 0.5) < 1e-4,
              "Left-hand C3 parsed with 0.5s duration at 120 BPM");
        CHECK(song.notes[1].midi_pitch == 60 && song.notes[1].hand == PianoHand::Right &&
                  std::fabs(song.notes[1].duration_sec - 0.5) < 1e-4,
              "Right-hand C4 parsed with running-status NoteOff (0.5s)");
        CHECK(song.notes[2].midi_pitch == 64 && song.notes[2].hand == PianoHand::Right &&
                  std::fabs(song.notes[2].start_sec - 0.5) < 1e-4 &&
                  std::fabs(song.notes[2].duration_sec - 1.0) < 1e-4,
              "Right-hand E4 reflects 60 BPM tempo change (start 0.5s, dur 1.0s)");
    }

    // Invalid header rejection.
    const uint8_t bad_bytes[16] = {'N','O','T','M','I','D','I',0};
    SongData bad_song;
    CHECK(!MidiSongParser::parse_bytes(bad_bytes, sizeof(bad_bytes), bad_song, err),
          "Invalid MIDI header cleanly rejected");
}

} // namespace

int main() {
    std::cout << "=== PianoTutor Milestones 1, 2 & 3 Test Suite ===\n";
    test_pitch_utils();
    test_piano_pitch_across_octaves(44100);
    test_piano_pitch_across_octaves(48000);
    test_sustain_no_duplicate_triggers();
    test_background_noise_rejection();
    test_sequential_melody_events();
    test_melody_recorder_unit();
    test_melody_evaluator_unit();
    test_melody_recognition_benchmarks();
    test_midi_song_parser_unit();
    test_capture_integration();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed.\n";
    return (g_failed == 0) ? 0 : 1;
}
