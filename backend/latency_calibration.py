"""Estimate a stable scheduling target from a short in-memory microphone sample."""
import math
import threading
import time
import numpy as np


class CalibrationCancelled(Exception):
    pass


def check_cancel(cancel):
    if cancel.is_set():
        raise CalibrationCancelled()


def recommend_latency(times_ms, budget_ms, lookback_ms, io_latency_ms):
    times = np.asarray(times_ms, dtype=np.float64)
    if times.ndim != 1 or not len(times) or not np.isfinite(times).all() or np.any(times < 0):
        raise ValueError('処理時間を測定できませんでした。')
    if not all(math.isfinite(value) and value >= 0 for value in (budget_ms, lookback_ms, io_latency_ms)) or budget_ms <= 0:
        raise ValueError('音声デバイスの遅延を取得できませんでした。')
    if float(np.mean(times)) >= budget_ms*.95:
        raise ValueError('この設定では処理に余裕がありません。GPUを選ぶかエフェクトを減らして再測定してください。')
    # Collection + worst observed processing + spare time all fit in the reservation.
    reservation = max(2*budget_ms, budget_ms+float(np.max(times))*1.5+20)
    # Add 100ms after the existing recommendation (including its minimum/rounding).
    # Keep this in calibration only: manual targets and saved presets stay exact.
    target = max(200, math.ceil((reservation+lookback_ms+io_latency_ms)/10)*10)+100
    if target > 2000:
        raise ValueError('必要な遅延が2000msを超えました。GPUや設定を見直して再測定してください。')
    return target


def capture_sample(sd, config, notify, cancel, seconds=6):
    from backend.realtime import resolve_devices, devices, audio_settings
    input_id, output_id = resolve_devices(config, devices())
    channels = min(2, sd.query_devices(output_id)['max_output_channels'])
    extra = audio_settings(sd, input_id, output_id, channels)
    sample = np.zeros(round(seconds*48000), np.float32)
    cursor = 0
    device_errors = 0
    complete = threading.Event()
    input_stream = output_stream = None

    def callback(indata, frames, timing, status):
        nonlocal cursor, device_errors
        device_errors += int(bool(status))
        count = min(frames, len(sample)-cursor)
        sample[cursor:cursor+count] = indata[:count, 0]
        cursor += count
        if cursor == len(sample):
            complete.set()

    try:
        check_cancel(cancel)
        input_stream = sd.InputStream(device=input_id, samplerate=48000, blocksize=480,
            channels=1, dtype='float32', latency='low', extra_settings=extra[0], callback=callback)
        # Open only to obtain PortAudio's output latency. Never start or write it.
        output_stream = sd.OutputStream(device=output_id, samplerate=48000, blocksize=480,
            channels=channels, dtype='float32', latency='low', extra_settings=extra[1])
        io_latency_ms = (input_stream.latency+output_stream.latency)*1000
        check_cancel(cancel)
        notify(dict(phase='speaking', message='マイクに向かって6秒ほどしゃべってください。', progress=.1, seconds_left=seconds, rms=0.))
        input_stream.start()
        deadline = time.monotonic()+seconds+5
        while not complete.wait(.1):
            check_cancel(cancel)
            if time.monotonic() > deadline or not input_stream.active:
                raise RuntimeError('マイクの音声を取得できませんでした。入力デバイスを確認してください。')
            count = cursor
            recent = sample[max(0, count-4800):count]
            rms = float(np.sqrt(np.mean(recent**2))) if len(recent) else 0.
            notify(dict(phase='speaking', message='マイクに向かってしゃべってください。', progress=.1+.4*count/len(sample), seconds_left=max(0, math.ceil(seconds-count/48000)), rms=rms))
        check_cancel(cancel)
        if device_errors:
            raise RuntimeError('測定中にマイクの音声が途切れました。デバイスを確認して再測定してください。')
        if not np.isfinite(sample).all():
            raise ValueError('マイクの音声を読み取れませんでした。')
        return sample, io_latency_ms
    except BaseException:
        sample.fill(0)
        raise
    finally:
        try:
            if input_stream:
                try: input_stream.abort()
                finally: input_stream.close()
        finally:
            if output_stream: output_stream.close()


