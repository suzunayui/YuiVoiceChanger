"""Singing timing uses a fixed alignment and a fixed sample-clock reservation."""
import math


def singing_settings(config):
    enabled, latency = config.get('singing_enabled', False), config.get('singing_latency_ms', 400)
    if type(enabled) is not bool or type(latency) not in (int, float) or not math.isfinite(latency) or latency != int(latency) or not 200 <= latency <= 2000:
        raise ValueError('歌枠用の固定遅延は200〜2000msの整数で指定してください。')
    return enabled, latency


def output_schedule(config, budget_ms, lookback_ms, io_latency_ms):
    enabled, target = singing_settings(config)
    if not enabled:
        return budget_ms*2
    required = 2*budget_ms+lookback_ms+io_latency_ms
    if target < required:
        minimum = math.ceil(required/10)*10
        raise ValueError(f'この実行先では固定遅延を{minimum}ms以上にしてください。GPUを選ぶと短くできる場合があります。')
    return round((target-lookback_ms-io_latency_ms)*48)/48
