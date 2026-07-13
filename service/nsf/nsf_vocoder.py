"""PC-NSF-HiFiGAN vocoder — vendored inference core (spike lane).

Verbatim port of OpenVPI DiffSinger `modules/nsf_hifigan/{models,nvSTFT,env,utils}.py`
(Apache-2.0), merged into one self-contained module with the training-only imports
(`lightning`, `matplotlib`) stripped. This is inference-only: load a checkpoint, extract a
mel with the EXACT config the model trained on, and resynthesize a waveform from
(mel, F0) — the pitch is an explicit input, so a corrected F0 re-sings at the new pitch
with formant preservation.

The WEIGHTS this drives are CC BY-NC-SA (non-commercial) — this is a spike/owner-only
lane, never shipped (see docs/superpowers/specs/2026-07-12-pc-nsf-hifigan-spike-design.md).
"""
from __future__ import annotations

import json
import pathlib

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from librosa.filters import mel as librosa_mel_fn
from torch.nn import Conv1d, ConvTranspose1d
from torch.nn.utils import remove_weight_norm, weight_norm

LRELU_SLOPE = 0.1


# ── helpers (env.py + utils.py, matplotlib stripped) ──────────────────────────────────
class AttrDict(dict):
    def __init__(self, *args, **kwargs):
        dict.__init__(self, *args, **kwargs)
        self.__dict__ = self

    def __getitem__(self, name):
        return super().__getitem__(name) if name in super().keys() else None

    __getattr__ = __getitem__


def init_weights(m, mean=0.0, std=0.01):
    if m.__class__.__name__.find("Conv") != -1:
        m.weight.data.normal_(mean, std)


def get_padding(kernel_size, dilation=1):
    return int((kernel_size * dilation - dilation) / 2)


# ── mel extractor (nvSTFT.py) — the EXACT config the checkpoint expects ────────────────
def dynamic_range_compression_torch(x, C=1, clip_val=1e-5):
    return torch.log(torch.clamp(x, min=clip_val) * C)


