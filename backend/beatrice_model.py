"""Beatrice 2 inference definitions, extracted without retraining.
Original: fierce-cats/beatrice-trainer, local source SHA256 f43fc6533d5e20dc5e1c48c30b4e5cacc470ebf5f1f6b37b9825f12711eee7b1.
MIT license: see BEATRICE_LICENSE.txt. Training-only imports and CLI initialization removed.
"""
import argparse
import gc
import gzip
import json
import math
import os
import shutil
import warnings
from collections import defaultdict
from contextlib import nullcontext
from copy import deepcopy
from fractions import Fraction
from functools import partial
from pathlib import Path
import sys
from pprint import pprint
from random import Random
from typing import BinaryIO, Literal, Optional, Union, Sequence, Iterable, Callable
import numpy as np
import torch
import torch.nn as nn
import torchaudio
from torch.nn import functional as F
from torch.nn.utils import remove_weight_norm, weight_norm
if not hasattr(torch.amp, 'GradScaler'):

    class GradScaler(torch.cuda.amp.GradScaler):

        def __init__(self, _, *args, **kwargs):
            super().__init__(*args, **kwargs)
    torch.amp.GradScaler = GradScaler
PARAPHERNALIA_VERSION = '2.0.0-rc.0'

def is_notebook() -> bool:
    return 'get_ipython' in globals()

def repo_root() -> Path:
    d = Path.cwd() / 'dummy' if is_notebook() else Path(__file__)
    assert d.is_absolute(), d
    for d in d.parents:
        if (d / '.git').is_dir():
            return d
    raise RuntimeError('Repository root is not found.')
dict_default_hparams = {'learning_rate_g': 5e-05, 'learning_rate_d': 5e-05, 'learning_rate_decay': 0.999999, 'adam_betas': [0.8, 0.99], 'adam_eps': 1e-06, 'batch_size': 8, 'grad_weight_loudness': 1.0, 'grad_weight_mel': 50.0, 'grad_weight_ap': 100.0, 'grad_weight_adv': 150.0, 'grad_weight_fm': 150.0, 'grad_balancer_ema_decay': 0.995, 'use_amp': True, 'num_workers': 16, 'n_steps': 10000, 'warmup_steps': 5000, 'evaluation_interval': 2000, 'save_interval': 2000, 'in_sample_rate': 16000, 'out_sample_rate': 24000, 'wav_length': 4 * 24000, 'segment_length': 100, 'phone_noise_ratio': 0.5, 'vq_topk': 4, 'training_time_vq': 'none', 'floor_noise_level': 0.001, 'record_metrics': False, 'augmentation_snr_candidates': [20.0, 25.0, 30.0, 35.0, 40.0, 45.0], 'augmentation_formant_shift_probability': 0.5, 'augmentation_formant_shift_semitone_min': -3.0, 'augmentation_formant_shift_semitone_max': 3.0, 'augmentation_reverb_probability': 0.5, 'augmentation_lpf_probability': 0.2, 'augmentation_lpf_cutoff_freq_candidates': [2000.0, 3000.0, 4000.0, 6000.0], 'phone_extractor_file': 'assets/pretrained/122_checkpoint_03000000.pt', 'pitch_estimator_file': 'assets/pretrained/104_3_checkpoint_00300000.pt', 'in_ir_wav_dir': 'assets/ir', 'in_noise_wav_dir': 'assets/noise', 'in_test_wav_dir': 'assets/test', 'pretrained_file': 'assets/pretrained/151_checkpoint_libritts_r_200_02750000.pt.gz', 'pitch_bins': 448, 'hidden_channels': 256, 'san': False, 'compile_convnext': False, 'compile_d4c': False, 'compile_discriminator': False, 'profile': False}

def prepare_training_configs_for_experiment() -> tuple[dict, Path, Path, bool, bool]:
    import ipynbname
    from IPython import get_ipython
    h = deepcopy(dict_default_hparams)
    in_wav_dataset_dir = repo_root() / '../../data/processed/libritts_r_200'
    try:
        notebook_name = ipynbname.name()
    except FileNotFoundError:
        notebook_name = Path(get_ipython().user_ns['__vsc_ipynb_file__']).name
    out_dir = repo_root() / 'notebooks' / notebook_name.split('.')[0].split('_')[0]
    resume = False
    skip_training = False
    return (h, in_wav_dataset_dir, out_dir, resume, skip_training)

def prepare_training_configs() -> tuple[dict, Path, Path, bool, bool]:
    parser = argparse.ArgumentParser()
    parser.add_argument('-d', '--data_dir', type=Path, help='directory containing the training data')
    parser.add_argument('-o', '--out_dir', type=Path, help='output directory')
    parser.add_argument('-r', '--resume', action='store_true', help='resume training')
    parser.add_argument('-c', '--config', type=Path, help='path to the config file')
    args = parser.parse_args()
    if args.config is None:
        h = deepcopy(dict_default_hparams)
    else:
        with open(args.config, encoding='utf-8') as f:
            h = json.load(f)
    for key in dict_default_hparams.keys():
        if key not in h:
            h[key] = dict_default_hparams[key]
            warnings.warn(f'{key} is not specified in the config file. Using the default value.')
    if args.data_dir is not None:
        in_wav_dataset_dir = args.data_dir
    elif 'data_dir' in h:
        in_wav_dataset_dir = repo_root() / Path(h['data_dir'])
        del h['data_dir']
    else:
        raise ValueError('data_dir must be specified. For example `python3 beatrice_trainer -d my_training_data_dir -o my_output_dir`.')
    if args.out_dir is not None:
        out_dir = args.out_dir
    elif 'out_dir' in h:
        out_dir = repo_root() / Path(h['out_dir'])
        del h['out_dir']
    else:
        raise ValueError('out_dir must be specified. For example `python3 beatrice_trainer -d my_training_data_dir -o my_output_dir`.')
    for key in list(h.keys()):
        if key not in dict_default_hparams:
            warnings.warn(f'`{key}` specified in the config file will be ignored.')
            del h[key]
    resume = args.resume
    return (h, in_wav_dataset_dir, out_dir, resume, False)

class AttrDict(dict):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.__dict__ = self

def dump_params(params: torch.Tensor, f: BinaryIO):
    if params is None:
        return
    if params.dtype == torch.bfloat16:
        f.write(params.detach().clone().float().view(torch.short).numpy().ravel()[1::2].tobytes())
    else:
        f.write(params.detach().numpy().ravel().tobytes())
    f.flush()

