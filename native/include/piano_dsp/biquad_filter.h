#pragma once

namespace piano_dsp {

/**
 * Second-order IIR Biquad filter (Direct Form II Transposed).
 * Used for DC removal / high-pass rumble rejection and low-pass anti-hiss filtering.
 */
class BiquadFilter {
public:
    BiquadFilter() = default;

    void configure_highpass(float sample_rate, float cutoff_hz, float q = 0.70710678f);
    void configure_lowpass(float sample_rate, float cutoff_hz, float q = 0.70710678f);
    void reset();

    float process(float x);
    void process_block(float* samples, int count);

private:
    float b0_ = 1.0f, b1_ = 0.0f, b2_ = 0.0f;
    float a1_ = 0.0f, a2_ = 0.0f;
    float z1_ = 0.0f, z2_ = 0.0f;
};

} // namespace piano_dsp
