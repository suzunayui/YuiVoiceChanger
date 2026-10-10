// SPDX-License-Identifier: MIT
#pragma once
#include <stdint.h>
#include <stddef.h>
// Caller serializes all operations. 40 ms at 48 kHz, mono PCM16.
struct YuiAudioRing {
    static constexpr size_t Capacity = 1920;
    int16_t samples[Capacity];
    size_t begin, count;
    uint64_t lastWrite;
    void reset() { begin=0; count=0; lastWrite=0; }
    void pushStereo(const int16_t* input, size_t frames, uint64_t now) {
        if (frames > Capacity) { input += (frames-Capacity)*2; frames=Capacity; }
        if (lastWrite && now-lastWrite > 1000000) reset(); // 100ms, 100ns units
        for(size_t i=0;i<frames;++i) {
            if(count==Capacity) { begin=(begin+1)%Capacity; --count; }
            const int32_t mono=(int32_t(input[i*2])+int32_t(input[i*2+1]))/2;
            samples[(begin+count)%Capacity]=static_cast<int16_t>(mono); ++count;
        }
        lastWrite=now;
    }
    void popMono(int16_t* output, size_t frames, uint64_t now) {
        if(lastWrite && now-lastWrite > 1000000) reset();
        for(size_t i=0;i<frames;++i) {
            output[i]=count?samples[begin]:0;
            if(count) { begin=(begin+1)%Capacity; --count; }
        }
    }
};
