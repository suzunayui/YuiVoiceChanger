"""GPU conversion with bounded queues and sample-clock output scheduling."""
import queue
import math
import os
import threading
import time
import numpy as np

from backend.scheduled_audio import ScheduledAudio
from backend.audio_controls import CONTROL_DEFAULTS, normalize_controls
from backend.vocal_effects import EFFECT_DEFAULTS, normalize_effects, VocalEffects
from backend.singing import singing_settings, output_schedule
from pathlib import Path


def model_cache_key(config):
    """Paths and file signatures prevent stale weights after an in-place update."""
    value = config.get('beatrice_model', '')
    if not value:
        return None
    try:
        source = Path(value).resolve()
        files = {source}
        if source.suffix.lower() in ('.toml', '.bin'):
            files.update(source.parent.glob('*.toml'))
            files.update(source.parent.glob('*.bin'))
        signatures = tuple((os.path.normcase(str(file)), file.stat().st_mtime_ns, file.stat().st_size) for file in sorted(files))
        return (os.path.normcase(str(source)), config.get('compute', 'auto'), config.get('beatrice_voice', 0), signatures)
    except OSError:
        return None


def estimate_latency_ms(schedule_ms, lookback_ms, io_latency_ms):
    """Nominal source-sample age at output, not an acoustic loopback measurement.

    Inference and block collection run inside the fixed output reservation;
    adding their durations again would count the same time twice. Model timing
    accuracy and delays after the selected output device remain unmeasured.
    """
    values=(schedule_ms,lookback_ms,io_latency_ms)
    if not all(math.isfinite(value) and value>=0 for value in values):return None
    return sum(values)


def devices():
    import sounddevice as sd
    hosts = sd.query_hostapis()
    return [dict(id=i, name=d['name'], host=hosts[d['hostapi']]['name'],
                 inputs=d['max_input_channels'], outputs=d['max_output_channels'], rate=d['default_samplerate'])
            for i, d in enumerate(sd.query_devices())]


def audio_settings(sd, input_id, output_id, output_channels, rate=48000):
    hosts = sd.query_hostapis()
    def host_settings(device):
        host = hosts[sd.query_devices(device)['hostapi']]['name']
        if host == 'Windows WASAPI':
            return sd.WasapiSettings(exclusive=False, auto_convert=True)
        if host == 'Core Audio':
            return sd.CoreAudioSettings(change_device_parameters=False,
                fail_if_conversion_required=False, conversion_quality='max')
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
            raise RuntimeError(f'{label}「{name}」を開けませんでした。別のデバイスを選ぶか、Windowsの音声設定を確認してください。({exc})') from exc
    return extra


def resolve_devices(config, available):
    """PortAudio IDs may change between processes; restore by WASAPI name."""
    result = []
    for key, channel, label in (('input', 'inputs', 'マイク'), ('output', 'outputs', '出力先')):
        name = config.get(key+'_name', '')
        matches = [d for d in available if d['host']=='Windows WASAPI' and d[channel]>0
                   and (d['name']==name if name else d['id']==int(config[key]))]
        if len(matches)!=1:
            raise ValueError(f'{label}「{name or config[key]}」が見つかりません。デバイスを更新して選び直してください。')
        result.append(matches[0]['id'])
    return tuple(result)


