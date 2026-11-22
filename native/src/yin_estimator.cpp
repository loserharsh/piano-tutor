#include "piano_dsp/yin_estimator.h"
#include "piano_dsp/pitch_utils.h"
#include <algorithm>
#include <cmath>

namespace piano_dsp {

YinPitchEstimator::YinPitchEstimator(int frame_size) {
    ensure_buffers(frame_size);
}

void YinPitchEstimator::ensure_buffers(int frame_size) {
    if (frame_size == frame_size_ && corr_fft_) {
        return;
    }
    frame_size_ = frame_size;
    corr_fft_ = std::make_unique<FFT>(frame_size_);
    buf_a_.resize(frame_size_);
    buf_b_.resize(frame_size_);
    cum_sq_.resize(frame_size_ + 1);
    const int half = frame_size_ / 2;
    diff_.resize(half);
    cmndf_.resize(half);
}

float YinPitchEstimator::harmonic_support_score(float f0_hz,
                                                const std::vector<float>& mag_spec,
                                                int fft_size,
                                                int sample_rate) {
    if (f0_hz < kMinPianoHz || mag_spec.empty()) return 0.0f;

    const float bin_hz = static_cast<float>(sample_rate) / static_cast<float>(fft_size);
    const int max_bin = static_cast<int>(mag_spec.size()) - 1;
    const int max_harmonics = 6;
    float score = 0.0f;

    for (int h = 1; h <= max_harmonics; ++h) {
        const float target_hz = f0_hz * static_cast<float>(h);
        if (target_hz > static_cast<float>(sample_rate) * 0.45f) break;

        // Allow +/- 2 bins (or +/- 3% for piano string inharmonicity at upper partials).
        const float center_bin = target_hz / bin_hz;
        const int radius = std::max(1, static_cast<int>(std::ceil(center_bin * 0.025f)));
        const int b_start = std::max(1, static_cast<int>(std::floor(center_bin)) - radius);
        const int b_end = std::min(max_bin, static_cast<int>(std::ceil(center_bin)) + radius);

        float peak = 0.0f;
        for (int b = b_start; b <= b_end; ++b) {
            peak = std::max(peak, mag_spec[b]);
        }
        // Weight lower harmonics slightly more strongly.
        score += peak / std::sqrt(static_cast<float>(h));
    }
    return score;
}

std::vector<PitchCandidate> YinPitchEstimator::estimate(
    const float* frame,
    int frame_size,
    const std::vector<float>& magnitude_spec,
    int sample_rate,
    const PipelineConfig& config) {

    std::vector<PitchCandidate> results;
    if (!frame || frame_size < 512 || (frame_size & (frame_size - 1)) != 0) {
        return results;
    }

    ensure_buffers(frame_size);
    const int half = frame_size / 2;

    // 1. Cumulative squared energy for fast d(tau) computation.
    cum_sq_[0] = 0.0;
    for (int i = 0; i < frame_size; ++i) {
        const double s = static_cast<double>(frame[i]);
        cum_sq_[i + 1] = cum_sq_[i] + s * s;
    }

    const double energy_first_half = cum_sq_[half];
    if (energy_first_half < 1e-12) {
        return results;
    }

    // 2. FFT-accelerated cross-correlation: r(tau) = sum_{j=0}^{W-1} x[j] * x[j+tau].
    for (int i = 0; i < half; ++i) {
        buf_a_[i] = std::complex<float>(frame[i], 0.0f);
    }
    for (int i = half; i < frame_size; ++i) {
        buf_a_[i] = std::complex<float>(0.0f, 0.0f);
    }
    for (int i = 0; i < frame_size; ++i) {
        buf_b_[i] = std::complex<float>(frame[i], 0.0f);
    }

    corr_fft_->forward(buf_a_);
    corr_fft_->forward(buf_b_);
    for (int i = 0; i < frame_size; ++i) {
        buf_a_[i] = std::conj(buf_a_[i]) * buf_b_[i];
    }
    corr_fft_->inverse(buf_a_);

    // 3. Difference function d(tau) and Cumulative Mean Normalized Difference Function d'(tau).
    diff_[0] = 0.0f;
    cmndf_[0] = 1.0f;
    double running_sum = 0.0;

    for (int tau = 1; tau < half; ++tau) {
        const double energy_shifted = cum_sq_[tau + half] - cum_sq_[tau];
        const double corr = static_cast<double>(buf_a_[tau].real());
        double d = energy_first_half + energy_shifted - 2.0 * corr;
        if (d < 0.0) d = 0.0;
        diff_[tau] = static_cast<float>(d);
        running_sum += d;
        cmndf_[tau] = (running_sum > 1e-12)
                          ? static_cast<float>(d * static_cast<double>(tau) / running_sum)
                          : 1.0f;
    }

    // 4. Search lag bounds corresponding to the 88-key piano range (A0=27.5Hz .. C8=4186Hz).
    const int min_tau = std::max(2, static_cast<int>(std::floor(static_cast<float>(sample_rate) / kMaxPianoHz)));
    const int max_tau = std::min(half - 2, static_cast<int>(std::ceil(static_cast<float>(sample_rate) / kMinPianoHz)));
    if (min_tau >= max_tau) {
        return results;
    }

    // 5. Absolute threshold search (first local minimum below yin_threshold).
    int best_tau = -1;
    for (int tau = min_tau; tau <= max_tau; ++tau) {
        if (cmndf_[tau] < config.yin_threshold) {
            while (tau + 1 <= max_tau && cmndf_[tau + 1] < cmndf_[tau]) {
                ++tau;
            }
            best_tau = tau;
            break;
        }
    }

    // Fallback: if nothing fell below threshold, take global minimum if reasonably periodic.
    if (best_tau == -1) {
        float min_val = 1.0f;
        for (int tau = min_tau; tau <= max_tau; ++tau) {
            if (cmndf_[tau] < min_val) {
                min_val = cmndf_[tau];
                best_tau = tau;
            }
        }
        if (best_tau == -1 || min_val > 0.35f) {
            return results;
        }
    }

    // 6. Parabolic interpolation around best_tau for sub-sample frequency precision
    //    (performed before spectral disambiguation so f_curr is accurate at high treble).
    float refined_tau = static_cast<float>(best_tau);
    if (best_tau > 1 && best_tau < half - 1) {
        const float y0 = cmndf_[best_tau - 1];
        const float y1 = cmndf_[best_tau];
        const float y2 = cmndf_[best_tau + 1];
        const float denom = 2.0f * (y0 - 2.0f * y1 + y2);
        if (std::fabs(denom) > 1e-9f) {
            const float delta = (y0 - y2) / denom;
            if (delta > -1.0f && delta < 1.0f) {
                refined_tau += delta;
            }
        }
    }

    float freq_hz = static_cast<float>(sample_rate) / refined_tau;

    // 7. Spectral octave disambiguation for real piano tones:
    //    (a) Sub-octave guard (fixes both treble half-integer lag on C8 and bass sub-octave
    //        lock on C2): if odd partials of f_curr (1x, 3x, 5x) carry almost no energy compared
    //        to even partials (2x, 4x, 6x), the true fundamental is 2*f_curr.
    //    (b) Bass weak-fundamental guard: if 2*best_tau also has a strong CMNDF dip AND both
    //        f_curr/2 and 3*(f_curr/2) have clear spectral peaks, shift down one octave.
    if (!magnitude_spec.empty()) {
        const float bin_hz = static_cast<float>(sample_rate) / static_cast<float>(frame_size);
        const int max_bin = static_cast<int>(magnitude_spec.size()) - 1;

        auto peak_near = [&](float hz) -> float {
            const float c = hz / bin_hz;
            if (c < 1.0f || c > static_cast<float>(max_bin)) return 0.0f;
            const int lo = std::max(1, static_cast<int>(std::floor(c)) - 1);
            const int hi = std::min(max_bin, static_cast<int>(std::ceil(c)) + 1);
            float p = 0.0f;
            for (int b = lo; b <= hi; ++b) p = std::max(p, magnitude_spec[b]);
            return p;
        };

        const float odd_e = peak_near(freq_hz) + peak_near(3.0f * freq_hz) + peak_near(5.0f * freq_hz);
        const float even_e = peak_near(2.0f * freq_hz) + peak_near(4.0f * freq_hz) + peak_near(6.0f * freq_hz);

        if (2.0f * freq_hz <= kMaxPianoHz && even_e > 1e-6f && odd_e < 0.15f * even_e) {
            freq_hz *= 2.0f;
        } else {
            const int double_tau = best_tau * 2;
            const float f_sub = freq_hz * 0.5f;
            if (double_tau >= min_tau && double_tau <= max_tau - 2 && f_sub >= kMinPianoHz &&
                (freq_hz - f_sub) > 2.5f * bin_hz) {
                int sub_tau = double_tau;
                const int search_lo = std::max(min_tau, double_tau - 3);
                const int search_hi = std::min(max_tau, double_tau + 3);
                for (int t = search_lo; t <= search_hi; ++t) {
                    if (cmndf_[t] < cmndf_[sub_tau]) {
                        sub_tau = t;
                    }
                }
                if (cmndf_[sub_tau] < config.yin_threshold * 1.10f) {
                    auto local_peak_near = [&](float hz) -> float {
                        const int b = static_cast<int>(std::lround(hz / bin_hz));
                        if (b <= 1 || b >= max_bin) return 0.0f;
                        // Only count genuine spectral peaks, not Hann main-lobe skirts of neighbors.
                        if (magnitude_spec[b] > magnitude_spec[b - 1] &&
                            magnitude_spec[b] >= magnitude_spec[b + 1]) {
                            return magnitude_spec[b];
                        }
                        return 0.0f;
                    };
                    const float e_curr = peak_near(freq_hz);
                    const float e_ref = std::max(e_curr, peak_near(2.0f * freq_hz));
                    const float e_sub = local_peak_near(f_sub);
                    const float e_3sub = local_peak_near(3.0f * f_sub);
                    const float e_5sub = local_peak_near(5.0f * f_sub);
                    if (e_ref > 1e-6f && e_sub > 0.15f * e_ref &&
                        e_3sub > 0.25f * e_ref && (e_sub + e_3sub + e_5sub) > 0.55f * e_ref) {
                        freq_hz = static_cast<float>(sample_rate) / static_cast<float>(sub_tau);
                    }
                }
            }
        }
    }
    float cents = 0.0f;
    const int midi = PitchUtils::hz_to_midi(freq_hz, cents, config.a4_reference_hz);
    if (!PitchUtils::is_piano_midi(midi)) {
        return results;
    }

    const float confidence = std::clamp(1.0f - cmndf_[best_tau], 0.0f, 1.0f);
    if (confidence < config.min_confidence) {
        return results;
    }

    PitchCandidate cand;
    cand.frequency_hz = freq_hz;
    cand.midi_note = midi;
    cand.cents_offset = cents;
    cand.confidence = confidence;
    cand.energy = harmonic_support_score(freq_hz, magnitude_spec, frame_size, sample_rate);
    results.push_back(cand);
    return results;
}

} // namespace piano_dsp
