#pragma once

#include "piano_dsp/melody_recorder.h"
#include <vector>

namespace piano_dsp {

struct ExpectedNote {
    int midi_note = -1;
    double start_sec = 0.0;
    double duration_sec = 0.5;
};

struct EvaluationConfig {
    double timing_tolerance_sec = 0.150;   // +/- 150 ms matching window
    double latency_offset_sec = 0.0;       // Known mic/DSP latency to subtract from detected times
    bool auto_estimate_latency = false;    // If true, estimate constant offset from median match error
};

enum class NoteMatchStatus {
    Correct,
    WrongPitch,
    Missed,
    Extra
};

struct NoteMatchDetail {
    NoteMatchStatus status = NoteMatchStatus::Missed;
    int expected_index = -1;
    int detected_index = -1;
    int expected_midi = -1;
    int detected_midi = -1;
    double timing_error_ms = 0.0; // detected - expected (after latency compensation)
};

struct EvaluationReport {
    int expected_count = 0;
    int detected_count = 0;
    int true_positives = 0;       // Correct pitch within timing tolerance
    int pitch_errors = 0;         // Note played in window with wrong pitch
    int missed_notes = 0;         // Expected notes with no match
    int extra_notes = 0;          // Unmatched / duplicate detected notes

    double precision = 0.0;       // TP / detected_count
    double recall = 0.0;          // TP / expected_count
    double f1_score = 0.0;        // Harmonic mean of precision & recall
    double sequence_accuracy = 0.0; // Tempo-free pitch sequence accuracy (1 - edit_dist / max_len)

    double estimated_latency_ms = 0.0;
    double mean_abs_timing_error_ms = 0.0;
    double mean_signed_timing_error_ms = 0.0;

    std::vector<NoteMatchDetail> details;
};

/**
 * Evaluates detected piano note sequences against ground-truth expected notes.
 * Supports latency compensation, configurable timing tolerance, and both
 * time-aligned F1 metrics and tempo-free sequence pitch accuracy.
 */
class MelodyEvaluator {
public:
    static EvaluationReport evaluate(const std::vector<ExpectedNote>& expected,
                                     const std::vector<RecordedNote>& detected,
                                     const EvaluationConfig& config = EvaluationConfig{});

    // Compute Levenshtein edit distance between two MIDI pitch sequences.
    static int pitch_edit_distance(const std::vector<int>& a, const std::vector<int>& b);
};

} // namespace piano_dsp