class Realtime:
    def __init__(self, notify):
        self.notify = notify
        self.stop_event = threading.Event()
        self.thread = None
        self.controls_lock = threading.Lock()
        self.controls = dict(CONTROL_DEFAULTS)
        self.effects = dict(EFFECT_DEFAULTS)
        self.cached_model = None

    def update_controls(self, changes, effects=None):
        if not isinstance(changes, dict) or not changes or set(changes) - CONTROL_DEFAULTS.keys():
            raise ValueError('変更できるのはピッチ・フォルマント・入力ゲイン・出力ゲインです。')
        with self.controls_lock:
            controls = normalize_controls({**self.controls, **changes})
            normalized = self.effects if effects is None else normalize_effects(effects)
            self.controls, self.effects = controls, normalized

    def start(self, config):
        if self.thread and self.thread.is_alive() and self.stop_event.is_set():
            # The stopped event is emitted just before the old audio thread exits.
            self.thread.join(timeout=10)
        if self.thread and self.thread.is_alive():
            raise RuntimeError('すでに起動中です。')
        if float(config.get('schedule_ms', 160)) != 160:
            raise ValueError('出力の待ち時間は160msです。')
        singing_settings(config)
        with self.controls_lock:
            self.controls = normalize_controls(config)
            self.effects = normalize_effects(config)
        self.stop_event.clear()
        self.notify({'type': 'state', 'state': 'loading'})
        # Model creation stays off the IPC thread so Stop also works while loading.
        self.thread = threading.Thread(target=self.run, args=(dict(config),), daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def run(self, config):
        stream = None
        pipeline = None
        com = None
        try:
            # WASAPI needs COM initialized on the thread opening the stream.
            if os.name == 'nt':
                import ctypes
                ole32 = ctypes.OleDLL('ole32')
                ole32.CoInitializeEx(None, 0)
                com = ole32
            import sounddevice as sd
            from backend.direct_gpu import BeatricePipeline
            key = model_cache_key(config)
            cached = self.cached_model if key is not None and self.cached_model and self.cached_model[0] == key else None
            if not cached:
                self.cached_model = None
            pipeline = BeatricePipeline(config, lambda msg: self.notify({'type': 'loading', 'message': msg}), **({'model': cached[1]} if cached else {}))
            if self.stop_event.is_set():
                return
            if cached:
                pipeline.restore_budget(cached[2])
            else:
                self.notify({'type': 'loading', 'message': '推論をウォームアップ中'})
                pipeline.warmup(self.stop_event)
            if self.stop_event.is_set():
                return
            if key is not None:
                self.cached_model = (key, pipeline.model, pipeline.config['block'])
            block = pipeline.block
            budget_ms=round(pipeline.config['block']*1000)
            schedule_ms=budget_ms*2
            delay = schedule_ms*48
            incoming = queue.Queue(maxsize=4)
            scheduled = ScheduledAudio(capacity=192000)
            effects_processor = VocalEffects()
            counters = {'dropped': 0, 'device_errors': 0}
            staging = np.zeros(block, np.float32)
            cursor = sequence = 0

            def callback(indata, outdata, frames, timing, status):
                nonlocal cursor, sequence
                counters['device_errors'] += int(bool(status))
                outdata[:] = scheduled.take(frames)[:, None]
                offset = 0
                while offset < frames:
                    n = min(block-cursor, frames-offset)
                    staging[cursor:cursor+n] = indata[offset:offset+n, 0]
                    cursor += n
                    offset += n
                    if cursor == block:
                        item = (sequence, staging.copy())
                        sequence += 1
                        cursor = 0
                        try:
                            incoming.put_nowait(item)
                        except queue.Full:
                            try:
                                incoming.get_nowait()
                            except queue.Empty:
                                pass
                            counters['dropped'] += 1
                            try:
                                incoming.put_nowait(item)
                            except queue.Full:
                                counters['dropped'] += 1

            input_id, output_id = resolve_devices(config, devices())
            output_channels = min(2, sd.query_devices(output_id)['max_output_channels'])
            extra = audio_settings(sd, input_id, output_id, output_channels)
            stream = sd.Stream(device=(input_id, output_id), samplerate=48000, blocksize=480,
                channels=(1, output_channels), dtype='float32', latency='low',
                extra_settings=extra, callback=callback)
            if self.stop_event.is_set():
                return
            io_latency_ms=sum(stream.latency)*1000
            schedule_ms=output_schedule(config,budget_ms,getattr(pipeline,'fixed_lookback_ms',65.),io_latency_ms)
            delay=round(schedule_ms*48)
            stream.start()
            self.notify({'type': 'state', 'state': 'running', 'rate': pipeline.rate,
                'device': pipeline.device_name, 'format': pipeline.format,
                'schedule_ms': schedule_ms, 'budget_ms':budget_ms, 'io_latency_ms': io_latency_ms,
                'singing_enabled':config.get('singing_enabled',False),
                'model_reused':bool(cached),
                'input': input_id, 'output': output_id})
            last_sequence = -1
            last_notice = 0
            while not self.stop_event.is_set():
                try:
                    seq, audio = incoming.get(timeout=.1)
                except queue.Empty:
                    if not stream.active:
                        raise RuntimeError('音声デバイスが停止しました。接続を確認してください。')
                    continue
                if seq != last_sequence+1:
                    pipeline.reset()
                    effects_processor.reset()
                last_sequence = seq
                with self.controls_lock:
                    controls = self.controls
                    effects = self.effects
                pipeline.set_controls(controls)
                processing_start = time.perf_counter()
                result = pipeline.convert(audio)
                result = effects_processor.process(result,effects)
                pipeline.stats['clip'] = int(bool(pipeline.stats.get('clip',0)) or effects_processor.peak > 1.)
                pipeline.stats['ms'] = (time.perf_counter()-processing_start)*1000
                scheduled.put(seq*block+delay, result)
                now = time.monotonic()
                if now-last_notice > .2:
                    self.notify({'type': 'metrics', **pipeline.stats, **counters,
                        'late_blocks': scheduled.late_blocks,
                        'missing_ms': scheduled.missing_after_start/48,
                        'schedule_ms': schedule_ms, 'queue_ms': incoming.qsize()*budget_ms,
                        'latency_estimate_ms': estimate_latency_ms(schedule_ms,pipeline.stats['lookback_ms'],io_latency_ms),
                        'budget_ms': budget_ms, 'over_budget': pipeline.stats['ms'] > budget_ms})
                    last_notice = now
        except Exception as exc:
            import traceback
            traceback.print_exc()
            self.notify({'type': 'error', 'message': str(exc)})
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
                del pipeline
                self.stop_event.set()
                self.notify({'type': 'state', 'state': 'stopped'})
