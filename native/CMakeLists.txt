cmake_minimum_required(VERSION 3.16)
project(piano_dsp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

option(PIANO_DSP_BUILD_CLI "Build terminal microphone pitch detector CLI" ON)
option(PIANO_DSP_BUILD_TESTS "Build C++ unit and integration tests" ON)

set(PIANO_DSP_SOURCES
    src/biquad_filter.cpp
    src/fft.cpp
    src/pitch_utils.cpp
    src/yin_estimator.cpp
    src/onset_detector.cpp
    src/melody_recorder.cpp
    src/melody_evaluator.cpp
    src/midi_song_parser.cpp
    src/audio_pipeline.cpp
    src/piano_dsp_ffi.cpp
)

if(UNIX AND NOT APPLE AND NOT ANDROID)
    find_package(PkgConfig QUIET)
    if(PkgConfig_FOUND)
        pkg_check_modules(PULSEAUDIO libpulse-simple libpulse)
    endif()
endif()

if(PULSEAUDIO_FOUND)
    list(APPEND PIANO_DSP_SOURCES src/capture/audio_capture_linux.cpp)
else()
    list(APPEND PIANO_DSP_SOURCES src/capture/audio_capture_stub.cpp)
endif()

add_library(piano_dsp SHARED ${PIANO_DSP_SOURCES})
target_include_directories(piano_dsp PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

if(PULSEAUDIO_FOUND)
    target_compile_definitions(piano_dsp PRIVATE PIANO_DSP_USE_PULSEAUDIO)
    target_include_directories(piano_dsp PRIVATE ${PULSEAUDIO_INCLUDE_DIRS})
    target_link_libraries(piano_dsp PRIVATE ${PULSEAUDIO_LIBRARIES})
endif()

if(UNIX AND NOT ANDROID)
    target_link_libraries(piano_dsp PRIVATE pthread)
endif()

if(PIANO_DSP_BUILD_CLI AND NOT ANDROID)
    add_executable(piano_dsp_cli cli/main.cpp)
    target_link_libraries(piano_dsp_cli PRIVATE piano_dsp)
endif()

if(PIANO_DSP_BUILD_TESTS AND NOT ANDROID)
    enable_testing()
    add_executable(piano_dsp_tests tests/test_main.cpp ${PIANO_DSP_SOURCES})
    target_include_directories(piano_dsp_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
    if(PULSEAUDIO_FOUND)
        target_compile_definitions(piano_dsp_tests PRIVATE PIANO_DSP_USE_PULSEAUDIO)
        target_include_directories(piano_dsp_tests PRIVATE ${PULSEAUDIO_INCLUDE_DIRS})
        target_link_libraries(piano_dsp_tests PRIVATE ${PULSEAUDIO_LIBRARIES})
    endif()
    if(UNIX)
        target_link_libraries(piano_dsp_tests PRIVATE pthread)
    endif()
    add_test(NAME piano_dsp_tests COMMAND piano_dsp_tests)
endif()
