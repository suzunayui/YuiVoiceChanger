// SPDX-License-Identifier: MIT
#include "bridge_ring.h"
#include <assert.h>
#include <stdio.h>
int main() {
    YuiAudioRing r={}; int16_t out[2000]={}, in[5000]={};
    r.popMono(out,10,1); for(int i=0;i<10;++i)assert(out[i]==0);
    const int16_t stereo[]={100,300,-32768,-32768,32767,32767,-100,100};
    r.pushStereo(stereo,4,10);r.popMono(out,6,20);
    assert(out[0]==200&&out[1]==-32768&&out[2]==32767&&out[3]==0&&out[4]==0&&out[5]==0);
    for(int i=0;i<2500;++i)in[i*2]=in[i*2+1]=int16_t(i);
    r.pushStereo(in,2500,100);assert(r.count==1920);r.popMono(out,2000,101);
    assert(out[0]==580&&out[1919]==2499&&out[1920]==0);
    r.reset();r.pushStereo(in,1500,200);r.pushStereo(in,1500,201);
    assert(r.count==1920);r.popMono(out,1920,202);assert(out[0]==1080&&out[420]==0);
    r.pushStereo(stereo,4,1000);r.popMono(out,4,1001001);assert(out[0]==0&&r.count==0);
    r.pushStereo(stereo,4,2000000);r.reset();r.popMono(out,4,2000001);assert(out[0]==0);
    puts("PASS silence, stereo downmix, wrap, oldest-drop, bounded queue, stale expiry, reset");
}
