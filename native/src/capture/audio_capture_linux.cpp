#include "piano_dsp/audio_capture.h"

#ifdef PIANO_DSP_USE_PULSEAUDIO

#include <atomic>
#include <pulse/error.h>
#include <pulse/simple.h>
#include <thread>
#include <vector>

namespace piano_dsp {

class PulseAudioCapture : public IAudioCapture {
public:
    ~PulseAudioCapture() override { stop(); }

    std::string backend_name() const override { return "Linux PulseAudio/PipeWire"; }

    std::vector<AudioDeviceInfo> list_input_devices() const override {
        return {AudioDeviceInfo{"default", "System Default Microphone (PulseAudio/PipeWire)", true}};
    }

    CaptureResult start(int sample_rate,
                        int frames_per_buffer,
                        const std::string& device_id,
                        AudioSamplesCallback callback) override {
        if (running_.load()) {
            return {CaptureStatus::AlreadyRunning, "Microphone capture is already running."};
        }
        if (sample_rate != 44100 && sample_rate != 48000) {
            return {CaptureStatus::UnsupportedFormat,
                    "Unsupported sample rate. Supported rates are 44100 Hz and 48000 Hz."};
        }
        if (!callback) {
            return {CaptureStatus::BackendError, "Audio callback must not be null."};
        }

        pa_sample_spec ss{};
        ss.format = PA_SAMPLE_FLOAT32LE;
        ss.rate = static_cast<uint32_t>(sample_rate);
        ss.channels = 1;

        pa_buffer_attr attr{};
        attr.maxlength = static_cast<uint32_t>(-1);
        attr.fragsize = static_cast<uint32_t>(frames_per_buffer * sizeof(float));

        const char* dev = (device_id.empty() || device_id == "default") ? nullptr : device_id.c_str();
        int error = 0;
        pa_simple* stream = pa_simple_new(
            nullptr,
            "PianoTutor",
            PA_STREAM_RECORD,
            dev,
            "Piano Microphone Input",
            &ss,
            nullptr,
            &attr,
            &error);

        if (!stream) {
            const std::string err_str = pa_strerror(error);
            if (error == PA_ERR_ACCESS) {
                return {CaptureStatus::PermissionDenied, "Microphone permission denied: " + err_str};
            }
            if (error == PA_ERR_NOENTITY) {
                return {CaptureStatus::DeviceNotFound, "Audio input device not found: " + err_str};
            }
            return {CaptureStatus::BackendError, "Failed to open PulseAudio input: " + err_str};
        }

        stream_ = stream;
        callback_ = std::move(callback);
        frames_per_buffer_ = (frames_per_buffer > 0) ? frames_per_buffer : 512;
        running_.store(true);

        capture_thread_ = std::thread([this]() { capture_loop(); });
        return {CaptureStatus::Ok, "Microphone capture started."};
    }

    void stop() override {
        if (!running_.exchange(false)) {
            return;
        }
        if (capture_thread_.joinable()) {
            capture_thread_.join();
        }
        if (stream_) {
            pa_simple_free(stream_);
            stream_ = nullptr;
        }
    }

    bool is_running() const override { return running_.load(); }

private:
    void capture_loop() {
        std::vector<float> buf(static_cast<size_t>(frames_per_buffer_));
        int error = 0;
        while (running_.load()) {
            if (pa_simple_read(stream_, buf.data(), buf.size() * sizeof(float), &error) < 0) {
                running_.store(false);
                break;
            }
            if (callback_) {
                callback_(buf.data(), buf.size());
            }
        }
    }

    pa_simple* stream_ = nullptr;
    AudioSamplesCallback callback_;
    int frames_per_buffer_ = 512;
    std::atomic<bool> running_{false};
    std::thread capture_thread_;
};

std::unique_ptr<IAudioCapture> create_native_audio_capture() {
    return std::make_unique<PulseAudioCapture>();
}

} // namespace piano_dsp

#endif // PIANO_DSP_USE_PULSEAUDIO
