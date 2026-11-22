#pragma once

#include <atomic>
#include <cstddef>
#include <vector>

namespace piano_dsp {

/**
 * Lock-free Single-Producer Single-Consumer (SPSC) ring buffer for real-time audio.
 * Safe for an audio capture callback thread (producer) and DSP thread (consumer)
 * without mutexes or dynamic allocations during streaming.
 */
template <typename T>
class RingBuffer {
public:
    explicit RingBuffer(size_t capacity_power_of_two)
        : capacity_(next_power_of_two(capacity_power_of_two)),
          mask_(capacity_ - 1),
          buffer_(capacity_),
          write_pos_(0),
          read_pos_(0) {}

    size_t capacity() const { return capacity_; }

    size_t available_read() const {
        const size_t w = write_pos_.load(std::memory_order_acquire);
        const size_t r = read_pos_.load(std::memory_order_relaxed);
        return w - r;
    }

    size_t available_write() const {
        return capacity_ - available_read();
    }

    // Returns number of elements actually written.
    size_t push(const T* data, size_t count) {
        const size_t r = read_pos_.load(std::memory_order_acquire);
        const size_t w = write_pos_.load(std::memory_order_relaxed);
        const size_t free_space = capacity_ - (w - r);
        const size_t to_write = (count < free_space) ? count : free_space;

        for (size_t i = 0; i < to_write; ++i) {
            buffer_[(w + i) & mask_] = data[i];
        }
        write_pos_.store(w + to_write, std::memory_order_release);
        return to_write;
    }

    // Returns number of elements actually read.
    size_t pop(T* out, size_t count) {
        const size_t w = write_pos_.load(std::memory_order_acquire);
        const size_t r = read_pos_.load(std::memory_order_relaxed);
        const size_t avail = w - r;
        const size_t to_read = (count < avail) ? count : avail;

        for (size_t i = 0; i < to_read; ++i) {
            out[i] = buffer_[(r + i) & mask_];
        }
        read_pos_.store(r + to_read, std::memory_order_release);
        return to_read;
    }

    void clear() {
        read_pos_.store(0, std::memory_order_relaxed);
        write_pos_.store(0, std::memory_order_relaxed);
    }

private:
    static size_t next_power_of_two(size_t v) {
        if (v < 2) return 2;
        size_t p = 1;
        while (p < v) p <<= 1;
        return p;
    }

    size_t capacity_;
    size_t mask_;
    std::vector<T> buffer_;
    std::atomic<size_t> write_pos_;
    std::atomic<size_t> read_pos_;
};

} // namespace piano_dsp
