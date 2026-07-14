# Bermannian and Non-Riemannian Compression/Colour Follow-up

**Date:** 2026-07-13
**Scope:** Primary sources in `C:\Foo\Papers\Non-Riemannian\`, plus repository
source code. This is a second-pass research note. It records only possibilities,
constraints, or corrections not already developed in:

- `docs/Non-Riemannian-Colour-Mathematics-Exploration.md`
- `docs/Non-Riemannian-Color-Space-Applications.md`
- `docs/Non-Riemannian Fable Max Overview.md`

No codec or colour behaviour is changed here.

## Reading key

- **[S]** Sourced fact, directly supported by a primary source.
- **[D]** Deduction or proposed engineering interpretation. Not claimed by source.
- **Invariant** Property implementation must preserve.
- **Kill** Result that falsifies or deprioritises proposal.

Page references use printed article pages. For Teti thesis preview, Roman-numbered
thesis pages are stated explicitly.

## Executive result

| Rank | New possibility | Compression relevance | Confidence |
|---|---|---:|---:|
| 1 | Monotone-damping invariance audit | Removes false selection/compression claims; identifies the low-rate regime | High |
| 2 | Sparse colour-manifold diffusion codec | Direct published compression method plus Farup's colour geometry | Medium |
| 3 | Category-first base layer and Fisher-tensor AQ | Preserve colour identity before within-category detail | Medium |
| 4 | Colour-metric structure tensor for block decisions | Coordinate-invariant edge direction, partitioning, and AQ | Medium |
| 5 | Damped Frechet representatives and equal-perceptual progressive ladder | Low-rate palette/DC/base-preview improvement | Medium-low |
| 6 | Bermannian Toeplitz lifting and local `p=2` enumeration | Exact transform family plus honest model-signalling cost | Low-medium |
| 7 | Illumination/material layered coding | Compress smooth illumination harder than colour/material detail | Low-medium |

Most important result is corrective: a strictly increasing scalar damping of a
distance does not change pair ordering, nearest neighbours, or metric-ball shape.
It cannot by itself make the colour selector follow an object through shadow, and
it is not a coordinate compander. Its plausible codec effect is concentrated in
low-rate representatives, early previews, and aggregation. Most direct new codec
bridge is the combination of Galic et al.'s sparse diffusion codec with Farup and
Rivertz's colour-manifold diffusion.

## 0. Decisive audit: what monotone damping can and cannot change

### Mathematical invariant

Let `rho` be a base distance and let `D=phi o rho`, where `phi` is strictly
increasing. Then

$$
D(x,a)<D(x,b)\iff \rho(x,a)<\rho(x,b),
$$

$$
\operatorname*{argmin}_{y\in S}D(x,y)
=\operatorname*{argmin}_{y\in S}\rho(x,y),
$$

and

$$
B_D(x,\tau)=B_\rho(x,\phi^{-1}(\tau)).
$$

**[D]** Pair ranking, nearest-neighbour assignment for fixed centres, nearest
point to a set, and ball topology are therefore unchanged. A fixed-rate choice
is also unchanged when `phi` is applied once *after* the candidate's complete
scalar distortion has been computed. It can change an objective when applied
inside an aggregate, for example `sum_i phi(rho_i)^2`; that is where centre
updates and the dangerous concentration effect in Section 4 enter.

### Current repository consequence

**[S]** `web/perceptual-color.mjs` defines
`phi(c)=30*log(1+c/30)` at lines 142-160. `selectByColour` at lines 293-307
explicitly inverts `phi` once, then compares ordinary squared Euclidean Lab
distance. Thus the selected set is exactly a Lab ball with a re-labelled radius.

**[D]** This implementation is efficient and mathematically correct for
`D=phi o rho`, but damping supplies no new boundary shape, illumination
invariance, or category awareness. Claims that damping alone makes the wand
stick to a flower across shadow must be withdrawn. Such behaviour needs a
different base metric, context, or categorical model.

`dampChroma` is a different operation: it radially moves each Lab point. It is
not an implementation of `D=phi o rho`. With knee 30, take chroma-plane points
`A=(30,0)` and `B=(0,30)`. Their raw separation is `42.426`, so

$$
\phi(\|A-B\|)=26.441.
$$

Radial mapping gives both points radius `phi(30)=20.794`, whose mutual
Euclidean separation is `29.408`, not `26.441`. Keep `dampChroma` as an
artistic look if useful; do not cite it as the Bujack distance transform.

### The codec regime is mainly low rate

For the repository's logarithmic function,

$$
\phi(r)=\kappa\log(1+r/\kappa)
=r-{r^2\over2\kappa}+O(r^3),\qquad \phi'(0)=1.
$$

**[D]** High-rate quantisation is local, so its small residuals see essentially
the original geometry. At knee 30, `phi(1)=0.984` and `phi(3)=2.859`, while
`phi(30)=20.794`. The hypothesis is therefore most testable in severe
compression, small palettes, DC/base previews, and whole-region pooling, not
near-lossless JXL coefficient tuning.

**Invariant:** A reported gain must be a real byte reduction at matched human or
task outcome. Merely replacing a quality axis `rho` by monotone `phi(rho)` can
change BD-rate integral weighting without changing any decoded image; that is
metric reparameterisation, not compression progress.

## 0A. Damped Frechet representatives and a perceptual preview ladder

### Source and deduction

**[S]** Bujack et al. (2022), equation (19) and Figure 10, minimise squared
metric distance to define an intrinsic mean. On their Bernhard Riemann image,
the additive achromatic mean is 42, while their fitted logarithmic distance
gives 54 (printed p. 8). This is a demonstrated large change in a representative,
not a change in nearest-neighbour ordering.

**[D]** For a palette, DC value, or block representative, keep assignment to
fixed centres ordinary because `phi` is monotone, but update each centre with

$$
q_j=\operatorname*{argmin}_q
\sum_{i\in C_j} w_i\,\phi(\rho(x_i,q))^2.
$$

This is the concrete low-rate use that monotone invariance does not erase. It
may preserve the dominant appearance better than an arithmetic or ordinary
Frechet centre. It is unsuitable for diagnostic/archival colour until validated:
the 42-to-54 example also shows how strongly it can bias a physical average.

For progressive output, an equal-perceived-error ladder from initial residual
`r_0` to final can be defined by

$$
\phi(r_j)=(1-j/m)\phi(r_0),\qquad
r_j=\phi^{-1}((1-j/m)\phi(r_0)).
$$

Concavity makes raw-error stages coarser early and denser near final, where small
changes matter more. This changes target spacing, not progressive decode
checkpoint semantics.

### Experiment MEAN-1

At palette sizes 4, 8, 16, 32 and at existing DC/base-preview budgets, compare
ordinary centres with damped intrinsic centres. Keep assignments and rate model
identical. Measure bytes, category flips, tail Delta E, Butteraugli, and blinded
preference. Separately test whether observers judge successive ladder stages as
equally spaced.

**Kill:** no held-out preference/category benefit, systematic loss of rare plant
hues, or failure of the fitted `phi` outside achromatic stimuli/background.

## 0B. Category-first progressive colour and Fisher-tensor AQ

### Source

**[S]** Griffin and Mylonas derive a Fisher-information metric from the
distribution of names elicited by each colour. Numerically, if columns `dR,dG,dB`
are derivatives of square-rooted naming distributions, their Section 6 computes

$$
\Gamma=(d_R\ d_G\ d_B)^T(d_R\ d_G\ d_B).
$$

They publish the tensor grid, estimate about 27 categorical grains in the sRGB
cube, and explicitly propose the metric for colour distortion in reproduction
media. The categorical metric is not a simple rescaling of CIE2000; 95% of local
distance ratios lie between 60% and 168%. See [the primary paper](https://doi.org/10.1371/journal.pone.0216296),
Sections 6-8, and [the tensor data](https://doi.org/10.5281/zenodo.2595963).

### New deductions

**[D] Category-first scalable coding.** Let `P_name(c)` be the naming posterior.
Optimise a small base layer for Jensen-Shannon divergence between
`P_name(c)` and `P_name(c_hat)`, then code within-category residuals under a
local discriminability metric. The base answers "what colour is it?" before the
enhancement answers "which exact colour?" This is a better-founded progressive
split than applying one metric at all scales.

**[D] Fisher AQ.** For a small error `delta`, categorical distortion is
approximately `delta^T Gamma(c) delta`. A fixed-distortion cell is an ellipsoid;
its RGB-coordinate volume is proportional to `1/sqrt(det Gamma)`. Therefore
codepoints or bits should be denser where naming distributions change rapidly,
especially near category boundaries, and sparser inside stable categories.

**[D] Biodiversity extension.** Replace the colour-name posterior with a
held-out species or trait posterior and form the same square-root-posterior
metric on image/colour features. This yields task-aware base-layer distortion.
It is a proposed extension, not a claim in Griffin and Mylonas.

### Experiment CAT-1

Using the released tensor grid, simulate palette/low-rate chroma quantisers with
ordinary cells versus categorical ellipsoids. Also build a two-layer palette:
category representative first, within-category residual second. At equal bytes,
measure naming-posterior JS, category flips, Delta E/Butteraugli, and downstream
species/trait accuracy.

**Kill:** no category/task gain, worse human preference, or lack of transfer from
English sRGB naming data to the target population, display, and wide-gamut data.

## 0C. Colour-metric structure tensor as an encoder feature

**[S]** Farup and Rivertz define

$$
s_{ij}=g_{\mu\nu}(u)\,\partial_i u^\mu\,\partial_j u^\nu
$$

(equation 31) and prove the resulting diffusion equation is independent of
colour coordinates. The two eigenvalues/eigenvectors of `s` describe the local
strength and spatial direction of colour change under metric `g`.

**[D]** The encoder can use `tr(s)`, `det(s)`, anisotropy
`(lambda_max-lambda_min)/(lambda_max+lambda_min+epsilon)`, and the principal
direction to choose an existing directional predictor/transform, block split,
or quant strength. This needs no PDE solve and no new decoder-side colour
transform if it only guides choices already signalled by the format. Unlike a
luma-only gradient, it detects a chromatic edge according to the selected colour
metric and is coordinate-invariant in the continuum model.

### Experiment ST-1

Shadow-compute these features on encoder blocks under (a) Euclidean opponent
colour, (b) a Riemannised discrimination metric, and (c) Griffin's categorical
metric. Measure prediction residual entropy and full net rate-distortion after
signalling. Test the same linear image represented in two smooth colour charts.

**Kill:** unstable discrete orientation under chart conversion, no held-out net
gain, or feature cost exceeds saved encode work/bytes.

## 1. Bermannian Toeplitz lifting transforms

### Source

**[S]** Berman, Klopsch and Onn define the class-two Lie lattice

$$
[x_i,y_j]=\delta_{ij}z_1+K_{ij}z_2,
$$

with all `x-x`, `y-y`, and central brackets zero. For the `t^m` family, `K` is
the nilpotent companion/shift matrix. See *On pro-isomorphic zeta functions of
D*-groups of even Hirsch length* (2025), Section 2, equation (2.2), printed
pp. 631-632; the equivalent presentation (1.3) on pp. 621-622 states
`[x_i,y_i]=z_1` and `[x_j,y_{j+1}]=z_2`.

**[S]** Corollary 2.5 gives centre-fixing automorphisms in block form

$$
T=\begin{pmatrix}A&B&E\\C&D&F\\0&0&I_2\end{pmatrix},
\qquad AD-BC=I_m,
$$

where `A,B,C,D` are upper-triangular Toeplitz matrices. See printed p. 639,
equation (2.14). Theorem 1.10 identifies the full group as

$$
G \cong B_2 \ltimes \left(SL_2(k[t]/(t^m))\ltimes V_{st}(k[t]/(t^m))^{\oplus2}\right)
$$

(printed pp. 628-629).

### New deduction

**[D]** Restrict to `A=D=I`, `C=0`, `E=F=0`, and an integer Toeplitz
`B=q(K)`. Then

$$
(x,y)\mapsto(x,\;y+xq(K)),\qquad
(x,y')\mapsto(x,\;y'-xq(K))
$$

is an exact integer lifting step. Toeplitz `q(K)` is a short, shift-invariant
FIR filter. This is a concrete codec primitive, not merely an analogy:

1. `x` and `y` are paired colour or spectral channels.
2. `q(K)x` predicts one channel from same-position and neighbouring samples of
   another channel.
3. Small integer coefficients keep inverse exact.
4. Search a small signalled family of `q` values per image or large tile.

The prior notes observed the `Toeplitz = convolution` connection. New part is
the explicit lifting restriction, inverse, candidate search, and rate test.

### Compression and colour implications

- Lossless RGB: use paired opponent residual planes after existing reversible
  colour transform, not raw nonlinear/display RGB.
- Multispectral: pair correlated bands; `m` is tap depth, not number of bands.
- RAW mosaics: candidate only after defining a causal, same-sampling-grid pair.
- Lossy: lifting can still precede quantisation, but gain must survive rounding.

### Invariants

- Integer bijection. For every tested block, inverse must reproduce every input
  sample bit-exactly.
- `AD-BC=I_m`; do not search arbitrary Toeplitz matrices.
- Decoder knows `q` before transformed samples need inversion.
- Bounded intermediate range; prove worst-case headroom for 8/16-bit inputs.
- Net rate includes transform ID and any model reset cost.

### Experiment LIFT-1

1. Offline, apply small candidates `q(t)=a_0+a_1t+a_2t^2`,
   `a_i in {-2,-1,0,1,2}`, to lossless corpus channel pairs.
2. Feed transformed planes to unchanged Modular encoder.
3. Measure JXL bytes, encode/decode time, maximum intermediate magnitude, and
   exact inverse.
4. Compare against current Modular RCT family in
   `external/libjxl-012/lib/jxl/modular/transform/enc_rct.cc` and `rct.cc`.
5. Use `CodecPaperTest.mjs` result conventions for bytes/bpp/time, but lossless
   equality is primary gate.

**Kill:** no median net byte reduction after signalling, any inverse mismatch,
or >5% encode-time regression at <0.5% size gain.

### Experiment P2-1: turn a local zeta count into an honest signalling budget

**[S]** For an actual Lie lattice `L`, the local factor

$$
\zeta^\wedge_{L,2}(s)=\sum_{k\ge0}a^{iso}_{2^k}(L_2)2^{-ks}
$$

counts index-`2^k` sublattices isomorphic to `L_2`. Berman et al. give explicit
rational local factors for the `t^2` and `t^3` families. The count says nothing
about image distortion or entropy.

**[D]** If, and only if, representatives can be instantiated as usable
bracket-preserving binary refinement/quantiser candidates, selecting one of
`a^{iso}_{2^k}` equiprobable models costs at least
`ceil(log2(a^{iso}_{2^k}))` bits. Expand the `p=2` rational factor for small `k`,
enumerate concrete representatives, and run exact rate-distortion search with
that signalling cost. Counts can be useful first as a warning that the adaptive
model family is too large.

**Kill before codec work:** no explicit image-feature bracket, no representative
enumerator, candidates cannot be expressed by bounded integer lifting/scaling,
or model ID plus search cost exceeds residual savings. A coefficient count alone
is not a quantiser design.

## 2. Two-form commutator entropy context

### Source

**[S]** From Berman et al. equation (2.2), bracket of two general noncentral
vectors can be written as two alternating bilinear forms:

$$
\beta_1((x,y),(x',y'))=x^Ty'-{x'}^Ty,
$$

$$
\beta_2((x,y),(x',y'))=x^TKy'-{x'}^TKy.
$$

For `Delta(t)=t^m`, first form is same-tap interaction and second is one-shift
interaction. This follows directly from the primary-source bracket; Berman et
al. do not claim an image-codec use.

**[S]** Current libjxl Modular coding learns tree splits over causal properties
and chooses predictors/contexts from samples. See repository primary source
`external/libjxl-012/lib/jxl/modular/encoding/enc_ma.cc`, especially
`FindBestSplit` and `ComputeBestTree`, and
`external/libjxl-012/lib/jxl/modular/encoding/context_predict.h`.

### New deduction

**[D]** Compute `beta_1,beta_2` from already-decoded causal neighbourhood
vectors of two correlated planes. Candidate properties:

$$
c_{mag}=\operatorname{bucket}(|\beta_1|+|\beta_2|),
$$

$$
c_{2}=\min(v_2(\beta_1),v_2(\beta_2)),
$$

with a defined sentinel for `(0,0)`. `c_2` is stronger than prior note's plain
trailing-zero context: it measures divisibility depth of the *two interaction
forms*. Under an integral change of centre basis in `GL_2(Z)`, the ideal
generated by `(beta_1,beta_2)` is unchanged, so
`gcd(beta_1,beta_2)` and its prime valuations are basis-independent.

Interpretation: context distinguishes flat/correlated regions, same-position
cross-channel disagreement, and shifted edge crossings without hard-coding a
particular opponent-axis basis.

### Invariants

- Causal: both encoder and decoder derive forms from already-known samples.
- Alternating: `beta(v,v)=0`; unit tests must enforce this exactly.
- Centre-basis robustness: unimodular mixing of `(beta_1,beta_2)` preserves
  `gcd`/minimum valuation.
- No semantic claim that centre *is* opponent chroma. Here centre contains two
  interaction statistics; visible colour samples remain in degree-one layer.

### Experiment CTX-1

Before bitstream work, collect current Modular residual tokens and compare held-out
ideal cross entropy for:

1. baseline properties;
2. baseline plus `c_mag`;
3. baseline plus `c_2`;
4. baseline plus both.

Report entropy after tree/header cost, by image class and bit depth. If held-out
gain exists, add temporary encoder/decoder property behind an experiment flag.

**Kill:** <0.2% held-out byte-equivalent gain after model overhead, unstable gain
across train/test split, or context computation costs more cycles than entropy
savings justify.

## 3. Geometry-covariant diffusion base plus exact residual

### Source

**[S]** Farup and Rivertz define a colour-metric structure tensor

$$
s_{ij}=g_{\mu\nu}u^\mu_{,i}u^\nu_{,j}
$$

in equation (31), and diffusion tensor

$$
D^{kl}=2\sum_p {\partial\psi\over\partial\lambda_p}
\theta_p^k\theta_p^l
$$

in equation (43). Their main result is the coupled PDE

$$
{\partial u^\rho\over\partial t}
=\partial_k(D^{kl}u^\rho_{,l})
+D^{kl}\Gamma^\rho_{\mu\nu}u^\mu_{,k}u^\nu_{,l}.
$$

See *Anisotropic Diffusion in Riemannian Colour Geometry* (2025), Section 3,
equations (31), (43), and (45), printed pp. 5-6.

**[S]** Section 4.1 proves coordinate independence of equation (45). Section
4.4 gives explicit hyperbolic equations (62)-(67). Conclusion, printed p. 9,
states that efficient numerical solution remains nontrivial and extension to
gradient-domain processing, including transport between different tangent
spaces, remains open. Paper cites anisotropic-diffusion image compression as
prior work but does not present a codec experiment.

**[S]** Galic et al., *Image Compression with Anisotropic Diffusion* (2008),
already provide the missing compression architecture. Their encoder removes
less-significant pixels by adaptive triangulation, codes the remaining scattered
samples with a B-tree structure, and lets edge-enhancing diffusion reconstruct
the image. They add diffusion-based point selection, threshold adaptation, and
quantisation. At the high compression rates tested, the method beat then-current
JPEG and approached JPEG2000. See [the primary paper](https://doi.org/10.1007/s10851-008-0087-0).

### Direct missed bridge: sparse manifold-diffusion coding

**[D]** Replace Galic's scalar/Euclidean reconstruction with Farup and Rivertz's
Riemannian colour diffusion while holding transmitted sample colours fixed. The
encoder chooses samples according to reconstruction error measured in the same
colour metric. Nested B-tree sample sets give a natural scalable stream: a coarse
set first, then error-reducing samples. This is more direct than inventing a new
transform because both halves already exist in primary literature; their
combination has not been validated.

### Experiment DIFF-SPARSE-1

At 0.05-0.5 bpp, compare (a) Galic-style Euclidean diffusion, (b) colour-manifold
diffusion, and (c) current JXL. Measure sample-tree overhead, decode iterations,
category flips, edge-local/tail colour error, Butteraugli, and blinded preference.
Use nested sample prefixes to test progressive quality. A 2008 JPEG/JPEG2000
result is not evidence this will beat modern JXL.

**Kill:** no Pareto gain over Euclidean diffusion, colour halos or category
damage, runtime outside offline-ingest budgets, or clear inferiority to JXL at
all relevant low rates.

### New deduction

**[D]** Use finite-time perceptual diffusion as a *scalable base generator*, not
as irreversible preprocessing:

$$
B=\operatorname{round}(\Phi_T(I)),\qquad R=I-B.
$$

Encode `B` as first progressive/scalable object and `R` as enhancement. Final
lossless reconstruction is exact by integer addition, while early display gets a
full-resolution, edge-aware colour base. A lossy variant quantises `R`.

The Christoffel term matters: channel-by-channel diffusion omitting it is not
coordinate-covariant on curved colour space. This offers a strong test oracle:
compute equivalent flow in two smooth colour-coordinate systems, transform back,
and compare before quantisation.

### Compression and colour implications

- Early progressive layer can retain chromatic edges better than Gaussian/downsample
  base at same entropy.
- Residual entropy may drop because base absorbs perceptually smooth structure.
- Same mathematical flow can be specified in one colour metric while implemented
  in another coordinate chart.
- This is not yet a JXL frame-setting tweak. Test as two independent streams or a
  temporary research container before proposing bitstream plumbing.

### Invariants

- Lossless final: `B+R == I` sample for sample.
- Deterministic boundary conditions, iteration count, and rounding.
- Coordinate covariance tolerance measured before integer quantisation.
- Metric remains SPD for PDE run; non-Riemannian damping is not inserted into
  equation (45) without a new derivation.

### Experiment DIFF-1

Compare, at equal first-layer bytes:

1. ordinary low-pass/downsample progressive base;
2. Euclidean anisotropic diffusion base;
3. Riemannian colour diffusion base with Christoffel term;
4. same without Christoffel term as ablation.

Measure first-layer Butteraugli/SSIM, edge-local colour error, total bytes after
residual, encode/decode time, and exact final reconstruction. Current
`CodecPaperTest.mjs` already records bytes, bpp, Butteraugli, SSIM, and timing.

**Kill:** no first-layer Pareto improvement, residual makes total lossless size
larger by >1%, coordinate-covariance test fails materially, or runtime is not
credible for offline ingest.

## 4. Concave damping is dangerous as a pixelwise codec loss

### Source

**[S]** Bujack et al. model perceptual difference as

$$
d(x_i,x_j)=f(|g(x_i)-g(x_j)|)
$$

(2022, equation (17), printed p. 5). Their tested families include
`f_poly`, `f_log`, and `f_sin` (equation (18), printed p. 6). A concave `f`
satisfies

$$
f(a)+f(b)>f(a+b),
$$

which encodes diminishing returns. Their empirical study is on achromatic
CIELAB triads; discussion says spline/log models fit best and warns that other
areas of colour space may behave differently (printed pp. 6-8).

### New deduction

**[D]** A separable image loss

$$
L=\sum_p f(e_p)
$$

rewards concentrating error. For increasing concave `f` with `f(0)=0`, Jensen
gives

$$
f(E)\le n f(E/n).
$$

Thus one pixel with error `E` can be cheaper than distributing `E/n` over `n`
pixels. An encoder optimising this loss can sacrifice a few pixels or small
regions, creating severe colour outliers while reporting lower total loss.

This is a compression-specific consequence absent from prior notes. It reverses
the intuitive proposal to apply diminishing-return damping independently to each
pixel or block.

### Guardrail

- Keep small-error local metric (Butteraugli/local Delta E) inside ordinary
  per-pixel or per-block rate-distortion optimisation.
- Use large-difference `f` for endpoint comparisons, retrieval, selection, or
  carefully defined *post-aggregate* reporting.
- Any spatial aggregate using `f` needs separate psychophysical validation;
  Bujack's triad data does not establish spatial error pooling.

### Experiment LOSS-1

Construct matched-error images: same total base-metric error distributed across
many pixels versus concentrated into few pixels. Compare:

1. `sum e_p`;
2. `sum f(e_p)`;
3. Butteraugli;
4. maximum/local-tail error;
5. blinded preference.

Then run a toy block quantiser under losses 1 and 2 and inspect error histograms.

**Kill pixelwise damping:** any systematic shift toward worse 99.9th-percentile
colour error or visible isolated artifacts at matched bytes. Expected outcome is
that pixelwise damping fails this gate.

## 5. Test whether local geometry is Finsler before assuming SPD tensors

### Source

**[S]** Bujack et al. (2025) define curve length by partition sums (equation
(2)), then claim an induced Riemannian tensor from

$$
g(\dot\gamma,\dot\gamma)=
\lim_{\delta t\to0}
\left({\Delta E(\gamma(t),\gamma(t+\delta t))\over\delta t}\right)^2
$$

(equation (4)), and Theorem 1 says shortest point-to-point paths in the original
metric and induced geometry coincide. See *The Geometry of Color in the Light
of a Non-Riemannian Space*, Section 5.2.2, printed p. 5. Theorem 2 shows closest
points to a set need not coincide (pp. 5-6).

**[S]** Farup and Rivertz equation (31) assumes a Riemannian SPD tensor
`g_{mu nu}`. Their PDE therefore needs a quadratic tangent norm.

### New mathematical audit

**[D]** Equation (4) defines a squared tangent *norm* if limit exists. It does
not, by itself, prove norm comes from inner product. A generic local metric can
produce a Finsler norm `F(c,v)` whose unit ball is not ellipsoid. Necessary and
sufficient gate for inner-product norm is parallelogram identity:

$$
F(v+w)^2+F(v-w)^2=2F(v)^2+2F(w)^2.
$$

Therefore phrase "induced Riemannian metric" needs additional local-quadratic
assumption. If identity fails beyond observer noise, correct local geometry is
Finsler; Christoffel/SPD machinery and ellipsoidal quantiser cells are incomplete.

A snowflake damping `f(r)=r^alpha`, `0<alpha<1`, is even sharper warning:
`f(delta t)/delta t` diverges as `delta t -> 0`; no finite tangent tensor follows.
A smooth concave `f` with finite `f'(0)` instead preserves local geometry up to
scale.

