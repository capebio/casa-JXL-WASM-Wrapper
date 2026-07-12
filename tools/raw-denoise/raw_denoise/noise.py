"""
Noise synthesis primitives for RAW sensor data.

All functions operate on numpy arrays with float32 dtype.
"""

from __future__ import annotations

import numpy as np


def add_poisson_gaussian(
    clean: np.ndarray,
    shot: float,
    read: float,
    rng: np.random.Generator,
) -> np.ndarray:
    """
    Add heteroscedastic Poisson-Gaussian noise.

    Model:  noisy = clean + n,  where Var[n|x] = shot * max(x, 0) + read

    Implemented as:
      1. Shot noise:  Gaussian with std = sqrt(shot * max(x, 0))
      2. Read noise:  Gaussian with std = sqrt(read)

    Args:
        clean: Clean normalised RAW patch, float32, any shape.
        shot:  Shot-noise coefficient (>=0).
        read:  Read-noise floor (>=0).
        rng:   NumPy Generator for reproducibility.

    Returns:
        Noisy patch, same shape and dtype as clean.
    """
    clean = np.asarray(clean, dtype=np.float32)
    shot_std = np.sqrt(np.maximum(clean, 0.0) * shot).astype(np.float32)
    read_std = float(np.sqrt(read))

    shot_noise = rng.standard_normal(clean.shape).astype(np.float32) * shot_std
    read_noise = (rng.standard_normal(clean.shape) * read_std).astype(np.float32)

    return (clean + shot_noise + read_noise).astype(np.float32)


def per_pixel_sigma_map(
    raw_f32: np.ndarray,
    shot: float,
    read: float,
) -> np.ndarray:
    """
    Compute per-pixel noise standard deviation.

    sigma(x) = sqrt(shot * max(x, 0) + read)

    Args:
        raw_f32: Normalised RAW patch, float32.
        shot:    Shot-noise coefficient.
        read:    Read-noise floor.

    Returns:
        Sigma map, same shape and float32 dtype.
    """
    raw_f32 = np.asarray(raw_f32, dtype=np.float32)
    return np.sqrt(np.maximum(raw_f32, 0.0) * shot + read).astype(np.float32)


def bayer_safe_augment(
    patch_raw: np.ndarray,
    patch_rgb: np.ndarray,
    flip_h: bool,
    flip_v: bool,
    rot90: int,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Augment a RAW patch while preserving Bayer CFA pattern alignment.

    The Bayer pattern has a 2×2 period. Safe augmentations are those that
    keep each pixel at an even offset from the top-left corner of the CFA:
      - Identity (no op)
      - flip_h only: safe when patch width is even (column parity preserved)
      - flip_v only: safe when patch height is even (row parity preserved)
      - flip_h + flip_v: 180° rotation, always safe (both parities preserved)
      - rot90 in {0, 2}: 0° or 180°, safe; rot90 in {1, 3} shifts Bayer phase

    Flips and rot90 are applied in order: flip_h → flip_v → rot90.
    The spatial axes are assumed to be the last two (C, H, W) layout.

    Args:
        patch_raw: [C_raw, H, W] float32 array.
        patch_rgb: [C_rgb, H, W] float32 array.
        flip_h:    If True, flip horizontally (last axis).
        flip_v:    If True, flip vertically (second-to-last axis).
        rot90:     Number of 90° counter-clockwise rotations (0..3).
                   Only 0 and 2 preserve Bayer alignment; 1 and 3 are allowed
                   by the API but callers should avoid them for aligned data.

    Returns:
        Tuple (augmented_raw, augmented_rgb), same shapes as inputs.
    """
    out_raw = patch_raw.copy()
    out_rgb = patch_rgb.copy()

    if flip_h:
        out_raw = np.flip(out_raw, axis=-1)
        out_rgb = np.flip(out_rgb, axis=-1)

    if flip_v:
        out_raw = np.flip(out_raw, axis=-2)
        out_rgb = np.flip(out_rgb, axis=-2)

    if rot90 % 4 != 0:
        out_raw = np.rot90(out_raw, k=rot90, axes=(-2, -1))
        out_rgb = np.rot90(out_rgb, k=rot90, axes=(-2, -1))

    return np.ascontiguousarray(out_raw), np.ascontiguousarray(out_rgb)
