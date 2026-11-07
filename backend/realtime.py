"""GPU conversion with bounded queues and sample-clock output scheduling."""
import queue
import math
import os
import sys
import threading
import time
import numpy as np

from backend.audio_diagnostics import AudioDiagnostics
from backend.scheduled_audio import ScheduledAudio
from backend.audio_controls import CONTROL_DEFAULTS, normalize_controls, apply_gain
from backend.vocal_effects import EFFECT_DEFAULTS, normalize_effects, VocalEffects
from backend.singing import singing_settings, output_schedule, resolve_fixed_timing
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


# A late callback on the low-latency buffer silently loses input and output blocks (WASAPI
# reports no status). Singing already waits hundreds of ms, so it can afford a larger buffer.
SINGING_DEVICE_LATENCY = .1
LATE_CALLBACK_SECONDS = .03


def catch_up_backlog(incoming, seq, audio, block, delay, cursor, estimate):
    """Skip queued blocks that cannot reach their output slot.

    Converting them anyway keeps every later block late too, which trims a little from
    each one and sounds choppy. Skipping gives one clean gap and then on-time audio.
    """
    skipped = 0
    while seq*block+delay-cursor() < estimate:
        try:
            seq, audio = incoming.get_nowait()
        except queue.Empty:
            break
        skipped += 1
    return seq, audio, skipped


def open_audio_stream(open_stream, singing):
    """Return the stream and the latency that timing is computed from.

    Measured on WASAPI: 0.1 s reports about 176 ms more than 'low' but the real round trip
    grows only about 6 ms. Timing keeps the 'low' figure so voice stays on its target time.
    """
    import sounddevice as sd
    stream = open_stream('low')
    io_latency_ms = sum(stream.latency)*1000
    if singing:
        stream.close()
        try:
            stream = open_stream(SINGING_DEVICE_LATENCY)
        except sd.PortAudioError:
            stream = open_stream('low')
    return stream, io_latency_ms


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
            raise RuntimeError(f'{label}「{name}」を開けませんでした。別のデバイスを選ぶか、OSの音声設定・マイクの許可を確認してください。({exc})') from exc
    return extra


