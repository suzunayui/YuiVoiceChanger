"""CPU-only Beatrice audio transport."""
from collections import deque
import os, queue, threading, time
import numpy as np

class AudioFIFO:
    """Bounded FIFO. Drop oldest complete blocks instead of accumulating delay."""
    def __init__(self, maximum):
        self.parts = deque()
        self.size = 0
        self.maximum = maximum
        self.lock = threading.Lock()
        self.dropped = 0

    def put(self, audio):
        with self.lock:
            audio = np.asarray(audio, dtype=np.float32).reshape(-1)
            if len(audio) > self.maximum:
                audio = audio[-self.maximum:]
                self.dropped += 1
            while self.parts and self.size + len(audio) > self.maximum:
                self.size -= len(self.parts.popleft())
                self.dropped += 1
            self.parts.append(audio.copy())
            self.size += len(audio)

    def take(self, count):
        result = np.zeros(count, np.float32)
        with self.lock:
            written = 0
            while self.parts and written < count:
                part = self.parts.popleft()
                n = min(len(part), count - written)
                result[written:written+n] = part[:n]
                if n < len(part):
                    self.parts.appendleft(part[n:])
                written += n
                self.size -= n
        return result, written


def devices():
    import sounddevice as sd
    hosts = sd.query_hostapis()
    return [dict(id=i, name=d['name'], host=hosts[d['hostapi']]['name'],
                 inputs=d['max_input_channels'], outputs=d['max_output_channels'], rate=d['default_samplerate'])
            for i,d in enumerate(sd.query_devices())]


def audio_settings(sd, input_id, output_id, output_channels, rate=48000):
    """Keep inference at 48k; let shared WASAPI adapt each device's mix format."""
    hosts = sd.query_hostapis()
    def host_settings(device):
        host = hosts[sd.query_devices(device)['hostapi']]['name']
        if host == 'Windows WASAPI':
            return sd.WasapiSettings(exclusive=False, auto_convert=True)
        if host == 'Core Audio':
            return sd.CoreAudioSettings(change_device_parameters=False,
                                        fail_if_conversion_required=False,
                                        conversion_quality='max')
        return None
    extra = tuple(host_settings(device) for device in (input_id, output_id))
    for label, device, channels, settings, check in (
        ('マイク', input_id, 1, extra[0], sd.check_input_settings),
        ('出力先', output_id, output_channels, extra[1], sd.check_output_settings),
    ):
        try:
            check(device=device, channels=channels, samplerate=rate,
                  dtype='float32', extra_settings=settings)
        except sd.PortAudioError as exc:
            name = sd.query_devices(device)['name']
            raise RuntimeError(f'{label}「{name}」を開けませんでした。'
                               f'別のデバイスを選ぶか、Windowsの音声設定を確認してください。({exc})') from exc
    return extra


class Realtime:
    def __init__(self, notify):
        self.notify = notify
        self.stop_event = threading.Event()
        self.thread = None

    def start(self, config):
        if self.thread and self.thread.is_alive():
            raise RuntimeError('すでに起動中です。')
        # VST3/JUCE requires plugin creation and reload on the IPC main thread.
        self.prepared_pipeline = None
        from backend.beatrice import BeatricePipeline
        self.notify({'type':'state','state':'loading'})
        self.prepared_pipeline = BeatricePipeline(config, lambda msg:self.notify({'type':'loading','message':msg}))
        self.stop_event.clear()
        self.thread = threading.Thread(target=self.run, args=(dict(config),), daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def run(self, config):
        stream = None
        com = None
        try:
            self.notify({'type':'state','state':'loading'})
            if os.name == 'nt':
                import ctypes
                ole32 = ctypes.OleDLL('ole32')
                ole32.CoInitializeEx(None, 0)
                com = ole32
            import sounddevice as sd
            pipeline = self.prepared_pipeline
            block = round(pipeline.config['block'] * 48000)
            incoming = queue.Queue(maxsize=2)
            outgoing = AudioFIFO(block * 2)
            counters = {'dropped':0, 'underflows':0, 'device_errors':0}
            staging = np.zeros(block, np.float32)
            cursor = 0
            sequence = 0
            warmed = False
            self.notify({'type':'loading','message':'推論をウォームアップ中'})
            for _ in range(2):
                if self.stop_event.is_set():
                    return
                pipeline.convert(np.zeros(round(pipeline.config['block']*pipeline.input_rate), np.float32), silence=False)
            pipeline.reset()
            input_id, output_id = int(config['input']), int(config['output'])
            output_channels = min(2, sd.query_devices(output_id)['max_output_channels'])
            extra_settings = audio_settings(sd, input_id, output_id, output_channels)

            def callback(indata, outdata, frames, timing, status):
                nonlocal cursor, sequence, warmed
                counters['device_errors'] += int(bool(status))
                audio, written = outgoing.take(frames)
                if warmed and written < frames:
                    counters['underflows'] += 1
                if written:
                    warmed = True
                outdata[:] = audio[:,None]
                offset = 0
                while offset < frames:
                    n = min(block-cursor, frames-offset)
                    staging[cursor:cursor+n] = indata[offset:offset+n,0]
                    cursor += n
                    offset += n
                    if cursor == block:
                        item = (sequence, time.perf_counter(), staging.copy())
                        sequence += 1
                        try:
                            incoming.put_nowait(item)
                        except queue.Full:
                            try: incoming.get_nowait()
                            except queue.Empty: pass
                            incoming.put_nowait(item)
                            counters['dropped'] += 1
                        cursor = 0

            stream = sd.Stream(device=(input_id,output_id), samplerate=48000, blocksize=480,
                               channels=(1,output_channels), dtype='float32', latency='low',
                               extra_settings=extra_settings, callback=callback)
            if self.stop_event.is_set():
                return
            stream.start()
            self.notify({'type':'state','state':'running','rate':pipeline.rate,
                         'device':str(pipeline.device),'format':pipeline.format,
                         'pitch_device':str(pipeline.pitch_device),
                         'io_latency_ms':sum(stream.latency)*1000})
            last_sequence = -1
            while not self.stop_event.is_set():
                try: seq, captured, audio = incoming.get(timeout=.1)
                except queue.Empty: continue
                if seq != last_sequence+1:
                    pipeline.reset()
                last_sequence = seq
                source = audio
                result = pipeline.convert(source)
                age = time.perf_counter()-captured
                if age > 2*pipeline.config['block']:
                    counters['dropped'] += 1
                    pipeline.reset()
                else:
                    output = result
                    outgoing.put(output[:block])
                self.notify({'type':'metrics',**pipeline.stats,**counters,
                             'output_drops':outgoing.dropped, 'queue_ms':outgoing.size/48,
                             'budget_ms':pipeline.config['block']*1000,
                             'over_budget':pipeline.stats['ms']>pipeline.config['block']*1000})
        except Exception as exc:
            import traceback
            traceback.print_exc()
            self.notify({'type':'error','message':str(exc)})
        finally:
            try:
                if stream:
                    try:
                        stream.abort()
                    finally:
                        stream.close()
            finally:
                if com:
                    com.CoUninitialize()
                self.notify({'type':'state','state':'stopped'})
