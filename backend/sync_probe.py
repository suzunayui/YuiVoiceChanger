"""Deterministic voiced test bursts injected in place of microphone samples.

The reference output and input ADC clocks are mapped to a common monotonic
epoch. No microphone samples are saved or sent to the reference output.
"""
import math
import threading
import time
import numpy as np

RATE = 48000
ONSETS = (1.8, 2.73, 3.96, 4.78, 6.12, 7.17, 8.60, 9.57)
DURATION = 15.0


def test_signals(rate=RATE):
    source = np.zeros(round(DURATION*rate), np.float32)
    reference = np.zeros_like(source)
    vowels = ((730, 1090, 2440), (270, 2290, 3010), (300, 870, 2240), (530, 1840, 2480))
    for index, onset in enumerate(ONSETS):
        length = (.26, .31, .23, .35)[index % 4]
        t = np.arange(round(length*rate))/rate
        f0 = (145, 175, 155, 195)[index % 4]
        formants = vowels[index % 4]
        sound = np.zeros_like(t)
        for harmonic in range(1, min(64, int(rate/2/f0))):
            frequency = harmonic*f0
            weight = .12/harmonic + sum(np.exp(-.5*((frequency-formant)/width)**2) for formant, width in zip(formants, (90, 130, 210)))/math.sqrt(harmonic)
            sound += weight*np.sin(2*np.pi*frequency*t+.15*harmonic)
        sound *= .08/max(np.max(np.abs(sound)), 1e-6)
        ramp = np.minimum(1., np.minimum(t/.02, (length-t)/.025))
        sound *= np.sin(np.clip(ramp, 0, 1)*np.pi/2)**2
        start = round(onset*rate)
        source[start:start+len(sound)] = sound
        bt = np.arange(round(.08*rate))/rate
        marker = .12*np.sin(2*np.pi*1000*bt)*np.sin(np.linspace(0, np.pi, len(bt)))**2
        reference[start:start+len(marker)] = marker
    return source, reference


class SampleClock:
    """Map a PortAudio sample clock to monotonic time once, then count samples."""
    def __init__(self, field, now=time.monotonic):
        self.field, self.now = field, now
        self.origin = self.device_origin = None
        self.frames = 0

    def index(self, timing, count, epoch):
        stamp, current = getattr(timing, self.field, None), getattr(timing, 'currentTime', None)
        if stamp is None or current is None or not all(math.isfinite(value) and value > 0 for value in (stamp, current)) or abs(stamp-current) > 2:
            raise ValueError('音声デバイスの時刻を取得できないため測定できません。')
        if self.origin is None:
            self.origin = self.now()+stamp-current
            self.device_origin = stamp
        if abs(stamp-(self.device_origin+self.frames/RATE)) > .05:
            raise ValueError('測定中に音声デバイスの時刻が変化しました。再測定してください。')
        position = round((self.origin-epoch)*RATE)+self.frames
        self.frames += count
        return position


def read_samples(signal, position, count):
    result = np.zeros(count, np.float32)
    left, right = max(0, position), min(len(signal), position+count)
    if right > left:
        result[left-position:right-position] = signal[left:right]
    return result


