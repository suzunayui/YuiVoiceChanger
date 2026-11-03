"""Audio output slots follow a sample clock, never inference completion time."""
import threading
import numpy as np


class ScheduledAudio:
    def __init__(self, capacity=96000):
        self.capacity = int(capacity)
        self.samples = np.zeros(self.capacity,np.float32)
        self.tags = np.full(self.capacity,-1,np.int64)
        self.cursor = 0
        self.late_blocks = 0
        self.missing_after_start = 0
        self.started = False
        self.lock = threading.Lock()

    def put(self, position, audio):
        audio = np.asarray(audio,np.float32).reshape(-1)
        with self.lock:
            position = int(position)
            late = max(0,self.cursor-position)
            if late:
                self.late_blocks += 1
                audio = audio[min(late,len(audio)):]
                position += late
            if not len(audio):
                return
            if position+len(audio)>self.cursor+self.capacity:
                raise RuntimeError('Scheduled output exceeds bounded buffer.')
            absolute = np.arange(position,position+len(audio),dtype=np.int64)
            index = absolute%self.capacity
            self.samples[index] = audio
            self.tags[index] = absolute

    def take(self, count):
        with self.lock:
            absolute = np.arange(self.cursor,self.cursor+count,dtype=np.int64)
            index = absolute%self.capacity
            valid = self.tags[index]==absolute
            result = np.where(valid,self.samples[index],0.).astype(np.float32)
            if self.started:
                self.missing_after_start += int(np.sum(~valid))
            if np.any(valid):
                self.started = True
            self.cursor += count
        return result


def verify_scheduler():
    """Independent requirement: variable job times must not shift later audio."""
    block,delay,quantum = 3840,12000,480
    expected = np.zeros(60000,np.float32)
    jobs=[]
    for seq in range(8):
        audio=np.full(block,(seq+1)/10,np.float32)
        duration_ms=[12,80,25,140,35,100,15,55][seq]
        ready=(seq+1)*block+round(duration_ms*48)
        jobs.append((ready,seq*block+delay,audio))
        expected[seq*block+delay:seq*block+delay+block]=audio
    jobs.sort(key=lambda item:item[0])
    buffer=ScheduledAudio();actual=[]
    for now in range(0,len(expected),quantum):
        while jobs and jobs[0][0]<=now:
            _,position,audio=jobs.pop(0);buffer.put(position,audio)
        actual.append(buffer.take(quantum))
    actual=np.concatenate(actual)
    assert np.array_equal(actual,expected)
    assert buffer.late_blocks==0
    # A job missing its deadline loses samples; it must not delay later slots.
    buffer=ScheduledAudio()
    buffer.take(5000)
    buffer.put(0,np.ones(1000,np.float32))
    buffer.put(6000,np.full(1000,.5,np.float32))
    result=buffer.take(2000)
    assert np.all(result[:1000]==0) and np.all(result[1000:]==.5)
    assert buffer.late_blocks==1
    return {'jittered_jobs':'passed','late_job_does_not_shift_later_audio':'passed'}


if __name__=='__main__':
    import json
    print(json.dumps(verify_scheduler()))