def resolve_devices(config, available):
    """Restore shared-mode WASAPI or native Core Audio devices by name."""
    host = 'Core Audio' if any(d['host']=='Core Audio' for d in available) else 'Windows WASAPI'
    result = []
    for key, channel, label in (('input', 'inputs', 'マイク'), ('output', 'outputs', '出力先')):
        name = config.get(key+'_name', '')
        matches = [d for d in available if d['host']==host and d[channel]>0
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
        self.sync_probe = None
        self.stream_running = threading.Event()
        self.probe_lock = threading.Lock()
        self.voice_reference = None
        self.reference_fixed = False
        self.program_mix = None
        self.mix_music_gain = -6
        self.muted = False

    def set_muted(self, value):
        if not isinstance(value, bool):
            raise ValueError('ミュートの指定が正しくありません。')
        self.muted = value

    def update_music_gain(self,value):
        if type(value) not in (int,float) or not math.isfinite(value) or not -24<=value<=6:raise ValueError('伴奏ゲインは−24〜6dBにしてください。')
        self.mix_music_gain=value
        if self.program_mix:self.program_mix.gain=10**(value/20)

    def start_passive_reference(self):
        from backend.passive_audio import VoiceReference
        if self.muted:raise ValueError('ミュートを解除してから確認してください。')
        if self.program_mix:raise ValueError('MIXモードでは声と伴奏を同じ時間軸で合成しています。個別ソースのずれ確認は通常モードで使用してください。')
        if not self.stream_running.is_set() or not self.reference_fixed:
            raise ValueError('固定遅延を有効にして声変換を開始してください。')
        if self.sync_probe:raise ValueError('自動調整が終わってから確認してください。')
        self.stop_passive_reference()
        self.voice_reference=VoiceReference()

    def stop_passive_reference(self):
        reference,self.voice_reference=self.voice_reference,None
        if reference:reference.close()

    def passive_snapshot(self):
        reference=self.voice_reference
        if not reference:raise ValueError('声の参照音声を取得していません。')
        if reference.failure:raise ValueError(reference.failure)
        return reference.ring.snapshot()

    def start_sync_test(self, identifier, device_name='', silent=False):
        import re
        from backend.sync_probe import SyncProbe
        if not isinstance(identifier, str) or not re.fullmatch(r'[a-f0-9-]{36}', identifier):
            raise ValueError('測定の識別子が正しくありません。')
        if not isinstance(device_name, str) or len(device_name) > 512 or any(ord(char) < 32 for char in device_name):
            raise ValueError('測定用の音声再生先が正しくありません。')
        with self.probe_lock:
            if not self.stream_running.is_set() or self.stop_event.is_set():
                raise ValueError('声変換を開始してから測定してください。')
            if self.muted:
                raise ValueError('ミュートを解除してから測定してください。')
            if self.sync_probe:
                raise ValueError('テスト音声は再生中です。')
            if self.voice_reference:raise ValueError('ずれの確認を停止してから自動調整してください。')
            if self.program_mix:raise ValueError('MIXモードではOBSの音声自動調整は使用しません。')
            if not isinstance(silent, bool):
                raise ValueError('測定方法が正しくありません。')
            probe = SyncProbe(identifier, device_name, self.notify, self._probe_closed, silent=silent)
            self.sync_probe = probe
            probe.start()

    def sync_test_clock(self, identifier, token):
        with self.probe_lock:
            if self.sync_probe and self.sync_probe.identifier == identifier and self.sync_probe.silent:
                self.sync_probe.emit('clock',token=token,clock=time.monotonic())

    def align_sync_test(self, identifier, epoch):
        with self.probe_lock:
            if not self.sync_probe or self.sync_probe.identifier != identifier:
                return
            try:
                self.sync_probe.align(epoch)
            except Exception as error:
                self.sync_probe.failure = str(error)
                self.sync_probe.stop()

    def _probe_closed(self, probe):
        with self.probe_lock:
            if self.sync_probe is probe:
                self.sync_probe = None

    def cancel_sync_test(self):
        with self.probe_lock:
            if self.sync_probe:
                self.sync_probe.stop()

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
        if config.get('mix_enabled') and (os.name!='nt' or not config.get('singing_enabled')):raise ValueError('MIXモードはWindowsの固定遅延で使用してください。')
        self.update_music_gain(config.get('mix_music_gain',-6))
        with self.controls_lock:
            self.controls = normalize_controls(config)
            self.effects = normalize_effects(config)
        self.muted = config.get('muted') is True
        self.stop_event.clear()
        self.notify({'type': 'state', 'state': 'loading'})
        # Model creation stays off the IPC thread so Stop also works while loading.
        self.thread = threading.Thread(target=self.run, args=(dict(config),), daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.cancel_sync_test()
        self.stop_passive_reference()

    def run(self, config):
        stream = None
        pipeline = None
        com = None
        mixer = None
        callback_failure = ['']
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
            counters = {'dropped': 0, 'device_errors': 0, 'skipped_blocks': 0}
            staging = np.zeros(block, np.float32)
            cursor = sequence = 0
            # Muting has two gates: the output gate cuts the voice at once, even with a long
            # fixed delay queued; the conversion gate keeps what was said while muted out of
            # that queue and the effect tails, so unmuting never replays it.
            output_gate = conversion_gate = 0. if self.muted else 1.
            last_callback = None
            callback_stats = {'late': 0, 'largest_gap': 0.}

            def callback(indata, outdata, frames, timing, status):
                nonlocal cursor, sequence, output_gate, last_callback
                arrived = time.perf_counter()
                if last_callback is not None and arrived-last_callback > LATE_CALLBACK_SECONDS:
                    callback_stats['late'] += 1
                    callback_stats['largest_gap'] = max(callback_stats['largest_gap'], arrived-last_callback)
                last_callback = arrived
                counters['device_errors'] += int(bool(status))
                position=scheduled.cursor
                voice=scheduled.take(frames)
                gate = 0. if self.muted else 1.
                if gate != 1. or output_gate != 1.:
                    voice = apply_gain(voice, output_gate, gate)
                    output_gate = gate
                if mixer:
                    try:outdata[:]=mixer.render(voice,position,timing,status,delay+round(pipeline.fixed_lookback_ms*48))
                    except Exception as error:outdata.fill(0);callback_failure[0]=str(error)
                else:outdata[:] = voice[:,None]
                reference=self.voice_reference
                if reference:
                    reference.timed(outdata[:,0],timing,status,delay+round(pipeline.fixed_lookback_ms*48))
                probe = self.sync_probe
                source = probe.input(frames, timing, status) if probe else indata[:, 0]
                offset = 0
                while offset < frames:
                    n = min(block-cursor, frames-offset)
                    staging[cursor:cursor+n] = source[offset:offset+n]
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
            if config.get('mix_enabled'):
                if output_channels!=2:raise ValueError('MIXの出力先はステレオ対応デバイスを選んでください。')
                from backend.program_mix import ProgramMix
                mixer=ProgramMix(config.get('mix_device_id','default'),sd.query_devices(output_id)['name'],self.mix_music_gain)
                self.program_mix=mixer;mixer.start()
            extra = audio_settings(sd, input_id, output_id, output_channels)
            stream, io_latency_ms = open_audio_stream(lambda latency: sd.Stream(device=(input_id, output_id), samplerate=48000, blocksize=480,
                channels=(1, output_channels), dtype='float32', latency=latency,
                extra_settings=extra, callback=callback), bool(config.get('singing_enabled')))
            if self.stop_event.is_set():
                return
            if mixer:
                from backend.program_mix import settings as mix_schedule
                manual_timing=None
                schedule_ms=mix_schedule(config,budget_ms,pipeline.fixed_lookback_ms,io_latency_ms)
            else:
                config,manual_timing=resolve_fixed_timing(config,budget_ms,getattr(pipeline,'fixed_lookback_ms',65.),io_latency_ms)
                schedule_ms=output_schedule(config,budget_ms,getattr(pipeline,'fixed_lookback_ms',65.),io_latency_ms)
            delay=round(schedule_ms*48)
            stream.start()
            self.reference_fixed=bool(config.get('singing_enabled',False))
            self.stream_running.set()
            self.notify({'type': 'state', 'state': 'running', 'rate': pipeline.rate,
                'device': pipeline.device_name, 'format': pipeline.format,
                'schedule_ms': schedule_ms, 'budget_ms':budget_ms, 'io_latency_ms': io_latency_ms,
                'singing_enabled':config.get('singing_enabled',False),
                'model_reused':bool(cached),
                'mix_enabled':bool(mixer),
                **({'manual_timing':manual_timing} if manual_timing else {}),
                'input': input_id, 'output': output_id})
            last_sequence = -1
            convert_estimate = 0
            last_notice = 0
            clock_report = (0, 0)
            diagnostics = AudioDiagnostics(lambda line: print(line, file=sys.stderr, flush=True))
            diagnostics.start(input=config.get('input_name') or input_id, output=config.get('output_name') or output_id,
                singing=bool(config.get('singing_enabled')), mix=bool(mixer), input_gain=config.get('input_gain'), gain=config.get('gain'),
                music_gain=self.mix_music_gain if mixer else None, fx=bool(config.get('fx_enabled')), compute=pipeline.device_name,
                buffer_ms=round(sum(stream.latency)*1000), timing_io_ms=round(io_latency_ms), schedule_ms=round(schedule_ms))
            def report_diagnostics():
                largest_gap, callback_stats['largest_gap'] = callback_stats['largest_gap'], 0.
                values = dict(callback_late=callback_stats['late'], largest_gap_ms=largest_gap*1000,
                    voice_late_blocks=scheduled.late_blocks, voice_missing_ms=scheduled.missing_after_start/48,
                    dropped=counters['dropped'], device_errors=counters['device_errors'], skipped_blocks=counters['skipped_blocks'])
                if mixer:
                    values.update(music_gaps=mixer.music.gaps, music_missing_samples=mixer.missing, limited_samples=mixer.limited)
                diagnostics.report(values, music_db=mixer.level.recent_db if mixer else None)
            while not self.stop_event.is_set():
                if callback_failure[0]:raise ValueError(callback_failure[0])
                if mixer and mixer.failure:raise ValueError(mixer.failure)
                if mixer and (mixer.clock.outliers,mixer.clock.resyncs)!=clock_report:
                    clock_report=(mixer.clock.outliers,mixer.clock.resyncs)
                    diagnostics.event(f'MIX clock: jumps={clock_report[0]} resyncs={clock_report[1]} largest={mixer.clock.largest_error*1000:.0f}ms')
                if diagnostics.due():
                    report_diagnostics()
                try:
                    seq, audio = incoming.get(timeout=.1)
                except queue.Empty:
                    if not stream.active:
                        raise RuntimeError('音声デバイスが停止しました。接続を確認してください。')
                    continue
                queue_depth = incoming.qsize()
                seq, audio, skipped = catch_up_backlog(incoming, seq, audio, block, delay, lambda: scheduled.cursor, convert_estimate)
                counters['skipped_blocks'] += skipped
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
                gate = 0. if self.muted else 1.
                if gate != 1. or conversion_gate != 1.:
                    result = apply_gain(result, conversion_gate, gate)
                    conversion_gate = gate
                effects_start = time.perf_counter()
                result = effects_processor.process(result,effects)
                effects_ms = (time.perf_counter()-effects_start)*1000
                pipeline.stats['clip'] = int(bool(pipeline.stats.get('clip',0)) or effects_processor.peak > 1.)
                pipeline.stats['ms'] = (time.perf_counter()-processing_start)*1000
                convert_estimate = round(pipeline.stats['ms']*48)
                diagnostics.observe(pipeline.stats['ms'], pipeline.stats.get('rms', 0.), effects_processor.peak,
                    effects_ms=effects_ms, queue_depth=queue_depth, budget_ms=budget_ms)
                scheduled.put(seq*block+delay, result)
                now = time.monotonic()
                if now-last_notice > .2:
                    self.notify({'type': 'metrics', **pipeline.stats, **counters,
                        'late_blocks': scheduled.late_blocks,
                        'missing_ms': scheduled.missing_after_start/48,
                        'output_started': scheduled.started, 'output_samples': scheduled.cursor,
                        'schedule_ms': schedule_ms, 'queue_ms': incoming.qsize()*budget_ms,
                        'latency_estimate_ms': estimate_latency_ms(schedule_ms,pipeline.stats['lookback_ms'],io_latency_ms),
                        'budget_ms': budget_ms, 'over_budget': pipeline.stats['ms'] > budget_ms,
                        **({'music_db': mixer.level.take_db(), 'music_low': mixer.level.low} if mixer else {})})
                    last_notice = now
            report_diagnostics()
        except Exception as exc:
            import traceback
            traceback.print_exc()
            self.notify({'type': 'error', 'message': str(exc)})
        finally:
            self.stream_running.clear()
            self.reference_fixed=False
            self.stop_passive_reference()
            self.program_mix=None
            probe = self.sync_probe
            if probe:
                probe.stop()
                probe.thread.join(timeout=5)
            try:
                if stream:
                    try:
                        stream.abort()
                    finally:
                        stream.close()
            finally:
                if mixer:mixer.close()
                if com:
                    com.CoUninitialize()
                del pipeline
                self.stop_event.set()
                self.notify({'type': 'state', 'state': 'stopped'})
