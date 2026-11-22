#include "piano_dsp/fft.h"
#include <cmath>
#include <stdexcept>

namespace piano_dsp {

namespace {
constexpr float kTwoPi = 6.28318530717958647692f;
}

FFT::FFT(int size) : size_(size), log2_size_(0) {
    if (size <= 0 || (size & (size - 1)) != 0) {
        throw std::invalid_argument("FFT size must be a positive power of two");
    }
    int temp = size;
    while (temp > 1) {
        temp >>= 1;
        ++log2_size_;
    }

    bit_reverse_.resize(size_);
    for (int i = 0; i < size_; ++i) {
        int rev = 0;
        int x = i;
        for (int b = 0; b < log2_size_; ++b) {
            rev = (rev << 1) | (x & 1);
            x >>= 1;
        }
        bit_reverse_[i] = rev;
    }

    hann_.resize(size_);
    for (int i = 0; i < size_; ++i) {
        hann_[i] = 0.5f * (1.0f - std::cos(kTwoPi * static_cast<float>(i) / static_cast<float>(size_ - 1)));
    }
}

void FFT::forward(std::vector<std::complex<float>>& data) const {
    transform(data, false);
}

void FFT::inverse(std::vector<std::complex<float>>& data) const {
    transform(data, true);
    const float inv_n = 1.0f / static_cast<float>(size_);
    for (auto& c : data) {
        c *= inv_n;
    }
}

void FFT::transform(std::vector<std::complex<float>>& data, bool inverse) const {
    for (int i = 0; i < size_; ++i) {
        const int j = bit_reverse_[i];
        if (i < j) {
            std::swap(data[i], data[j]);
        }
    }

    const float sign = inverse ? 1.0f : -1.0f;
    for (int len = 2; len <= size_; len <<= 1) {
        const int half = len >> 1;
        const float angle = sign * kTwoPi / static_cast<float>(len);
        const std::complex<float> w_step(std::cos(angle), std::sin(angle));

        for (int i = 0; i < size_; i += len) {
            std::complex<float> w(1.0f, 0.0f);
            for (int j = 0; j < half; ++j) {
                const auto u = data[i + j];
                const auto v = data[i + j + half] * w;
                data[i + j] = u + v;
                data[i + j + half] = u - v;
                w *= w_step;
            }
        }
    }
}

void FFT::real_magnitude_spectrum(const float* time_domain,
                                  std::vector<float>& magnitudes_out,
                                  bool apply_hann) const {
    std::vector<std::complex<float>> buf(size_);
    if (apply_hann) {
        for (int i = 0; i < size_; ++i) {
            buf[i] = std::complex<float>(time_domain[i] * hann_[i], 0.0f);
        }
    } else {
        for (int i = 0; i < size_; ++i) {
            buf[i] = std::complex<float>(time_domain[i], 0.0f);
        }
    }

    forward(buf);

    const int bins = size_ / 2 + 1;
    magnitudes_out.resize(bins);
    const float scale = 2.0f / static_cast<float>(size_);
    for (int k = 0; k < bins; ++k) {
        magnitudes_out[k] = std::abs(buf[k]) * scale;
    }
}

} // namespace piano_dsp
