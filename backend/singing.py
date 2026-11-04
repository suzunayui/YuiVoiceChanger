"""Fixed-position synthesis and sample-clock reservation preserve singing timing."""
import math
import json


def latency_signature(config):
    return json.dumps([config.get('beatrice_model', ''), config.get('beatrice_voice', 0), config.get('compute', 'auto'),
                       config.get('input_name') or config.get('input', -1), config.get('output_name') or config.get('output', -1),
                       config.get('obs_port', 4455), config.get('obs_input_uuid') or config.get('obs_input_name', '')],
                      ensure_ascii=False, separators=(',', ':'))


def singing_settings(config):
    enabled, latency = config.get('singing_enabled', False), config.get('singing_latency_ms', 400)
    if type(enabled) is not bool or type(latency) not in (int, float) or not math.isfinite(latency) or latency != int(latency) or not 200 <= latency <= 2000:
        raise ValueError('歌枠用の固定遅延は200〜2000msの整数で指定してください。')
    return enabled, latency


def resolve_fixed_timing(config, budget_ms, lookback_ms, io_latency_ms):
    """Reserve the chosen OBS arrival time minus the measured downstream path."""
    enabled, base = singing_settings(config)
    if not enabled:
        return config, None
    measured = config.get('obs_path_signature') == latency_signature(config)
    correction = config.get('obs_path_delay_ms', 0) if measured else 0
    minimum = math.ceil((2*budget_ms+lookback_ms+io_latency_ms)/10)*10
    if not config.get('obs_delay_manual', False):
        # Old files store a raw engine reserve and an unverified beep correction.
        # Do not turn the latter into a new floor. Repair an impossible old
        # reserve before calibration, retaining 100ms of startup headroom.
        if minimum > 2000:
            raise ValueError(f'この設定で必要な待ち時間は{minimum}msで、設定できる上限2000msを超えています。')
        target = min(2000, minimum+100) if base < minimum else base
        return {**config, 'singing_latency_ms': target, 'obs_correction_ms': correction, 'obs_delay_manual': True}, {
            'legacy_timing': True, 'previous_base_ms': base, 'previous_correction_ms': config.get('obs_correction_ms', 0),
            'singing_latency_ms': target, 'obs_correction_ms': correction}
    total = base+config.get('obs_correction_ms', 0)
    target = total-correction
    if target < minimum:
        raise ValueError(f'現在の設定では固定遅延を{minimum+correction}ms以上にしてください。')
    if target > 2000:
        raise ValueError(f'この音声経路では固定遅延を{2000+correction}ms以下にしてください。')
    if base == target:
        return config, None
    next_config = {**config, 'singing_latency_ms': target, 'obs_correction_ms': correction}
    return next_config, {'previous_base_ms': base, 'previous_correction_ms': config.get('obs_correction_ms', 0),
                         'singing_latency_ms': target, 'obs_correction_ms': correction}


def output_schedule(config, budget_ms, lookback_ms, io_latency_ms):
    enabled, target = singing_settings(config)
    if not enabled:
        return budget_ms*2
    required = 2*budget_ms+lookback_ms+io_latency_ms
    if target < required:
        minimum = math.ceil(required/10)*10
        raise ValueError(f'現在の設定では変換処理の待ち時間を{minimum}ms以上にしてください。')
    return round((target-lookback_ms-io_latency_ms)*48)/48