### Compression possibility

Fit local discrimination unit balls. If non-ellipsoidal, use polyhedral or
lattice quantiser cells approximating `F(c,v)<=epsilon`, rather than only an SPD
ellipsoid. This could improve direction-selective chroma quantisation without
requiring global non-Riemannian geodesics.

### Invariants

- Positive homogeneity `F(c,lambda v)=|lambda|F(c,v)` locally.
- Convex unit ball for stable quantisation.
- Explicit handling of neutral-axis hue singularity.
- Coordinate-change tests; measured distortion cannot depend on chart.

### Experiment FIN-1

For each calibrated colour neighbourhood, estimate JND radius in directions
`v,w,v+w,v-w`; bootstrap parallelogram residual against observer noise. Compare
held-out prediction of SPD ellipsoid versus convex Finsler body. Only if Finsler
wins, build matched-cell quantiser simulation.

**Kill:** parallelogram residual statistically indistinguishable from noise, or
Finsler model does not improve held-out choices enough to pay model complexity.

## 6. Metric-derived hue/saturation/lightness compander

### Source

**[S]** Bujack et al. (2025) formalise:

- stimulus quality by geodesics, Definition 5;
- lightness under non-Riemannian or induced metric, Definitions 6 and 7;
- neutral at fixed lightness as point closest to black, Definition 8;
- saturation through distance to neutral, Definitions 3-4.

