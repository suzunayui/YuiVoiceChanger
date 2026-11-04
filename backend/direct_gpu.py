"""Beatrice training checkpoint inference; no plugin host or exported binaries."""
import gzip
import math
from pathlib import Path
import time

import numpy as np
from backend.audio_controls import normalize_controls, apply_gain
from backend.singing import singing_settings


def checkpoint_path(value):
    path = Path(value).expanduser()
    if not value or not (path.name.endswith('.pt.gz') or path.suffix == '.pt'):
        raise ValueError('Beatriceの学習チェックポイント（.pt.gz / .pt）を選んでください。RVCは「モデルを追加」で学習してから使います。')
    if not path.is_file():
        raise ValueError(f'学習チェックポイントが見つかりません: {path}')
    return path


def select_device(preference='auto'):
    import torch
    import re
    if not isinstance(preference,str) or not re.fullmatch(r'auto|cpu|cuda(?::(?:0|[1-9]\d{0,4}))?',preference):
        raise ValueError('実行先の設定が不正です。')
    explicit_gpu=preference.startswith('cuda')
    target=preference if explicit_gpu else 'cuda:0'
    if preference!='cpu' and torch.cuda.is_available():
        try:
            probe=torch.ones((16,16),device=target)
            if not torch.isfinite(probe@probe).all().item():raise RuntimeError('Invalid GPU result')
            return torch.device(target)
        except Exception:
            if explicit_gpu:raise RuntimeError('選択したGPUを利用できません。実行先の一覧を更新してください。')
    elif explicit_gpu:raise RuntimeError('利用できるNVIDIA GPUがありません。')
    return torch.device('cpu')


class DirectModel:
    def __init__(self, checkpoint, device='auto', voice=0):
        import torch
        from backend import beatrice_model as module
        torch.set_num_threads(2)
        self.preference=device
        self.voice=voice
        self.device = select_device(device)
        self.source_format = 'Beatrice checkpoint / FP32'
        if Path(checkpoint).suffix.lower() in ('.toml','.bin'):
            from backend.exported_model import load_exported
            self.phone,self.pitch,self.net,self.metadata = load_exported(checkpoint)
            self.iteration = None
            self.source_format = 'Beatrice rc.0 binary / FP32'
            self._finish(torch)
            return
        path = checkpoint_path(checkpoint)
        opener = gzip.open if path.suffix == '.gz' else open
        with opener(path, 'rb') as f:
            data = torch.load(f, map_location='cpu', weights_only=True)
        required = {'h', 'net_g', 'phone_extractor', 'pitch_estimator'}
        if not isinstance(data, dict) or not required.issubset(data):
            raise ValueError('対応するBeatrice学習チェックポイントではありません。')
        h = data['h']
        self.phone = module.PhoneExtractor()
        self.pitch = module.PitchEstimator()
        self.phone.load_state_dict(data['phone_extractor'])
        self.pitch.load_state_dict(data['pitch_estimator'])
        self.net = module.ConverterNetwork(
            self.phone, self.pitch, data['net_g']['embed_speaker.weight'].shape[0],
            h['pitch_bins'], h['hidden_channels'], h['vq_topk'], h['training_time_vq'],
            h['phone_noise_ratio'], h['floor_noise_level'])
        self.net.load_state_dict(data['net_g'])
        self.iteration = data.get('iteration')
        self._finish(torch)

    def _finish(self, torch):
        try:
            for model in (self.phone, self.pitch, self.net):model.to(self.device).eval()
        except RuntimeError:
            if self.preference!='auto' or self.device.type!='cuda':raise
            self.device=torch.device('cpu')
            for model in (self.phone,self.pitch,self.net):model.to(self.device).eval()
            torch.cuda.empty_cache()
        if type(self.voice) is not int or not 0<=self.voice<self.net.embed_speaker.num_embeddings:
            raise ValueError('選択した声の番号がモデルにありません。モデルを選び直してください。')
        self.speaker = torch.tensor([self.voice], device=self.device)
        self.formant = torch.tensor([0.], device=self.device)
        self.pitch_shift = torch.tensor([0.], device=self.device)
        self.device_name = torch.cuda.get_device_name(self.device) if self.device.type=='cuda' else 'CPU'

    def infer(self, audio16k, shift=14., formant=0., seed=42, excitation_state=None):
        import torch
        audio16k = np.asarray(audio16k, dtype=np.float32)
        if audio16k.ndim != 1 or len(audio16k) < 160 or not np.isfinite(audio16k).all():
            raise ValueError('有限値のモノラル音声が必要です。')
        if not math.isfinite(shift) or not -24 <= shift <= 24:
            raise ValueError('音の高さは−24〜24半音です。')
        if not math.isfinite(formant) or not -2 <= formant <= 2 or formant*2 != round(formant*2):
            raise ValueError('フォルマントは−2〜2半音、0.5刻みです。')
        if len(audio16k) % 160:
            audio16k = np.pad(audio16k, (0, -len(audio16k) % 160))
        with torch.inference_mode():
            # Preserve the batch seed; fixed-position streaming uses its own
            # continuous excitation state. Attention dropout stays disabled.
            torch.manual_seed(seed)
            self.pitch_shift.fill_(shift)
            self.formant.fill_(formant)
            source = torch.from_numpy(np.ascontiguousarray(audio16k))[None, None].to(self.device)
            y = self.net(source, self.speaker, self.formant, pitch_shift_semitone=self.pitch_shift,
                         **({'excitation_state': excitation_state} if excitation_state is not None else {}))
            result = y[0, 0].cpu().numpy()
        if not np.isfinite(result).all():
            raise RuntimeError('モデルの出力に非有限値があります。')
        return result


