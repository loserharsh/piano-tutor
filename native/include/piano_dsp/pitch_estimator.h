#pragma once

#include "piano_dsp/types.h"
#include <string>
#include <vector>

namespace piano_dsp {

/**
 * Abstract interface for pitch estimation backends.
 *
 * Milestone 1 uses YinPitchEstimator (monophonic, FFT-accelerated YIN with spectral verification).
 * Milestone 5 can plug in a polyphonic estimator (e.g., Harmonic Summation, NMF, or ONNX)
 * without changing the audio pipeline, C-ABI, or Flutter UI.
 */
class IPitchEstimator {
public:
    virtual ~IPitchEstimator() = default;

    virtual std::string name() const = 0;
    virtual bool supports_polyphony() const = 0;

    /**
     * Estimate pitch candidate(s) from a pre-filtered time-domain frame and its magnitude spectrum.
     *
     * @param frame          Time-domain PCM samples (length = config.frame_size).
     * @param frame_size     Number of samples in frame.
     * @param magnitude_spec FFT magnitude spectrum (length = frame_size / 2 + 1).
     * @param sample_rate    Audio sample rate in Hz (e.g. 44100 or 48000).
     * @param config         Pipeline configuration parameters.
     * @return               Detected pitch candidates sorted by confidence descending.
     */
    virtual std::vector<PitchCandidate> estimate(
        const float* frame,
        int frame_size,
        const std::vector<float>& magnitude_spec,
        int sample_rate,
        const PipelineConfig& config) = 0;
};

} // namespace piano_dsp