See Sections 3 and 5, printed pp. 3-6. Their experiments find no evidence that
tested non-Riemannian and induced-Riemannian paths differ after accounting for
response bias (Section 6.2.1, printed p. 10); this is permission to test a cheaper
induced geometry, not proof of equality everywhere.

### New deduction

**[D]** Use these operators as a nonlinear coding transform:

$$
c\mapsto(L_g(c),S_g(c),H_g(c)),
$$

where `L_g` is position along stimulus-quality geodesic, `S_g` is distance to
neutral, and `H_g` identifies geodesic/hue class. Quantise `L_g,S_g,H_g`
according to their intrinsic perceptual meaning, then invert to colour.

This differs from prior use in viewer tools: transform is tested directly for
entropy and rate-distortion against XYB. Potential win is better companding of
wide-gamut/HDR colours and explicit hue wrap handling.

### Invariants and experiment HSLG-1

- Round-trip bijection within chosen gamut except declared neutral-axis hue
  degeneracy.
- Neutral has `S_g=0`; hue bits must vanish or become irrelevant there.
- No archival use until invertibility and calibration are proven.

Build LUT prototype only. Measure transform-domain entropy, inversion error,
and JXL size/Butteraugli after pre-transform/quantise/inverse. Compare against
XYB and CIELAB cylindrical baselines.

