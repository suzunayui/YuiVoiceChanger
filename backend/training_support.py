"""Beatrice training losses/discriminators. MIT: BEATRICE_LICENSE.txt.
Extracted from the same trainer revision as beatrice_model.py.
GradBalancer is adapted upstream from Meta EnCodec's MIT-licensed balancer.
"""
import torch
from torch import nn
from torch.nn import functional as F
from torch.nn.utils import weight_norm
from collections import defaultdict
from typing import Union,Optional
def _normalize(tensor: torch.Tensor, dim: int) -> torch.Tensor:
    denom = tensor.norm(p=2.0, dim=dim, keepdim=True).clamp_min(1e-06)
    return tensor / denom

class SANConv2d(nn.Conv2d):

    def __init__(self, in_channels: int, out_channels: int, kernel_size: int, stride: int=1, padding: int=0, dilation: int=1, bias: bool=True, padding_mode='zeros', device=None, dtype=None):
        super().__init__(in_channels, out_channels, kernel_size, stride, padding=padding, dilation=dilation, groups=1, bias=bias, padding_mode=padding_mode, device=device, dtype=dtype)
        scale = self.weight.norm(p=2.0, dim=[1, 2, 3], keepdim=True).clamp_min(1e-06)
        self.weight = nn.parameter.Parameter(self.weight / scale.expand_as(self.weight))
        self.scale = nn.parameter.Parameter(scale.view(out_channels))
        if bias:
            self.bias = nn.parameter.Parameter(torch.zeros(in_channels, device=device, dtype=dtype))
        else:
            self.register_parameter('bias', None)

    def forward(self, input: torch.Tensor, flg_san_train: bool=False) -> Union[torch.Tensor, tuple[torch.Tensor, torch.Tensor]]:
        if self.bias is not None:
            input = input + self.bias.view(self.in_channels, 1, 1)
        normalized_weight = self._get_normalized_weight()
        scale = self.scale.view(self.out_channels, 1, 1)
        if flg_san_train:
            out_fun = F.conv2d(input, normalized_weight.detach(), None, self.stride, self.padding, self.dilation, self.groups)
            out_dir = F.conv2d(input.detach(), normalized_weight, None, self.stride, self.padding, self.dilation, self.groups)
            out = (out_fun * scale, out_dir * scale.detach())
        else:
            out = F.conv2d(input, normalized_weight, None, self.stride, self.padding, self.dilation, self.groups)
            out = out * scale
        return out

    @torch.no_grad()
    def normalize_weight(self):
        self.weight.data = self._get_normalized_weight()

    def _get_normalized_weight(self) -> torch.Tensor:
        return _normalize(self.weight, dim=[1, 2, 3])

def get_padding(kernel_size: int, dilation: int=1) -> int:
    return (kernel_size * dilation - dilation) // 2

