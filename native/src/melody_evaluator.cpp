#include "piano_dsp/melody_evaluator.h"
#include <algorithm>
#include <cmath>
#include <limits>

namespace piano_dsp {

int MelodyEvaluator::pitch_edit_distance(const std::vector<int>& a, const std::vector<int>& b) {
    const size_t n = a.size();
    const size_t m = b.size();
    std::vector<int> prev(m + 1), curr(m + 1);
    for (size_t j = 0; j <= m; ++j) prev[j] = static_cast<int>(j);

    for (size_t i = 1; i <= n; ++i) {
        curr[0] = static_cast<int>(i);
        for (size_t j = 1; j <= m; ++j) {
            const int cost = (a[i - 1] == b[j - 1]) ? 0 : 1;
            curr[j] = std::min({
                prev[j] + 1,        // deletion
                curr[j - 1] + 1,    // insertion
                prev[j - 1] + cost  // substitution
            });
        }
        std::swap(prev, curr);
    }
    return prev[m];
}

EvaluationReport MelodyEvaluator::evaluate(const std::vector<ExpectedNote>& expected,
                                           const std::vector<RecordedNote>& detected,
                                           const EvaluationConfig& config) {
    EvaluationReport report;
    report.expected_count = static_cast<int>(expected.size());
    report.detected_count = static_cast<int>(detected.size());

    // 1. Tempo-free sequence pitch accuracy via Levenshtein edit distance.
    std::vector<int> exp_pitches, det_pitches;
    exp_pitches.reserve(expected.size());
    det_pitches.reserve(detected.size());
    for (const auto& e : expected) exp_pitches.push_back(e.midi_note);
    for (const auto& d : detected) det_pitches.push_back(d.midi_note);

    const int max_len = std::max(report.expected_count, report.detected_count);
    if (max_len == 0) {
        report.sequence_accuracy = 1.0;
        report.precision = 1.0;
        report.recall = 1.0;
        report.f1_score = 1.0;
        return report;
    }
    const int edit_dist = pitch_edit_distance(exp_pitches, det_pitches);
    report.sequence_accuracy = std::max(0.0, 1.0 - static_cast<double>(edit_dist) / static_cast<double>(max_len));

    // 2. Optional constant latency estimation using median onset delta of pitch-matched pairs.
    double latency_sec = config.latency_offset_sec;
    if (config.auto_estimate_latency && !expected.empty() && !detected.empty()) {
        std::vector<double> deltas;
        for (const auto& e : expected) {
            double best_diff = std::numeric_limits<double>::max();
            double best_signed = 0.0;
            for (const auto& d : detected) {
                if (d.midi_note != e.midi_note) continue;
                const double signed_err = d.start_sec - e.start_sec;
                const double abs_err = std::fabs(signed_err);
                if (abs_err < best_diff && abs_err < 0.500) {
                    best_diff = abs_err;
                    best_signed = signed_err;
                }
            }
            if (best_diff < 0.500) {
                deltas.push_back(best_signed);
            }
        }
        if (!deltas.empty()) {
            std::sort(deltas.begin(), deltas.end());
            latency_sec = deltas[deltas.size() / 2];
        }
    }
    report.estimated_latency_ms = latency_sec * 1000.0;

    // 3. Time-aligned matching:
    //    Pass A: Match exact-pitch pairs within timing_tolerance_sec (closest in time first).
    std::vector<bool> exp_used(expected.size(), false);
    std::vector<bool> det_used(detected.size(), false);

    struct CandidatePair {
        int exp_idx;
        int det_idx;
        double abs_err;
        double signed_err;
    };

    std::vector<CandidatePair> exact_pairs;
    for (size_t i = 0; i < expected.size(); ++i) {
        for (size_t j = 0; j < detected.size(); ++j) {
            if (expected[i].midi_note != detected[j].midi_note) continue;
            const double signed_err = (detected[j].start_sec - latency_sec) - expected[i].start_sec;
            const double abs_err = std::fabs(signed_err);
            if (abs_err <= config.timing_tolerance_sec) {
                exact_pairs.push_back({static_cast<int>(i), static_cast<int>(j), abs_err, signed_err});
            }
        }
    }
    std::sort(exact_pairs.begin(), exact_pairs.end(),
              [](const CandidatePair& a, const CandidatePair& b) { return a.abs_err < b.abs_err; });

    double sum_abs_ms = 0.0;
    double sum_signed_ms = 0.0;

    for (const auto& p : exact_pairs) {
        if (exp_used[p.exp_idx] || det_used[p.det_idx]) continue;
        exp_used[p.exp_idx] = true;
        det_used[p.det_idx] = true;
        ++report.true_positives;

        const double err_ms = p.signed_err * 1000.0;
        sum_abs_ms += std::fabs(err_ms);
        sum_signed_ms += err_ms;

        NoteMatchDetail d;
        d.status = NoteMatchStatus::Correct;
        d.expected_index = p.exp_idx;
        d.detected_index = p.det_idx;
        d.expected_midi = expected[p.exp_idx].midi_note;
        d.detected_midi = detected[p.det_idx].midi_note;
        d.timing_error_ms = err_ms;
        report.details.push_back(d);
    }

    //    Pass B: Remaining unmatched expected/detected notes within timing_tolerance_sec -> WrongPitch.
    std::vector<CandidatePair> wrong_pitch_pairs;
    for (size_t i = 0; i < expected.size(); ++i) {
        if (exp_used[i]) continue;
        for (size_t j = 0; j < detected.size(); ++j) {
            if (det_used[j]) continue;
            const double signed_err = (detected[j].start_sec - latency_sec) - expected[i].start_sec;
            const double abs_err = std::fabs(signed_err);
            if (abs_err <= config.timing_tolerance_sec) {
                wrong_pitch_pairs.push_back({static_cast<int>(i), static_cast<int>(j), abs_err, signed_err});
            }
        }
    }
    std::sort(wrong_pitch_pairs.begin(), wrong_pitch_pairs.end(),
              [](const CandidatePair& a, const CandidatePair& b) { return a.abs_err < b.abs_err; });

    for (const auto& p : wrong_pitch_pairs) {
        if (exp_used[p.exp_idx] || det_used[p.det_idx]) continue;
        exp_used[p.exp_idx] = true;
        det_used[p.det_idx] = true;
        ++report.pitch_errors;

        NoteMatchDetail d;
        d.status = NoteMatchStatus::WrongPitch;
        d.expected_index = p.exp_idx;
        d.detected_index = p.det_idx;
        d.expected_midi = expected[p.exp_idx].midi_note;
        d.detected_midi = detected[p.det_idx].midi_note;
        d.timing_error_ms = p.signed_err * 1000.0;
        report.details.push_back(d);
    }

    //    Pass C: Record missed expected notes and extra detected notes.
    for (size_t i = 0; i < expected.size(); ++i) {
        if (!exp_used[i]) {
            ++report.missed_notes;
            NoteMatchDetail d;
            d.status = NoteMatchStatus::Missed;
            d.expected_index = static_cast<int>(i);
            d.expected_midi = expected[i].midi_note;
            report.details.push_back(d);
        }
    }
    for (size_t j = 0; j < detected.size(); ++j) {
        if (!det_used[j]) {
            ++report.extra_notes;
            NoteMatchDetail d;
            d.status = NoteMatchStatus::Extra;
            d.detected_index = static_cast<int>(j);
            d.detected_midi = detected[j].midi_note;
            report.details.push_back(d);
        }
    }

    // 4. Aggregate metrics.
    report.precision = (report.detected_count > 0)
                           ? static_cast<double>(report.true_positives) / static_cast<double>(report.detected_count)
                           : 0.0;
    report.recall = (report.expected_count > 0)
                        ? static_cast<double>(report.true_positives) / static_cast<double>(report.expected_count)
                        : 0.0;
    if (report.precision + report.recall > 0.0) {
        report.f1_score = 2.0 * report.precision * report.recall / (report.precision + report.recall);
    }
    if (report.true_positives > 0) {
        report.mean_abs_timing_error_ms = sum_abs_ms / static_cast<double>(report.true_positives);
        report.mean_signed_timing_error_ms = sum_signed_ms / static_cast<double>(report.true_positives);
    }

    return report;
}

} // namespace piano_dsp
