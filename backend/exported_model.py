"""Read the public Beatrice rc.0 FP16 export format without a plugin."""
import math
from pathlib import Path
import tomllib
from unittest.mock import patch

import numpy as np
import torch
from torch import nn
from backend import beatrice_model as m

BINARIES = ('phone_extractor.bin','pitch_estimator.bin','waveform_generator.bin',
            'speaker_embeddings.bin','embedding_setter.bin')


class ExportWSConv(m.WSConv1d):
    def standardized_weight(self):
        return self.weight


class ExportWSLinear(m.WSLinear):
    def standardized_weight(self):
        return self.weight


def freeze_export_weights(root):
    for layer in root.modules():
        if type(layer) is m.WSConv1d:layer.__class__=ExportWSConv
        elif type(layer) is m.WSLinear:layer.__class__=ExportWSLinear


def manifest_path(value):
    path = Path(value).expanduser()
    if path.suffix.lower()=='.bin':
        choices = list(path.parent.glob('*.toml'))
        if len(choices)!=1:
            raise ValueError('.binと同じフォルダのモデル.tomlを選んでください。')
        path = choices[0]
    if not path.is_file():
        raise ValueError(f'モデルが見つかりません: {path}')
    metadata = tomllib.loads(path.read_text(encoding='utf-8-sig'))
    if metadata.get('model',{}).get('version')!='2.0.0-rc.0':
        raise ValueError('対応するBeatrice形式は2.0.0-rc.0です。')
    voices = metadata.get('voice',{})
    if not voices or set(voices)!={str(i) for i in range(len(voices))}:
        raise ValueError('モデルの声IDが不正です。')
    missing=[name for name in BINARIES if not (path.parent/name).is_file()]
    if missing:
        raise ValueError('モデルのファイルが不足しています: '+', '.join(missing))
    return path, metadata


class Reader:
    def __init__(self, path):
        self.path=Path(path)
        data=self.path.read_bytes()
        if len(data)%2:
            raise ValueError(f'モデルのサイズが不正です: {self.path.name}')
        self.values=np.frombuffer(data,dtype='<f2')
        self.position=0

    def tensor(self, shape):
        size=math.prod(shape)
        end=self.position+size
        if end>len(self.values):
            raise ValueError(f'未対応のモデル構造または不完全なファイル: {self.path.name}')
        a=self.values[self.position:end].astype(np.float32).reshape(tuple(shape))
        self.position=end
        if not np.isfinite(a).all():
            raise ValueError(f'モデルに不正な値があります: {self.path.name}')
        return torch.from_numpy(a)

    def fill(self, target, **kwargs):
        if target is not None:
            target.data.copy_(self.tensor(target.shape))

    def finish(self):
        if self.position!=len(self.values):
            raise ValueError(f'未対応のモデル構造（余分なデータ）: {self.path.name}')

    def write(self, data):
        raise RuntimeError('A reader cannot write model data.')


def load_layer(layer, reader):
    if isinstance(layer,m.CrossAttention):
        scale=math.sqrt(math.sqrt(layer.head_qk_channels))
        layer.q_projection.weight.data.copy_(reader.tensor(layer.q_projection.weight.shape)*scale)
        layer.q_projection.bias.data.copy_(reader.tensor(layer.q_projection.bias.shape)*scale)
        load_layer(layer.out_projection,reader)
    elif isinstance(layer,nn.MultiheadAttention):
        e,h=layer.embed_dim,layer.num_heads
        w=reader.tensor((h,3,e//h,e)).transpose(0,1).reshape(3*e,e)
        b=reader.tensor((h,3,e//h)).transpose(0,1).reshape(3*e)
        scale=math.sqrt(math.sqrt(e//h))
        w[:2*e]*=scale;b[:2*e]*=scale
        layer.in_proj_weight.data.copy_(w);layer.in_proj_bias.data.copy_(b)
        load_layer(layer.out_proj,reader)
    elif hasattr(layer,'dump'):
        layer.dump(reader)
    elif isinstance(layer,(nn.Linear,nn.Conv1d,nn.LayerNorm)):
        reader.fill(layer.weight);reader.fill(layer.bias)
    elif isinstance(layer,nn.Embedding):
        reader.fill(layer.weight)
    elif isinstance(layer,nn.Parameter):
        reader.fill(layer)
    elif isinstance(layer,nn.ModuleList):
        for child in layer:load_layer(child,reader)
    else:
        raise ValueError(f'未対応のモデル層: {type(layer).__name__}')


def load_kv(attention, reader):
    h,q,v,c=attention.num_heads,attention.head_qk_channels,attention.head_vo_channels,attention.in_kv_channels
    keys,values=[],[]
    for _ in range(h):
        keys.append(reader.tensor((q,c)));values.append(reader.tensor((v,c)))
    biases_k,biases_v=[],[]
    for _ in range(h):
        biases_k.append(reader.tensor((q,)));biases_v.append(reader.tensor((v,)))
    scale=math.sqrt(math.sqrt(q))
    attention.kv_projection.weight.data.copy_(torch.cat([torch.cat(keys)*scale,torch.cat(values)]))
    attention.kv_projection.bias.data.copy_(torch.cat([torch.cat(biases_k)*scale,torch.cat(biases_v)]))


def load_exported(value):
    path, metadata=manifest_path(value)
    phone,pitch=m.PhoneExtractor(),m.PitchEstimator()
    net=m.ConverterNetwork(phone,pitch,len(metadata['voice']),448,256)
    phone.remove_weight_norm();phone.merge_weights();pitch.merge_weights();net.merge_weights()
    # Only the local exporter traversal is reused; no data is written. Its
    # attention reordering/scaling is explicitly inverted above.
    for filename, target in zip(BINARIES[:3],(phone,pitch,net)):
        reader=Reader(path.parent/filename)
        with patch.object(m,'dump_params',reader.fill),patch.object(m,'dump_layer',load_layer):
            load_layer(target,reader)
        reader.finish()
    reader=Reader(path.parent/BINARIES[3])
    reader.fill(net.vq.codebooks)
    for layer in (net.embed_speaker,net.embed_formant_shift,net.key_value_speaker_embedding):
        reader.fill(layer.weight)
    reader.finish()
    reader=Reader(path.parent/BINARIES[4])
    for block in net.vocoder.prenet.convnext:
        if block.use_mha:
            load_kv(block.mha,reader)
    reader.finish()
    # Exports already contain weight standardization and learned output scales.
    # Running WS normalization again would remove the folded vocoder scales.
    for root in (phone,pitch,net):
        freeze_export_weights(root)
    return phone,pitch,net,metadata
