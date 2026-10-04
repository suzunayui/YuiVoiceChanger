"""Host a user-installed official Beatrice 2 VST3; models remain external.

The preset component stream follows the public beatrice-vst parameter schema.
No inference library or model weights are copied into this project.
"""
from pathlib import Path
import math
import struct
import tempfile
import time
import tomllib
import sys

import numpy as np


def vst_path(vst, platform=None):
    platform = sys.platform if platform is None else platform
    vst = Path(vst)
    if not vst.exists() or vst.suffix.lower() != '.vst3':
        raise ValueError('公式Beatrice 2 VST3を環境設定で選択してください。')
    if platform == 'darwin':
        if not vst.is_dir() or not (vst/'Contents'/'MacOS'/vst.stem).is_file():
            raise ValueError('macOS版Beatrice VST3のフォルダを選択してください。')
        return vst
    if vst.is_dir():
        vst = vst/'Contents'/'x86_64-win'/vst.name
    if not vst.is_file():
        raise ValueError('VST3のWindows x86_64バイナリが見つかりません。')
    return vst


def component_state(model, pitch, average_pitch):
    path = str(Path(model).resolve()).encode('utf-8')
    entries = struct.pack('<hii', 1, 2, len(path)) + path
    entries += struct.pack('<hii', 2, 0, 0)  # Voice 0
    for key, value in ((3, 0.), (4, pitch), (5, average_pitch-pitch),
                       (7, 0.), (8, 0.), (9, 1.), (10, 0.), (100, average_pitch)):
        entries += struct.pack('<hid', key, 1, value)
    return struct.pack('<i', len(entries)) + entries


def preset_bytes(component):
    # Official rc.3 distribution's moduleinfo.json Audio Module Class CID.
    uid = b'B0EABF53EAA94CC08F52C9959D91057B'
    header = b'VST3' + struct.pack('<i', 1) + uid + struct.pack('<q', 48+len(component))
    return header + component + b'List' + struct.pack('<i4sqq', 1, b'Comp', 48, len(component))


class SilenceEnvelope:
    """Input-driven gate: fast opening, 160 ms hold for model delay and endings."""
    def __init__(self, threshold=-50):
        self.level = 10**(threshold/20)
        self.reset()

    def reset(self):
        self.gain = 0.
        self.hold = 0

    def process(self, output, source):
        result = output.copy()
        for start in range(0, len(source), 480):
            piece = source[start:start+480]
            rms = float(np.sqrt(np.mean(piece*piece)))
            threshold = self.level * (.5 if self.hold else 1)
            if rms >= threshold:
                self.hold = 7680
            else:
                self.hold = max(0, self.hold-len(piece))
            end = min(start+len(piece), len(result))
            count = end-start
            if count <= 0:
                continue
            step = 1/144 if self.hold else -1/3840
            gains = np.clip(self.gain + np.arange(1,count+1)*step, 0, 1)
            result[start:end] *= gains
            self.gain = float(gains[-1])
        return result


class BeatricePipeline:
    input_rate = rate = 48000
    device = pitch_device = 'cpu'
    format = 'Beatrice VST3'

    def __init__(self, config, notify):
        block = float(config.get('beatrice_block', .04))
        if block not in (.01, .02, .04):
            raise ValueError('Beatriceの処理ブロックは10・20・40msです。')
        self.config = dict(config, block=block)
        model = Path(config.get('beatrice_model', ''))
        vst = Path(config.get('beatrice_vst', ''))
        if not model.is_file() or model.suffix.lower() != '.toml':
            raise ValueError('Beatriceモデルの.tomlを選択してください。')
        vst = vst_path(vst)
        with model.open('rb') as f:
            metadata = tomllib.load(f)
        if metadata.get('model', {}).get('version') != '2.0.0-rc.0':
            raise ValueError('現在のBeatrice対応は2.0.0-rc.0形式のモデルです。')
        for name in ('phone_extractor.bin', 'pitch_estimator.bin', 'waveform_generator.bin',
                     'speaker_embeddings.bin', 'embedding_setter.bin'):
            if not (model.parent/name).is_file():
                raise ValueError(f'Beatriceモデルの隣に{name}が必要です。')
        pitch = float(config.get('beatrice_pitch', 12))
        gain = float(config.get('gain', 0))
        if not math.isfinite(pitch) or not -24 <= pitch <= 24:
            raise ValueError('Beatriceの音高は-24〜24半音です。')
        if not math.isfinite(gain) or not -24 <= gain <= 30:
            raise ValueError('ゲインは-24〜30 dBです。')
        average = float(metadata['voice']['0']['average_pitch'])
        if not math.isfinite(average) or not 0 <= average <= 128:
            raise ValueError('モデルの平均音高が不正です。')
        try:
            from pedalboard import load_plugin
        except ImportError as exc:
            raise RuntimeError('Beatrice用のpedalboardがありません。docs/beatrice.mdのセットアップを実行してください。') from exc
        notify('Beatrice VST3とローカルモデルを読み込み中')
        self.plugin = load_plugin(str(vst))
        if self.plugin.name.lower() != 'beatrice_2.0.0-rc.3':
            raise ValueError('公式Beatrice 2.0.0-rc.3のVST3を選択してください。')
        with tempfile.TemporaryDirectory(prefix='yvc-beatrice-') as folder:
            preset = Path(folder)/'voice.vstpreset'
            preset.write_bytes(preset_bytes(component_state(model, pitch, average)))
            self.plugin.load_preset(str(preset))
        self.gain = 10**(gain/20)
        self.stats = {}
        self.envelope = SilenceEnvelope(float(config.get("beatrice_gate", -50)))
        self.noise_filter = config.get("beatrice_noise_filter", True)
        self.clarity = None
        if config.get('beatrice_clarity', False):
            from pedalboard import Pedalboard, PeakFilter, HighShelfFilter
            self.clarity = Pedalboard([
                PeakFilter(cutoff_frequency_hz=350, gain_db=-2, q=.7),
                HighShelfFilter(cutoff_frequency_hz=3500, gain_db=2, q=.707),
            ])

    def reset(self):
        self.plugin.reset()
        self.envelope.reset()
        if self.clarity is not None:
            self.clarity.reset()

    def convert(self, audio, silence=True):
        started = time.perf_counter()
        audio = np.asarray(audio, dtype=np.float32)
        # Keep the streaming state alive through silence, including word onsets.
        result = self.plugin.process(audio[None], self.rate, buffer_size=480, reset=False)
        result = np.asarray(result, dtype=np.float32)
        if result.ndim == 2:
            result = result.mean(axis=0)
        if not np.isfinite(result).all():
            raise RuntimeError('Beatriceの出力に非有限値があります。')
        if getattr(self, 'clarity', None) is not None:
            result = self.clarity.process(result[None], self.rate, buffer_size=480, reset=False)[0]
        if getattr(self, "noise_filter", False):
            result = self.envelope.process(result, audio)
        result *= self.gain
        rms = float(np.sqrt(np.mean(audio**2)+1e-12))
        self.stats = dict(ms=(time.perf_counter()-started)*1000, rms=rms,
                          silent=rms < 1e-5, clip=int(np.any(np.abs(result)>1)))
        return np.clip(result, -1, 1)
