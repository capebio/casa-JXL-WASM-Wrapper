"""
Dataset classes for RAW joint denoiser training.

SyntheticRawDataset:
    Deterministic synthetic dataset using numpy RNG seeded per index.
    Suitable for tests and CI — no camera hardware required.

RealRawDataset (stub):
    Loads real RAW patches from a directory matching the dataset manifest
    schema at docs/denoise/dataset-manifest.schema.json.
    Not used in tests.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.utils.data

from raw_denoise.noise import add_poisson_gaussian, per_pixel_sigma_map


class SyntheticRawDataset(torch.utils.data.Dataset):
    """
    Fully synthetic training dataset for testing and integration.

    Each sample is generated deterministically from a per-index RNG seed
    so the dataset is reproducible and independent of global random state.

    Tensor layout
    -------------
    input_tensor  [20, 320, 320]:
        ch 0..3  : noisy RGGB (4 Bayer channels, each 80×80 packed as 320×320)
        ch 4..7  : per-pixel sigma maps for ch 0..3
        ch 8..19 : clean MHC RGB context (12 channels, 320×320)

    target_rgb    [12, 256, 256]:
        Clean RGB packed in 12 channels (halo stripped, 256×256 core)
        Layout: 4 groups of 3 (R, G, B), e.g. from 4 denoised frames.

    Args:
        num_samples: Dataset length (default 256).
        seed:        Base seed — sample i uses seed+i for full determinism.
        patch_size:  Spatial size of the model input (default 320).
        core_size:   Spatial size of the target after halo strip (default 256).
        shot:        Shot-noise coefficient (default 0.02).
        read:        Read-noise floor (default 0.005).
    """

    def __init__(
        self,
        num_samples: int = 256,
        seed: int = 20260710,
        patch_size: int = 320,
        core_size: int = 256,
        shot: float = 0.02,
        read: float = 0.005,
    ) -> None:
        super().__init__()
        self.num_samples = num_samples
        self.base_seed = seed
        self.patch_size = patch_size
        self.core_size = core_size
        self.shot = shot
        self.read = read

    def __len__(self) -> int:
        return self.num_samples

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor]:
        rng = np.random.default_rng(self.base_seed + idx)
        p = self.patch_size
        c = self.core_size

        # --- Clean RGGB: 4 channels, [0, 1] ---
        clean_rggb = rng.random((4, p, p), dtype=np.float32)

        # --- Noisy RGGB ---
        noisy_rggb = np.stack(
            [
                add_poisson_gaussian(clean_rggb[i], self.shot, self.read, rng)
                for i in range(4)
            ],
            axis=0,
        )  # [4, p, p]

        # --- Sigma maps ---
        sigma_maps = np.stack(
            [per_pixel_sigma_map(clean_rggb[i], self.shot, self.read) for i in range(4)],
            axis=0,
        )  # [4, p, p]

        # --- MHC context: 12 channels (simulate clean multi-hypothesis context) ---
        mhc = rng.random((12, p, p), dtype=np.float32)

        # --- Input tensor [20, p, p] ---
        input_np = np.concatenate([noisy_rggb, sigma_maps, mhc], axis=0)  # [20, p, p]
        input_tensor = torch.from_numpy(input_np)

        # --- Target: clean RGB core [12, c, c] ---
        # Halo strip: take the center core_size×core_size from clean_rggb
        halo = (p - c) // 2
        clean_core = clean_rggb[:, halo : halo + c, halo : halo + c]  # [4, c, c]
        # Simulate 3 RGB frames → 12 channels (4×RGB with slight variation)
        rgb_frames = []
        for _ in range(4):
            frame = np.stack(
                [
                    clean_core[0],                          # R from R channel
                    (clean_core[1] + clean_core[2]) / 2.0, # G average
                    clean_core[3],                          # B from B channel
                ],
                axis=0,
            )  # [3, c, c]
            rgb_frames.append(frame)
        target_np = np.concatenate(rgb_frames, axis=0).astype(np.float32)  # [12, c, c]
        target_tensor = torch.from_numpy(target_np)

        return input_tensor, target_tensor
