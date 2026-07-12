"""
Contract tests for RawJointDenoiser.

All assertions are against the spec in Task 9:
  - Input  [N, 20, 320, 320]
  - Output [N, 12, 320, 320]
  - Deterministic: same input → same output
  - Parameter count <= 4_000_000
  - No BatchNorm (forbidden for ONNX-RT WebGPU)
  - Finite gradients on forward + backward
"""
import torch
import torch.nn as nn
import pytest

from raw_denoise.model import RawJointDenoiser


def _make_input(seed: int = 0, n: int = 1) -> torch.Tensor:
    g = torch.Generator()
    g.manual_seed(seed)
    return torch.randn(n, 20, 320, 320, generator=g)


class TestShapeContract:
    def test_output_shape_n1(self):
        model = RawJointDenoiser()
        model.eval()
        with torch.no_grad():
            y = model(_make_input())
        assert y.shape == (1, 12, 320, 320), f"expected (1,12,320,320) got {y.shape}"

    def test_output_shape_n2(self):
        model = RawJointDenoiser()
        model.eval()
        with torch.no_grad():
            y = model(_make_input(n=2))
        assert y.shape == (2, 12, 320, 320), f"expected (2,12,320,320) got {y.shape}"


class TestDeterminism:
    def test_same_input_same_output(self):
        model = RawJointDenoiser()
        model.eval()
        x = _make_input(seed=42)
        with torch.no_grad():
            y1 = model(x)
            y2 = model(x)
        assert torch.allclose(y1, y2), "Model is not deterministic for same input"


class TestParameterCount:
    def test_param_count_le_4m(self):
        model = RawJointDenoiser()
        count = sum(p.numel() for p in model.parameters())
        assert count <= 4_000_000, f"Parameter count {count} exceeds 4,000,000"


class TestNoBatchNorm:
    def test_no_batchnorm_layers(self):
        model = RawJointDenoiser()
        for name, module in model.named_modules():
            assert not isinstance(module, (nn.BatchNorm1d, nn.BatchNorm2d, nn.BatchNorm3d)), \
                f"Found BatchNorm layer at '{name}' — forbidden for ONNX-RT WebGPU"


class TestGradients:
    def test_finite_gradients(self):
        model = RawJointDenoiser()
        model.train()
        x = _make_input(seed=7)
        y = model(x)
        loss = y.sum()
        loss.backward()
        for name, p in model.named_parameters():
            if p.grad is not None:
                assert torch.isfinite(p.grad).all(), f"Non-finite gradient for param '{name}'"
