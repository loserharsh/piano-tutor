#include "piano_dsp/audio_pipeline.h"
#include "piano_dsp/yin_estimator.h"
#include <algorithm>
#include <cmath>
#include <cstring>

namespace piano_dsp {

AudioPipeline::AudioPipeline(const PipelineConfig& config,
                             std::unique_ptr<IPitchEstimator> estimator)
    : config_(config),
      estimator_(estimator ? std::move(estimator)
                           : std::make_unique<YinPitchEstimator>(config.frame_size)),
      fft_(config.frame_size),
      ring_buffer_(static_cast<size_t>(config.sample_rate)), // ~1 second lock-free buffer
      hop_scratch_(config.hop_size, 0.0f),
      rolling_window_(config.frame_size, 0.0f),
      filtered_frame_(config.frame_size, 0.0f) {

    // Continuous pre-filtering: remove DC & room rumble (<25 Hz) and ultrasonic hiss (>4500 Hz).
    highpass_.configure_highpass(static_cast<float>(config_.sample_rate), 25.0f);
    lowpass_.configure_lowpass(static_cast<float>(config_.sample_rate), 4500.0f);
    reset();
}

void AudioPipeline::reset() {
    ring_buffer_.clear();
    highpass_.reset();
    lowpass_.reset();
    note_tracker_.reset();
    std::fill(rolling_window_.begin(), rolling_window_.end(), 0.0f);
    samples_accumulated_ = 0;
    total_samples_processed_ = 0;
    noise_floor_db_ = -65.0f;

    std::lock_guard<std::mutex> lock(state_mutex_);
    latest_snapshot_ = AnalysisSnapshot{};
    event_queue_.clear();
}

void AudioPipeline::set_pitch_estimator(std::unique_ptr<IPitchEstimator> estimator) {
    if (estimator) {
        estimator_ = std::move(estimator);
    }
}

void AudioPipeline::update_noise_gate_db(float noise_gate_db) {
    config_.noise_gate_db = noise_gate_db;
}

void AudioPipeline::update_yin_threshold(float yin_threshold) {
    config_.yin_threshold = std::clamp(yin_threshold, 0.05f, 0.40f);
}

size_t AudioPipeline::push_audio(const float* samples, size_t count) {
    if (!samples || count == 0) return 0;
    return ring_buffer_.push(samples, count);
}

int AudioPipeline::process_available() {
    int frames_processed = 0;
    const size_t hop = static_cast<size_t>(config_.hop_size);

    while (ring_buffer_.available_read() >= hop) {
        ring_buffer_.pop(hop_scratch_.data(), hop);

        // Apply continuous IIR band-pass filtering to the new hop only.
        highpass_.process_block(hop_scratch_.data(), config_.hop_size);
        lowpass_.process_block(hop_scratch_.data(), config_.hop_size);

        // Shift rolling window left by hop_size and append new filtered hop.
        const size_t keep = static_cast<size_t>(config_.frame_size - config_.hop_size);
        std::memmove(rolling_window_.data(),
                     rolling_window_.data() + hop,
                     keep * sizeof(float));
        std::memcpy(rolling_window_.data() + keep,
                    hop_scratch_.data(),
                    hop * sizeof(float));

        total_samples_processed_ += hop;
        samples_accumulated_ = std::min(config_.frame_size,
                                        samples_accumulated_ + config_.hop_size);

        if (samples_accumulated_ >= config_.frame_size) {
            process_frame();
            ++frames_processed;
        }
    }
    return frames_processed;
}

void AudioPipeline::process_frame() {
    // 1. Compute frame RMS level in dBFS.
    double sum_sq = 0.0;
    for (int i = 0; i < config_.frame_size; ++i) {
        const double s = static_cast<double>(rolling_window_[i]);
        sum_sq += s * s;
    }
    const float rms = static_cast<float>(std::sqrt(sum_sq / static_cast<double>(config_.frame_size)));
    const float rms_db = (rms > 1e-9f) ? (20.0f * std::log10(rms)) : -100.0f;

    // Track ambient noise floor slowly when signal is quiet.
    if (rms_db < noise_floor_db_ + 6.0f) {
        noise_floor_db_ = 0.98f * noise_floor_db_ + 0.02f * rms_db;
    } else {
        noise_floor_db_ = 0.999f * noise_floor_db_ + 0.001f * rms_db;
    }

    // 2. Compute Hann-windowed FFT magnitude spectrum.
    fft_.real_magnitude_spectrum(rolling_window_.data(), magnitude_spec_, true);

    // 3. Noise gate check: avoid running pitch estimation on room noise.
    const float effective_gate_db = std::max(config_.noise_gate_db, noise_floor_db_ + 6.0f);
    PitchCandidate top_candidate;

    if (rms_db >= effective_gate_db && estimator_) {
        auto candidates = estimator_->estimate(
            rolling_window_.data(),
            config_.frame_size,
            magnitude_spec_,
            config_.sample_rate,
            config_);
        if (!candidates.empty()) {
            top_candidate = candidates.front();
        }
    }

    // 4. Onset detection & sustained-note tracking.
    const double timestamp_sec = static_cast<double>(total_samples_processed_) /
                                 static_cast<double>(config_.sample_rate);
    float flux = 0.0f;
    bool is_onset = false;
    std::vector<NoteEvent> new_events;
    const int active_midi = note_tracker_.process(
        magnitude_spec_, top_candidate, rms_db, timestamp_sec, config_,
        flux, is_onset, new_events);

    // 5. Build visualization snapshot.
    AnalysisSnapshot snap;
    snap.has_pitch = (top_candidate.midi_note != -1);
    snap.frequency_hz = top_candidate.frequency_hz;
    snap.midi_note = top_candidate.midi_note;
    snap.cents_offset = top_candidate.cents_offset;
    snap.confidence = top_candidate.confidence;
    snap.rms_db = rms_db;
    snap.noise_floor_db = noise_floor_db_;
    snap.spectral_flux = flux;
    snap.is_onset = is_onset;
    snap.active_note_midi = active_midi;
    snap.timestamp_sec = timestamp_sec;
    compute_log_spectrum(magnitude_spec_, snap.spectrum_bins);

    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        latest_snapshot_ = snap;
        for (const auto& evt : new_events) {
            if (recorder_.is_recording()) {
                recorder_.on_note_event(evt);
            }
            if (event_queue_.size() < 256) {
                event_queue_.push_back(evt);
            }
        }
    }
}

