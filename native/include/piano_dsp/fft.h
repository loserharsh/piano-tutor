#pragma once

#include <complex>
#include <vector>

namespace piano_dsp {

/**
 * Self-contained Radix-2 Cooley-Tukey FFT with precomputed twiddle factors and Hann window.
 * Zero external dependencies; suitable for real-time mobile and desktop audio DSP.
 */
class FFT {
public:
    explicit FFT(int size);

    int size() const { return size_; }

    // In-place forward or inverse complex FFT.
    void forward(std::vector<std::complex<float>>& data) const;
    void inverse(std::vector<std::complex<float>>& data) const;

    // Convenience: real input -> magnitude spectrum (size / 2 + 1 bins), applying Hann window.
    void real_magnitude_spectrum(const float* time_domain,
                                 std::vector<float>& magnitudes_out,
                                 bool apply_hann = true) const;

    const std::vector<float>& hann_window() const { return hann_; }

private:
    void transform(std::vector<std::complex<float>>& data, bool inverse) const;

    int size_;
    int log2_size_;
    std::vector<int> bit_reverse_;
    std::vector<float> hann_;
};

} // namespace piano_dsp
