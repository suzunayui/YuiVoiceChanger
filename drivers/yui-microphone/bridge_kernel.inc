// SPDX-License-Identifier: MIT
// Included once in minwavertstream.cpp; all callbacks are nonpageable.
#include "bridge_ring.h"
#include "bridge_kernel.h"
static KSPIN_LOCK g_yuiLock;
static YuiAudioRing g_yuiRing;
void YuiBridgeInitialize() { KeInitializeSpinLock(&g_yuiLock); g_yuiRing.reset(); }
void YuiBridgeReset() {
    KIRQL old; KeAcquireSpinLock(&g_yuiLock,&old);
    g_yuiRing.reset(); KeReleaseSpinLock(&g_yuiLock,old);
}
void YuiBridgeRender(const UCHAR* data, ULONG bytes) {
    if(bytes%4) return;
    KIRQL old; KeAcquireSpinLock(&g_yuiLock,&old);
    g_yuiRing.pushStereo(reinterpret_cast<const int16_t*>(data),bytes/4,KeQueryInterruptTime());
    KeReleaseSpinLock(&g_yuiLock,old);
}
void YuiBridgeCapture(UCHAR* data, ULONG bytes) {
    if(bytes%2) { RtlZeroMemory(data,bytes); return; }
    // Bound work under the spin lock even when a timer is late.
    for(ULONG offset=0;offset<bytes;) {
        const ULONG n=min(bytes-offset,ULONG(YuiAudioRing::Capacity*2));
        KIRQL old; KeAcquireSpinLock(&g_yuiLock,&old);
        g_yuiRing.popMono(reinterpret_cast<int16_t*>(data+offset),n/2,KeQueryInterruptTime());
        KeReleaseSpinLock(&g_yuiLock,old); offset+=n;
    }
}
