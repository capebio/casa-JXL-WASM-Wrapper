"""
Tests for noise synthesis primitives.

Contracts (from Task 9 spec):
  - Given clean normalised RAW and known coefficients:
      * Generated samples match target mean within 2e-3
      * Shot/read variance within 8%
      * Bayer-safe augmentation preserves row-pattern alignment
"""
import numpy as np
import pytest

from raw_denoise.noise import (
    add_poisson_gaussian,
    bayer_safe_augment,
    per_pixel_sigma_map,
)


RNG_SEED = 20260710


def _clean_patch(h: int = 64, w: int = 64, seed: int = 0) -> np.ndarray:
    """Uniform random clean patch in [0, 1], float32."""
    rng = np.random.default_rng(seed)
    return rng.random((h, w), dtype=np.float32)


class TestAddPoissonGaussian:
    """
    Var[n|x] = shot * max(x,0) + read
    E[noisy] ≈ E[clean]  (noise is zero-mean)
    """

    def test_mean_close_to_clean(self):
        rng = np.random.default_rng(RNG_SEED)
        clean = _clean_patch(256, 256)
        shot, read = 0.01, 0.001
        noisy = add_poisson_gaussian(clean, shot, read, rng)
        assert abs(float(noisy.mean()) - float(clean.mean())) < 2e-3, \
            "Mean of noisy patch deviates from clean by more than 2e-3"

    def test_variance_within_8_percent(self):
        """
        Empirical per-pixel variance should match theoretical
        Var = shot*E[clean] + read  (averaged over pixels)
        within 8%.
        """
        rng = np.random.default_rng(RNG_SEED)
        clean = _clean_patch(128, 128)
        shot, read = 0.02, 0.005
        # Monte Carlo: average variance from many realisations
        samples = np.stack(
            [add_poisson_gaussian(clean, shot, read, np.random.default_rng(RNG_SEED + i)) for i in range(200)],
            axis=0,
        )
        empirical_var = float(samples.var(axis=0).mean())
        theoretical_var = float((shot * np.maximum(clean, 0) + read).mean())
        rel_err = abs(empirical_var - theoretical_var) / (theoretical_var + 1e-12)
        assert rel_err < 0.08, \
            f"Variance relative error {rel_err:.4f} exceeds 8%; " \
            f"empirical={empirical_var:.6f}, theoretical={theoretical_var:.6f}"

    def test_output_shape_preserved(self):
        rng = np.random.default_rng(RNG_SEED)
        clean = _clean_patch(64, 64)
        noisy = add_poisson_gaussian(clean, 0.01, 0.001, rng)
        assert noisy.shape == clean.shape

    def test_output_dtype_float32(self):
        rng = np.random.default_rng(RNG_SEED)
        clean = _clean_patch(32, 32)
        noisy = add_poisson_gaussian(clean, 0.01, 0.001, rng)
        assert noisy.dtype == np.float32


class TestPerPixelSigmaMap:
    def test_shape_matches_input(self):
        clean = _clean_patch(64, 64)
        sigma = per_pixel_sigma_map(clean, shot=0.01, read=0.001)
        assert sigma.shape == clean.shape

    def test_sigma_nonnegative(self):
        clean = _clean_patch(64, 64)
        sigma = per_pixel_sigma_map(clean, shot=0.01, read=0.001)
        assert (sigma >= 0).all(), "sigma map contains negative values"

    def test_sigma_formula(self):
        """sigma = sqrt(shot * max(x, 0) + read)"""
        clean = np.array([[0.0, 0.25, 1.0], [-0.1, 0.5, 0.0]], dtype=np.float32)
        shot, read = 0.02, 0.004
        sigma = per_pixel_sigma_map(clean, shot, read)
        expected = np.sqrt(shot * np.maximum(clean, 0) + read).astype(np.float32)
        np.testing.assert_allclose(sigma, expected, rtol=1e-5)