class STFT:
    def __init__(self, sr=44100, n_mels=128, n_fft=2048, win_size=2048, hop_length=512,
                 fmin=40, fmax=16000, clip_val=1e-5, device=None):
        self.target_sr = sr
        self.n_mels, self.n_fft, self.win_size, self.hop_length = n_mels, n_fft, win_size, hop_length
        self.fmin, self.fmax, self.clip_val = fmin, fmax, clip_val
        self.device = device or torch.device("cpu")
        mel_basis = librosa_mel_fn(sr=sr, n_fft=n_fft, n_mels=n_mels, fmin=fmin, fmax=fmax)
        self.mel_basis = torch.from_numpy(mel_basis).float().to(self.device)

    def get_mel(self, y, center=False):
        window = torch.hann_window(self.win_size, device=self.device)
        pad = ((self.win_size - self.hop_length) // 2, (self.win_size - self.hop_length + 1) // 2)
        y = torch.nn.functional.pad(y.unsqueeze(1), pad, mode="reflect").squeeze(1)
        spec = torch.stft(y, self.n_fft, hop_length=self.hop_length, win_length=self.win_size,
                          window=window, center=center, pad_mode="reflect", normalized=False,
                          onesided=True, return_complex=True).abs()
        spec = torch.matmul(self.mel_basis, spec)
        return dynamic_range_compression_torch(spec, clip_val=self.clip_val)


# ── generator (models.py) ─────────────────────────────────────────────────────────────
class ResBlock1(torch.nn.Module):
    def __init__(self, h, channels, kernel_size=3, dilation=(1, 3, 5)):
        super().__init__()
        self.convs1 = nn.ModuleList([
            weight_norm(Conv1d(channels, channels, kernel_size, 1, dilation=d,
                               padding=get_padding(kernel_size, d))) for d in dilation])
        self.convs1.apply(init_weights)
        self.convs2 = nn.ModuleList([
            weight_norm(Conv1d(channels, channels, kernel_size, 1, dilation=1,
                               padding=get_padding(kernel_size, 1))) for _ in range(3)])
        self.convs2.apply(init_weights)

    def forward(self, x):
        for c1, c2 in zip(self.convs1, self.convs2):
            xt = c2(F.leaky_relu(c1(F.leaky_relu(x, LRELU_SLOPE)), LRELU_SLOPE))
            x = xt + x
        return x

    def remove_weight_norm(self):
        for l in (*self.convs1, *self.convs2):
            remove_weight_norm(l)


class ResBlock2(torch.nn.Module):
    def __init__(self, h, channels, kernel_size=3, dilation=(1, 3)):
        super().__init__()
        self.convs = nn.ModuleList([
            weight_norm(Conv1d(channels, channels, kernel_size, 1, dilation=d,
                               padding=get_padding(kernel_size, d))) for d in dilation])
        self.convs.apply(init_weights)

    def forward(self, x):
        for c in self.convs:
            x = c(F.leaky_relu(x, LRELU_SLOPE)) + x
        return x

    def remove_weight_norm(self):
        for l in self.convs:
            remove_weight_norm(l)


class Generator(torch.nn.Module):
    def __init__(self, h):
        super().__init__()
        self.h = h
        self.num_kernels = len(h.resblock_kernel_sizes)
        self.num_upsamples = len(h.upsample_rates)
        self.mini_nsf = h.mini_nsf
        self.noise_sigma = h.noise_sigma
        if h.mini_nsf:
            self.source_sr = h.sampling_rate / int(np.prod(h.upsample_rates[2:]))
            self.upp = int(np.prod(h.upsample_rates[:2]))
        else:
            raise NotImplementedError("only mini_nsf checkpoints are vendored for the spike")
        self.conv_pre = weight_norm(Conv1d(h.num_mels, h.upsample_initial_channel, 7, 1, padding=3))
        self.ups = nn.ModuleList()
        self.resblocks = nn.ModuleList()
        resblock = ResBlock1 if h.resblock == "1" else ResBlock2
        ch = h.upsample_initial_channel
        for i, (u, k) in enumerate(zip(h.upsample_rates, h.upsample_kernel_sizes)):
            ch //= 2
            self.ups.append(weight_norm(ConvTranspose1d(2 * ch, ch, k, u, padding=(k - u) // 2)))
            for j, (k2, d) in enumerate(zip(h.resblock_kernel_sizes, h.resblock_dilation_sizes)):
                self.resblocks.append(resblock(h, ch, k2, d))
            if i == 1:
                self.source_conv = Conv1d(1, ch, 1)
                self.source_conv.apply(init_weights)
        self.conv_post = weight_norm(Conv1d(ch, 1, 7, 1, padding=3))
        self.ups.apply(init_weights)
        self.conv_post.apply(init_weights)

    def fastsinegen(self, f0):
        n = torch.arange(1, self.upp + 1, device=f0.device)
        s0 = f0.unsqueeze(-1) / self.source_sr
        ds0 = F.pad(s0[:, 1:, :] - s0[:, :-1, :], (0, 0, 0, 1))
        rad = s0 * n + 0.5 * ds0 * n * (n - 1) / self.upp
        rad2 = torch.fmod(rad[..., -1:].float() + 0.5, 1.0) - 0.5
        rad_acc = rad2.cumsum(dim=1).fmod(1.0).to(f0)
        rad += F.pad(rad_acc[:, :-1, :], (0, 0, 1, 0))
        rad = rad.reshape(f0.shape[0], 1, -1)
        return torch.sin(2 * np.pi * rad)

    def forward(self, x, f0):
        har_source = self.fastsinegen(f0)
        x = self.conv_pre(x)
        if self.noise_sigma is not None and self.noise_sigma > 0:
            x = x + self.noise_sigma * torch.randn_like(x)
        for i in range(self.num_upsamples):
            x = self.ups[i](F.leaky_relu(x, LRELU_SLOPE))
            if i == 1:
                x = x + self.source_conv(har_source)
            xs = None
            for j in range(self.num_kernels):
                blk = self.resblocks[i * self.num_kernels + j](x)
                xs = blk if xs is None else xs + blk
            x = xs / self.num_kernels
        return torch.tanh(self.conv_post(F.leaky_relu(x)))

    def remove_weight_norm(self):
        for l in self.ups:
            remove_weight_norm(l)
        for l in self.resblocks:
            l.remove_weight_norm()
        remove_weight_norm(self.conv_pre)
        remove_weight_norm(self.conv_post)


def load_model(model_path):
    model_path = pathlib.Path(model_path)
    h = AttrDict(json.loads(model_path.with_name("config.json").read_text()))
    generator = Generator(h)
    cp = torch.load(model_path, map_location="cpu", weights_only=False)
    generator.load_state_dict(cp["generator"])
    generator.eval()
    generator.remove_weight_norm()
    return generator, h