class SyncProbe:
    def __init__(self, identifier, device_name, notify, on_close, sd=None, silent=False):
        self.identifier, self.device_name, self.notify, self.on_close = identifier, device_name, notify, on_close
        self.sd = sd
        self.silent = silent
        self.aligned = threading.Event()
        self.source, self.reference = test_signals()
        self.cancel = threading.Event()
        self.done = threading.Event()
        self.input_ready = threading.Event()
        self.epoch = None
        self.failure = ''
        self.input_clock = SampleClock('inputBufferAdcTime')
        self.output_clock = SampleClock('outputBufferDacTime')
        self.thread = threading.Thread(target=self.run, daemon=True)

    def emit(self, phase, **extra):
        self.notify({'type': 'sync-test', 'id': self.identifier, 'phase': phase, **extra})

    def start(self):
        self.thread.start()

    def stop(self):
        self.cancel.set()

    def align(self, epoch):
        if not self.silent or self.aligned.is_set() or not isinstance(epoch, (float, int)) or not math.isfinite(epoch) or not -4.1 <= time.monotonic()-epoch <= 1.2:
            raise ValueError('OBSの測定用音声の投入時刻を確認できませんでした。')
        self.epoch = float(epoch)
        self.aligned.set()

    def run_silent(self):
        """Only feed the existing conversion input. Never open a playback device."""
        self.emit('ready')
        deadline = time.monotonic()+8
        while not self.aligned.wait(.02):
            if self.cancel.is_set():
                raise InterruptedError('測定を中止しました。')
            if time.monotonic()>deadline:
                raise ValueError('OBSの測定用音声と同期できませんでした。')
        last = 0.
        while time.monotonic()<self.epoch+DURATION:
            if self.failure:
                raise ValueError(self.failure)
            if self.cancel.wait(.03):
                raise InterruptedError('測定を中止しました。')
            current = time.monotonic()
            if current>self.epoch+1 and not self.input_ready.is_set():
                raise ValueError('測定用の音声を変換処理へ送れませんでした。')
            if current-last>.2:
                self.emit('testing',progress=max(0.,min(.9,(current-self.epoch)/DURATION*.9)))
                last=current
        if not self.input_ready.is_set():
            raise ValueError('測定用の音声が変換されませんでした。')

    def input(self, count, timing, status):
        if self.epoch is None or self.cancel.is_set():
            return np.zeros(count, np.float32)
        try:
            if status:
                raise ValueError('測定中にマイクの音声デバイスが途切れました。')
            position = self.input_clock.index(timing, count, self.epoch)
            self.input_ready.set()
            return read_samples(self.source, position, count)
        except Exception as error:
            self.failure = str(error)
            self.cancel.set()
            return np.zeros(count, np.float32)

    def run(self):
        stream, phase, detail, com = None, 'completed', {}, None
        try:
            if self.silent:
                self.run_silent()
                return
            import os
            if os.name == 'nt':
                import ctypes
                ole32 = ctypes.OleDLL('ole32')
                try:
                    ole32.CoInitializeEx(None, 0)
                except OSError as error:
                    if getattr(error, 'winerror', 0) & 0xffffffff != 0x80010106:
                        raise
                else:
                    com = ole32
            sd = self.sd
            if sd is None:
                import sounddevice as sd
            hosts = sd.query_hostapis()
            host_name = 'Core Audio' if any(host['name'] == 'Core Audio' for host in hosts) else 'Windows WASAPI'
            host = next((i for i, item in enumerate(hosts) if item['name'] == host_name), None)
            if host is None:
                raise ValueError('測定用の音声再生先が見つかりません。')
            choices = [i for i, item in enumerate(sd.query_devices()) if item['hostapi'] == host and item['max_output_channels'] > 0 and (item['name'] == self.device_name if self.device_name else i == hosts[host]['default_output_device'])]
            if len(choices) != 1:
                raise ValueError('伴奏ソースと同じ音声再生先を確認してください。')
            channels = min(2, sd.query_devices(choices[0])['max_output_channels'])

            def callback(outdata, frames, timing, status):
                outdata.fill(0)
                if self.cancel.is_set():
                    return
                try:
                    if status:
                        raise ValueError('測定用の音声再生が途切れました。')
                    position = self.output_clock.index(timing, frames, self.epoch)
                    outdata[:] = read_samples(self.reference, position, frames)[:, None]
                    if position >= len(self.reference):
                        self.done.set()
                except Exception as error:
                    self.failure = str(error)
                    self.cancel.set()

            settings = sd.CoreAudioSettings(change_device_parameters=False, fail_if_conversion_required=False, conversion_quality='max') if host_name == 'Core Audio' else sd.WasapiSettings(exclusive=False, auto_convert=True)
            stream = sd.OutputStream(device=choices[0], samplerate=RATE, channels=channels, dtype='float32', blocksize=480, latency='low', extra_settings=settings, callback=callback)
            self.epoch = time.monotonic()+max(.5, float(stream.latency)+.25)
            if self.cancel.is_set():
                raise InterruptedError('測定を中止しました。')
            stream.start()
            deadline, last = self.epoch+DURATION+4, 0.
            while not self.done.wait(.03):
                if self.cancel.is_set():
                    raise InterruptedError('測定を中止しました。')
                now = time.monotonic()
                if now > deadline or (now > self.epoch+1 and not self.input_ready.is_set()):
                    raise ValueError('測定用の音声を変換処理へ送れませんでした。')
                if now-last > .2:
                    self.emit('testing', progress=max(0., min(.9, (now-self.epoch)/DURATION*.9)))
                    last = now
            if self.failure:
                raise ValueError(self.failure)
            if self.cancel.is_set():
                raise InterruptedError('測定を中止しました。')
            if not self.input_ready.is_set():
                raise ValueError('測定用の音声が変換されませんでした。')
        except Exception as error:
            phase = 'failed' if self.failure or not isinstance(error, InterruptedError) else 'cancelled'
            detail = {'message': self.failure or str(error)}
        finally:
            if stream:
                try:
                    stream.abort()
                except Exception:
                    pass
                try:
                    stream.close()
                except Exception as error:
                    phase, detail = 'failed', {'message': str(error)}
            self.on_close(self)
            if com:
                com.CoUninitialize()
            detail['timing'] = {'epoch': self.epoch, 'input_origin': self.input_clock.origin,
                                'output_origin': self.output_clock.origin, 'input_device_origin': self.input_clock.device_origin,
                                'output_device_origin': self.output_clock.device_origin,
                                'input_frames': self.input_clock.frames, 'output_frames': self.output_clock.frames}
            self.emit(phase, **detail)
