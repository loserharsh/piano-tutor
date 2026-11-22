#pragma once

#include "piano_dsp/fft.h"
#include "piano_dsp/pitch_estimator.h"
#include <complex>
#include <memory>
#include <vector>

namespace piano_dsp {

/**
 * FFT-accelerated YIN fundamental frequency estimator with spectral harmonic verification.
 *
 * Uses FFT-based cross-correlation to compute the YIN difference function d(tau) in O(N log N)
 * rather than O(N^2), enabling 4096-sample frames (down to piano A0 = 27.5 Hz) at low latency.
 * Includes parabolic lag interpolation and spectral harmonic checking to mitigate octave errors
 * common on acoustic pianos (weak bass fundamental or strong 2nd/3rd harmonics).
 */
class YinPitchEstimator : public IPitchEstimator {
public:
    explicit YinPitchEstimator(int frame_size = 4096);

    std::string name() const override { return "YIN-FFT+HarmonicCheck"; }
    bool supports_polyphony() const override { return false; }

    std::vector<PitchCandidate> estimate(
        const float* frame,
        int frame_size,
        const std::vector<float>& magnitude_spec,
        int sample_rate,
        const PipelineConfig& config) override;

private:
    void ensure_buffers(int frame_size);

    // Helper: sum spectral magnitude around f0 and its harmonics (accounting for mild inharmonicity).
    static float harmonic_support_score(float f0_hz,
                                        const std::vector<float>& mag_spec,
                                        int fft_size,
                                        int sample_rate);

    int frame_size_ = 0;
    std::unique_ptr<FFT> corr_fft_;
    std::vector<std::complex<float>> buf_a_;
    std::vector<std::complex<float>> buf_b_;
    std::vector<double> cum_sq_;
    std::vector<float> diff_;
    std::vector<float> cmndf_;
};

} // namespace piano_dsp