def dump_layer(layer: nn.Module, f: BinaryIO):
    dump = partial(dump_params, f=f)
    if hasattr(layer, 'dump'):
        layer.dump(f)
    elif isinstance(layer, (nn.Linear, nn.Conv1d, nn.LayerNorm)):
        dump(layer.weight)
        dump(layer.bias)
    elif isinstance(layer, nn.MultiheadAttention):
        embed_dim = layer.embed_dim
        num_heads = layer.num_heads
        in_proj_weight = layer.in_proj_weight.data.clone()
        in_proj_weight[:2 * embed_dim] *= 1.0 / math.sqrt(math.sqrt(embed_dim // num_heads))
        in_proj_weight = in_proj_weight.view(3, num_heads, embed_dim // num_heads, embed_dim)
        in_proj_weight = in_proj_weight.transpose(0, 1)
        in_proj_bias = layer.in_proj_bias.data.clone()
        in_proj_bias[:2 * embed_dim] *= 1.0 / math.sqrt(math.sqrt(embed_dim // num_heads))
        in_proj_bias = in_proj_bias.view(3, num_heads, embed_dim // num_heads)
        in_proj_bias = in_proj_bias.transpose(0, 1)
        dump(in_proj_weight)
        dump(in_proj_bias)
        dump(layer.out_proj.weight)
        dump(layer.out_proj.bias)
    elif isinstance(layer, nn.Embedding):
        dump(layer.weight)
    elif isinstance(layer, nn.Parameter):
        dump(layer)
    elif isinstance(layer, nn.ModuleList):
        for layer_i in layer:
            dump_layer(layer_i, f)
    else:
        assert False, layer

class CausalConv1d(nn.Conv1d):

    def __init__(self, in_channels: int, out_channels: int, kernel_size: int, stride: int=1, dilation: int=1, groups: int=1, bias: bool=True, delay: int=0):
        padding = (kernel_size - 1) * dilation - delay
        self.trim = (kernel_size - 1) * dilation - 2 * delay
        if self.trim < 0:
            raise ValueError
        super().__init__(in_channels, out_channels, kernel_size=kernel_size, stride=stride, padding=padding, dilation=dilation, groups=groups, bias=bias)

    def forward(self, input: torch.Tensor) -> torch.Tensor:
        result = super().forward(input)
        if self.trim == 0:
            return result
        else:
            return result[:, :, :-self.trim]

class WSConv1d(CausalConv1d):

    def __init__(self, in_channels: int, out_channels: int, kernel_size: int, stride: int=1, dilation: int=1, groups: int=1, bias: bool=True, delay: int=0):
        super().__init__(in_channels, out_channels, kernel_size=kernel_size, stride=stride, dilation=dilation, groups=groups, bias=bias, delay=delay)
        self.weight.data.normal_(0.0, math.sqrt(1.0 / (in_channels * kernel_size // groups)))
        if bias:
            self.bias.data.zero_()
        self.gain = nn.Parameter(torch.ones((out_channels, 1, 1)))

    def standardized_weight(self) -> torch.Tensor:
        var, mean = torch.var_mean(self.weight, [1, 2], keepdim=True)
        scale = self.gain * (self.in_channels * self.kernel_size[0] // self.groups * var + 1e-08).rsqrt()
        return scale * (self.weight - mean)

    def forward(self, input: torch.Tensor) -> torch.Tensor:
        result = F.conv1d(input, self.standardized_weight(), self.bias, self.stride, self.padding, self.dilation, self.groups)
        if self.trim == 0:
            return result
        else:
            return result[:, :, :-self.trim]

    def merge_weights(self):
        self.weight.data[:] = self.standardized_weight().detach()
        self.gain.data.fill_(1.0)

class WSLinear(nn.Linear):

    def __init__(self, in_features: int, out_features: int, bias: bool=True):
        super().__init__(in_features, out_features, bias)
        self.weight.data.normal_(0.0, math.sqrt(1.0 / in_features))
        self.bias.data.zero_()
        self.gain = nn.Parameter(torch.ones((out_features, 1)))

    def standardized_weight(self) -> torch.Tensor:
        var, mean = torch.var_mean(self.weight, 1, keepdim=True)
        scale = self.gain * (self.in_features * var + 1e-08).rsqrt()
        return scale * (self.weight - mean)

    def forward(self, input: torch.Tensor) -> torch.Tensor:
        return F.linear(input, self.standardized_weight(), self.bias)

    def merge_weights(self):
        self.weight.data[:] = self.standardized_weight().detach()
        self.gain.data.fill_(1.0)

class CrossAttention(nn.Module):

    def __init__(self, qk_channels: int, vo_channels: int, num_heads: int, in_q_channels: int, in_kv_channels: int, out_channels: int, dropout: float=0.0):
        super().__init__()
        assert qk_channels % num_heads == 0
        self.qk_channels = qk_channels
        self.vo_channels = vo_channels
        self.num_heads = num_heads
        self.in_q_channels = in_q_channels
        self.in_kv_channels = in_kv_channels
        self.out_channels = out_channels
        self.dropout = dropout
        self.head_qk_channels = qk_channels // num_heads
        self.head_vo_channels = vo_channels // num_heads
        self.q_projection = nn.Linear(in_q_channels, qk_channels)
        self.q_projection.weight.data.normal_(0.0, math.sqrt(1.0 / in_q_channels))
        self.q_projection.bias.data.zero_()
        self.kv_projection = nn.Linear(in_kv_channels, qk_channels + vo_channels)
        self.kv_projection.weight.data.normal_(0.0, math.sqrt(1.0 / in_kv_channels))
        self.kv_projection.bias.data.zero_()
        self.out_projection = nn.Linear(vo_channels, out_channels)
        self.out_projection.weight.data.normal_(0.0, math.sqrt(1.0 / vo_channels))
        self.out_projection.bias.data.zero_()

    def forward(self, q: torch.Tensor, kv: torch.Tensor) -> torch.Tensor:
        batch_size, q_length, _ = q.size()
        _, kv_length, _ = kv.size()
        q = self.q_projection(q)
        kv = self.kv_projection(kv)
        k, v = kv.split([self.qk_channels, self.vo_channels], dim=2)
        q = q.view(batch_size, q_length, self.num_heads, self.head_qk_channels).transpose(1, 2)
        k = k.view(batch_size, kv_length, self.num_heads, self.head_qk_channels).transpose(1, 2)
        v = v.view(batch_size, kv_length, self.num_heads, self.head_vo_channels).transpose(1, 2)
        attn_out = F.scaled_dot_product_attention(q, k, v, dropout_p=(self.dropout if self.training else 0.0))
        attn_out = attn_out.transpose(1, 2).contiguous().view(batch_size, q_length, self.vo_channels)
        attn_out = self.out_projection(attn_out)
        return attn_out

    def dump(self, f: Union[BinaryIO, str, bytes, os.PathLike]):
        if isinstance(f, (str, bytes, os.PathLike)):
            with open(f, 'wb') as f:
                self.dump(f)
            return
        if not hasattr(f, 'write'):
            raise TypeError
        q_projection_weight = self.q_projection.weight.data.clone()
        q_projection_bias = self.q_projection.bias.data.clone()
        q_projection_weight *= 1.0 / math.sqrt(math.sqrt(self.head_qk_channels))
        q_projection_bias *= 1.0 / math.sqrt(math.sqrt(self.head_qk_channels))
        dump_params(q_projection_weight, f)
        dump_params(q_projection_bias, f)
        dump_layer(self.out_projection, f)

    def dump_kv(self, f: Union[BinaryIO, str, bytes, os.PathLike]):
        if isinstance(f, (str, bytes, os.PathLike)):
            with open(f, 'wb') as f:
                self.dump_kv(f)
            return
        if not hasattr(f, 'write'):
            raise TypeError
        kv_projection_weight = self.kv_projection.weight.data.clone()
        kv_projection_bias = self.kv_projection.bias.data.clone()
        k_projection_weight, v_projection_weight = kv_projection_weight.split([self.qk_channels, self.vo_channels])
        k_projection_bias, v_projection_bias = kv_projection_bias.split([self.qk_channels, self.vo_channels])
        k_projection_weight *= 1.0 / math.sqrt(math.sqrt(self.head_qk_channels))
        k_projection_bias *= 1.0 / math.sqrt(math.sqrt(self.head_qk_channels))
        k_projection_weight = k_projection_weight.view(self.num_heads, self.head_qk_channels, self.in_kv_channels)
        k_projection_bias = k_projection_bias.view(self.num_heads, self.head_qk_channels)
        v_projection_weight = v_projection_weight.view(self.num_heads, self.head_vo_channels, self.in_kv_channels)
        v_projection_bias = v_projection_bias.view(self.num_heads, self.head_vo_channels)
        for i in range(self.num_heads):
            dump_params(k_projection_weight[i], f)
            dump_params(v_projection_weight[i], f)
        for i in range(self.num_heads):
            dump_params(k_projection_bias[i], f)
            dump_params(v_projection_bias[i], f)

class ConvNeXtBlock(nn.Module):

    def __init__(self, channels: int, intermediate_channels: int, layer_scale_init_value: float, kernel_size: int=7, use_weight_standardization: bool=False, enable_scaling: bool=False, pre_scale: float=1.0, post_scale: float=1.0, use_mha: bool=False, cross_attention: bool=False, num_heads: int=4, attention_dropout: float=0.1, attention_channels: Optional[int]=None, kv_channels: Optional[int]=None):
        super().__init__()
        self.use_weight_standardization = use_weight_standardization
        self.enable_scaling = enable_scaling
        self.use_mha = use_mha
        self.cross_attention = cross_attention
        if use_mha:
            self.attn_norm = nn.LayerNorm(channels)
            if cross_attention:
                self.mha = CrossAttention(qk_channels=attention_channels, vo_channels=attention_channels, num_heads=num_heads, in_q_channels=channels, in_kv_channels=kv_channels, out_channels=channels, dropout=attention_dropout)
            else:
                assert attention_channels is None
                assert kv_channels is None
                self.mha = nn.MultiheadAttention(embed_dim=channels, num_heads=num_heads, dropout=attention_dropout, batch_first=True)
        self.dwconv = CausalConv1d(channels, channels, kernel_size=kernel_size, groups=channels)
        self.norm = nn.LayerNorm(channels)
        self.pwconv1 = nn.Linear(channels, intermediate_channels)
        self.pwconv2 = nn.Linear(intermediate_channels, channels)
        self.gamma = nn.Parameter(torch.full((channels,), layer_scale_init_value))
        self.dwconv.weight.data.normal_(0.0, math.sqrt(1.0 / kernel_size))
        self.dwconv.bias.data.zero_()
        self.pwconv1.weight.data.normal_(0.0, math.sqrt(2.0 / channels))
        self.pwconv1.bias.data.zero_()
        self.pwconv2.weight.data.normal_(0.0, math.sqrt(1.0 / intermediate_channels))
        self.pwconv2.bias.data.zero_()
        if use_weight_standardization:
            self.norm = nn.Identity()
            self.dwconv = WSConv1d(channels, channels, kernel_size, groups=channels)
            self.pwconv1 = WSLinear(channels, intermediate_channels)
            self.pwconv2 = WSLinear(intermediate_channels, channels)
            del self.gamma
        if enable_scaling:
            self.register_buffer('pre_scale', torch.tensor(pre_scale))
            self.register_buffer('post_scale', torch.tensor(post_scale))
            self.post_scale_weight = nn.Parameter(torch.ones(()))

    def forward(self, x: torch.Tensor, attn_mask: Optional[torch.Tensor]=None, kv: Optional[torch.Tensor]=None) -> torch.Tensor:
        if self.use_mha:
            batch_size, channels, length = x.size()
            if self.cross_attention:
                assert kv is not None
            else:
                assert kv is None
                assert length % 4 == 0
            identity = x
            if self.cross_attention:
                x = x.transpose(1, 2)
                x = self.attn_norm(x)
                x = self.mha(x, kv)
                x = x.transpose(1, 2)
            else:
                x = x.view(batch_size, channels, length // 4, 4)
                x = x.permute(0, 3, 2, 1)
                x = x.reshape(batch_size * 4, length // 4, channels)
                x = self.attn_norm(x)
                x, _ = self.mha(x, x, x, attn_mask=attn_mask, is_causal=True, need_weights=False)
                x = x.view(batch_size, 4, length // 4, channels)
                x = x.permute(0, 3, 2, 1)
                x = x.reshape(batch_size, channels, length)
            x += identity
        identity = x
        if self.enable_scaling:
            x = x * self.pre_scale
        x = self.dwconv(x)
        x = x.transpose(1, 2)
        x = self.norm(x)
        x = self.pwconv1(x)
        x = F.gelu(x, approximate='tanh')
        x = self.pwconv2(x)
        if not self.use_weight_standardization:
            x *= self.gamma
        if self.enable_scaling:
            x *= self.post_scale * self.post_scale_weight
        x = x.transpose(1, 2)
        x += identity
        return x

    def merge_weights(self):
        if self.use_mha:
            if self.cross_attention:
                assert isinstance(self.mha, CrossAttention)
                self.mha.q_projection.bias.data += torch.mv(self.mha.q_projection.weight.data, self.attn_norm.bias.data)
                self.mha.q_projection.weight.data *= self.attn_norm.weight.data[None, :]
                self.attn_norm.bias.data[:] = 0.0
                self.attn_norm.weight.data[:] = 1.0
            else:
                assert isinstance(self.mha, nn.MultiheadAttention)
                self.mha.in_proj_bias.data += torch.mv(self.mha.in_proj_weight.data, self.attn_norm.bias.data)
                self.mha.in_proj_weight.data *= self.attn_norm.weight.data[None, :]
                self.attn_norm.bias.data[:] = 0.0
                self.attn_norm.weight.data[:] = 1.0
        if self.use_weight_standardization:
            self.dwconv.merge_weights()
            self.pwconv1.merge_weights()
            self.pwconv2.merge_weights()
        else:
            self.pwconv1.bias.data += torch.mv(self.pwconv1.weight.data, self.norm.bias.data)
            self.pwconv1.weight.data *= self.norm.weight.data[None, :]
            self.norm.bias.data[:] = 0.0
            self.norm.weight.data[:] = 1.0
            self.pwconv2.weight.data *= self.gamma.data[:, None]
            self.pwconv2.bias.data *= self.gamma.data
            self.gamma.data[:] = 1.0
        if self.enable_scaling:
            self.dwconv.weight.data *= self.pre_scale.data
            self.pre_scale.data.fill_(1.0)
            self.pwconv2.weight.data *= self.post_scale.data * self.post_scale_weight.data
            self.pwconv2.bias.data *= self.post_scale.data * self.post_scale_weight.data
            self.post_scale.data.fill_(1.0)
            self.post_scale_weight.data.fill_(1.0)

    def dump(self, f: Union[BinaryIO, str, bytes, os.PathLike]):
        if isinstance(f, (str, bytes, os.PathLike)):
            with open(f, 'wb') as f:
                self.dump(f)
            return
        if not hasattr(f, 'write'):
            raise TypeError
        if self.use_mha:
            dump_layer(self.mha, f)
        dump_layer(self.dwconv, f)
        dump_layer(self.pwconv1, f)
        dump_layer(self.pwconv2, f)

class ConvNeXtStack(nn.Module):

    def __init__(self, in_channels: int, channels: int, intermediate_channels: int, n_blocks: int, delay: int, embed_kernel_size: int, kernel_size: int, use_weight_standardization: bool=False, enable_scaling: bool=False, use_mha: bool=False, cross_attention: bool=False, kv_channels: Optional[int]=None):
        super().__init__()
        assert delay * 2 + 1 <= embed_kernel_size
        assert not (use_weight_standardization and use_mha)
        self.use_weight_standardization = use_weight_standardization
        self.use_mha = use_mha
        self.cross_attention = cross_attention
        self.embed = CausalConv1d(in_channels, channels, embed_kernel_size, delay=delay)
        self.norm = nn.LayerNorm(channels)
        self.convnext = nn.ModuleList()
        for i in range(n_blocks):
            pre_scale = 1.0 / math.sqrt(1.0 + i / n_blocks) if enable_scaling else 1.0
            post_scale = 1.0 / math.sqrt(n_blocks) if enable_scaling else 1.0
            block = ConvNeXtBlock(channels=channels, intermediate_channels=intermediate_channels, layer_scale_init_value=1.0 / n_blocks, kernel_size=kernel_size, use_weight_standardization=use_weight_standardization, enable_scaling=enable_scaling, pre_scale=pre_scale, post_scale=post_scale, use_mha=use_mha, cross_attention=cross_attention, num_heads=4, attention_dropout=0.1, attention_channels=kv_channels, kv_channels=kv_channels)
            self.convnext.append(block)
        self.final_layer_norm = nn.LayerNorm(channels)
        self.embed.weight.data.normal_(0.0, math.sqrt(0.5 / (embed_kernel_size * in_channels)))
        self.embed.bias.data.zero_()
        if use_weight_standardization:
            self.embed = WSConv1d(in_channels, channels, embed_kernel_size, delay=delay)
            self.norm = nn.Identity()
            self.final_layer_norm = nn.Identity()

    def forward(self, x: torch.Tensor, kv: Optional[torch.Tensor]=None) -> torch.Tensor:
        x = self.embed(x)
        x = self.norm(x.transpose(1, 2)).transpose(1, 2)
        if self.use_mha and (not self.cross_attention):
            pad_length = -x.size(2) % 4
            if pad_length:
                x = F.pad(x, (0, pad_length))
            t40 = x.size(2) // 4
            attn_mask = torch.ones((t40, t40), dtype=torch.bool, device=x.device).triu(1)
        else:
            attn_mask = None
        for conv_block in self.convnext:
            x = conv_block(x, attn_mask=attn_mask, kv=kv)
        if self.use_mha and (not self.cross_attention) and pad_length:
            x = x[:, :, :-pad_length]
        x = self.final_layer_norm(x.transpose(1, 2)).transpose(1, 2)
        return x

    def merge_weights(self):
        if self.use_weight_standardization:
            self.embed.merge_weights()
        for conv_block in self.convnext:
            conv_block.merge_weights()

    def dump(self, f: Union[BinaryIO, str, bytes, os.PathLike]):
        if isinstance(f, (str, bytes, os.PathLike)):
            with open(f, 'wb') as f:
                self.dump(f)
            return
        if not hasattr(f, 'write'):
            raise TypeError
        dump_layer(self.embed, f)
        if not self.use_weight_standardization:
            dump_layer(self.norm, f)
        dump_layer(self.convnext, f)
        if not self.use_weight_standardization:
            dump_layer(self.final_layer_norm, f)

    def dump_kv(self, f: Union[BinaryIO, str, bytes, os.PathLike]):
        if isinstance(f, (str, bytes, os.PathLike)):
            with open(f, 'wb') as f:
                self.dump_kv(f)
            return
        if not hasattr(f, 'write'):
            raise TypeError
        assert self.use_mha and self.cross_attention
        for conv_block in self.convnext:
            if not conv_block.use_mha or not conv_block.cross_attention:
                continue
            assert isinstance(conv_block, ConvNeXtBlock)
            assert hasattr(conv_block, 'mha')
            assert isinstance(conv_block.mha, CrossAttention)
            conv_block.mha.dump_kv(f)

class FeatureExtractor(nn.Module):

    def __init__(self, hidden_channels: int):
        super().__init__()
        self.conv0 = weight_norm(nn.Conv1d(1, hidden_channels // 8, 10, 5, bias=False))
        self.conv1 = weight_norm(nn.Conv1d(hidden_channels // 8, hidden_channels // 4, 3, 2, bias=False))
        self.conv2 = weight_norm(nn.Conv1d(hidden_channels // 4, hidden_channels // 2, 3, 2, bias=False))
        self.conv3 = weight_norm(nn.Conv1d(hidden_channels // 2, hidden_channels, 3, 2, bias=False))
        self.conv4 = weight_norm(nn.Conv1d(hidden_channels, hidden_channels, 3, 2, bias=False))
        self.conv5 = weight_norm(nn.Conv1d(hidden_channels, hidden_channels, 2, 2, bias=False))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        wav_length = x.size(2)
        if wav_length % 160 != 0:
            warnings.warn('wav_length % 160 != 0')
        x = F.pad(x, (40, 40))
        x = F.gelu(self.conv0(x), approximate='tanh')
        x = F.gelu(self.conv1(x), approximate='tanh')
        x = F.gelu(self.conv2(x), approximate='tanh')
        x = F.gelu(self.conv3(x), approximate='tanh')
        x = F.gelu(self.conv4(x), approximate='tanh')
        x = F.gelu(self.conv5(x), approximate='tanh')
        return x

    def remove_weight_norm(self):
        remove_weight_norm(self.conv0)
        remove_weight_norm(self.conv1)
        remove_weight_norm(self.conv2)
        remove_weight_norm(self.conv3)
        remove_weight_norm(self.conv4)
        remove_weight_norm(self.conv5)

    def dump(self, f: Union[BinaryIO, str, bytes, os.PathLike]):
        if isinstance(f, (str, bytes, os.PathLike)):
            with open(f, 'wb') as f:
                self.dump(f)
            return
        if not hasattr(f, 'write'):
            raise TypeError
        dump_layer(self.conv0, f)
        dump_layer(self.conv1, f)
        dump_layer(self.conv2, f)
        dump_layer(self.conv3, f)
        dump_layer(self.conv4, f)
        dump_layer(self.conv5, f)

class FeatureProjection(nn.Module):

    def __init__(self, channels: int):
        super().__init__()
        self.norm = nn.LayerNorm(channels)
        self.dropout = nn.Dropout(0.1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.norm(x.transpose(1, 2)).transpose(1, 2)
        x = self.dropout(x)
        return x

class PhoneExtractor(nn.Module):

    def __init__(self, phone_channels: int=128, hidden_channels: int=128, backbone_embed_kernel_size: int=9, kernel_size: int=17, n_blocks: int=20):
        super().__init__()
        self.feature_extractor = FeatureExtractor(hidden_channels)
        self.feature_projection = FeatureProjection(hidden_channels)
        self.backbone = ConvNeXtStack(in_channels=hidden_channels, channels=hidden_channels, intermediate_channels=hidden_channels * 3, n_blocks=n_blocks, delay=0, embed_kernel_size=backbone_embed_kernel_size, kernel_size=kernel_size, use_mha=True)
        self.head = weight_norm(nn.Conv1d(hidden_channels, phone_channels, 1))

    def forward(self, x: torch.Tensor, return_stats: bool=True) -> Union[torch.Tensor, tuple[torch.Tensor, dict[str, float]]]:
        stats = {}
        x = self.feature_extractor(x)
        if return_stats:
            stats['feature_norm'] = x.detach().norm(dim=1).mean()
        x = self.feature_projection(x)
        x = self.backbone(x)
        phone = self.head(F.gelu(x, approximate='tanh'))
        results = [phone]
        if return_stats:
            stats['code_norm'] = phone.detach().norm(dim=1).mean()
            results.append(stats)
        if len(results) == 1:
            return results[0]
        return tuple(results)

    @torch.inference_mode()
    def units(self, x: torch.Tensor) -> torch.Tensor:
        phone = self.forward(x, return_stats=False)
        phone = phone.transpose(1, 2)
        return phone

    def remove_weight_norm(self):
        self.feature_extractor.remove_weight_norm()
        remove_weight_norm(self.head)

    def merge_weights(self):
        self.backbone.merge_weights()
        self.backbone.embed.bias.data += (self.feature_projection.norm.bias.data[None, :, None] * self.backbone.embed.weight.data).sum(1).sum(1)
        self.backbone.embed.weight.data *= self.feature_projection.norm.weight.data[None, :, None]
        self.feature_projection.norm.bias.data[:] = 0.0
        self.feature_projection.norm.weight.data[:] = 1.0

    def dump(self, f: Union[BinaryIO, str, bytes, os.PathLike]):
        if isinstance(f, (str, bytes, os.PathLike)):
            with open(f, 'wb') as f:
                self.dump(f)
            return
        if not hasattr(f, 'write'):
            raise TypeError
        dump_layer(self.feature_extractor, f)
        dump_layer(self.backbone, f)
        dump_layer(self.head, f)

class VectorQuantizer(nn.Module):

    def __init__(self, n_speakers: int, codebook_size: int, channels: int, topk: int=4, training_time_vq: Literal['none', 'self', 'random']='none'):
        super().__init__()
        assert 1 <= topk <= codebook_size
        self.n_speakers = n_speakers
        self.codebook_size = codebook_size
        self.channels = channels
        self.topk = topk
        self.training_time_vq = training_time_vq
        self.register_buffer('codebooks', torch.empty(n_speakers, codebook_size, channels, dtype=torch.half))
        self.codebooks: torch.Tensor
        self._hook_handle: Optional[torch.utils.hooks.RemovableHandle] = None
        self.target_speaker_ids: Optional[torch.Tensor] = None

        def _hook(_, __, output):
            return self(output, self.target_speaker_ids)
        self._hook_fn = _hook

    @torch.no_grad()
    def build_codebooks(self, collector_func: Callable, target_layer: nn.Module, inputs: Sequence[Iterable[torch.Tensor]], kmeans_n_iters: int=50):
        assert len(inputs) == self.n_speakers
        assert self._hook_handle is None, 'hook already installed'
        device = next(self.buffers()).device
        for spk_id, inps in enumerate(inputs):
            activations: list[torch.Tensor] = []

            def _collect(_, __, output):
                activations.append(output.detach())
            handle = target_layer.register_forward_hook(_collect)
            for x in inps:
                collector_func(x.to(device))
            handle.remove()
            if not activations:
                raise RuntimeError(f'No activation collected for speaker {spk_id}')
            activations: torch.Tensor = torch.cat([a.transpose(1, 2).reshape(a.size(0) * a.size(2), self.channels) for a in activations])
            activations = activations.float()
            activations = F.normalize(activations, dim=1, eps=1e-06)
            centers = self._kmeans_plus_plus(activations, self.codebook_size, kmeans_n_iters) if activations.size(0) >= self.codebook_size else self._pad_replicate(activations, self.codebook_size)
            self.codebooks[spk_id] = centers.to(self.codebooks.dtype)

    def forward(self, x: torch.Tensor, speaker_ids: Optional[torch.Tensor]=None) -> torch.Tensor:
        batch_size, channels, length = x.size()
        assert channels == self.channels
        device = x.device
        dtype = x.dtype
        if self.training:
            if self.training_time_vq == 'none':
                return x
            elif self.training_time_vq == 'self':
                if self.target_speaker_ids is None:
                    raise ValueError('target_speaker_ids is not set')
            elif self.training_time_vq == 'random':
                speaker_ids = torch.randint(0, self.n_speakers, (batch_size,), device=device)
            else:
                raise ValueError(f'Unknown training_time_vq: {self.training_time_vq}')
        else:
            if speaker_ids is None:
                return x
            speaker_ids = speaker_ids.to(device)
        q = F.normalize(x, dim=1, eps=1e-06)
        codes = self.codebooks[speaker_ids].to(q.dtype)
        sim = torch.einsum('bcl,bkc->blk', q, codes)
        _, topk_idx = sim.topk(self.topk, dim=-1)
        expanded_codes = codes[:, None, :, :].expand(-1, length, -1, -1)
        expanded_topk_idx = topk_idx[:, :, :, None].expand(-1, -1, -1, channels)
        gathered = expanded_codes.gather(2, expanded_topk_idx)
        gathered = gathered.mean(2)
        return gathered.transpose(1, 2).to(dtype)

    def enable_hook(self, target_layer: nn.Module):
        if self._hook_handle is not None:
            raise RuntimeError('hook already installed')
        self._hook_handle = target_layer.register_forward_hook(self._hook_fn)

    def disable_hook(self):
        if self._hook_handle is None:
            raise RuntimeError('hook not installed')
        self._hook_handle.remove()
        self._hook_handle = None

    def set_target_speaker_ids(self, speaker_ids: Optional[torch.Tensor]):
        self.target_speaker_ids = speaker_ids

    @staticmethod
    def _pad_replicate(x: torch.Tensor, n: int) -> torch.Tensor:
        idx = torch.arange(n, device=x.device) % x.size(0)
        return x[idx]

    @staticmethod
    def _kmeans_plus_plus(x: torch.Tensor, n_clusters: int, n_iters: int=50) -> torch.Tensor:
        n_data, _ = x.size()
        center_indices = [torch.randint(0, n_data, ()).item()]
        min_distances = torch.full((n_data,), math.inf, device=x.device)
        for _ in range(1, n_clusters):
            last_center_index = center_indices[-1]
            min_distances = min_distances.minimum(torch.cdist(x, x[last_center_index:last_center_index + 1]).float().square_().squeeze_(1))
            probs = min_distances / (min_distances.sum() + 1e-12)
            center_indices.append(torch.multinomial(probs, 1).item())
        centers = x[center_indices]
        del min_distances, probs
        for _ in range(n_iters):
            distances = torch.cdist(x, centers)
            labels = distances.argmin(1)
            new_centers = torch.zeros_like(centers).index_add_(0, labels, x)
            counts = labels.bincount(minlength=n_clusters)
            if (counts == 0).sum().item() != 0:
                warnings.warn('Some clusters have no assigned data points.')
            new_centers /= counts[:, None].clamp_(min=1).float()
            centers = new_centers
        return centers

def extract_pitch_features(y: torch.Tensor, hop_length: int=160, win_length: int=560, max_corr_period: int=256, corr_win_length: int=304, instfreq_features_cutoff_bin: int=64) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    assert max_corr_period + corr_win_length == win_length
    padding_length = (win_length - hop_length) // 2
    y = F.pad(y, (padding_length, padding_length))
    y_frames = y.unfold(-1, win_length, hop_length).transpose_(-2, -1)
    spec: torch.Tensor = torch.fft.rfft(y_frames, n=win_length, dim=-2)
    spec = spec[..., :instfreq_features_cutoff_bin, :]
    log_power_spec = spec.abs().add_(1e-05).log10_()
    delta_spec = spec[..., :, 1:] * spec[..., :, :-1].conj()
    delta_spec /= delta_spec.abs().add_(1e-05)
    delta_spec = torch.cat([torch.zeros_like(delta_spec[..., :, :1]), delta_spec], dim=-1)
    instfreq_features = torch.cat([log_power_spec, delta_spec.real, delta_spec.imag], dim=-2)
    flipped_y_frames = y_frames.flip((-2,))
    a = torch.fft.rfft(flipped_y_frames, n=win_length, dim=-2)
    b = torch.fft.rfft(y_frames[..., -corr_win_length:, :], n=win_length, dim=-2)
    corr = torch.fft.irfft(a * b, n=win_length, dim=-2)[..., corr_win_length:, :]
    energy = flipped_y_frames.square_().cumsum_(-2)
    energy0 = energy[..., corr_win_length - 1:corr_win_length, :]
    energy = energy[..., corr_win_length:, :] - energy[..., :-corr_win_length, :]
    corr_diff = (energy0 + energy).sub_(corr.mul_(2.0))
    assert corr_diff.min() >= -0.001, corr_diff.min()
    corr_diff.clamp_(min=0.0)
    corr_diff *= 2.0 / corr_win_length
    corr_diff.sqrt_()
    energy = (y_frames * torch.signal.windows.cosine(win_length, device=y.device)[..., None]).square_().sum(-2, keepdim=True)
    energy.clamp_(min=0.001).log10_()
    energy *= 0.5
    return (instfreq_features, corr_diff, energy)

class PitchEstimator(nn.Module):

    def __init__(self, input_instfreq_channels: int=192, input_corr_channels: int=256, pitch_bins: int=448, channels: int=192, intermediate_channels: int=192 * 2, n_blocks: int=9, delay: int=1, embed_kernel_size: int=3, kernel_size: int=33, pitch_bins_per_octave: int=96):
        super().__init__()
        self.pitch_bins_per_octave = pitch_bins_per_octave
        self.instfreq_embed_0 = nn.Conv1d(input_instfreq_channels, channels, 1)
        self.instfreq_embed_1 = nn.Conv1d(channels, channels, 1)
        self.corr_embed_0 = nn.Conv1d(input_corr_channels, channels, 1)
        self.corr_embed_1 = nn.Conv1d(channels, channels, 1)
        self.backbone = ConvNeXtStack(channels, channels, intermediate_channels, n_blocks, delay, embed_kernel_size, kernel_size, enable_scaling=True)
        self.head = nn.Conv1d(channels, pitch_bins, 1)

    def forward(self, wav: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        with torch.amp.autocast('cuda', enabled=False):
            instfreq_features, corr_diff, energy = extract_pitch_features(wav.squeeze(1), hop_length=160, win_length=560, max_corr_period=256, corr_win_length=304, instfreq_features_cutoff_bin=64)
        instfreq_features = F.gelu(self.instfreq_embed_0(instfreq_features), approximate='tanh')
        instfreq_features = self.instfreq_embed_1(instfreq_features)
        corr_diff = F.gelu(self.corr_embed_0(corr_diff), approximate='tanh')
        corr_diff = self.corr_embed_1(corr_diff)
        x = F.gelu(instfreq_features + corr_diff, approximate='tanh')
        x = self.backbone(x)
        x = self.head(x)
        return (x, energy)

    def sample_pitch(self, pitch: torch.Tensor, band_width: int=4, return_features: bool=False) -> Union[torch.Tensor, tuple[torch.Tensor, torch.Tensor]]:
        batch_size, pitch_bins, length = pitch.size()
        pitch = pitch.softmax(1)
        if return_features:
            unvoiced_proba = pitch[:, :1, :].clone()
        pitch[:, 0, :] = -100.0
        pitch = pitch.transpose(1, 2).contiguous().view(batch_size * length, 1, pitch_bins)
        band_pitch = F.conv1d(pitch, torch.ones((1, 1, 1), device=pitch.device).expand(1, 1, band_width))
        quantized_band_pitch = band_pitch.argmax(2)
        if return_features:
            band_proba = band_pitch.gather(2, quantized_band_pitch[:, :, None])
            half_pitch_band_proba = band_pitch.gather(2, (quantized_band_pitch - self.pitch_bins_per_octave).clamp_(min=1)[:, :, None])
            half_pitch_band_proba[quantized_band_pitch <= self.pitch_bins_per_octave] = 0.0
            half_pitch_proba = (half_pitch_band_proba / (band_proba + 1e-06)).view(batch_size, 1, length)
            double_pitch_band_proba = band_pitch.gather(2, (quantized_band_pitch + self.pitch_bins_per_octave).clamp_(max=pitch_bins - band_width)[:, :, None])
            double_pitch_band_proba[quantized_band_pitch > pitch_bins - band_width - self.pitch_bins_per_octave] = 0.0
            double_pitch_proba = (double_pitch_band_proba / (band_proba + 1e-06)).view(batch_size, 1, length)
        mask = torch.arange(pitch_bins, device=pitch.device)[None, :]
        mask = (quantized_band_pitch <= mask) & (mask < quantized_band_pitch + band_width)
        quantized_pitch = (pitch.squeeze(1) * mask).argmax(1).view(batch_size, length)
        if return_features:
            features = torch.cat([unvoiced_proba, half_pitch_proba, double_pitch_proba], dim=1)
            return (quantized_pitch, features)
        else:
            return quantized_pitch

    def merge_weights(self):
        self.backbone.merge_weights()

    def dump(self, f: Union[BinaryIO, str, bytes, os.PathLike]):
        if isinstance(f, (str, bytes, os.PathLike)):
            with open(f, 'wb') as f:
                self.dump(f)
            return
        if not hasattr(f, 'write'):
            raise TypeError
        dump_layer(self.instfreq_embed_0, f)
        dump_layer(self.instfreq_embed_1, f)
        dump_layer(self.corr_embed_0, f)
        dump_layer(self.corr_embed_1, f)
        dump_layer(self.backbone, f)
        dump_layer(self.head, f)

def overlap_add(ir_amp: torch.Tensor, ir_phase: torch.Tensor, window: torch.Tensor, pitch: torch.Tensor, hop_length: int=240, delay: int=0, sr: float=24000.0) -> torch.Tensor:
    batch_size, ir_length, length = ir_amp.size()
    ir_length = (ir_length - 1) * 2
    assert ir_phase.size() == ir_amp.size()
    assert window.size() == (ir_length,), (window.size(), ir_amp.size())
    assert pitch.size() == (batch_size, length * hop_length)
    assert 0 <= delay < ir_length, (delay, ir_length)
    normalized_freq = pitch / sr
    normalized_freq[:, 0] = torch.rand(batch_size, device=pitch.device)
    with torch.amp.autocast('cuda', enabled=False):
        phase = (normalized_freq.double().cumsum_(1) % 1.0).float()
    indices0, indices1 = torch.nonzero(phase[:, :-1] > phase[:, 1:], as_tuple=True)
    numer = 1.0 - phase[indices0, indices1]
    fractional_part = numer / (numer + phase[indices0, indices1 + 1])
    ir_amp = ir_amp[indices0, :, indices1 // hop_length]
    ir_phase = ir_phase[indices0, :, indices1 // hop_length]
    delay_phase = torch.arange(ir_length // 2 + 1, device=pitch.device, dtype=torch.float32)[None, :] * (-math.tau / ir_length) * fractional_part[:, None]
    spec = torch.polar(ir_amp, ir_phase + delay_phase)
    ir = torch.fft.irfft(spec, n=ir_length, dim=1)
    ir *= window
    ir = ir.ravel()
    indices0 = indices0[:, None].expand(-1, ir_length).ravel()
    indices1 = (indices1[:, None] + torch.arange(ir_length, device=pitch.device)).ravel()
    overlap_added_signal = torch.zeros((batch_size, length * hop_length + ir_length), device=pitch.device)
    overlap_added_signal.index_put_((indices0, indices1), ir, accumulate=True)
    overlap_added_signal = overlap_added_signal[:, delay:-ir_length + delay]
    return overlap_added_signal

def generate_noise(aperiodicity: torch.Tensor, delay: int=0) -> tuple[torch.Tensor, torch.Tensor]:
    batch_size, hop_length, length = aperiodicity.size()
    excitation = torch.rand(batch_size, (length + 1) * hop_length, device=aperiodicity.device)
    excitation -= 0.5
    n_fft = 2 * hop_length
    noise = torch.stft(excitation, n_fft=n_fft, hop_length=hop_length, window=torch.ones(n_fft, device=excitation.device), center=False, return_complex=True)
    assert noise.size(2) == aperiodicity.size(2)
    noise[:, 0, :] = 0.0
    noise[:, 1:, :] *= aperiodicity
    noise = torch.fft.irfft(noise, n=2 * hop_length, dim=1)
    noise *= torch.hann_window(2 * hop_length, device=noise.device)[None, :, None]
    noise = F.fold(noise, (1, (length + 1) * hop_length), (1, 2 * hop_length), stride=(1, hop_length)).squeeze_((1, 2))
    assert delay < hop_length
    noise = noise[:, delay:-hop_length + delay]
    excitation = excitation[:, delay:-hop_length + delay]
    return (noise, excitation)
D4C_PREVENT_ZERO_DIVISION = True

def interp(x: torch.Tensor, y: torch.Tensor, xi: torch.Tensor) -> torch.Tensor:
    x = torch.as_tensor(x)
    y = torch.as_tensor(y)
    xi = torch.as_tensor(xi)
    if xi.ndim < y.ndim:
        diff_ndim = y.ndim - xi.ndim
        xi = xi.view(tuple([1] * diff_ndim) + xi.size())
    if xi.size()[:-1] != y.size()[:-1]:
        xi = xi.expand(y.size()[:-1] + (xi.size(-1),))
    assert (x.min(-1).values == x[..., 0]).all()
    assert (x.max(-1).values == x[..., -1]).all()
    assert (xi.min(-1).values >= x[..., 0]).all()
    assert (xi.max(-1).values <= x[..., -1]).all()
    delta_x = (x[..., -1].double() - x[..., 0].double()) / (x.size(-1) - 1.0)
    delta_x = delta_x.to(x.dtype)
    xi = (xi - x[..., :1]).div_(delta_x[..., None])
    xi_base = xi.floor()
    xi_fraction = xi.sub_(xi_base)
    xi_base = xi_base.long()
    delta_y = y.diff(dim=-1, append=y[..., -1:])
    yi = y.gather(-1, xi_base) + delta_y.gather(-1, xi_base) * xi_fraction
    return yi

def linear_smoothing(group_delay: torch.Tensor, sr: int, n_fft: int, width: torch.Tensor) -> torch.Tensor:
    group_delay = torch.as_tensor(group_delay)
    assert group_delay.size(-1) == n_fft // 2 + 1
    width = torch.as_tensor(width)
    boundary = (width.max() * n_fft / sr).long() + 1
    dtype = group_delay.dtype
    device = group_delay.device
    fft_resolution = sr / n_fft
    mirroring_freq_axis = torch.arange(-boundary, n_fft // 2 + 1 + boundary, dtype=dtype, device=device).add(0.5).mul(fft_resolution)
    if group_delay.ndim == 1:
        mirroring_spec = F.pad(group_delay[None], (boundary, boundary), mode='reflect').squeeze_(0)
    elif group_delay.ndim >= 4:
        shape = group_delay.size()
        mirroring_spec = F.pad(group_delay.view(math.prod(shape[:-1]), group_delay.size(-1)), (boundary, boundary), mode='reflect').view(shape[:-1] + (shape[-1] + 2 * boundary,))
    else:
        mirroring_spec = F.pad(group_delay, (boundary, boundary), mode='reflect')
    mirroring_segment = mirroring_spec.mul(fft_resolution).cumsum_(-1)
    center_freq = torch.arange(n_fft // 2 + 1, dtype=dtype, device=device).mul_(fft_resolution)
    low_freq = center_freq - width[..., None] * 0.5
    high_freq = center_freq + width[..., None] * 0.5
    levels = interp(mirroring_freq_axis, mirroring_segment, torch.cat([low_freq, high_freq], dim=-1))
    low_levels, high_levels = levels.split([n_fft // 2 + 1] * 2, dim=-1)
    smoothed = (high_levels - low_levels).div_(width[..., None])
    return smoothed

def dc_correction(spec: torch.Tensor, sr: int, n_fft: int, f0: torch.Tensor) -> torch.Tensor:
    spec = torch.as_tensor(spec)
    f0 = torch.as_tensor(f0)
    dtype = spec.dtype
    device = spec.device
    upper_limit = 2 + (f0 * (n_fft / sr)).long()
    max_upper_limit = upper_limit.max()
    upper_limit_mask = torch.arange(max_upper_limit - 1, device=device) < (upper_limit - 1)[..., None]
    low_freq_axis = torch.arange(max_upper_limit + 1, dtype=dtype, device=device) * (sr / n_fft)
    low_freq_replica = interp(f0[..., None] - low_freq_axis.flip(-1), spec[..., :max_upper_limit + 1].flip(-1), low_freq_axis[..., :max_upper_limit - 1] * upper_limit_mask)
    output = spec.clone()
    output[..., :max_upper_limit - 1] += low_freq_replica * upper_limit_mask
    return output

def nuttall(n: int, device: torch.types.Device) -> torch.Tensor:
    t = torch.linspace(0, math.tau, n, device=device)
    coefs = torch.tensor([0.355768, -0.487396, 0.144232, -0.012604], device=device)
    terms = torch.tensor([0.0, 1.0, 2.0, 3.0], device=device)
    cos_matrix = (terms[:, None] * t).cos_()
    window = coefs.matmul(cos_matrix)
    return window

def get_windowed_waveform(x: torch.Tensor, sr: int, f0: torch.Tensor, position: torch.Tensor, half_window_length_ratio: float, window_type: Literal['hann', 'blackman'], n_fft: int) -> tuple[torch.Tensor, torch.Tensor]:
    x = torch.as_tensor(x)
    f0 = torch.as_tensor(f0)
    position = torch.as_tensor(position)
    current_sample = position * sr
    half_window_length = (half_window_length_ratio * sr / f0).add_(0.5).long()
    base_index = -half_window_length[..., None] + torch.arange(n_fft, device=x.device)
    base_index_mask = base_index <= half_window_length[..., None]
    safe_index = ((current_sample + 0.501).long()[..., None] + base_index).clamp_(0, x.size(-1) - 1)
    time_axis = base_index.to(x.dtype).div_(half_window_length_ratio)
    normalized_f0 = math.pi / sr * f0
    phase = time_axis.mul_(normalized_f0[..., None])
    if window_type == 'hann':
        window = phase.cos_().mul_(0.5).add_(0.5)
    elif window_type == 'blackman':
        window = phase.mul(2.0).cos_().mul_(0.08).add_(phase.cos().mul_(0.5)).add_(0.42)
    else:
        assert False
    window *= base_index_mask
    prefix_shape = tuple((max(x_size, i_size) for x_size, i_size in zip(x.size(), safe_index.size())))[:-1]
    waveform = x.expand(prefix_shape + (-1,)).gather(-1, safe_index.expand(prefix_shape + (-1,))).mul_(window)
    if not D4C_PREVENT_ZERO_DIVISION:
        waveform += torch.randn_like(window).mul_(1e-12)
    waveform *= base_index_mask
    waveform -= window * waveform.sum(-1, keepdim=True).div_(window.sum(-1, keepdim=True))
    return (waveform, window)

def get_centroid(x: torch.Tensor, n_fft: int) -> torch.Tensor:
    x = torch.as_tensor(x)
    if D4C_PREVENT_ZERO_DIVISION:
        x = x / x.norm(dim=-1, keepdim=True).clamp(min=6e-08)
    else:
        x = x / x.norm(dim=-1, keepdim=True)
    spec0 = torch.fft.rfft(x, n_fft)
    spec1 = torch.fft.rfft(x * torch.arange(1, x.size(-1) + 1, dtype=x.dtype, device=x.device).div_(n_fft), n_fft)
    centroid = spec0.real * spec1.real + spec0.imag * spec1.imag
    return centroid

def get_static_centroid(x: torch.Tensor, sr: int, f0: torch.Tensor, position: torch.Tensor, n_fft: int) -> torch.Tensor:
    """First step: calculation of temporally static parameters on basis of group delay"""
    x1, _ = get_windowed_waveform(x, sr, f0, position + 0.25 / f0, 2.0, 'blackman', n_fft)
    x2, _ = get_windowed_waveform(x, sr, f0, position - 0.25 / f0, 2.0, 'blackman', n_fft)
    centroid1 = get_centroid(x1, n_fft)
    centroid2 = get_centroid(x2, n_fft)
    return dc_correction(centroid1 + centroid2, sr, n_fft, f0)

def get_smoothed_power_spec(x: torch.Tensor, sr: int, f0: torch.Tensor, position: torch.Tensor, n_fft: int) -> tuple[torch.Tensor, torch.Tensor]:
    x = torch.as_tensor(x)
    f0 = torch.as_tensor(f0)
    x, window = get_windowed_waveform(x, sr, f0, position, 2.0, 'hann', n_fft)
    window_weight = window.square().sum(-1, keepdim=True)
    rms = x.square().sum(-1, keepdim=True).div_(window_weight).sqrt_()
    if D4C_PREVENT_ZERO_DIVISION:
        x = x / (rms * math.sqrt(n_fft)).clamp_(min=6e-08)
    smoothed_power_spec = torch.fft.rfft(x, n_fft).abs().square_()
    smoothed_power_spec = dc_correction(smoothed_power_spec, sr, n_fft, f0)
    smoothed_power_spec = linear_smoothing(smoothed_power_spec, sr, n_fft, f0)
    return (smoothed_power_spec, rms.detach().squeeze(-1))

def get_static_group_delay(static_centroid: torch.Tensor, smoothed_power_spec: torch.Tensor, sr: int, f0: torch.Tensor, n_fft: int) -> torch.Tensor:
    """Second step: calculation of parameter shaping"""
    if D4C_PREVENT_ZERO_DIVISION:
        smoothed_power_spec = smoothed_power_spec.clamp(min=6e-08)
    static_group_delay = static_centroid / smoothed_power_spec
    static_group_delay = linear_smoothing(static_group_delay, sr, n_fft, f0 * 0.5)
    smoothed_group_delay = linear_smoothing(static_group_delay, sr, n_fft, f0)
    static_group_delay = static_group_delay - smoothed_group_delay
    return static_group_delay

def get_coarse_aperiodicity(group_delay: torch.Tensor, sr: int, n_fft: int, freq_interval: int, n_aperiodicities: int, window: torch.Tensor) -> torch.Tensor:
    """Third step: estimation of band-aperiodicity"""
    group_delay = torch.as_tensor(group_delay)
    window = torch.as_tensor(window)
    boundary = int(round(n_fft * 8 / window.size(-1)))
    half_window_length = window.size(-1) // 2
    coarse_aperiodicity = torch.empty(group_delay.size()[:-1] + (n_aperiodicities,), dtype=group_delay.dtype, device=group_delay.device)
    for i in range(n_aperiodicities):
        center = freq_interval * (i + 1) * n_fft // sr
        segment = group_delay[..., center - half_window_length:center + half_window_length + 1] * window
        power_spec: torch.Tensor = torch.fft.rfft(segment, n_fft).abs().square_()
        cumulative_power_spec = power_spec.sort(-1).values.cumsum_(-1)
        if D4C_PREVENT_ZERO_DIVISION:
            cumulative_power_spec.clamp_(min=6e-08)
        coarse_aperiodicity[..., i] = cumulative_power_spec[..., n_fft // 2 - boundary - 1] / cumulative_power_spec[..., -1]
    coarse_aperiodicity.log10_().mul_(10.0)
    return coarse_aperiodicity

def d4c_love_train(x: torch.Tensor, sr: int, f0: torch.Tensor, position: torch.Tensor, threshold: float) -> int:
    x = torch.as_tensor(x)
    position = torch.as_tensor(position)
    f0: torch.Tensor = torch.as_tensor(f0)
    vuv = f0 != 0
    lowest_f0 = 40
    f0 = f0.clamp(min=lowest_f0)
    n_fft = 1 << (3 * sr // lowest_f0).bit_length()
    boundary0 = (100 * n_fft - 1) // sr + 1
    boundary1 = (4000 * n_fft - 1) // sr + 1
    boundary2 = (7900 * n_fft - 1) // sr + 1
    waveform, _ = get_windowed_waveform(x, sr, f0, position, 1.5, 'blackman', n_fft)
    power_spec = torch.fft.rfft(waveform, n_fft).abs().square_()
    power_spec[..., :boundary0 + 1] = 0.0
    cumulative_spec = power_spec.cumsum_(-1)
    vuv = vuv & (cumulative_spec[..., boundary1] > threshold * cumulative_spec[..., boundary2])
    return vuv

def d4c_general_body(x: torch.Tensor, sr: int, f0: torch.Tensor, freq_interval: int, position: torch.Tensor, n_fft: int, n_aperiodicities: int, window: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    static_centroid = get_static_centroid(x, sr, f0, position, n_fft)
    smoothed_power_spec, rms = get_smoothed_power_spec(x, sr, f0, position, n_fft)
    static_group_delay = get_static_group_delay(static_centroid, smoothed_power_spec, sr, f0, n_fft)
    coarse_aperiodicity = get_coarse_aperiodicity(static_group_delay, sr, n_fft, freq_interval, n_aperiodicities, window)
    coarse_aperiodicity.add_((f0[..., None] - 100.0).div_(50.0)).clamp_(max=0.0)
    return (coarse_aperiodicity, rms)

def d4c(x: torch.Tensor, f0: torch.Tensor, t: torch.Tensor, sr: int, threshold: float=0.85, n_fft_spec: Optional[int]=None, coarse_only: bool=False) -> tuple[torch.Tensor, torch.Tensor]:
    """Adapted from https://github.com/tuanad121/Python-WORLD/blob/master/world/d4c.py"""
    FLOOR_F0 = 71
    FLOOR_F0_D4C = 47
    UPPER_LIMIT = 15000
    FREQ_INTERVAL = 3000
    assert sr == int(sr)
    sr = int(sr)
    assert sr % 2 == 0
    x = torch.as_tensor(x)
    f0 = torch.as_tensor(f0)
    temporal_positions = torch.as_tensor(t)
    n_fft_d4c = 1 << (4 * sr // FLOOR_F0_D4C).bit_length()
    if n_fft_spec is None:
        n_fft_spec = 1 << (3 * sr // FLOOR_F0).bit_length()
    n_aperiodicities = min(UPPER_LIMIT, sr // 2 - FREQ_INTERVAL) // FREQ_INTERVAL
    assert n_aperiodicities >= 1
    window_length = FREQ_INTERVAL * n_fft_d4c // sr * 2 + 1
    window = nuttall(window_length, device=x.device)
    freq_axis = torch.arange(n_fft_spec // 2 + 1, device=x.device) * (sr / n_fft_spec)
    coarse_aperiodicity, rms = d4c_general_body(x[..., None, :], sr, f0.clamp(min=FLOOR_F0_D4C), FREQ_INTERVAL, temporal_positions, n_fft_d4c, n_aperiodicities, window)
    if coarse_only:
        return (coarse_aperiodicity, rms)
    even_coarse_axis = torch.arange(n_aperiodicities + 3, device=x.device) * FREQ_INTERVAL
    assert even_coarse_axis[-2] <= sr // 2 < even_coarse_axis[-1], sr
    coarse_axis_low = torch.arange(n_aperiodicities + 1, dtype=torch.float, device=x.device) * FREQ_INTERVAL
    aperiodicity_low = interp(coarse_axis_low, F.pad(coarse_aperiodicity, (1, 0), value=-60.0), freq_axis[freq_axis < n_aperiodicities * FREQ_INTERVAL])
    coarse_axis_high = torch.tensor([n_aperiodicities * FREQ_INTERVAL, sr * 0.5], device=x.device)
    aperiodicity_high = interp(coarse_axis_high, F.pad(coarse_aperiodicity[..., -1:], (0, 1), value=-1e-12), freq_axis[freq_axis >= n_aperiodicities * FREQ_INTERVAL])
    aperiodicity = torch.cat([aperiodicity_low, aperiodicity_high], -1)
    aperiodicity = 10.0 ** (aperiodicity / 20.0)
    vuv = d4c_love_train(x[..., None, :], sr, f0, temporal_positions, threshold)
    aperiodicity = torch.where(vuv[..., None], aperiodicity, 1 - 1e-12)
    return (aperiodicity, coarse_aperiodicity)

class Vocoder(nn.Module):

    def __init__(self, channels: int, speaker_embedding_channels: int=128, hop_length: int=240, n_pre_blocks: int=4, out_sample_rate: float=24000.0):
        super().__init__()
        self.hop_length = hop_length
        self.out_sample_rate = out_sample_rate
        self.prenet = ConvNeXtStack(in_channels=channels, channels=channels, intermediate_channels=channels * 2, n_blocks=n_pre_blocks, delay=2, embed_kernel_size=7, kernel_size=33, enable_scaling=True, use_mha=True, cross_attention=True, kv_channels=speaker_embedding_channels)
        self.ir_generator = ConvNeXtStack(in_channels=channels, channels=channels, intermediate_channels=channels * 2, n_blocks=2, delay=0, embed_kernel_size=3, kernel_size=33, use_weight_standardization=True, enable_scaling=True)
        self.ir_generator_post = WSConv1d(channels, 512, 1)
        self.register_buffer('ir_scale', torch.tensor(1.0))
        self.ir_window = nn.Parameter(torch.ones(512))
        self.aperiodicity_generator = ConvNeXtStack(in_channels=channels, channels=channels, intermediate_channels=channels * 2, n_blocks=1, delay=0, embed_kernel_size=3, kernel_size=33, use_weight_standardization=True, enable_scaling=True)
        self.aperiodicity_generator_post = WSConv1d(channels, hop_length, 1, bias=False)
        self.register_buffer('aperiodicity_scale', torch.tensor(0.005))
        self.post_filter_generator = ConvNeXtStack(in_channels=channels, channels=channels, intermediate_channels=channels * 2, n_blocks=1, delay=0, embed_kernel_size=3, kernel_size=33, use_weight_standardization=True, enable_scaling=True)
        self.post_filter_generator_post = WSConv1d(channels, 512, 1, bias=False)
        self.register_buffer('post_filter_scale', torch.tensor(0.01))

    def forward(self, x: torch.Tensor, pitch: torch.Tensor, speaker_embedding: torch.Tensor) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        batch_size, _, length = x.size()
        x = self.prenet(x, speaker_embedding)
        ir = self.ir_generator(x)
        ir = F.silu(ir, inplace=True)
        ir = self.ir_generator_post(ir)
        ir *= self.ir_scale
        ir_amp = ir[:, :ir.size(1) // 2 + 1, :].exp()
        ir_phase = F.pad(ir[:, ir.size(1) // 2 + 1:, :], (0, 0, 1, 1))
        ir_phase[:, 1::2, :] += math.pi
        pitch = torch.repeat_interleave(pitch, self.hop_length, dim=1)
        periodic_signal = overlap_add(ir_amp, ir_phase, self.ir_window, pitch, self.hop_length, delay=0, sr=self.out_sample_rate)
        aperiodicity = self.aperiodicity_generator(x)
        aperiodicity = F.silu(aperiodicity, inplace=True)
        aperiodicity = self.aperiodicity_generator_post(aperiodicity)
        aperiodicity *= self.aperiodicity_scale
        aperiodic_signal, noise_excitation = generate_noise(aperiodicity, delay=0)
        post_filter = self.post_filter_generator(x)
        post_filter = F.silu(post_filter, inplace=True)
        post_filter = self.post_filter_generator_post(post_filter)
        post_filter *= self.post_filter_scale
        post_filter[:, 0, :] += 1.0
        post_filter = post_filter.transpose(1, 2)
        with torch.amp.autocast('cuda', enabled=False):
            periodic_signal = periodic_signal.float()
            aperiodic_signal = aperiodic_signal.float()
            post_filter = post_filter.float()
            post_filter = torch.fft.rfft(post_filter, n=768)
            periodic_signal = torch.fft.irfft(torch.fft.rfft(periodic_signal.view(batch_size, length, self.hop_length), n=768) * post_filter, n=768)
            aperiodic_signal = torch.fft.irfft(torch.fft.rfft(aperiodic_signal.view(batch_size, length, self.hop_length), n=768) * post_filter, n=768)
            periodic_signal = F.fold(periodic_signal.transpose(1, 2), (1, (length - 1) * self.hop_length + 768), (1, 768), stride=(1, self.hop_length)).squeeze_((1, 2))
            aperiodic_signal = F.fold(aperiodic_signal.transpose(1, 2), (1, (length - 1) * self.hop_length + 768), (1, 768), stride=(1, self.hop_length)).squeeze_((1, 2))
        periodic_signal = periodic_signal[:, 120:120 + length * self.hop_length]
        aperiodic_signal = aperiodic_signal[:, 120:120 + length * self.hop_length]
        noise_excitation = noise_excitation[:, 120:]
        y_g_hat = (periodic_signal + aperiodic_signal)[:, None, :]
        return (y_g_hat, {'periodic_signal': periodic_signal.detach(), 'aperiodic_signal': aperiodic_signal.detach(), 'noise_excitation': noise_excitation.detach()})

    def merge_weights(self):
        self.prenet.merge_weights()
        self.ir_generator.merge_weights()
        self.ir_generator_post.merge_weights()
        self.aperiodicity_generator.merge_weights()
        self.aperiodicity_generator_post.merge_weights()
        self.ir_generator_post.weight.data *= self.ir_scale
        self.ir_generator_post.bias.data *= self.ir_scale
        self.ir_scale.fill_(1.0)
        self.aperiodicity_generator_post.weight.data *= self.aperiodicity_scale
        self.aperiodicity_scale.fill_(1.0)
        self.post_filter_generator.merge_weights()
        self.post_filter_generator_post.merge_weights()
        self.post_filter_generator_post.weight.data *= self.post_filter_scale
        self.post_filter_scale.fill_(1.0)

    def dump(self, f: Union[BinaryIO, str, bytes, os.PathLike]):
        if isinstance(f, (str, bytes, os.PathLike)):
            with open(f, 'wb') as f:
                self.dump(f)
            return
        if not hasattr(f, 'write'):
            raise TypeError
        dump_layer(self.prenet, f)
        dump_layer(self.ir_generator, f)
        dump_layer(self.ir_generator_post, f)
        dump_layer(self.ir_window, f)
        dump_layer(self.aperiodicity_generator, f)
        dump_layer(self.aperiodicity_generator_post, f)
        dump_layer(self.post_filter_generator, f)
        dump_layer(self.post_filter_generator_post, f)

def compute_loudness(x: torch.Tensor, sr: int, win_lengths: list[int]) -> list[torch.Tensor]:
    assert x.ndim == 2
    n_fft = 2048
    chunk_length = n_fft // 2
    n_taps = chunk_length + 1
    results = []
    with torch.amp.autocast('cuda', enabled=False):
        if not hasattr(compute_loudness, 'filter'):
            compute_loudness.filter = {}
        if sr not in compute_loudness.filter:
            ir = torch.zeros(n_taps, device=x.device, dtype=torch.double)
            ir[0] = 0.5
            ir = torchaudio.functional.treble_biquad(ir, sr, 4.0, 1500.0, 1.0 / math.sqrt(2))
            ir = torchaudio.functional.highpass_biquad(ir, sr, 38.0, 0.5)
            ir *= 2.0
            compute_loudness.filter[sr] = torch.fft.rfft(ir, n=n_fft).to(torch.complex64)
        x = x.float()
        wav_length = x.size(-1)
        if wav_length % chunk_length != 0:
            x = F.pad(x, (0, chunk_length - wav_length % chunk_length))
        padded_wav_length = x.size(-1)
        x = x.view(x.size()[:-1] + (padded_wav_length // chunk_length, chunk_length))
        x = torch.fft.irfft(torch.fft.rfft(x, n=n_fft) * compute_loudness.filter[sr], n=n_fft)
        x = F.fold(x.transpose(-2, -1), (1, padded_wav_length + chunk_length), (1, n_fft), stride=(1, chunk_length)).squeeze_((-3, -2))[..., :wav_length]
        x.square_()
        for win_length in win_lengths:
            hop_length = win_length // 4
            energy = x.unfold(-1, win_length, hop_length).matmul(torch.hann_window(win_length, device=x.device)).add_(win_length / 4.0 * 1e-05).log10_()
            results.append(energy)
    return results

def slice_segments(x: torch.Tensor, start_indices: torch.Tensor, segment_length: int) -> torch.Tensor:
    batch_size, channels, _ = x.size()
    indices = start_indices[:, None, None] + torch.arange(segment_length, device=start_indices.device)
    indices = indices.expand(batch_size, channels, segment_length)
    return x.gather(2, indices)

class ConverterNetwork(nn.Module):

    def __init__(self, phone_extractor: PhoneExtractor, pitch_estimator: PitchEstimator, n_speakers: int, pitch_bins: int, hidden_channels: int, vq_topk: int=4, training_time_vq: Literal['none', 'self', 'random']='none', phone_noise_ratio: int=0.5, floor_noise_level: float=0.001):
        super().__init__()
        self.frozen_modules = {'phone_extractor': phone_extractor.eval().requires_grad_(False), 'pitch_estimator': pitch_estimator.eval().requires_grad_(False)}
        self.pitch_bins = pitch_bins
        self.phone_noise_ratio = phone_noise_ratio
        self.floor_noise_level = floor_noise_level
        self.out_sample_rate = out_sample_rate = 24000
        phone_channels = 128
        self.vq = VectorQuantizer(n_speakers=n_speakers, codebook_size=512, channels=phone_channels, topk=vq_topk, training_time_vq=training_time_vq)
        self.embed_phone = nn.Conv1d(phone_channels, hidden_channels, 1)
        self.embed_phone.weight.data.normal_(0.0, math.sqrt(2.0 / (256 * 5)))
        self.embed_phone.bias.data.zero_()
        self.embed_quantized_pitch = nn.Embedding(pitch_bins, hidden_channels)
        phase = torch.arange(pitch_bins, dtype=torch.float)[:, None] * (torch.arange(0, hidden_channels, 2, dtype=torch.float) * (-math.log(10000.0) / hidden_channels)).exp_()
        self.embed_quantized_pitch.weight.data[:, 0::2] = phase.sin()
        self.embed_quantized_pitch.weight.data[:, 1::2] = phase.cos_()
        self.embed_quantized_pitch.weight.data *= math.sqrt(4.0 / 5.0)
        self.embed_quantized_pitch.weight.requires_grad_(False)
        self.embed_pitch_features = nn.Conv1d(4, hidden_channels, 1)
        self.embed_pitch_features.weight.data.normal_(0.0, math.sqrt(2.0 / (4 * 5)))
        self.embed_pitch_features.bias.data.zero_()
        self.embed_speaker = nn.Embedding(n_speakers, hidden_channels)
        self.embed_speaker.weight.data.normal_(0.0, math.sqrt(2.0 / 5.0))
        self.embed_formant_shift = nn.Embedding(9, hidden_channels)
        self.embed_formant_shift.weight.data.normal_(0.0, math.sqrt(2.0 / 5.0))
        self.key_value_speaker_embedding_length = 384
        self.key_value_speaker_embedding_channels = 128
        self.key_value_speaker_embedding = nn.Embedding(n_speakers, self.key_value_speaker_embedding_length * self.key_value_speaker_embedding_channels)
        self.key_value_speaker_embedding.weight.data[0].normal_()
        self.key_value_speaker_embedding.weight.data[1:] = self.key_value_speaker_embedding.weight.data[0]
        self.vocoder = Vocoder(channels=hidden_channels, speaker_embedding_channels=self.key_value_speaker_embedding_channels, hop_length=out_sample_rate // 100, n_pre_blocks=4, out_sample_rate=out_sample_rate)
        self.melspectrograms = nn.ModuleList()
        for win_length, n_mels in [(32, 5), (64, 10), (128, 20), (256, 40), (512, 80), (1024, 160), (2048, 320)]:
            self.melspectrograms.append(torchaudio.transforms.MelSpectrogram(sample_rate=out_sample_rate, n_fft=win_length, win_length=win_length, hop_length=win_length // 4, n_mels=n_mels, power=2, norm='slaney', mel_scale='slaney'))

    def initialize_vq(self, inputs: Sequence[Iterable[torch.Tensor]]):
        collector_func = self.frozen_modules['phone_extractor'].units
        target_layer = self.frozen_modules['phone_extractor'].head
        self.vq.build_codebooks(collector_func, target_layer, inputs)
        self.vq.enable_hook(target_layer)

    def enable_hook(self):
        target_layer = self.frozen_modules['phone_extractor'].head
        self.vq.enable_hook(target_layer)

    def _get_resampler(self, orig_freq, new_freq, device, cache={}) -> torchaudio.transforms.Resample:
        key = (orig_freq, new_freq)
        if key in cache:
            return cache[key]
        resampler = torchaudio.transforms.Resample(orig_freq, new_freq).to(device, non_blocking=True)
        cache[key] = resampler
        return resampler

    def forward(self, x: torch.Tensor, target_speaker_id: torch.Tensor, formant_shift_semitone: torch.Tensor, pitch_shift_semitone: Optional[torch.Tensor]=None, slice_start_indices: Optional[torch.Tensor]=None, slice_segment_length: Optional[int]=None, return_stats: bool=False) -> Union[torch.Tensor, tuple[torch.Tensor, dict[str, float]]]:
        batch_size, _, _ = x.size()
        self.vq.set_target_speaker_ids(target_speaker_id)
        with torch.inference_mode():
            phone_extractor: PhoneExtractor = self.frozen_modules['phone_extractor']
            pitch_estimator: PitchEstimator = self.frozen_modules['pitch_estimator']
            phone = phone_extractor.units(x).transpose(1, 2)
            if self.training and self.phone_noise_ratio != 0.0:
                phone *= (1.0 - self.phone_noise_ratio) / phone.square().mean(1, keepdim=True).sqrt_()
                noise = torch.randn_like(phone)
                noise *= self.phone_noise_ratio / noise.square().mean(1, keepdim=True).sqrt_()
                phone += noise
            phone *= 1.0 / phone.square().mean(1, keepdim=True).add_(torch.finfo(torch.float).eps).sqrt_()
            pitch, energy = pitch_estimator(x)
            if self.training:
                weights = pitch.softmax(1)[:, 1:, :].mean(2)
                mean_pitch = (weights * torch.arange(1, self.embed_quantized_pitch.num_embeddings, device=weights.device)).sum(1) / weights.sum(1)
                mean_pitch = mean_pitch.round_().long()
                target_pitch = torch.randint_like(mean_pitch, 64, 257)
                shift = target_pitch - mean_pitch
                shift_ratio = (2.0 ** (shift.float() / pitch_estimator.pitch_bins_per_octave)).tolist()
                shift = []
                interval_length = 100
                interval_zeros = torch.zeros((1, 1, interval_length * 160), device=x.device)
                concatenated_shifted_x = []
                offsets = [0]
                torch.backends.cudnn.benchmark = False
                for i in range(batch_size):
                    shift_ratio_i = shift_ratio[i]
                    shift_ratio_fraction_i = Fraction.from_float(shift_ratio_i).limit_denominator(30)
                    shift_numer_i = shift_ratio_fraction_i.numerator
                    shift_denom_i = shift_ratio_fraction_i.denominator
                    shift_ratio_i = shift_numer_i / shift_denom_i
                    shift_i = int(round(math.log2(shift_ratio_i) * pitch_estimator.pitch_bins_per_octave))
                    shift.append(shift_i)
                    shift_ratio[i] = shift_ratio_i
                    with torch.amp.autocast('cuda', enabled=False):
                        shifted_x_i = self._get_resampler(shift_numer_i, shift_denom_i, x.device)(x[i])[None]
                    if shifted_x_i.size(2) % 160 != 0:
                        shifted_x_i = F.pad(shifted_x_i, (0, 160 - shifted_x_i.size(2) % 160), mode='reflect')
                    assert shifted_x_i.size(2) % 160 == 0
                    offsets.append(offsets[-1] + interval_length + shifted_x_i.size(2) // 160)
                    concatenated_shifted_x.extend([interval_zeros, shifted_x_i])
                if offsets[-1] % 256 != 0:
                    concatenated_shifted_x.append(torch.zeros((1, 1, (256 - offsets[-1] % 256) * 160), device=x.device))
                concatenated_shifted_x = torch.cat(concatenated_shifted_x, dim=2)
                assert concatenated_shifted_x.size(2) % (256 * 160) == 0
                concatenated_pitch, concatenated_energy = pitch_estimator(concatenated_shifted_x)
                for i in range(batch_size):
                    shift_i = shift[i]
                    shift_ratio_i = shift_ratio[i]
                    left = offsets[i] + interval_length
                    right = offsets[i + 1]
                    pitch_i = concatenated_pitch[:, :, left:right]
                    energy_i = concatenated_energy[:, :, left:right]
                    pitch_i = F.interpolate(pitch_i, scale_factor=shift_ratio_i, mode='linear', align_corners=False)
                    energy_i = F.interpolate(energy_i, scale_factor=shift_ratio_i, mode='linear', align_corners=False)
                    assert pitch_i.size(2) == energy_i.size(2)
                    assert abs(pitch_i.size(2) - pitch.size(2)) <= 10
                    length = min(pitch_i.size(2), pitch.size(2))
                    if shift_i > 0:
                        pitch[i:i + 1, :1, :length] = pitch_i[:, :1, :length]
                        pitch[i:i + 1, 1:-shift_i, :length] = pitch_i[:, 1 + shift_i:, :length]
                        pitch[i:i + 1, -shift_i:, :length] = -10.0
                    elif shift_i < 0:
                        pitch[i:i + 1, :1, :length] = pitch_i[:, :1, :length]
                        pitch[i:i + 1, 1:1 - shift_i, :length] = -10.0
                        pitch[i:i + 1, 1 - shift_i:, :length] = pitch_i[:, 1:shift_i, :length]
                    energy[i:i + 1, :, :length] = energy_i[:, :, :length]
                torch.backends.cudnn.benchmark = True
            quantized_pitch, pitch_features = pitch_estimator.sample_pitch(pitch, return_features=True)
            if pitch_shift_semitone is not None:
                quantized_pitch = torch.where(quantized_pitch == 0, quantized_pitch, (quantized_pitch + (pitch_shift_semitone[:, None] * (pitch_estimator.pitch_bins_per_octave / 12.0)).round_().long()).clamp_(1, self.pitch_bins - 1))
            pitch = 55.0 * 2.0 ** (quantized_pitch.float() / pitch_estimator.pitch_bins_per_octave)
            energy = F.pad(energy[:, :, :-1], (1, 0), mode='reflect')
            quantized_pitch = F.pad(quantized_pitch[:, :-2], (2, 0), mode='reflect')
            pitch_features = F.pad(pitch_features[:, :, :-2], (2, 0), mode='reflect')
            pitch_features = torch.cat([energy, pitch_features], dim=1)
            formant_shift_indices = ((formant_shift_semitone + 2.0) * 2.0).round_().long()
        phone = phone.clone()
        quantized_pitch = quantized_pitch.clone()
        pitch_features = pitch_features.clone()
        formant_shift_indices = formant_shift_indices.clone()
        pitch = pitch.clone()
        x = self.embed_phone(phone) + self.embed_quantized_pitch(quantized_pitch).transpose(1, 2) + self.embed_pitch_features(pitch_features) + (self.embed_speaker(target_speaker_id)[:, :, None] + self.embed_formant_shift(formant_shift_indices)[:, :, None])
        if slice_start_indices is not None:
            assert slice_segment_length is not None
            x = slice_segments(x, slice_start_indices, slice_segment_length)
        x = F.silu(x, inplace=True)
        speaker_embedding = self.key_value_speaker_embedding(target_speaker_id).view(batch_size, self.key_value_speaker_embedding_length, self.key_value_speaker_embedding_channels)
        y_g_hat, stats = self.vocoder(x, pitch, speaker_embedding)
        stats['pitch'] = pitch
        if return_stats:
            return (y_g_hat, stats)
        else:
            return y_g_hat

    def _normalize_melsp(self, x):
        return x.clamp(min=1e-10).log_()

    def forward_and_compute_loss(self, noisy_wavs_16k: torch.Tensor, target_speaker_id: torch.Tensor, formant_shift_semitone: torch.Tensor, slice_start_indices: torch.Tensor, slice_segment_length: int, y_all: torch.Tensor, enable_loss_ap: bool=False) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, dict[str, float]]:
        stats = {}
        loss_mel = 0.0
        loss_loudness = 0.0
        loudness_win_lengths = [512, 1024, 2048, 4096]
        y_hat_all, intermediates = self(noisy_wavs_16k, target_speaker_id, formant_shift_semitone, return_stats=True)
        y_hat_all = y_hat_all.detach().where(y_all == 0.0, y_hat_all)
        with torch.amp.autocast('cuda', enabled=False):
            periodic_signal = intermediates['periodic_signal'].float()
            aperiodic_signal = intermediates['aperiodic_signal'].float()
            noise_excitation = intermediates['noise_excitation'].float()
            periodic_signal = periodic_signal[:, :noise_excitation.size(1)]
            aperiodic_signal = aperiodic_signal[:, :noise_excitation.size(1)]
            y_hat_all = y_hat_all.float()
            floor_noise = torch.randn_like(y_all) * self.floor_noise_level
            y_all = y_all + floor_noise
            y_hat_all += floor_noise
            y_hat_all_truncated = y_hat_all.squeeze(1)[:, :periodic_signal.size(1)]
            y_all_truncated = y_all.squeeze(1)[:, :periodic_signal.size(1)]
            y_loudness = compute_loudness(y_all_truncated, self.out_sample_rate, loudness_win_lengths)
            y_hat_loudness = compute_loudness(y_hat_all_truncated, self.out_sample_rate, loudness_win_lengths)
            for win_length, y_loudness_i, y_hat_loudness_i in zip(loudness_win_lengths, y_loudness, y_hat_loudness):
                loss_loudness_i = F.mse_loss(y_hat_loudness_i, y_loudness_i)
                loss_loudness += loss_loudness_i * math.sqrt(win_length)
                stats[f'loss_loudness_{win_length}'] = loss_loudness_i.item()
            for melspectrogram in self.melspectrograms:
                melsp_periodic_signal = melspectrogram(periodic_signal)
                melsp_aperiodic_signal = melspectrogram(aperiodic_signal)
                melsp_noise_excitation = melspectrogram(noise_excitation)
                reference_melsp = melspectrogram.mel_scale(torch.full((1, melspectrogram.n_fft // 2 + 1, 1), 1 / 6 * (3 / 8) * 0.5 * melspectrogram.win_length, device=noisy_wavs_16k.device))
                aperiodic_ratio = melsp_aperiodic_signal / (melsp_periodic_signal + melsp_aperiodic_signal + 1e-05)
                compensation_ratio = reference_melsp / (melsp_noise_excitation + 1e-05)
                melsp_y_hat = melspectrogram(y_hat_all_truncated)
                melsp_y_hat = melsp_y_hat * (1.0 - aperiodic_ratio + aperiodic_ratio * compensation_ratio)
                y_hat_mel = self._normalize_melsp(melsp_y_hat)
                y_mel = self._normalize_melsp(melspectrogram(y_all_truncated))
                loss_mel_i = F.l1_loss(y_hat_mel, y_mel)
                loss_mel += loss_mel_i
                stats[f'loss_mel_{melspectrogram.win_length}_{melspectrogram.n_mels}'] = loss_mel_i.item()
            loss_mel /= len(self.melspectrograms)
            if enable_loss_ap:
                t = torch.arange(intermediates['pitch'].size(1), device=y_all.device) * 0.01 + 0.005
                y_coarse_aperiodicity, y_rms = d4c(y_all.squeeze(1), intermediates['pitch'], t, self.vocoder.out_sample_rate, coarse_only=True)
                y_coarse_aperiodicity = 10.0 ** (y_coarse_aperiodicity / 10.0)
                y_hat_coarse_aperiodicity, y_hat_rms = d4c(y_hat_all.squeeze(1), intermediates['pitch'], t, self.vocoder.out_sample_rate, coarse_only=True)
                y_hat_coarse_aperiodicity = 10.0 ** (y_hat_coarse_aperiodicity / 10.0)
                rms = torch.maximum(y_rms, y_hat_rms)
                loss_ap = F.mse_loss(y_hat_coarse_aperiodicity, y_coarse_aperiodicity, reduction='none')
                loss_ap *= (rms / (rms + 0.001) * (rms > 1e-05))[:, :, None]
                loss_ap = loss_ap.mean()
            else:
                loss_ap = torch.tensor(0.0)
        y_hat = slice_segments(y_hat_all, slice_start_indices * 240, slice_segment_length * 240)
        y = slice_segments(y_all, slice_start_indices * 240, slice_segment_length * 240)
        return (y, y_hat, y_hat_all, loss_loudness, loss_mel, loss_ap, stats)

    def merge_weights(self):
        self.vocoder.merge_weights()

    def dump(self, f: Union[BinaryIO, str, bytes, os.PathLike]):
        if isinstance(f, (str, bytes, os.PathLike)):
            with open(f, 'wb') as f:
                self.dump(f)
            return
        if not hasattr(f, 'write'):
            raise TypeError
        dump_layer(self.embed_phone, f)
        dump_layer(self.embed_quantized_pitch, f)
        dump_layer(self.embed_pitch_features, f)
        dump_layer(self.vocoder, f)

    def dump_speaker_embeddings(self, f: Union[BinaryIO, str, bytes, os.PathLike]):
        if isinstance(f, (str, bytes, os.PathLike)):
            with open(f, 'wb') as f:
                self.dump_speaker_embeddings(f)
            return
        if not hasattr(f, 'write'):
            raise TypeError
        dump_params(self.vq.codebooks, f)
        dump_layer(self.embed_speaker, f)
        dump_layer(self.embed_formant_shift, f)
        dump_layer(self.key_value_speaker_embedding, f)

    def dump_embedding_setter(self, f: Union[BinaryIO, str, bytes, os.PathLike]):
        if isinstance(f, (str, bytes, os.PathLike)):
            with open(f, 'wb') as f:
                self.dump_embedding_setter(f)
            return
        if not hasattr(f, 'write'):
            raise TypeError
        self.vocoder.prenet.dump_kv(f)
