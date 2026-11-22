CXX      := g++
CXXFLAGS := -std=c++17 -O2 -Wall -Wextra -fPIC -MMD -MP -Iinclude -DPIANO_DSP_USE_PULSEAUDIO
LDFLAGS  := -pthread
PA_LIBS  := $(shell pkg-config --libs libpulse-simple libpulse)

BUILD_DIR := build
LIB_SRCS  := src/biquad_filter.cpp \
             src/fft.cpp \
             src/pitch_utils.cpp \
             src/yin_estimator.cpp \
             src/onset_detector.cpp \
             src/melody_recorder.cpp \
             src/melody_evaluator.cpp \
             src/midi_song_parser.cpp \
             src/audio_pipeline.cpp \
             src/piano_dsp_ffi.cpp \
             src/capture/audio_capture_linux.cpp

LIB_OBJS  := $(patsubst src/%.cpp,$(BUILD_DIR)/%.o,$(LIB_SRCS))
DEPS      := $(LIB_OBJS:.o=.d)
SHARED_LIB := $(BUILD_DIR)/libpiano_dsp.so
CLI_BIN    := $(BUILD_DIR)/piano_dsp_cli
TEST_BIN   := $(BUILD_DIR)/piano_dsp_tests

.PHONY: all clean test

all: $(SHARED_LIB) $(CLI_BIN) $(TEST_BIN)

-include $(DEPS)

$(BUILD_DIR)/%.o: src/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(SHARED_LIB): $(LIB_OBJS)
	@mkdir -p $(BUILD_DIR)
	$(CXX) -shared $(LIB_OBJS) -o $@ $(LDFLAGS) $(PA_LIBS)

$(CLI_BIN): cli/main.cpp $(SHARED_LIB)
	$(CXX) $(CXXFLAGS) cli/main.cpp -L$(BUILD_DIR) -lpiano_dsp -Wl,-rpath,'$$ORIGIN' -o $@ $(LDFLAGS)

$(TEST_BIN): tests/test_main.cpp $(LIB_OBJS)
	$(CXX) $(CXXFLAGS) tests/test_main.cpp $(LIB_OBJS) -o $@ $(LDFLAGS) $(PA_LIBS)

test: $(TEST_BIN)
	./$(TEST_BIN)

clean:
	rm -rf $(BUILD_DIR)
