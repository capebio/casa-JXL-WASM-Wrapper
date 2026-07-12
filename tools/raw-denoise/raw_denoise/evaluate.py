"""
Artifact gates for the RAW denoise model.

evaluate_model() verifies the artifact hash and checks release quality gates.
Gates that require holdout camera data return None when called without a manifest;
the size and hash gates always run.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any


def verify_hash(model_path: str, manifest_path: str) -> bool:
    """
    Recompute the SHA-256 of model_path and compare to the value stored in
    the manifest at manifest_path.

    Returns True if the hashes match, False otherwise (including any I/O error).
    """
    try:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
        expected = manifest.get("sha256", "")
    except (OSError, json.JSONDecodeError, KeyError):
        return False

    h = hashlib.sha256()
    try:
        with open(model_path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
    except OSError:
        return False

    return h.hexdigest() == expected


def evaluate_model(
    model_path: str,
    manifest_path: str,
    holdout_manifest: str | None = None,
) -> dict[str, Any]:
    """
    Evaluate a model artifact and check release gates.

    Args:
        model_path:        Path to the .ort artifact.
        manifest_path:     Path to the JSON manifest produced by export_model().
        holdout_manifest:  Path to a holdout data manifest (optional).
                           If None, data-dependent gates return None.

    Returns:
        Dict with gate results.  Keys that require holdout data are None when
        holdout_manifest is not provided.
    """
    # ---- Gates that always run ----
    try:
        artifact_size = os.path.getsize(model_path)
    except OSError:
        artifact_size = -1

    artifact_size_ok = 0 < artifact_size <= 8 * 1024 * 1024  # 8 MiB limit

    hash_ok = verify_hash(model_path, manifest_path)

    # ---- Gates that require holdout data ----
    # These are stubs; fill in when offline training produces real weights
    # and a holdout manifest is available.
    if holdout_manifest is not None:
        # TODO: load holdout images, run inference, compute PSNR/SSIM/MTF50/ΔE00
        psnr_gain: float | None = None
        ssim_no_regression: bool | None = None
        mtf50_retention_pct: float | None = None
        delta_e00_regression: bool | None = None
    else:
        psnr_gain = None
        ssim_no_regression = None
        mtf50_retention_pct = None
        delta_e00_regression = None

    return {
        "psnr_gain_over_gaussian_db": psnr_gain,
        "ssim_no_regression": ssim_no_regression,
        "mtf50_retention_pct": mtf50_retention_pct,
        "delta_e00_regression": delta_e00_regression,
        "artifact_size_bytes": artifact_size,
        "artifact_size_ok": artifact_size_ok,
        "hash_verified": hash_ok,
    }
