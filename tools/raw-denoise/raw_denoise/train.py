"""
Training script for RawJointDenoiser.

This module implements the training loop infrastructure.
Actual training (400k steps, real camera data) is an offline task
requiring physical camera hardware and GPU time.

Usage
-----
    from raw_denoise.train import train, default_config
    train(default_config())

Loss functions
--------------
    charbonnier_loss : smooth L1 approximation, robust to outliers.
    gradient_loss    : multi-scale Sobel edge preservation.
"""

from __future__ import annotations

import math
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingLR

from raw_denoise.model import RawJointDenoiser
from raw_denoise.dataset import SyntheticRawDataset


# ---------------------------------------------------------------------------
# Loss functions
# ---------------------------------------------------------------------------

def charbonnier_loss(
    pred: torch.Tensor,
    target: torch.Tensor,
    eps: float = 1e-3,
) -> torch.Tensor:
    """
    Charbonnier loss: mean(sqrt((pred - target)^2 + eps^2)).

    Smoother than L1 near zero; robust to outliers unlike L2.

    Args:
        pred:   Predicted tensor.
        target: Ground-truth tensor, same shape as pred.
        eps:    Smoothing constant (default 1e-3).

    Returns:
        Scalar loss tensor.
    """
    diff = pred - target
    return torch.mean(torch.sqrt(diff * diff + eps * eps))


def _sobel_gradients(x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Compute Sobel gradients along H and W axes."""
    # Sobel kernels
    kx = torch.tensor(
        [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]],
        dtype=x.dtype,
        device=x.device,
    ).view(1, 1, 3, 3)
    ky = kx.transpose(-1, -2)

    # Apply per-channel
    b, c, h, w = x.shape
    x_flat = x.view(b * c, 1, h, w)
    gx = F.conv2d(x_flat, kx, padding=1)
    gy = F.conv2d(x_flat, ky, padding=1)
    return gx.view(b, c, h, w), gy.view(b, c, h, w)


def gradient_loss(
    pred: torch.Tensor,
    target: torch.Tensor,
    scales: int = 3,
) -> torch.Tensor:
    """
    Multi-scale Sobel gradient magnitude difference.

    Computes |grad(pred)| - |grad(target)| across `scales` resolutions
    (each halved via average pooling) and returns the mean Charbonnier loss.

    Args:
        pred:   Predicted tensor [N, C, H, W].
        target: Ground-truth tensor, same shape.
        scales: Number of spatial scales (default 3).

    Returns:
        Scalar loss tensor.
    """
    loss = torch.tensor(0.0, device=pred.device, dtype=pred.dtype)
    p, t = pred, target
    for _ in range(scales):
        gx_p, gy_p = _sobel_gradients(p)
        gx_t, gy_t = _sobel_gradients(t)
        mag_p = torch.sqrt(gx_p * gx_p + gy_p * gy_p + 1e-8)
        mag_t = torch.sqrt(gx_t * gx_t + gy_t * gy_t + 1e-8)
        loss = loss + charbonnier_loss(mag_p, mag_t)
        # Downsample for next scale
        p = F.avg_pool2d(p, 2, 2)
        t = F.avg_pool2d(t, 2, 2)
    return loss / scales


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def default_config() -> dict[str, Any]:
    """Return the default training configuration dict."""
    return {
        "seed": 20260710,
        "device": "cuda" if torch.cuda.is_available() else "cpu",
        "batch_size": 8,
        "max_steps": 400_000,
        "lr": 2e-4,
        "betas": (0.9, 0.99),
        "weight_decay": 1e-4,
        "grad_clip": 1.0,
        "log_every": 500,
        "save_every": 10_000,
        "loss_weights": {
            "charbonnier": 1.0,
            "gradient": 0.10,
        },
        "num_workers": 4,
    }


# ---------------------------------------------------------------------------
# Training loop
# ---------------------------------------------------------------------------

def train(config: dict[str, Any]) -> None:
    """
    Main training loop for RawJointDenoiser.

    This function is a complete implementation stub.  It runs correctly on
    synthetic data (for integration tests) and is designed for production
    training with real camera burst data.

    Args:
        config: Dictionary produced by default_config() or overrides.
    """
    seed = config["seed"]
    torch.manual_seed(seed)

    device = torch.device(config["device"])

    # --- Model ---
    model = RawJointDenoiser().to(device)

    # --- Optimiser ---
    optimizer = AdamW(
        model.parameters(),
        lr=config["lr"],
        betas=config["betas"],
        weight_decay=config["weight_decay"],
    )

    # --- LR Scheduler ---
    scheduler = CosineAnnealingLR(optimizer, T_max=config["max_steps"])

    # --- Dataset ---
    dataset = SyntheticRawDataset(
        num_samples=max(config["batch_size"] * 4, 64),
        seed=seed,
    )
    loader = torch.utils.data.DataLoader(
        dataset,
        batch_size=config["batch_size"],
        shuffle=True,
        num_workers=0,  # 0 for Windows compatibility; set via config in production
        drop_last=True,
    )

    # --- Loss weights ---
    w_char = config["loss_weights"]["charbonnier"]
    w_grad = config["loss_weights"]["gradient"]
    grad_clip: float = config.get("grad_clip", 1.0)

    # --- Training loop ---
    model.train()
    step = 0
    data_iter = iter(loader)

    while step < config["max_steps"]:
        # Reload loader when exhausted
        try:
            x, y_true = next(data_iter)
        except StopIteration:
            data_iter = iter(loader)
            x, y_true = next(data_iter)

        x = x.to(device)
        y_true = y_true.to(device)

        # --- Resize target to match model output (320×320) ---
        # The dataset returns [12, 256, 256] targets (halo-stripped).
        # For training, upsample to model output size 320×320, or crop
        # the model output. We crop the model output's center to match.
        y_pred = model(x)                           # [N, 12, 320, 320]
        halo = (y_pred.shape[-1] - y_true.shape[-1]) // 2
        if halo > 0:
            y_pred = y_pred[..., halo : halo + y_true.shape[-1], halo : halo + y_true.shape[-1]]

        # --- Loss ---
        loss_char = charbonnier_loss(y_pred, y_true)
        loss_grad = gradient_loss(y_pred, y_true)
        loss = w_char * loss_char + w_grad * loss_grad

        # --- Backprop ---
        optimizer.zero_grad()
        loss.backward()
        if grad_clip > 0:
            nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
        optimizer.step()
        scheduler.step()

        step += 1

        if step % config["log_every"] == 0 or step == 1:
            lr_now = scheduler.get_last_lr()[0]
            print(
                f"step={step:>7d}  loss={loss.item():.6f}  "
                f"char={loss_char.item():.6f}  grad={loss_grad.item():.6f}  "
                f"lr={lr_now:.2e}"
            )

        if step % config["save_every"] == 0:
            ckpt = {
                "step": step,
                "model_state_dict": model.state_dict(),
                "optimizer_state_dict": optimizer.state_dict(),
                "scheduler_state_dict": scheduler.state_dict(),
                "config": config,
            }
            torch.save(ckpt, f"checkpoint_step{step:07d}.pt")

    print(f"Training complete after {step} steps.")