def measure_sample(pipeline, sample, config, notify, cancel, io_latency_ms):
    from backend.vocal_effects import VocalEffects
    check_cancel(cancel)
    windows = sample[:len(sample)//480*480].reshape(-1, 480)
    gain = 10**(config.get('input_gain', 12)/20)
    if not len(windows) or np.sum(np.sqrt(np.mean(windows**2, axis=1))*gain > .002) < 50:
        raise ValueError('声が小さいか、十分な音声がありませんでした。マイクに向かってもう一度しゃべってください。')
    pipeline.reset()
    effects = VocalEffects()
    count = math.ceil(len(sample)/pipeline.block)
    times = []
    for index in range(count):
        check_cancel(cancel)
        audio = sample[index*pipeline.block:(index+1)*pipeline.block]
        if len(audio) < pipeline.block:
            audio = np.pad(audio, (0, pipeline.block-len(audio)))
        started = time.perf_counter()
        result = pipeline.convert(audio)
        effects.process(result, config)
        times.append((time.perf_counter()-started)*1000)
        notify(dict(phase='measuring', message='変換の処理時間を測定しています…', progress=.5+.45*(index+1)/count, rms=0.))
    check_cancel(cancel)
    budget_ms = round(pipeline.config['block']*1000)
    target = recommend_latency(times, budget_ms, pipeline.fixed_lookback_ms, io_latency_ms)
    return dict(recommended_ms=target, device=pipeline.device_name, budget_ms=budget_ms,
        processing_max_ms=max(times), io_latency_ms=io_latency_ms)


def calibrate(config, notify, cancel):
    import os
    sample = pipeline = None
    com = None
    try:
        if os.name == 'nt':
            import ctypes
            ole32 = ctypes.OleDLL('ole32')
            try:
                ole32.CoInitializeEx(None, 0)
            except OSError as error:
                # Another library may already have initialized this thread as STA.
                # Keep that apartment and balance only our successful initialization.
                if getattr(error, 'winerror', 0) & 0xffffffff != 0x80010106:
                    raise
            else:
                com = ole32
        check_cancel(cancel)
        import sounddevice as sd
        from backend.direct_gpu import BeatricePipeline
        notify(dict(phase='preparing', message='声のモデルを準備しています。案内が出たらしゃべってください。', progress=0.))
        pipeline = BeatricePipeline({**config, 'singing_enabled': True})
        check_cancel(cancel)
        pipeline.warmup(cancel)
        check_cancel(cancel)
        sample, io_latency_ms = capture_sample(sd, config, notify, cancel)
        return measure_sample(pipeline, sample, config, notify, cancel, io_latency_ms)
    finally:
        if sample is not None: sample.fill(0)
        del pipeline
        if com: com.CoUninitialize()


def main():
    import json
    import sys
    wire = sys.stdout
    sys.stdout = sys.stderr
    cancel = threading.Event()
    def emit(event):
        wire.write(json.dumps(event, ensure_ascii=False, allow_nan=False)+'\n')
        wire.flush()
    config = json.loads(sys.stdin.readline())
    def listen():
        for line in sys.stdin:
            try:
                if json.loads(line).get('command') == 'cancel': cancel.set()
            except (ValueError, AttributeError): pass
    listener = threading.Thread(target=listen, daemon=True)
    listener.start()
    try:
        result = calibrate(config, emit, cancel)
        check_cancel(cancel)
        emit(dict(phase='completed', message='固定遅延を自動設定しました。', progress=1., **result))
    except CalibrationCancelled:
        emit(dict(phase='cancelled', message='測定を中止しました。'))
    except Exception as error:
        emit(dict(phase='failed', message=str(error)))
    finally:
        listener.join(timeout=1)


if __name__ == '__main__':
    import sys
    from pathlib import Path
    for stream in (sys.stdin, sys.stdout, sys.stderr): stream.reconfigure(encoding='utf-8')
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    main()