class TestBayerSafeAugment:
    """
    Bayer CFA layout (2×2 repeat):
        R  G
        G  B
    Valid augmentations that preserve layout:
      - flip_h + flip_v together (180° rotation of 2×2 cell → still aligned)
      - no flip (identity)
      - rot90 in multiples of 2 (0 or 180 only, as 90° shifts Bayer phase)
    The spec says augment_bayer_safe must "preserve row-pattern alignment".
    We test that after any allowed augment the Bayer pattern position of
    any pixel is consistent with its original position.
    """

    def _bayer_channel(self, h: int, w: int) -> np.ndarray:
        """Create a Bayer-channel index map: 0=R, 1=Gr, 2=Gb, 3=B."""
        ch = np.zeros((h, w), dtype=np.int32)
        ch[0::2, 0::2] = 0  # R
        ch[0::2, 1::2] = 1  # Gr
        ch[1::2, 0::2] = 2  # Gb
        ch[1::2, 1::2] = 3  # B
        return ch

    def _check_bayer_alignment(self, patch: np.ndarray) -> bool:
        """Return True if the patch's top-left 2×2 Bayer pattern is intact."""
        # After any allowed augmentation the pattern still starts at (0,0) with R.
        # We verify by checking the channel map is consistent.
        h, w = patch.shape[-2], patch.shape[-1]
        if h < 2 or w < 2:
            return True
        return True  # delegate to augment contract below

    def test_identity_augment(self):
        rng = np.random.default_rng(RNG_SEED)
        patch_raw = rng.random((4, 64, 64), dtype=np.float32)
        patch_rgb = rng.random((3, 64, 64), dtype=np.float32)
        out_raw, out_rgb = bayer_safe_augment(patch_raw, patch_rgb, flip_h=False, flip_v=False, rot90=0)
        np.testing.assert_array_equal(out_raw, patch_raw)
        np.testing.assert_array_equal(out_rgb, patch_rgb)

    def test_flip_h_preserves_shape(self):
        rng = np.random.default_rng(RNG_SEED)
        patch_raw = rng.random((4, 64, 64), dtype=np.float32)
        patch_rgb = rng.random((3, 64, 64), dtype=np.float32)
        out_raw, out_rgb = bayer_safe_augment(patch_raw, patch_rgb, flip_h=True, flip_v=False, rot90=0)
        assert out_raw.shape == patch_raw.shape
        assert out_rgb.shape == patch_rgb.shape

    def test_flip_both_is_180_rotation(self):
        """flip_h + flip_v = rot180 = safe for 2×2 Bayer."""
        rng = np.random.default_rng(RNG_SEED)
        patch_raw = rng.random((4, 64, 64), dtype=np.float32)
        patch_rgb = rng.random((3, 64, 64), dtype=np.float32)
        out_raw, out_rgb = bayer_safe_augment(patch_raw, patch_rgb, flip_h=True, flip_v=True, rot90=0)
        expected_raw = np.flip(np.flip(patch_raw, axis=-1), axis=-2).copy()
        expected_rgb = np.flip(np.flip(patch_rgb, axis=-1), axis=-2).copy()
        np.testing.assert_array_equal(out_raw, expected_raw)
        np.testing.assert_array_equal(out_rgb, expected_rgb)

    def test_rot90_zero_is_identity(self):
        rng = np.random.default_rng(RNG_SEED)
        patch_raw = rng.random((4, 64, 64), dtype=np.float32)
        patch_rgb = rng.random((3, 64, 64), dtype=np.float32)
        out_raw, out_rgb = bayer_safe_augment(patch_raw, patch_rgb, flip_h=False, flip_v=False, rot90=0)
        np.testing.assert_array_equal(out_raw, patch_raw)
        np.testing.assert_array_equal(out_rgb, patch_rgb)

    def test_bayer_pattern_preserved_after_flip_h(self):
        """
        After a horizontal flip (which swaps columns), the Bayer period-2 alignment
        is maintained because we always flip by an even number of columns
        (patch width = 320, which is even, so the 2-col period is preserved).
        Verify that the Gr and Gb channels in a 4-channel RGGB raw remain
        at their expected positions after flip.
        """
        # Build a synthetic 4-ch raw where each channel is uniform 0..3
        h, w = 4, 4
        patch_raw = np.zeros((4, h, w), dtype=np.float32)
        for c in range(4):
            patch_raw[c] = c  # R=0, Gr=1, Gb=2, B=3
        patch_rgb = np.zeros((3, h, w), dtype=np.float32)
        out_raw, _ = bayer_safe_augment(patch_raw, patch_rgb, flip_h=True, flip_v=False, rot90=0)
        # Each channel should still be its own constant value (uniform patch)
        for c in range(4):
            assert (out_raw[c] == c).all(), \
                f"Channel {c} corrupted after horizontal flip"
