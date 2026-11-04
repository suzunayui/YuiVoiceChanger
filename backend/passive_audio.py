"""Bounded passive references; audio never enters the renderer or network."""
from collections import deque
import base64
import queue
import threading
import time
import numpy as np

RATE=16000

class ReferenceRing:
    def __init__(self,seconds=50):
        self.parts=deque();self.seconds=seconds;self.lock=threading.Lock();self.history=np.zeros(48,np.float32)
        t=np.arange(-24,25);self.filter=np.sinc(t/3)*np.hamming(49);self.filter/=self.filter.sum()

    def append(self,stamp,samples):
        # 48 -> 16 kHz, symmetric anti-alias FIR; discard boundary transients.
        samples=np.asarray(samples,np.float32)
        if len(samples)<3:return
        combined=np.r_[self.history,samples]
        filtered=np.convolve(combined,self.filter,'valid')[::3].astype(np.float32)
        self.history=combined[-48:].copy()
        with self.lock:
            self.parts.append((stamp-24/48000,filtered))
            while self.parts and self.parts[0][0]<stamp-self.seconds:self.parts.popleft()

    def snapshot(self):
        with self.lock:parts=list(self.parts)
        if not parts:return None
        begin=parts[0][0];end=parts[-1][0]+len(parts[-1][1])/RATE
        count=round((end-begin)*RATE)
        if count<=0 or count>RATE*(self.seconds+2):return None
        samples=np.zeros(count,np.float32);valid=np.zeros(count,np.bool_)
        for stamp,audio in parts:
            p=round((stamp-begin)*RATE);n=min(len(audio),count-p)
            if p>=0 and n>0:samples[p:p+n]=audio[:n];valid[p:p+n]=True
        # FIR edge gaps (1 ms) are expected; larger capture gaps invalidate windows.
        return {'time':begin,'samples':base64.b64encode(samples.tobytes()).decode('ascii'),'valid':base64.b64encode(np.packbits(valid).tobytes()).decode('ascii')}

class VoiceReference:
    def __init__(self):
        from backend.sync_probe import SampleClock
        self.clock=SampleClock('inputBufferAdcTime')
        self.ring=ReferenceRing();self.queue=queue.Queue(maxsize=200);self.stop=threading.Event();self.failure=''
        self.thread=threading.Thread(target=self.run,daemon=True);self.thread.start()

    def feed(self,stamp,samples,status):
        if self.failure:return
        if status:self.failure='音声デバイスが途切れたため確認を停止しました。';return
        try:self.queue.put_nowait((stamp,samples.copy()))
        except queue.Full:self.failure='声の参照音声の取得が間に合いませんでした。'

    def timed(self,samples,timing,status,source_offset):
        try:
            position=self.clock.index(timing,len(samples),0)
            self.feed((position-source_offset)/48000,samples,status)
        except Exception as error:self.failure=str(error)

    def run(self):
        while not self.stop.is_set():
            try:stamp,samples=self.queue.get(timeout=.1)
            except queue.Empty:continue
            try:self.ring.append(stamp,samples)
            except Exception as error:self.failure=str(error)

    def close(self):
        self.stop.set();self.thread.join(timeout=2)

def unpack(value):
    if not value:return None
    audio=np.frombuffer(base64.b64decode(value['samples']),'<f4').astype(np.float64)
    valid=np.unpackbits(np.frombuffer(base64.b64decode(value['valid']),np.uint8))[:len(audio)].astype(bool)
    return float(value['time']),audio,valid

def match(reference,recording,start,length=4):
    """Normalized exact-audio match; confidence gates deliberately refuse ambiguity."""
    origin,audio,valid=reference
    p=round(start*RATE);n=round(length*RATE);ref=audio[p:p+n].copy()
    if len(ref)!=n or len(recording)<n or valid[p:p+n].mean()<.98:return None
    # Pre-emphasis makes attacks/noise distinguish repeated bass notes and vowel cycles.
    ref-=.97*np.r_[audio[p-1] if p else 0.,ref[:-1]]
    recording=recording-.97*np.r_[0.,recording[:-1]]
    ref-=ref.mean();energy=np.dot(ref,ref)
    if energy/n<1e-7:return None
    size=1<<int(len(recording)+n-1).bit_length()
    corr=np.fft.irfft(np.fft.rfft(recording,size)*np.conj(np.fft.rfft(ref,size)),size)[:len(recording)-n+1]
    sums=np.r_[0,np.cumsum(recording)];squares=np.r_[0,np.cumsum(recording**2)]
    power=squares[n:]-squares[:-n]-(sums[n:]-sums[:-n])**2/n
    scores=corr/np.sqrt(np.maximum(energy*power,1e-20));peak=int(np.argmax(scores));score=float(scores[peak])
    excluded=scores.copy();excluded[max(0,peak-800):peak+801]=-1
    ratio=score/max(float(excluded.max()),1e-8)
    if score<.2 or ratio<1.6:return None
    return {'offset':peak/RATE-(origin+start),'score':score,'ratio':ratio,'record_position':peak/RATE,'reference_time':origin+start}

def measure(voice,music,recording,now=None):
    now=time.monotonic() if now is None else now
    if not voice or not music:return {'phase':'waiting','message':'声と伴奏がそろうのを待っています。'}
    latest=np.floor(min(voice[0]+len(voice[1])/RATE,music[0]+len(music[1])/RATE)-5)
    earliest=max(voice[0],music[0])
    # Work backwards from recent content: recording fragments can be several seconds late.
    for offset in range(0,16):
        stamp=latest-offset
        if stamp<earliest:break
        v=match(voice,recording,stamp-voice[0]);m=match(music,recording,stamp-music[0])
        if not v or not m:continue
        if match(voice,music[1],stamp-voice[0]):
            return {'phase':'waiting','message':'伴奏の再生先に変換後の声も混ざっています。伴奏と声の出力先を分けてください。'}
        delta=(v['offset']-m['offset'])*1000
        if abs(delta)>3000 or now-stamp>15:continue
        # Confirm with a nonoverlapping earlier interval. A single match is never shown.
        earlier=stamp-4
        if earlier<earliest:continue
        v2=match(voice,recording,earlier-voice[0]);m2=match(music,recording,earlier-music[0])
        if not v2 or not m2:continue
        other=(v2['offset']-m2['offset'])*1000
        if abs(delta-other)>15:return {'phase':'waiting','message':'ずれの変化を検出しました。次の区間を確認しています。'}
        # Reject a shared voice reference masquerading as the accompaniment.
        if abs(v['record_position']-m['record_position'])<.02 and abs(delta)>80:continue
        value=int(round((delta+other)/2))
        return {'phase':'measured','delta_ms':value,'spread_ms':round(abs(delta-other)),'age_s':round(now-stamp,1),'message':'声と伴奏を照合しました。','measured_at':now,'confidence':round(min(v['score'],m['score'],v2['score'],m2['score']),3)}
    return {'phase':'waiting','message':'判定待ち：声と伴奏を十分に照合できません。'}
