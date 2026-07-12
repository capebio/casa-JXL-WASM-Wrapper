"""
Export RawJointDenoiser to ONNX and write an .ort artifact + manifest.

Opset strategy
--------------
The plan spec targets opset 21.  The legacy TorchScript exporter bundled with
torch 2.13.0 supports up to opset 20 (the dynamo path that reaches 21 requires
the onnxscript package, which is not pinned in the project).  We therefore
export at opset 20, which is fully supported by onnxruntime 1.27.0 and by the
onnxruntime-web JS runtime used in-browser.  The opset is noted in the manifest
so a future re-export can bump it once onnxscript is added to the environment.

ORT file format
---------------
`onnxruntime.InferenceSession` treats files with a `.ort` extension as
ORT-flatbuffer format, not standard ONNX protobuf.  Converting to real ORT
flatbuffer requires the `onnxruntime-training` wheel (not pinned).  We therefore:
  1. Export to a temp `.onnx` file and verify with ORT (using the `.onnx` path).
  2. Copy the verified ONNX bytes to the final `.ort` destination.
The JS onnxruntime-web runtime loads the file by its ArrayBuffer content, not its
extension, so it correctly handles standard ONNX protobuf from the `.ort` file.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from typing import Any

import torch
import onnxruntime as ort

# The legacy TorchScript ONNX path tops out at opset 20 in torch 2.13.
# Bump to 21 once onnxscript is pinned and dynamo export is enabled.
_OPSET_VERSION = 20


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def export_model(
    model: Any,
    output_path: str,
    manifest_path: str,
    **metadata: Any,
) -> dict[str, Any]:
    """
    Export RawJointDenoiser to ONNX (opset 20), verify with ORT, write .ort artifact.

    Args:
        model:          RawJointDenoiser instance (CPU, eval mode assumed).
        output_path:    Destination path for the .ort file (ONNX bytes, .ort extension).
        manifest_path:  Destination path for the JSON manifest.
        **metadata:     Optional fields: training_manifest_hash, git_commit,
                        quality_metrics.

    Returns:
        dict with the manifest contents (mirrors what was written to disk).
    """
    model.cpu()
    model.eval()

    dummy = torch.zeros(1, 20, 320, 320, dtype=torch.float32)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    # --- Export to a temp .onnx file, verify, then copy as .ort ---
    with tempfile.NamedTemporaryFile(suffix=".onnx", delete=False) as tmp:
        tmp_onnx = tmp.name

    try:
        with torch.no_grad():
            torch.onnx.export(
                model,
                (dummy,),
                tmp_onnx,
                input_names=["input"],
                output_names=["residual_rgb"],
                opset_version=_OPSET_VERSION,
                do_constant_folding=True,
                dynamo=False,  # legacy TorchScript path; dynamo requires onnxscript
            )

        # Verify: load the .onnx (not the .ort destination) so ORT uses the
        # protobuf path, not the flatbuffer/ORT-model path.
        sess = ort.InferenceSession(tmp_onnx, providers=["CPUExecutionProvider"])
        ort_out = sess.run(None, {"input": dummy.numpy()})
        assert ort_out[0].shape == (1, 12, 320, 320), (
            f"ORT output shape mismatch: {ort_out[0].shape}"
        )

        # Copy verified ONNX bytes to final .ort destination.
        shutil.copy2(tmp_onnx, output_path)
    finally:
        if os.path.exists(tmp_onnx):
            os.unlink(tmp_onnx)

    sha = _sha256_file(output_path)

    quality_metrics: dict[str, Any] = metadata.get("quality_metrics", {})

    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "modelVersion": "raw-denoise-v1",
        "inputShape": [1, 20, 320, 320],
        "outputShape": [1, 12, 320, 320],
        "haloPixels": 32,
        "coreSize": 256,
        "inputChannels": {
            "raw_rggb": [0, 1, 2, 3],
            "sigma_maps": [4, 5, 6, 7],
            "mhc_rgb_packed": [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
        },
        "outputChannels": {
            "residual_rgb_packed": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        },
        "normalization": {
            "rawRange": [-0.05, 1.25],
            "residualClamp": [-0.25, 0.25],
        },
        "onnxOpset": _OPSET_VERSION,
        "sha256": sha,
        "trainingManifestHash": metadata.get("training_manifest_hash", None),
        "gitCommit": metadata.get("git_commit", None),
        "qualityMetrics": quality_metrics,
    }

    os.makedirs(os.path.dirname(os.path.abspath(manifest_path)), exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    return manifest