class DiscriminatorP(nn.Module):

    def __init__(self, period: int, kernel_size: int=5, stride: int=3, san: bool=False):
        super().__init__()
        self.period = period
        self.san = san
        self.convs = nn.ModuleList([weight_norm(nn.Conv2d(1, 32, (kernel_size, 1), (stride, 1), (get_padding(kernel_size, 1), 0))), weight_norm(nn.Conv2d(32, 128, (kernel_size, 1), (stride, 1), (get_padding(kernel_size, 1), 0))), weight_norm(nn.Conv2d(128, 512, (kernel_size, 1), (stride, 1), (get_padding(kernel_size, 1), 0))), weight_norm(nn.Conv2d(512, 1024, (kernel_size, 1), (stride, 1), (get_padding(kernel_size, 1), 0))), weight_norm(nn.Conv2d(1024, 1024, (kernel_size, 1), 1, (get_padding(kernel_size, 1), 0)))])
        if san:
            self.conv_post = SANConv2d(1024, 1, (3, 1), 1, (1, 0))
        else:
            self.conv_post = weight_norm(nn.Conv2d(1024, 1, (3, 1), 1, (1, 0)))

    def forward(self, x: torch.Tensor, flg_san_train: bool=False) -> tuple[Union[torch.Tensor, tuple[torch.Tensor, torch.Tensor]], list[torch.Tensor]]:
        fmap = []
        b, c, t = x.shape
        if t % self.period != 0:
            n_pad = self.period - t % self.period
            x = F.pad(x, (0, n_pad), 'reflect')
            t = t + n_pad
        x = x.view(b, c, t // self.period, self.period)
        for conv in self.convs:
            x = conv(x)
            x = F.silu(x, inplace=True)
            fmap.append(x)
        if self.san:
            x = self.conv_post(x, flg_san_train=flg_san_train)
        else:
            x = self.conv_post(x)
        if flg_san_train:
            x_fun, x_dir = x
            fmap.append(x_fun)
            x_fun = torch.flatten(x_fun, 1, -1)
            x_dir = torch.flatten(x_dir, 1, -1)
            x = (x_fun, x_dir)
        else:
            fmap.append(x)
            x = torch.flatten(x, 1, -1)
        return (x, fmap)

class DiscriminatorR(nn.Module):

    def __init__(self, resolution: int, san: bool=False):
        super().__init__()
        self.resolution = resolution
        self.san = san
        assert len(self.resolution) == 3
        self.convs = nn.ModuleList([weight_norm(nn.Conv2d(1, 32, (3, 9), padding=(1, 4))), weight_norm(nn.Conv2d(32, 32, (3, 9), (1, 2), (1, 4))), weight_norm(nn.Conv2d(32, 32, (3, 9), (1, 2), (1, 4))), weight_norm(nn.Conv2d(32, 32, (3, 9), (1, 2), (1, 4))), weight_norm(nn.Conv2d(32, 32, (3, 3), padding=(1, 1)))])
        if san:
            self.conv_post = SANConv2d(32, 1, (3, 3), padding=(1, 1))
        else:
            self.conv_post = weight_norm(nn.Conv2d(32, 1, (3, 3), padding=(1, 1)))

    def forward(self, x: torch.Tensor, flg_san_train: bool=False) -> tuple[Union[torch.Tensor, tuple[torch.Tensor, torch.Tensor]], list[torch.Tensor]]:
        fmap = []
        x = self._spectrogram(x).unsqueeze(1)
        for conv in self.convs:
            x = conv(x)
            x = F.silu(x, inplace=True)
            fmap.append(x)
        if self.san:
            x = self.conv_post(x, flg_san_train=flg_san_train)
        else:
            x = self.conv_post(x)
        if flg_san_train:
            x_fun, x_dir = x
            fmap.append(x_fun)
            x_fun = torch.flatten(x_fun, 1, -1)
            x_dir = torch.flatten(x_dir, 1, -1)
            x = (x_fun, x_dir)
        else:
            fmap.append(x)
            x = torch.flatten(x, 1, -1)
        return (x, fmap)

    def _spectrogram(self, x: torch.Tensor) -> torch.Tensor:
        n_fft, hop_length, win_length = self.resolution
        x = F.pad(x, ((n_fft - hop_length) // 2, (n_fft - hop_length) // 2), mode='reflect').squeeze(1)
        with torch.amp.autocast('cuda', enabled=False):
            mag = torch.stft(x.float(), n_fft=n_fft, hop_length=hop_length, win_length=win_length, window=torch.ones(win_length, device=x.device), center=False, return_complex=True).abs()
        return mag

class MultiPeriodDiscriminator(nn.Module):

    def __init__(self, san: bool=False):
        super().__init__()
        resolutions = [[1024, 120, 600], [2048, 240, 1200], [512, 50, 240]]
        periods = [2, 3, 5, 7, 11]
        self.discriminators = nn.ModuleList([DiscriminatorR(r, san=san) for r in resolutions] + [DiscriminatorP(p, san=san) for p in periods])
        self.discriminator_names = [f'R_{n}_{h}_{w}' for n, h, w in resolutions] + [f'P_{p}' for p in periods]
        self.san = san

    def forward(self, y: torch.Tensor, y_hat: torch.Tensor, flg_san_train: bool=False) -> tuple[list[Union[torch.Tensor, tuple[torch.Tensor, torch.Tensor]]], list[Union[torch.Tensor, tuple[torch.Tensor, torch.Tensor]]], list[list[torch.Tensor]], list[list[torch.Tensor]]]:
        batch_size = y.size(0)
        concatenated_y_y_hat = torch.cat([y, y_hat])
        y_d_rs = []
        y_d_gs = []
        fmap_rs = []
        fmap_gs = []
        for d in self.discriminators:
            if flg_san_train:
                (y_d_fun, y_d_dir), fmap = d(concatenated_y_y_hat, flg_san_train=flg_san_train)
                y_d_r_fun, y_d_g_fun = torch.split(y_d_fun, batch_size)
                y_d_r_dir, y_d_g_dir = torch.split(y_d_dir, batch_size)
                y_d_r = (y_d_r_fun, y_d_r_dir)
                y_d_g = (y_d_g_fun, y_d_g_dir)
            else:
                y_d, fmap = d(concatenated_y_y_hat, flg_san_train=flg_san_train)
                y_d_r, y_d_g = torch.split(y_d, batch_size)
            fmap_r = []
            fmap_g = []
            for fm in fmap:
                fm_r, fm_g = torch.split(fm, batch_size)
                fmap_r.append(fm_r)
                fmap_g.append(fm_g)
            y_d_rs.append(y_d_r)
            y_d_gs.append(y_d_g)
            fmap_rs.append(fmap_r)
            fmap_gs.append(fmap_g)
        return (y_d_rs, y_d_gs, fmap_rs, fmap_gs)

    def forward_and_compute_loss(self, y: torch.Tensor, y_hat: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, dict[str, float]]:
        y_d_rs, y_d_gs, fmap_rs, fmap_gs = self(y, y_hat, flg_san_train=self.san)
        stats = {}
        assert len(y_d_gs) == len(y_d_rs) == len(self.discriminators)
        with torch.amp.autocast('cuda', enabled=False):
            d_loss = 0.0
            for dr, dg, name in zip(y_d_rs, y_d_gs, self.discriminator_names):
                if self.san:
                    dr_fun, dr_dir = map(lambda x: x.float(), dr)
                    dg_fun, dg_dir = map(lambda x: x.float(), dg)
                    r_loss_fun = F.softplus(1.0 - dr_fun).square().mean()
                    g_loss_fun = F.softplus(dg_fun).square().mean()
                    r_loss_dir = F.softplus(1.0 - dr_dir).square().mean()
                    g_loss_dir = -F.softplus(1.0 - dg_dir).square().mean()
                    r_loss = r_loss_fun + r_loss_dir
                    g_loss = g_loss_fun + g_loss_dir
                else:
                    dr = dr.float()
                    dg = dg.float()
                    r_loss = (1.0 - dr).square().mean()
                    g_loss = dg.square().mean()
                stats[f'{name}_dr_loss'] = r_loss.item()
                stats[f'{name}_dg_loss'] = g_loss.item()
                d_loss += r_loss + g_loss
            adv_loss = 0.0
            for dg, name in zip(y_d_gs, self.discriminator_names):
                if self.san:
                    dg_fun = dg[0].float()
                    g_loss = F.softplus(1.0 - dg_fun).square().mean()
                else:
                    dg = dg.float()
                    g_loss = (1.0 - dg).square().mean()
                stats[f'{name}_gg_loss'] = g_loss.item()
                adv_loss += g_loss
            fm_loss = 0.0
            for fr, fg, name in zip(fmap_rs, fmap_gs, self.discriminator_names):
                fm_loss_i = 0.0
                for j, (r, g) in enumerate(zip(fr, fg)):
                    fm_loss_ij = (r.detach().float() - g.float()).abs().mean()
                    stats[f'~{name}_fm_loss_{j}'] = fm_loss_ij.item()
                    fm_loss_i += fm_loss_ij
                stats[f'{name}_fm_loss'] = fm_loss_i.item()
                fm_loss += fm_loss_i
        return (d_loss, adv_loss, fm_loss, stats)

class GradBalancer:
    """Adapted from https://github.com/facebookresearch/encodec/blob/main/encodec/balancer.py"""

    def __init__(self, weights: dict[str, float], rescale_grads: bool=True, total_norm: float=1.0, ema_decay: float=0.999, per_batch_item: bool=True):
        self.weights = weights
        self.per_batch_item = per_batch_item
        self.total_norm = total_norm
        self.ema_decay = ema_decay
        self.rescale_grads = rescale_grads
        self.ema_total: dict[str, float] = defaultdict(float)
        self.ema_fix: dict[str, float] = defaultdict(float)

    def backward(self, losses: dict[str, torch.Tensor], input: torch.Tensor, scaler: Optional[torch.amp.GradScaler]=None, skip_update_ema: bool=False) -> dict[str, float]:
        stats = {}
        if skip_update_ema:
            assert len(losses) == len(self.ema_total)
            ema_norms = {k: tot / self.ema_fix[k] for k, tot in self.ema_total.items()}
        else:
            norms = {}
            grads = {}
            for name, loss in losses.items():
                if scaler is not None:
                    loss = scaler.scale(loss)
                grad, = torch.autograd.grad(loss, [input], retain_graph=True)
                if not grad.isfinite().all():
                    input.backward(grad)
                    return {}
                grad = grad.detach() / (1.0 if scaler is None else scaler.get_scale())
                if self.per_batch_item:
                    dims = tuple(range(1, grad.dim()))
                    ema_norm = grad.norm(dim=dims).mean()
                else:
                    ema_norm = grad.norm()
                norms[name] = float(ema_norm)
                grads[name] = grad
            for key, value in norms.items():
                self.ema_total[key] = self.ema_total[key] * self.ema_decay + value
                self.ema_fix[key] = self.ema_fix[key] * self.ema_decay + 1.0
            ema_norms = {k: tot / self.ema_fix[k] for k, tot in self.ema_total.items()}
            total_ema_norm = sum(ema_norms.values())
            for k, ema_norm in ema_norms.items():
                stats[f'grad_norm_value_{k}'] = ema_norm
                stats[f'grad_norm_ratio_{k}'] = ema_norm / (total_ema_norm + 1e-12)
        if self.rescale_grads:
            total_weights = sum([self.weights[k] for k in ema_norms])
            ratios = {k: w / total_weights for k, w in self.weights.items()}
        loss = 0.0
        for name, ema_norm in ema_norms.items():
            if self.rescale_grads:
                scale = ratios[name] * self.total_norm / (ema_norm + 1e-12)
            else:
                scale = self.weights[name]
            loss += (losses if skip_update_ema else grads)[name] * scale
        if scaler is not None:
            loss = scaler.scale(loss)
        if skip_update_ema:
            loss, = torch.autograd.grad(loss, [input])
        input.backward(loss)
        return stats

    def state_dict(self) -> dict[str, dict[str, float]]:
        return {'ema_total': dict(self.ema_total), 'ema_fix': dict(self.ema_fix)}

    def load_state_dict(self, state_dict):
        self.ema_total = defaultdict(float, state_dict['ema_total'])
        self.ema_fix = defaultdict(float, state_dict['ema_fix'])
