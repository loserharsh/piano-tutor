#pragma once

#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace piano_dsp {

struct AudioDeviceInfo {
    std::string id;
    std::string name;
    bool is_default = false;
};

enum class CaptureStatus {
    Ok = 0,
    DeviceNotFound,
    UnsupportedFormat,
    PermissionDenied,
    BackendError,
    AlreadyRunning
};

struct CaptureResult {
    CaptureStatus status = CaptureStatus::Ok;
    std::string message;
};

using AudioSamplesCallback = std::function<void(const float* samples, size_t count)>;

/**
 * Cross-platform microphone capture interface.
 * Platform backends:
 *  - Linux:   PulseAudio / PipeWire-pulse (libpulse-simple)
 *  - Windows: WASAPI (Milestone 6 / native Windows build)
 *  - Android: AAudio / Oboe or Flutter mic stream feeding piano_dsp_push_audio()
 */
class IAudioCapture {
public:
    virtual ~IAudioCapture() = default;

    virtual std::string backend_name() const = 0;
    virtual std::vector<AudioDeviceInfo> list_input_devices() const = 0;

    virtual CaptureResult start(int sample_rate,
                                int frames_per_buffer,
                                const std::string& device_id,
                                AudioSamplesCallback callback) = 0;
    virtual void stop() = 0;
    virtual bool is_running() const = 0;
};

// Factory returning the native capture backend for the current OS.
std::unique_ptr<IAudioCapture> create_native_audio_capture();

} // namespace piano_dsp