void AudioPipeline::compute_log_spectrum(const std::vector<float>& mag_spec, float* out_bins) const {
    if (mag_spec.empty()) {
        std::memset(out_bins, 0, sizeof(float) * kSpectrumBins);
        return;
    }

    const float bin_hz = static_cast<float>(config_.sample_rate) /
                         static_cast<float>(config_.frame_size);
    const int max_bin = static_cast<int>(mag_spec.size()) - 1;
    const float f_min = 27.5f;   // A0
    const float f_max = 4500.0f; // Slightly above C8
    const float log_ratio = std::log(f_max / f_min);

    for (int i = 0; i < kSpectrumBins; ++i) {
        const float f0 = f_min * std::exp(log_ratio * static_cast<float>(i) / static_cast<float>(kSpectrumBins));
        const float f1 = f_min * std::exp(log_ratio * static_cast<float>(i + 1) / static_cast<float>(kSpectrumBins));

        const int b0 = std::clamp(static_cast<int>(std::floor(f0 / bin_hz)), 1, max_bin);
        const int b1 = std::clamp(static_cast<int>(std::ceil(f1 / bin_hz)), b0, max_bin);

        float peak = 0.0f;
        for (int b = b0; b <= b1; ++b) {
            peak = std::max(peak, mag_spec[b]);
        }

        // Convert magnitude to compressed dB scale [0..1] for clean UI rendering.
        const float db = (peak > 1e-7f) ? (20.0f * std::log10(peak)) : -140.0f;
        out_bins[i] = std::clamp((db + 75.0f) / 65.0f, 0.0f, 1.0f);
    }
}

AnalysisSnapshot AudioPipeline::latest_snapshot() const {
    std::lock_guard<std::mutex> lock(state_mutex_);
    return latest_snapshot_;
}

bool AudioPipeline::pop_note_event(NoteEvent& out_event) {
    std::lock_guard<std::mutex> lock(state_mutex_);
    if (event_queue_.empty()) {
        return false;
    }
    out_event = event_queue_.front();
    event_queue_.pop_front();
    return true;
}

void AudioPipeline::start_recording() {
    std::lock_guard<std::mutex> lock(state_mutex_);
    const double now_sec = static_cast<double>(total_samples_processed_) /
                           static_cast<double>(config_.sample_rate);
    recorder_.start(now_sec);
}

void AudioPipeline::stop_recording() {
    std::lock_guard<std::mutex> lock(state_mutex_);
    const double now_sec = static_cast<double>(total_samples_processed_) /
                           static_cast<double>(config_.sample_rate);
    recorder_.stop(now_sec);
}

bool AudioPipeline::is_recording() const {
    std::lock_guard<std::mutex> lock(state_mutex_);
    return recorder_.is_recording();
}

std::vector<RecordedNote> AudioPipeline::recorded_notes() const {
    std::lock_guard<std::mutex> lock(state_mutex_);
    return recorder_.notes();
}

} // namespace piano_dsp
