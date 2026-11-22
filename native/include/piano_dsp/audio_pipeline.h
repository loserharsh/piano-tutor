#pragma once

#include "piano_dsp/biquad_filter.h"
#include "piano_dsp/fft.h"
#include "piano_dsp/melody_recorder.h"
#include "piano_dsp/onset_detector.h"
#include "piano_dsp/pitch_estimator.h"
#include "piano_dsp/ring_buffer.h"
#include "piano_dsp/types.h"
#include <deque>
#include <memory>
#include <mutex>
#include <vector>

namespace piano_dsp {

/**
 * End-to-end real-time audio recognition pipeline:
 *
 * Raw Mic PCM -> RingBuffer -> Overlapping Frame Assembly ->
 * High-Pass/Low-Pass Filtering -> Noise Floor Gate ->
 * Hann-Windowed FFT -> Pluggable Pitch Estimator (YIN in M1) ->
 * Onset & Note State Tracker -> AnalysisSnapshot + NoteEvent queue + MelodyRecorder.
 */
class AudioPipeline {
public:
    explicit AudioPipeline(const PipelineConfig& config,
                           std::unique_ptr<IPitchEstimator> estimator = nullptr);

    void reset();

    // Swap pitch estimator at runtime (e.g. monophonic YIN -> polyphonic model in M5).
    void set_pitch_estimator(std::unique_ptr<IPitchEstimator> estimator);

    const PipelineConfig& config() const { return config_; }
    void update_noise_gate_db(float noise_gate_db);
    void update_yin_threshold(float yin_threshold);

    /**
     * Thread-safe audio ingestion (safe to call from real-time audio capture thread).
     * Returns number of samples accepted into the ring buffer.
     */
    size_t push_audio(const float* samples, size_t count);

    /**
     * Drain ring buffer and process all available overlapping hops.
     * Returns number of frames processed in this call.
     */
    int process_available();

    /**
     * Latest analysis snapshot (thread-safe copy).
     */
    AnalysisSnapshot latest_snapshot() const;

    /**
     * Pop the next pending NoteEvent (NoteOn / NoteOff). Returns false if queue is empty.
     */
    bool pop_note_event(NoteEvent& out_event);

    // Milestone 2: Melody sequence recording controls (thread-safe).
    void start_recording();
    void stop_recording();
    bool is_recording() const;
    std::vector<RecordedNote> recorded_notes() const;

private:
    void process_frame();
    void compute_log_spectrum(const std::vector<float>& mag_spec, float* out_bins) const;

    PipelineConfig config_;
    std::unique_ptr<IPitchEstimator> estimator_;
    FFT fft_;
    BiquadFilter highpass_;
    BiquadFilter lowpass_;
    OnsetAndNoteTracker note_tracker_;

    RingBuffer<float> ring_buffer_;
    std::vector<float> hop_scratch_;
    std::vector<float> rolling_window_;
    std::vector<float> filtered_frame_;
    std::vector<float> magnitude_spec_;
    int samples_accumulated_ = 0;
    uint64_t total_samples_processed_ = 0;

    float noise_floor_db_ = -65.0f;

    mutable std::mutex state_mutex_;
    AnalysisSnapshot latest_snapshot_;
    std::deque<NoteEvent> event_queue_;
    MelodyRecorder recorder_;
};

} // namespace piano_dsp