class AlignedOverlap:
    def __init__(self, block, overlap=960, search=480, fixed=False):
        self.block, self.overlap, self.search = block, overlap, search
        self.fixed = fixed
        t = np.linspace(0., np.pi, overlap, dtype=np.float32)
        self.fade = .5-.5*np.cos(t)
        self.reset()

    def reset(self):
        self.tail = None
        self.last_shift = self.search//2

    def join(self, candidate):
        candidate = np.asarray(candidate, dtype=np.float32)
        if len(candidate) != self.block+self.overlap+self.search:
            raise ValueError('生成した音声の長さが不正です。')
        shift = self.search//2
        if not self.fixed and self.tail is not None and np.mean(self.tail**2) > 1e-10:
            head = candidate[:self.overlap+self.search]
            numerator = np.correlate(head, self.tail, mode='valid')
            energy = np.convolve(head*head, np.ones(self.overlap, np.float32), mode='valid')
            denominator = np.sqrt(np.maximum(energy*float(np.sum(self.tail**2)), 1e-20))
            scores = numerator/denominator
            scores -= np.abs(np.arange(len(scores))-self.last_shift)*1e-5
            shift = int(np.argmax(scores))
        segment = candidate[shift:shift+self.block+self.overlap].copy()
        if self.tail is not None:
            segment[:self.overlap] = self.tail*(1-self.fade)+segment[:self.overlap]*self.fade
        else:
            segment[:self.overlap] *= self.fade
        self.tail = segment[self.block:self.block+self.overlap].copy()
        self.last_shift = shift
        return segment[:self.block]


