"""
NAFNet-lite RAW Joint Denoiser.

Architecture:
  Input  [N, 20, 320, 320]
    - Channels 0..7:  4 noisy RGGB + 4 per-pixel sigma maps
    - Channels 8..19: 12 MHC (multi-hypothesis context) channels

  Dual CFA-aware stems:
    stem_raw  : Conv2d(8,  16, 3, padding=1)
    stem_mhc  : Conv2d(12, 16, 3, padding=1)
    Concat → [N, 32, 320, 320]

  3-level NAFNet-lite encoder/decoder:
    Enc L0 : 4 NAFBlocks, width 32
    Enc L1 : PixelUnshuffle(2)→conv→width 64, 2 NAFBlocks
    Enc L2 : PixelUnshuffle(2)→conv→width 128, 2 NAFBlocks
    Middle : 8 NAFBlocks at width 128
    Dec L2 : PixelShuffle(2)→conv→width 64 + skip, 2 NAFBlocks
    Dec L1 : PixelShuffle(2)→conv→width 32 + skip, 2 NAFBlocks
    Dec L0 : 2 NAFBlocks

  Head: Conv2d(32, 12, 1)
  Output [N, 12, 320, 320]

Constraints:
  - No BatchNorm (ONNX-RT WebGPU compatibility)
  - Only conv, depthwise conv, add, mul, sigmoid, reshape ops
  - SimpleGate = channel split + multiply (no sigmoid)
  - Parameter count <= 4,000,000
"""

import torch
import torch.nn as nn


class NAFBlock(nn.Module):
    """
    NAFNet-lite building block.
    depthwise conv 3x3 → SimpleGate (channel split+multiply) → pointwise conv → skip.
    No normalization (lite version).
    """

    def __init__(self, channels: int) -> None:
        super().__init__()
        self.dw_conv = nn.Conv2d(channels, channels, 3, padding=1, groups=channels, bias=True)
        # gate expand: C → 2C for SimpleGate split
        self.pw1 = nn.Conv2d(channels, channels * 2, 1, bias=True)
        # project back: C → C
        self.pw2 = nn.Conv2d(channels, channels, 1, bias=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        x = self.dw_conv(x)
        x = self.pw1(x)              # [N, 2C, H, W]
        x_a, x_b = x.chunk(2, dim=1)  # SimpleGate: split
        x = x_a * x_b               # [N, C, H, W]
        x = self.pw2(x)
        return x + residual


def _make_blocks(n: int, channels: int) -> nn.Sequential:
    return nn.Sequential(*[NAFBlock(channels) for _ in range(n)])


class _Downsample(nn.Module):
    """PixelUnshuffle(2) + conv to target width."""

    def __init__(self, in_channels: int, out_channels: int) -> None:
        super().__init__()
        # PixelUnshuffle(2) multiplies channels by 4
        self.unshuffle = nn.PixelUnshuffle(2)
        self.conv = nn.Conv2d(in_channels * 4, out_channels, 1, bias=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.conv(self.unshuffle(x))


class _Upsample(nn.Module):
    """PixelShuffle(2) + conv to target width."""

    def __init__(self, in_channels: int, out_channels: int) -> None:
        super().__init__()
        # PixelShuffle(2) divides channels by 4; pre-expand then shuffle
        self.conv = nn.Conv2d(in_channels, out_channels * 4, 1, bias=True)
        self.shuffle = nn.PixelShuffle(2)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.shuffle(self.conv(x))


class RawJointDenoiser(nn.Module):
    """
    NAFNet-lite joint denoiser for RAW sensor + MHC context.

    Input:  [N, 20, 320, 320]
    Output: [N, 12, 320, 320]
    """

    W0 = 32    # base width
    W1 = 64
    W2 = 128

    def __init__(self) -> None:
        super().__init__()

        # --- Dual CFA-aware stems ---
        self.stem_raw = nn.Conv2d(8,  self.W0 // 2, 3, padding=1, bias=True)  # 16 ch
        self.stem_mhc = nn.Conv2d(12, self.W0 // 2, 3, padding=1, bias=True)  # 16 ch
        # concat → W0 = 32

        # --- Encoder ---
        self.enc0 = _make_blocks(4, self.W0)
        self.down0 = _Downsample(self.W0, self.W1)

        self.enc1 = _make_blocks(2, self.W1)
        self.down1 = _Downsample(self.W1, self.W2)

        self.enc2 = _make_blocks(2, self.W2)

        # --- Middle ---
        self.middle = _make_blocks(8, self.W2)

        # --- Decoder ---
        # up2: W2(80) → W1(160); skip from enc1 at 160px = W1 channels
        self.up2 = _Upsample(self.W2, self.W1)
        self.fuse2 = nn.Conv2d(self.W1 + self.W1, self.W1, 1, bias=True)
        self.dec2 = _make_blocks(2, self.W1)

        # up1: W1(160) → W0(320); skip from enc0 at 320px = W0 channels
        self.up1 = _Upsample(self.W1, self.W0)
        self.fuse1 = nn.Conv2d(self.W0 + self.W0, self.W0, 1, bias=True)
        self.dec1 = _make_blocks(2, self.W0)

        self.dec0 = _make_blocks(2, self.W0)

        # --- Head ---
        self.head = nn.Conv2d(self.W0, 12, 1, bias=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [N, 20, H, W]
        raw_noise = x[:, :8]   # channels 0..7
        mhc       = x[:, 8:]   # channels 8..19

        # Dual stems + concat
        feat = torch.cat([self.stem_raw(raw_noise), self.stem_mhc(mhc)], dim=1)  # [N,32,H,W]

        # Encoder
        # s0: full-res skip (320, W0=32)
        s0 = self.enc0(feat)                       # [N,32,H,W]
        # s1: half-res skip (160, W1=64)
        s1 = self.enc1(self.down0(s0))             # [N,64,H/2,W/2]
        # bottleneck level
        bot = self.enc2(self.down1(s1))            # [N,128,H/4,W/4]

        # Middle
        m = self.middle(bot)                       # [N,128,H/4,W/4]

        # Decoder L2: upsample from H/4 → H/2, fuse with s1 skip (H/2)
        d2 = self.up2(m)                           # [N,64,H/2,W/2]
        d2 = self.fuse2(torch.cat([d2, s1], dim=1))  # [N,W1+W1,H/2,W/2]→W1
        d2 = self.dec2(d2)

        # Decoder L1: upsample from H/2 → H, fuse with s0 skip (H)
        d1 = self.up1(d2)                          # [N,32,H,W]
        d1 = self.fuse1(torch.cat([d1, s0], dim=1))  # [N,W0+W0,H,W]→W0
        d1 = self.dec1(d1)

        # Decoder L0: final refine (no extra skip needed)
        d0 = self.dec0(d1)

        return self.head(d0)                       # [N,12,H,W]
