"""
CLI entry point for production training.

Run offline with a GPU and real burst-capture data:

    uv run python -m raw_denoise.train_cli \\
        --data-manifest /path/to/burst-manifest.json \\
        --output-dir    /path/to/checkpoints \\
        --steps         400000 \\
        --device        cuda

This script is intentionally thin — all training logic lives in train.py.
"""

from __future__ import annotations

import argparse

from .train import train


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Train RawJointDenoiser.  Requires GPU and real burst data.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--data-manifest",
        required=True,
        help="Path to JSON manifest listing training burst files.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory for checkpoints and final export.",
    )
    parser.add_argument(
        "--steps",
        type=int,
        default=400_000,
        help="Total training steps.",
    )
    parser.add_argument(
        "--device",
        default="cuda",
        help="PyTorch device string (e.g. 'cuda', 'cuda:1', 'cpu').",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=20260710,
        help="Global random seed for reproducibility.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=16,
        help="Training batch size (16 fits a 24 GB GPU at 320×320).",
    )
    parser.add_argument(
        "--lr",
        type=float,
        default=2e-4,
        help="Peak learning rate for AdamW + cosine schedule.",
    )
    args = parser.parse_args()

    train(
        {
            "seed": args.seed,
            "device": args.device,
            "max_steps": args.steps,
            "data_manifest": args.data_manifest,
            "output_dir": args.output_dir,
            "batch_size": args.batch_size,
            "lr": args.lr,
            # Carry train.py defaults for anything not exposed here
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
    )


if __name__ == "__main__":
    main()
