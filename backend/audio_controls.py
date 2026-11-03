"""Validated block-level controls and a short, click-reducing gain transition."""
import math

CONTROL_DEFAULTS = {'beatrice_pitch': 14., 'beatrice_formant': 0., 'input_gain': 12., 'gain': 0.}
RANGES = {'beatrice_pitch': (-24, 24), 'beatrice_formant': (-2, 2), 'input_gain': (-12, 18), 'gain': (-24, 18)}


def normalize_controls(values):
    if not isinstance(values, dict):
        raise ValueError('音声設定の形式が正しくありません。')
    result = {}
    for key, default in CONTROL_DEFAULTS.items():
        value = values.get(key, default)
        low, high = RANGES[key]
        if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f'音声設定の値が範囲外です: {key}')
        result[key] = float(value)
    if result['beatrice_formant'] * 2 != round(result['beatrice_formant'] * 2):
        raise ValueError('フォルマントは0.5半音刻みです。')
    return result


def apply_gain(audio, previous, target):
    """Keep unchanged gains identical; ramp changed gains over at most 10 ms."""
    import numpy as np
    result = audio * target
    if previous != target:
        count = min(480, len(audio))
        if count > 1:
            result[:count] = audio[:count] * np.linspace(previous, target, count, dtype=np.float32)
    return result
