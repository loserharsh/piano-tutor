#include "piano_dsp/biquad_filter.h"
#include <cmath>

namespace piano_dsp {

namespace {
constexpr float kPi = 3.14159265358979323846f;
}

void BiquadFilter::configure_highpass(float sample_rate, float cutoff_hz, float q) {
    const float w0 = 2.0f * kPi * cutoff_hz / sample_rate;
    const float cos_w0 = std::cos(w0);
    const float sin_w0 = std::sin(w0);
    const float alpha = sin_w0 / (2.0f * q);

    const float a0 = 1.0f + alpha;
    b0_ = ((1.0f + cos_w0) * 0.5f) / a0;
    b1_ = (-(1.0f + cos_w0)) / a0;
    b2_ = ((1.0f + cos_w0) * 0.5f) / a0;
    a1_ = (-2.0f * cos_w0) / a0;
    a2_ = (1.0f - alpha) / a0;
    reset();
}

void BiquadFilter::configure_lowpass(float sample_rate, float cutoff_hz, float q) {
    const float w0 = 2.0f * kPi * cutoff_hz / sample_rate;
    const float cos_w0 = std::cos(w0);
    const float sin_w0 = std::sin(w0);
    const float alpha = sin_w0 / (2.0f * q);

    const float a0 = 1.0f + alpha;
    b0_ = ((1.0f - cos_w0) * 0.5f) / a0;
    b1_ = (1.0f - cos_w0) / a0;
    b2_ = ((1.0f - cos_w0) * 0.5f) / a0;
    a1_ = (-2.0f * cos_w0) / a0;
    a2_ = (1.0f - alpha) / a0;
    reset();
}

void BiquadFilter::reset() {
    z1_ = 0.0f;
    z2_ = 0.0f;
}

float BiquadFilter::process(float x) {
    const float y = b0_ * x + z1_;
    z1_ = b1_ * x - a1_ * y + z2_;
    z2_ = b2_ * x - a2_ * y;
    return y;
}

void BiquadFilter::process_block(float* samples, int count) {
    for (int i = 0; i < count; ++i) {
        samples[i] = process(samples[i]);
    }
}

} // namespace piano_dsp
