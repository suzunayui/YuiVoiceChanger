"""Put converted voice and stereo accompaniment on the microphone sample timeline."""
import math
import threading
import time
from collections import deque
import numpy as np

RATE=48000
QUANTUM=480

def settings(config,budget_ms,lookback_ms,io_ms):
    target=config.get('mix_latency_ms',500)
    if type(target) is not int or not 200<=target<=3000:raise ValueError('MIXの待ち時間は200〜3000msにしてください。')
    minimum=math.ceil((2*budget_ms+lookback_ms+io_ms)/10)*10
    if target<minimum:raise ValueError(f'現在の処理速度ではMIXの待ち時間を{minimum}ms以上にしてください。')
    return (target-lookback_ms-io_ms)

class InputClock:
    """Remember actual ADC timestamps; do not assume that two hardware clocks agree.

    A late callback reports a late time although its samples stay continuous, so a brief
    jump keeps the sample timeline. Only a jump that lasts moves the timeline, and jumps
    that keep recurring still stop the mix rather than stream it out of alignment.
    """
    OUTLIER_SECONDS=.075
    RESYNC_AFTER_BLOCKS=50
    MAX_RESYNCS=3
    RESYNC_WINDOW_SAMPLES=60*RATE

    def __init__(self,now=time.monotonic):
        self.now=now;self.offset=None;self.anchors={};self.last_position=None
        self.outlier_blocks=0;self.outliers=0;self.resyncs=0;self.largest_error=0.
        self.recent_resyncs=[];self.breaks=set()

    def resync(self,position):
        self.recent_resyncs=[item for item in self.recent_resyncs if position-item<self.RESYNC_WINDOW_SAMPLES]+[position]
        if len(self.recent_resyncs)>self.MAX_RESYNCS:raise ValueError('マイクの時刻が変化したためMIXを停止しました。')
        self.resyncs+=1;self.outlier_blocks=0;self.breaks.add(position)

    def feed(self,position,count,timing,status):
        if status:raise ValueError('音声デバイスが途切れたためMIXを停止しました。')
        adc,current=getattr(timing,'inputBufferAdcTime',None),getattr(timing,'currentTime',None)
        if count!=QUANTUM or adc is None or current is None or not all(math.isfinite(x) and x>0 for x in [adc,current]) or abs(adc-current)>2:raise ValueError('マイクの音声時刻を確認できません。')
        if self.offset is None:self.offset=self.now()-current
        stamp=adc+self.offset
        if self.last_position is not None:
            expected=self.anchors[self.last_position]+QUANTUM/RATE
            error=stamp-expected
            if position!=self.last_position+QUANTUM:raise ValueError('マイクの時刻が変化したためMIXを停止しました。')
            if abs(error)>self.OUTLIER_SECONDS:
                self.outliers+=not self.outlier_blocks
                self.outlier_blocks+=1
                self.largest_error=max(self.largest_error,abs(error))
                if self.outlier_blocks<self.RESYNC_AFTER_BLOCKS:stamp=expected
                else:self.resync(position)
            else:
                self.outlier_blocks=0
                # WASAPI callback timestamps can repeat or advance by a full device period.
                # Track clock drift gradually without bending an individual audio block.
                stamp=expected+max(-.00005,min(.00005,error*.02))
        self.anchors[position]=stamp;self.last_position=position
        self.anchors.pop(position-QUANTUM*450,None)
        self.breaks.discard(position-QUANTUM*450)

    def times(self,position,count):
        if position<0:return None
        positions=np.arange(position,position+count,dtype=np.int64)
        starts=(positions//QUANTUM)*QUANTUM
        output=np.empty(count,np.float64)
        for start in np.unique(starts):
            left,right=self.anchors.get(int(start)),self.anchors.get(int(start)+QUANTUM)
            if left is None or right is None or int(start)+QUANTUM in self.breaks:return None
            mask=starts==start
            output[mask]=left+(positions[mask]-start)*(right-left)/QUANTUM
        return output

class TimedMusic:
    def __init__(self,seconds=5):
        self.capacity=seconds*RATE;self.audio=np.zeros((self.capacity,2),np.float32)
        self.tags=np.full(self.capacity,-1,np.int64);self.lock=threading.Lock();self.pending=None;self.gaps=0

    def gap(self):self.pending=None;self.gaps+=1

    def append(self,stamp,samples):
        samples=np.asarray(samples,np.float32)
        if not math.isfinite(stamp) or samples.ndim!=2 or samples.shape[1]!=2 or not np.isfinite(samples).all():raise ValueError('伴奏の音声データが正しくありません。')
        if not len(samples):return
        previous,self.pending=self.pending,(stamp,samples.copy())
        if previous is None:return
        before,chunk=previous;duration=stamp-before
        if duration<=0 or duration>.5 or abs(duration-len(chunk)/RATE)>.01:self.gaps+=1;return
        # Adjacent QPC timestamps resample the render clock to the common 48 kHz grid.
        first,last=math.ceil(before*RATE),math.ceil(stamp*RATE)
        absolute=np.arange(first,last,dtype=np.int64)
        phase=(absolute/RATE-before)/duration*len(chunk)
        positions=np.arange(len(chunk)+1)
        extended=np.vstack([chunk,samples[:1]])
        audio=np.column_stack([np.interp(phase,positions,extended[:,channel]) for channel in range(2)]).astype(np.float32)
        index=absolute%self.capacity
        with self.lock:self.audio[index]=audio;self.tags[index]=absolute

    def read(self,times):
        if times is None:return np.zeros((QUANTUM,2),np.float32),0
        positions=times*RATE;left=np.floor(positions).astype(np.int64);right=left+1
        with self.lock:
            valid=(self.tags[left%self.capacity]==left)&(self.tags[right%self.capacity]==right)
            mix=positions-left
            audio=self.audio[left%self.capacity]*(1-mix[:,None])+self.audio[right%self.capacity]*mix[:,None]
        audio[~valid]=0
        return audio.astype(np.float32),int((~valid).sum())

class MusicLevel:
    """Peak of the captured accompaniment, before the gain, read by the conversion loop."""
    FLOOR_DB=-90.
    SILENCE=10**(-60/20)
    LOW=10**(-20/20)
    BLOCKS_PER_SECOND=100
    WINDOW_SECONDS=10

    def __init__(self):
        self.seconds=deque(maxlen=self.WINDOW_SECONDS);self.current=0.;self.blocks=0;self.peak=0.

    def record(self,peak):
        self.peak=max(self.peak,peak);self.current=max(self.current,peak);self.blocks+=1
        if self.blocks==self.BLOCKS_PER_SECOND:
            self.seconds.append(self.current);self.current=0.;self.blocks=0

    @property
    def recent_db(self):
        peak=max(*self.seconds,self.current) if self.seconds else self.current
        return 20*math.log10(peak) if peak>10**(self.FLOOR_DB/20) else self.FLOOR_DB

    def take_db(self):
        peak,self.peak=self.peak,0.
        return 20*math.log10(peak) if peak>10**(self.FLOOR_DB/20) else self.FLOOR_DB

    @property
    def low(self):
        # Music normally peaks near full scale; silence just means nothing is playing yet.
        if len(self.seconds)<self.WINDOW_SECONDS:return False
        return self.SILENCE<max(*self.seconds,self.current)<self.LOW

class ProgramMix:
    def __init__(self,device_id,output_name,gain_db=-6,loopback=None):
        from backend.wasapi_loopback import Loopback
        self.music=TimedMusic();self.clock=InputClock();self.stop=threading.Event();self.ready=threading.Event();self.failure=''
        self.gain=self.previous_gain=10**(gain_db/20);self.missing=0;self.limited=0;self.level=MusicLevel()
        self.capture=loopback or Loopback(device_id,stereo=True,forbidden_name=output_name,on_gap=self.music.gap)
        self.thread=threading.Thread(target=self.run,daemon=True)

    def run(self):
        try:self.capture.run(self.stop,self.music.append,self.ready.set)
        except Exception as error:self.failure=str(error);self.ready.set()

    def start(self):
        self.thread.start()
        if not self.ready.wait(5):self.close();raise ValueError('伴奏の再生先を開けませんでした。')
        if self.failure:self.close();raise ValueError(self.failure)

    def render(self,voice,position,timing,status,source_offset):
        self.clock.feed(position,len(voice),timing,status)
        music,missing=self.music.read(self.clock.times(position-source_offset,len(voice)))
        self.missing+=missing
        self.level.record(float(np.max(np.abs(music))))
        gain=np.linspace(self.previous_gain,self.gain,len(voice),dtype=np.float32)
        self.previous_gain=self.gain
        output=music*gain[:,None]+voice[:,None]
        # Linked stereo soft limiter: preserve the image, add no lookahead delay.
        magnitude=np.max(np.abs(output),axis=1)
        target=np.where(magnitude<=.9,magnitude,.9+.08*np.tanh((magnitude-.9)/.08))
        self.limited+=int(np.sum(magnitude>.9))
        output*=np.divide(target,magnitude,out=np.ones_like(target),where=magnitude>0)[:,None]
        return output.astype(np.float32)

    def close(self):
        self.stop.set()
        if self.thread.is_alive():self.thread.join(timeout=3)
        with self.music.lock:self.music.audio.fill(0);self.music.tags.fill(-1)
