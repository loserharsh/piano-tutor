#include "piano_dsp/audio_capture.h"

#ifndef PIANO_DSP_USE_PULSEAUDIO

namespace piano_dsp {

/**
 * Fallback capture adapter for platforms where audio capture is driven externally
 * (e.g., Android AAudio/Oboe or Flutter mic stream calling piano_dsp_push_audio()).
 */
class ExternalPushAudioCapture : public IAudioCapture {
public:
    std::string backend_name() const override { return "ExternalPush (FFI)"; }

    std::vector<AudioDeviceInfo> list_input_devices() const override {
        return {};
    }

    CaptureResult start(int, int, const std::string&, AudioSamplesCallback) override {
        return {CaptureStatus::BackendError,
                "Native microphone capture backend is not enabled on this target. "
                "Push PCM samples via piano_dsp_push_audio()."};
    }

    void stop() override {}
    bool is_running() const override { return false; }
};

std::unique_ptr<IAudioCapture> create_native_audio_capture() {
    return std::make_unique<ExternalPushAudioCapture>();
}

} // namespace piano_dsp

#endif // !PIANO_DSP_USE_PULSEAUDIO