**Kill:** LUT inverse exceeds half source LSB for lossless-target path, visible hue
seams, or no rate-distortion gain over XYB.

## 7. Natural-hue pair prior for palette headers

### Source

**[S]** Forni, Darmon and Benzaquen (2026) define pair score
`S_ij=f^B_ij-f^W_ij` (equation 1, printed p. 2) and combinability index
`C(j)=sum_{i != j} S_ij` (equation 2, p. 3). They analyse 346 participants and
13 controlled HSL hues. Natural-image analysis uses 12,000 landscapes plus
4,319 and 15,501 validation sets; dominant-hue angular separations cluster near
180 degrees (pp. 3-4; STAR Methods p. e1). Authors explicitly warn HSL is not
perceptually uniform and results vary strongly by absolute hue (pp. 4-5).

### New deduction

**[D]** Natural-image hue-pair histogram, not aesthetic score, is a possible
fixed prior for the first two entries of small natural-image palettes. Encode
second dominant hue as signed angular offset conditioned on first hue. This may
reduce palette/header bits before image-specific model adapts.

Do not use harmony preference as probability. Recompute occurrence histogram
on this repository's target corpus in working colour space; source landscape
distribution is only a prior.

**Kill:** <0.1% total file saving after prior/table signalling, or cross-entropy
worse than uniform/current palette coding outside landscape class.