class BeatricePipeline:
    rate = input_rate = 48000
    device = pitch_device = 'cuda'
    format = 'Beatrice checkpoint / FP32 GPU'

    def __init__(self, config, notify=lambda message: None, model=None):
        import torchaudio
        block = float(config.get('beatrice_block', .08))
        if block != .08:
            raise ValueError('GPU直接変換の更新間隔は80msです。')
        self.set_controls(config)
        self.fixed_alignment = singing_settings(config)[0]
        self.previous_input_gain, self.previous_output_gain = self.input_gain, self.output_gain
        notify('声のモデルを読み込み中' if model is None else '読み込み済みの声のモデルを使用')
        self.model = DirectModel(config.get('beatrice_model', ''),config.get('compute','auto'),config.get('beatrice_voice',0)) if model is None else model
        self.device = self.pitch_device = self.model.device.type
        self.device_name = self.model.device_name
        self.format = self.model.source_format
        self.config = {'block': block}
        self.block = round(block*48000)
        self.history_samples = 153600
        self.guard24, self.overlap48, self.search48, self.edge24 = 960, 960, 480, 48
        self.down = torchaudio.transforms.Resample(48000, 16000)
        self.up = torchaudio.transforms.Resample(24000, 48000)
        self.joiner = AlignedOverlap(self.block, self.overlap48, self.search48, fixed=self.fixed_alignment)
        self.fixed_lookback_ms = self.guard24/24+(self.overlap48+self.search48-self.search48//2)/48
        self.stats = {}
        self.reset()

    def set_controls(self, values):
        controls = normalize_controls(values)
        self.pitch, self.formant = controls['beatrice_pitch'], controls['beatrice_formant']
        self.input_gain, self.output_gain = 10**(controls['input_gain']/20), 10**(controls['gain']/20)

    def reset(self):
        from backend.streaming_excitation import StreamingExcitation
        self.history = np.zeros(self.history_samples, np.float32)
        self.joiner.reset()
        # Vocoder post filtering advances its excitation by 120 samples at 24 kHz.
        # Anchor at the centre of the audible overlap, with no waveform time shift.
        anchor_from_end = self.guard24 + (self.block+self.overlap48+self.search48)//2 - self.search48//4 - self.overlap48//4 - 120
        self.excitation_state = StreamingExcitation(self.block//2, anchor_from_end) if self.fixed_alignment else None

    def restore_budget(self, block_seconds):
        """Reuse the measured CPU/GPU block size without warming the model again."""
        block_ms = round(block_seconds*1000)
        if block_ms not in range(80, 641, 80):
            raise ValueError('保持した更新間隔が不正です。')
        self.config['block'] = block_ms/1000
        self.block = block_ms*48
        self.joiner = AlignedOverlap(self.block, self.overlap48, self.search48, fixed=self.fixed_alignment)
        self.reset()

    def warmup(self, stop_event):
        times=[]
        for _ in range(3):
            if stop_event.is_set():
                return
            self.convert(np.zeros(self.block, np.float32))
            times.append(self.stats['ms'])
        if self.device=='cpu':
            # Reserve headroom on CPU; keep the chosen clock fixed for this run.
            block_ms=max(80,min(640,math.ceil(max(times[1:])*1.6/80)*80))
            self.config['block']=block_ms/1000
            self.block=block_ms*48
            self.joiner=AlignedOverlap(self.block,self.overlap48,self.search48,fixed=self.fixed_alignment)
        self.reset()

    def convert(self, audio):
        import torch
        started = time.perf_counter()
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        if len(audio) != self.block or not np.isfinite(audio).all():
            raise ValueError('80msの有限値の音声ブロックが必要です。')
        self.history[:-self.block] = self.history[self.block:]
        self.history[-self.block:] = apply_gain(audio, self.previous_input_gain, self.input_gain)
        self.previous_input_gain = self.input_gain
        with torch.inference_mode():
            source16 = self.down(torch.from_numpy(self.history)).numpy()
            result24 = self.model.infer(source16, shift=self.pitch, formant=self.formant,
                **({'excitation_state': self.excitation_state} if self.excitation_state is not None else {}))
            candidate24 = (self.block+self.overlap48+self.search48)//2
            stop = len(result24)-self.guard24
            start = stop-candidate24
            extended = result24[start-self.edge24:stop+self.edge24]
            candidate = self.up(torch.from_numpy(extended)).numpy()
            candidate = candidate[2*self.edge24:-2*self.edge24]
        output = apply_gain(self.joiner.join(candidate), self.previous_output_gain, self.output_gain)
        self.previous_output_gain = self.output_gain
        if not np.isfinite(output).all():
            raise RuntimeError('生成した音声に非有限値があります。')
        peak = float(np.max(np.abs(output)))
        rms = float(np.sqrt(np.mean(audio*audio)))
        self.stats = dict(ms=(time.perf_counter()-started)*1000, rms=rms, silent=rms<1e-5,
                          clip=int(peak>1.), peak=peak, alignment_ms=self.joiner.last_shift/48,
                          lookback_ms=self.guard24/24+(self.overlap48+self.search48-self.joiner.last_shift)/48)
        return np.clip(output, -1, 1)
