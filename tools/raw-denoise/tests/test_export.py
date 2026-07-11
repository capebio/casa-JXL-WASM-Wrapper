"""
Parity tests for export_model().

Validates that PyTorch and ONNX Runtime (CPU) produce numerically identical
output for the same fixed-seed model and input:
  - max absolute error  <= 2e-4
  - mean absolute error <= 2e-5

Also checks that the manifest is well-formed and the hash gate passes.
"""

from __future__ import annotations

import json
import os
import tempfile

import numpy as np
import pytest
import torch

from raw_denoise.model import RawJointDenoiser
from raw_denoise.export import export_model
from raw_denoise.evaluate import evaluate_model, verify_hash


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def exported_artifact(tmp_path_factory: pytest.TempPathFactory):
    """
    Build a miniature (random-weights) model, export it once, and return
    (ort_path, manifest_path, torch_output).
    """
    tmp = tmp_path_factory.mktemp("export_test")
    ort_path = str(tmp / "model.ort")
    manifest_path = str(tmp / "manifest.json")

    torch.manual_seed(20260710)
    model = RawJointDenoiser()
    model.eval()

    # Compute PyTorch reference output
    g = torch.Generator()
    g.manual_seed(42)
    x = torch.randn(1, 20, 320, 320, generator=g)

    with torch.no_grad():
        pt_out = model(x).numpy()

    manifest = export_model(
        model,
        ort_path,
        manifest_path,
        quality_metrics={
            "note": "development-artifact-random-weights-no-training"
        },
    )

    return ort_path, manifest_path, manifest, x.numpy(), pt_out


# ---------------------------------------------------------------------------
# Parity tests
# ---------------------------------------------------------------------------

def _ort_session_from_ort_file(ort_path: str):
    """
    Load an ORT inference session from an .ort artifact file.

    onnxruntime treats .ort extensions as ORT-flatbuffer format; our artifact
    is standard ONNX protobuf bytes renamed to .ort for the JS runtime.  Load
    via raw bytes to bypass the extension-based format detection.
    """
    import onnxruntime as ort
    with open(ort_path, "rb") as f:
        model_bytes = f.read()
    return ort.InferenceSession(model_bytes, providers=["CPUExecutionProvider"])


class TestOnnxParity:
    def test_ort_output_shape(self, exported_artifact):
        ort_path, _, _, x_np, _ = exported_artifact
        sess = _ort_session_from_ort_file(ort_path)
        out = sess.run(None, {"input": x_np})
        assert out[0].shape == (1, 12, 320, 320)

    def test_max_abs_error_le_2e4(self, exported_artifact):
        ort_path, _, _, x_np, pt_out = exported_artifact
        sess = _ort_session_from_ort_file(ort_path)
        ort_out = sess.run(None, {"input": x_np})[0]
        max_err = float(np.max(np.abs(pt_out - ort_out)))
        assert max_err <= 2e-4, (
            f"Max absolute error {max_err:.3e} exceeds threshold 2e-4"
        )

    def test_mean_abs_error_le_2e5(self, exported_artifact):
        ort_path, _, _, x_np, pt_out = exported_artifact
        sess = _ort_session_from_ort_file(ort_path)
        ort_out = sess.run(None, {"input": x_np})[0]
        mean_err = float(np.mean(np.abs(pt_out - ort_out)))
        assert mean_err <= 2e-5, (
            f"Mean absolute error {mean_err:.3e} exceeds threshold 2e-5"
        )


# ---------------------------------------------------------------------------
# Manifest tests
# ---------------------------------------------------------------------------

class TestManifest:
    def test_manifest_schema_version(self, exported_artifact):
        _, manifest_path, manifest, _, _ = exported_artifact
        assert manifest["schemaVersion"] == 1

    def test_manifest_model_version(self, exported_artifact):
        _, _, manifest, _, _ = exported_artifact
        assert manifest["modelVersion"] == "raw-denoise-v1"

    def test_manifest_input_shape(self, exported_artifact):
        _, _, manifest, _, _ = exported_artifact
        assert manifest["inputShape"] == [1, 20, 320, 320]

    def test_manifest_output_shape(self, exported_artifact):
        _, _, manifest, _, _ = exported_artifact
        assert manifest["outputShape"] == [1, 12, 320, 320]

    def test_manifest_sha256_present(self, exported_artifact):
        _, _, manifest, _, _ = exported_artifact
        sha = manifest.get("sha256", "")
        assert isinstance(sha, str) and len(sha) == 64

    def test_manifest_file_roundtrip(self, exported_artifact):
        _, manifest_path, manifest_obj, _, _ = exported_artifact
        with open(manifest_path, encoding="utf-8") as f:
            loaded = json.load(f)
        assert loaded == manifest_obj

    def test_manifest_halo_and_core(self, exported_artifact):
        _, _, manifest, _, _ = exported_artifact
        assert manifest["haloPixels"] == 32
        assert manifest["coreSize"] == 256

    def test_manifest_channel_ranges(self, exported_artifact):
        _, _, manifest, _, _ = exported_artifact
        ch = manifest["inputChannels"]
        assert ch["raw_rggb"] == [0, 1, 2, 3]
        assert ch["sigma_maps"] == [4, 5, 6, 7]
        assert ch["mhc_rgb_packed"] == list(range(8, 20))


# ---------------------------------------------------------------------------
# evaluate_model gate tests
# ---------------------------------------------------------------------------

class TestEvaluateGates:
    def test_hash_verified(self, exported_artifact):
        ort_path, manifest_path, _, _, _ = exported_artifact
        gates = evaluate_model(ort_path, manifest_path)
        assert gates["hash_verified"] is True

    def test_artifact_size_ok(self, exported_artifact):
        ort_path, manifest_path, _, _, _ = exported_artifact
        gates = evaluate_model(ort_path, manifest_path)
        assert gates["artifact_size_ok"] is True
        assert gates["artifact_size_bytes"] > 0

    def test_data_gates_none_without_holdout(self, exported_artifact):
        ort_path, manifest_path, _, _, _ = exported_artifact
        gates = evaluate_model(ort_path, manifest_path)
        assert gates["psnr_gain_over_gaussian_db"] is None
        assert gates["ssim_no_regression"] is None
        assert gates["mtf50_retention_pct"] is None
        assert gates["delta_e00_regression"] is None

    def test_hash_fails_on_tampered_file(self, exported_artifact, tmp_path):
        ort_path, manifest_path, _, _, _ = exported_artifact
        tampered = str(tmp_path / "tampered.ort")
        with open(ort_path, "rb") as src, open(tampered, "wb") as dst:
            data = bytearray(src.read())
            data[-1] ^= 0xFF  # flip last byte
            dst.write(data)
        assert verify_hash(tampered, manifest_path) is False