## 7A. Illumination/material factorisation as unequal-protection coding

### Source

**[S]** Akleman et al., *Hyper-Realist Rendering* (2024), separate an
illumination image `W` from material/shading textures `T_i`, then combine them
with algebraically complete barycentric shaders. Their Figure 9 deliberately
blurs `W` while retaining clean rendered structure, illustrating robustness to
illumination approximation. The paper presents rendering examples, not a codec,
and states that estimating shapes/materials is an inverse problem for future
work. See [the primary preprint](https://arxiv.org/abs/2401.12853), Sections 3-5.

### New deduction

**[D]** For photographs where a stable decomposition can be estimated, encode
smooth illumination `W` at lower spatial/chromatic precision and protect
reflectance/material layers more strongly. Reconstruct through the same
barycentric combination. This separates two kinds of colour variation before
bit allocation: lighting variation that can tolerate blur and object colour or
texture that carries identity. It is a more explicit compression version of
reflectance/shading factorisation, not a claim of colour constancy.

### Experiment LAYER-1

Use controlled multi-exposure/relit RAW scenes where illumination and material
are partly identifiable. Compare ordinary JXL with a two-layer representation at
equal total bytes, including layer metadata. Measure relighting consistency,
edge/tail colour error, category/trait accuracy, and decomposition artifacts.

**Kill:** layer overhead erases gain, inverse decomposition is unstable, or
material colour shifts under changed illuminant. Do not use unsupervised output
as diagnostic colour ground truth.

## 8. Corrections and limits to carry forward

### 8.1 Non-Riemannian conclusion remains contested

**[S]** Berthier and Provenzi (2023), Section 3, equations (8)-(10), argue
Bujack's triads were fixed under Euclidean `L*` differences while compatibility
was tested against a Thurstone-derived metric. They conclude experiment rejects
`ds=dx`, not every possible Riemannian `ds=h(x)dx` (printed pp. 4-5).

**[D]** No encoder default should depend on global damping `f`. Keep all such
metrics as shadow experiments until reanalysis compares:

1. Euclidean `h=1`;
2. Thurstone-derived `h=g'`;
3. regularised free positive `h`;
4. explicit nonadditive `f o g`;

using held-out likelihood. This is more decisive than further metaphysical
argument.

### 8.2 One global damping LUT is unsupported

**[S]** Bujack et al. 2022 measured achromatic `L*` triads. Their discussion
says other colour-space areas may behave differently (pp. 7-8). Teti thesis
abstract reports evidence that diminishing returns varies across CIELAB, but
available local PDF is a restricted preview; see thesis pp. vi-vii.

**[D]** Do not extrapolate neutral-axis `f` to saturated XYB globally. Any
compression experiment needs location/direction-dependent calibration or must
stay within achromatic scope.

### 8.3 Natural boundary is not computational hardness

**[S]** Berman et al. Corollary 1.4 says global `zeta^wedge_{Gamma_{t^3}}`
has meromorphic continuation for `Re(s)>3` and line `Re(s)=3` is a natural
boundary (printed p. 623). This is statement about analytic continuation.

**[D]** Prior overview called this a structured-quantiser "complexity wall".
That inference is unsupported. Natural boundary does not imply NP-hardness,
search lower bound, or codec phase transition. Remove it from engineering
justification unless separate computational theorem is proved.

### 8.4 Functional-equation exponent remains conjectural in general

**[S]** Berman et al. Conjecture 1.8, printed p. 627, proposes that local-zeta
degree equals minimal-grading weight. For naturally graded class-two `L`, expected
degree is `rk L + rk[L,L]`. It matches computed `t^2` and `t^3` cases through
functional-equation exponents 8 and 10 (Theorems 1.1 and 1.3, pp. 622-623).

**[D]** Equality with Carnot homogeneous dimension is exact algebra for selected
graded models and verified examples, but not established perceptual law and not a
general theorem of Berman paper. Keep labelled model/conjecture.

### 8.5 Dyadic codec structure makes local `p=2` the first candidate

**[S]** Berman local factors enumerate `p`-power index objects; global series is
Euler product across all primes. Theorem 1.1/1.3 give local rational functions.

**[D]** A binary bitstream alone does not force any transform or quantiser to
have `p`-power index. Integer sample domains, bit-plane decompositions, and
dyadic quantiser or refinement ladders make `p=2` the first candidate only when
the mapped codec objects really do have `2`-power index. A codec built around a
different radix could point elsewhere. Global Euler products, Dedekind prime
splitting, poles, and residues may count abstract families but do not themselves
encode pixels or choose quantisers. Require an explicit bijection from counted
sublattice to codec transform/quantiser before claiming compression use.

### 8.6 `p -> p^-1` is not fine/coarse codec duality

**[S]** Berman et al. define the local functional equation by formal inversion
of `p` in a rational function. Their introduction connects such symmetries to
`p`-adic Bruhat decomposition and affine-Weyl-group symmetry (printed
pp. 619-620). There is no field with `p^-1` elements being used as a decoder and
no operational reversal of a refinement stream.

**[D]** Prior language interpreting the functional equation as fine/coarse,
encode/decode, or quantise/dequantise duality is unsupported. Use the equation as
an algebraic check on an enumeration, not as codec architecture.

### 8.7 Rank-two centre is not an opponent plane without a fitted bracket

**[S]** In the D*-lattice, `z_1,z_2` are central outputs of two alternating
bilinear forms. In particular `[v,v]=0`. A static chroma magnitude is nonzero
away from neutral, so the commutator cannot equal `chroma^2` for one colour.

**[D]** An opponent interpretation can only attach the centre to *interactions
of two increments* (or a loop/oriented area), after a concrete bracket is fitted
to perceptual data. Until then, Sections 1-2 are generic integer-transform and
context experiments, not colour theorems.

### 8.8 Number-field degree is not spectral-band count

**[S]** Berman, Glazer and Schein extend scalars from `Z` to a number ring and
then restrict scalars; degree `d` multiplies algebraic ranks and changes local
factors. The paper does not discuss spectra, sensors, or colour bands.

**[D]** Equating `d` with number of spectral channels is only a proposed model.
It predicts no compression gain and is not evidence of useful multispectral
coupling. First fit a band interaction algebra; then test whether its integral
form is actually a base extension.

### 8.9 Zeta counts measure family size, not quantiser quality

**[S]** `a_n^wedge` counts finite-index subgroups whose profinite completions
are isomorphic to the ambient group. It does not rank their image distortion,
entropy reduction, runtime, or signalling cost.

**[D]** A useful codec claim requires enumerated representatives, a mapping to
coefficient operations, and full rate-distortion including model ID. The zeta
factor can estimate candidate-family size and validate enumeration; it cannot
choose a good quantiser.

### 8.10 Current Lens17 code is a hand-tuned experiment, not a sourced model

**[S] Code audit.** `crates/raw-pipeline/src/pipeline.rs` around lines 534-630
calls the Rust path the “Lens17 full implementation” of a “unified
non-Riemannian model.” It defines `SENSOR_SHARPEN_B` with the code comment
“Plausible sensor-sharpen,” then combines a componentwise log transform with
fixed residual weight `0.02`, neutral-density weight `0.3`, a binary green
multiplier `1.15`, a neutral-gray spring with cutoff `0.25` and gain `0.7`,
and separate red/green/blue `f(c)` factors. The green factor uses `0.12`;
red and blue use `0.08`.

**[D] Source audit.** No primary source in this corpus derives that matrix,
those equations, those parameters, or their composition. In particular, this is
not a validated implementation of the Bujack, Molchanov, or Los Alamos results;
the per-channel factors are also not the same object as a fitted monotone
function of perceptual distance. Treat the current path as an experimental look
or LUT candidate. Keep the classic path as the baseline for perceptual and
compression comparisons. Before making compression claims, either calibrate the
matrix and constants on independent camera/perceptual data or relabel the
implementation and documentation to remove the “full model” claim.

## 9. Recommended experiment order

1. **Reanalyse/calibrate first:** compare positive Riemannian `h(x)`, contextual
   `g_t`, and nonadditive `phi o g` on held-out triads that cover chromatic
   directions and compression artifacts. No global `phi` default before this.
2. **LOSS-1:** prove the pixelwise concavity hazard in a toy optimiser. Cheap
   safety result before any rate-distortion integration.
3. **MEAN-1 and CAT-1:** low-rate representatives and category-first base layer.
   They target the regime where the mathematics can actually change decisions.
4. **ST-1:** shadow encoder feature. No bitstream change until net gain appears.
5. **DIFF-SPARSE-1:** direct low-rate diffusion codec bridge. Larger runtime
   investment, but strongest literature-to-codec chain.
6. **LIFT-1, then P2-1:** generic reversible transform gain first; zeta-guided
   enumeration only after a concrete bracket and representative generator exist.
7. **LAYER-1:** controlled reflectance/illumination data only.
8. **CTX-1, FIN-1, DIFF-1, HSLG-1:** research follow-ups after the earlier gates.
   Natural-hue palette prior remains last; likely small payoff.

For all compression experiments, report:

- encoded bytes and bpp;
- encode/decode wall time;
- exact equality where lossless;
- Butteraugli plus SSIM, not either alone;
- maximum and tail colour error, specifically because concave averages hide
  concentrated failure;
- corpus-class split and held-out validation;
- signalling/model overhead.

## 10. Primary-source ledger

1. **Berman, Klopsch, Onn (2025)**, [*On pro-isomorphic zeta functions of
   D*-groups of even Hirsch length*](https://doi.org/10.1007/s11856-025-2822-2), Israel Journal of Mathematics 269,
   617-695. Local file: `C:\Foo\Papers\Non-Riemannian\Mark Berman 2025.pdf`.
   Key locations: presentation (1.3), pp. 621-622; Theorems 1.1/1.3,
   pp. 622-623; Corollary 1.4, p. 623; Conjecture 1.8, p. 627; Theorem 1.10,
   pp. 628-629; equations (2.1)-(2.2), pp. 631-632; Corollary 2.5 and
   equation (2.14), p. 639.
2. **Berman, Glazer, Schein (2022)**, [*Pro-isomorphic zeta functions of
   nilpotent groups and Lie rings under base extension*](https://doi.org/10.1090/tran/8506). Local primary TeX:
   `C:\Foo\Papers\Non-Riemannian\Berman 2022 - Pro-isomorphic zeta functions of nilpotent groups and Lie rings under base extension.tex`.
   Relevant facts: Introduction/Theorem 1.1, fine Euler products, finite
   uniformity, and Section 3 rigidity. Used here mainly to constrain, not to
   create a new codec claim.
3. **Bujack, Teti, Miller, Caffrey, Turton (2022)**, [*The non-Riemannian
   nature of perceptual color space*](https://doi.org/10.1073/pnas.2119753119), PNAS 119(18), e2119753119. Local file:
   `C:\Foo\Papers\Non-Riemannian\bujack-et-al-2022-the-non-riemannian-nature-of-perceptual-color-space.pdf`.
   Key equations: (1)-(4), pp. 1-2; (17), p. 5; (18), p. 6; discussion,
   pp. 7-8.
4. **Bujack, Stark, Turton, Miller, Rogers (2025)**, [*The Geometry of Color
   in the Light of a Non-Riemannian Space*](https://doi.org/10.1111/cgf.70136), Computer Graphics Forum 44(3),
   e70136. Local file starts `Computer Graphics Forum - 2025 - Bujack`.
   Key locations: Definitions 1-8, pp. 3-6; equations (2)-(4), Theorems 1-2,
   pp. 5-6; experiment conclusion, p. 10.
5. **Farup, Rivertz (2025)**, [*Anisotropic Diffusion in Riemannian Colour
   Geometry*](https://doi.org/10.1007/s10851-024-01223-9), Journal of Mathematical Imaging and Vision 67:6. Local file:
   `C:\Foo\Papers\Non-Riemannian\s10851-024-01223-9.pdf`. Key equations:
   (31), p. 5; (43)-(45), p. 6; coordinate proof, pp. 6-7; hyperbolic
   equations (62)-(67), p. 8; conclusion/open problem, p. 9.
6. **Berthier, Provenzi (2023)**, [*On the questionable use of CIE L* to infer
   geometric properties of achromatic perception*](https://doi.org/10.1002/col.22902). Local file:
   `C:\Foo\Papers\Non-Riemannian\Revised_Version_Berthier_Provenzi.pdf`.
   Key locations: Section 3, equations (8)-(10), pp. 4-5; conclusion, p. 9.
7. **Teti (2022)**, *Diminishing Returns in Color Perception*, PhD thesis.
   Local restricted preview: `C:\Foo\Papers\Non-Riemannian\out.pdf`.
   Abstract, thesis pp. vi-vii.
8. **Forni, Darmon, Benzaquen (2026)**, *Harmonious color pairings: Insights
   from human preference and natural hue statistics*, iScience 29, 116038.
   Local file: `C:\Foo\Papers\Non-Riemannian\Harmonious color pairings Insights from human preference.pdf`.
   Equations (1)-(2), pp. 2-3; natural-image analysis/PCA, pp. 3-5; STAR
   Methods, p. e1.
9. **Griffin, Mylonas (2019)**, [*Categorical colour geometry*](https://doi.org/10.1371/journal.pone.0216296),
   PLOS ONE 14(5), e0216296. Section 6 derives the categorical Fisher tensor.
   The released tensor grid is the primary data record [Zenodo
   2595963](https://doi.org/10.5281/zenodo.2595963).
10. **Galic, Weickert, Welk, Bruhn, Belyaev, Seidel (2008)**, [*Image
    Compression with Anisotropic Diffusion*](https://doi.org/10.1007/s10851-008-0087-0),
    Journal of Mathematical Imaging and Vision 31, 255-269. Encoder,
    triangulation, B-tree representation, diffusion reconstruction, and rate-
    distortion experiments are the relevant primary results.
11. **Akleman et al. (2024)**, [*Hyper-Realist Rendering*](https://arxiv.org/abs/2401.12853),
    arXiv:2401.12853. Local file:
    `C:\Foo\Papers\Non-Riemannian\2401.12853v1.pdf`. The illumination/material
    decomposition and Figure 9 are used only to motivate the codec experiment.

## Final judgement

A global monotone remap of an already scalar colour distance leaves pair order,
nearest neighbours, and metric balls unchanged. In the current selector it only
relabels the threshold; its near-origin derivative also makes a high-rate gain
unlikely. Its defensible compression roles are low-rate representatives,
aggregation, and progressive-preview allocation, where the representative itself
can move. Concave damping remains unsafe as a separable pixel loss because it can
reward concentrated large errors.

The strongest new codec path is Galic-style sparse sample transmission plus
Farup-Rivertz colour-manifold diffusion, tested as nested progressive prefixes
against current JXL. Next are damped Frechet low-rate representatives and
Griffin-Mylonas category/Fisher distortion for base-layer or adaptive-quantisation
decisions. Both require held-out perceptual/category tests and net-byte accounting;
neither follows automatically from the geometry.

Berman's zeta functions still do not supply a compressor. Toeplitz lifting and
local `p=2` enumeration now rank as low-confidence research tools, not leading
codec mechanisms. Promote them only after fitting an alternating bracket to
image residuals, enumerating concrete dyadic candidates, and showing a gain after
side information. Local colour geometry should first pass the
quadratic/parallelogram gate; only then choose Riemannian SPD tensors or Finsler
cells.
