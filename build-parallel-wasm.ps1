# build-parallel-wasm.ps1
# Builds raw-converter-wasm with configurable cargo features for quickest most performant runs.
#
# Performance pathway (C++, AVX2, Rust intrinsics, SIMD, parallel, threads - "build it all in"):
# 1. Nightly toolchain + rust-src + target for wasm32 (enables +simd, atomics, bulk-memory, threads).
# 2. Features: parallel-wasm (rayon/wasm threads for demosaic/tonemap/downscale), c-perceptual
#    (pulls C++ bridge with hand-written AVX2 intrinsics for perceptual_constancy in tonemap;
#     see perceptual_constancy_cpp_stability_bench.cpp for the __m256 log/exp/blendv/FMA code;
#     falls back to portable Rust in apply_tone_math when not enabled or no AVX2).
# 3. Demosaic: on wasm32, rggb (bilinear fast) uses explicit wasm128 SIMD (8-wide v128 loads/avgs/
#    bitselect/shuffles + ptr stores). Production for previews/LOD (lib.rs planar path).
#    MHC (quality, ~2x slower) uses scalar + recent Lens23 pointers (band writes, planar deinterleave).
#    Black sub: wasm128 u16x8 SIMD (or pointer). Future: mhc intrinsics/C++ like perceptual (Lens22/25).
# 4. Tonemap/pipeline: pointer-advance LUT loops (Lens23) + process_into/planar_into (Lens24, no extra allocs).
#    With c-perceptual: C++/AVX2 bulk for advanced math (perceptual_apply_full_avx2 SoA).
#    Basic path (default perceptual_constancy=false): fast matrix/sat/vib + LUT.
# 5. Glue in src/lib.rs: always fast preview (planar bilinear + simd + downs + into), full mhc only for
#    quality rgb16. Early drops (raw after demosaic, rgb16 after tone). Feature-gated fast paths.
# 6. JXL layer (separate): MT tiers (simd / relaxed-simd-mt), scheduler, progressive first-paint.
# 7. Run: this script (cargo +nightly --lib --target wasm32... + bindgen + wasm-opt + copy to pkg/ + web/pkg).
#    Then node StandardMultifileTest.mjs (or native cargo run --bin raw_decode_bench --release --features c-perceptual,parallel).
#    Compare raw_*_ms, body=, flip medians, TOON. Use mt tier + parallel for lowest times.
#
# This script + features = all optimizations built in (C++ AVX2 where possible, Rust/wasm intrinsics,
# pointers, dedup crossings, parallel, simd in build flags).
#
# Prerequisites (one-time):
#   rustup toolchain install nightly-2026-06-01 --target wasm32-unknown-unknown
#   rustup component add rust-src --toolchain nightly-2026-06-01
#
# Usage:
#   .\build-parallel-wasm.ps1
# Default now: parallel-wasm + c-perceptual (max perf). Pass -Features 'parallel-wasm,c-perceptual' explicitly if overriding.

param([string[]]$Features = @('parallel-wasm', 'c-perceptual'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$pkgDir = Join-Path $repoRoot "pkg"
$webPkgDir = Join-Path $repoRoot "web\pkg"
$cargoLockPath = Join-Path $repoRoot "Cargo.lock"
$nightly = "nightly-2026-06-01"
$savedRustflags = $env:RUSTFLAGS
$savedPath = $env:PATH

function Get-WasmBindgenVersion {
    $lockText = Get-Content $cargoLockPath -Raw
    $match = [regex]::Match($lockText, 'name = "wasm-bindgen"\s+version = "([^"]+)"', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $match.Success) { throw "Could not find wasm-bindgen version in Cargo.lock" }
    return $match.Groups[1].Value
}

function Resolve-WasmBindgenCli([string]$version) {
    $cacheRoot = Join-Path $env:LOCALAPPDATA ".wasm-pack"
    $candidates = @()
    if (Test-Path $cacheRoot) {
        $candidates = Get-ChildItem $cacheRoot -Recurse -Filter "wasm-bindgen.exe" -ErrorAction SilentlyContinue
    }
    foreach ($candidate in $candidates) {
        try {
            $reported = & $candidate.FullName --version
            if ($LASTEXITCODE -eq 0 -and $reported -match [regex]::Escape($version)) {
                return $candidate.FullName
            }
        } catch {}
    }
    throw "wasm-bindgen-cli $version not found. Run: cargo install wasm-bindgen-cli --version $version"
}

function Resolve-WasmOptBin {
    $cacheRoot = Join-Path $env:LOCALAPPDATA ".wasm-pack"
    if (-not (Test-Path $cacheRoot)) { return $null }
    return Get-ChildItem $cacheRoot -Recurse -Filter "wasm-opt.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}

function Assert-RustupComponent([string]$toolchain, [string]$component) {
    $installed = & rustup component list --toolchain $toolchain
    if ($LASTEXITCODE -ne 0) { throw "rustup component list failed for $toolchain" }
    if (-not ($installed | Select-String "^$component.*\(installed\)$" -Quiet)) {
        throw "$component missing for $toolchain. Run: rustup toolchain install $toolchain --target wasm32-unknown-unknown; rustup component add $component --toolchain $toolchain"
    }
}

function Invoke-Bindgen([string]$wasmBindgen, [string]$wasmIn, [string]$outDir) {
    Write-Host "=== wasm-bindgen -> $outDir ===" -ForegroundColor Cyan
    & $wasmBindgen $wasmIn --out-dir $outDir --target web
    if ($LASTEXITCODE -ne 0) { throw "wasm-bindgen failed for $outDir" }

    # Version pinning keeps upstream emission shape stable enough for this line-oriented patch.
    Get-ChildItem -Path (Join-Path $outDir "snippets") -Recurse -Filter "workerHelpers.js" -ErrorAction SilentlyContinue | ForEach-Object {
        $f = $_.FullName
        $raw = Get-Content $f -Raw -ErrorAction SilentlyContinue
        if ($raw -and ($raw -notmatch "Guard: only attach the worker-entry listener")) {
            Write-Host "  patching $f for node/browser cross-compat"
            $lines = Get-Content $f
            $outLines = New-Object System.Collections.Generic.List[string]
            $inWait = $false
            $addedIf = $false
            for ($i = 0; $i -lt $lines.Count; $i++) {
                $line = $lines[$i]
                if (-not $inWait -and $line -match "waitForMsgType\(self, 'wasm_bindgen_worker_init'\)") {
                    $inWait = $true
                    $addedIf = $true
                    $indent = ($line -replace '^(\s*).*', '$1')
                    $outLines.Add($indent + "// Guard: only attach the worker-entry listener when we are in an environment")
                    $outLines.Add($indent + "// that looks like a Web Worker (or main thread in browser). Prevents crashes")
                    $outLines.Add($indent + "// when the parallel-wasm glue is imported under Node (for benchmarks / tooling)")
                    $outLines.Add($indent + "// or other non-browser hosts. The listener is only needed for the child worker")
                    $outLines.Add($indent + "// instances created by startWorkers().")
                    $outLines.Add($indent + "if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {")
                    $outLines.Add($line)
                    continue
                }
                if ($inWait -and $line -match '^\s*\}\);$') {
                    $outLines.Add($line)
                    $outLines.Add("}")
                    $inWait = $false
                    continue
                }
                $outLines.Add($line)
            }
            if ($addedIf) {
                Set-Content -Path $f -Value ($outLines -join "`r`n") -NoNewline
            } else {
                $wrapped = "// Guard: only attach... (node safety)`nif (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {`n" + $raw + "`n}`n"
                Set-Content -Path $f -Value $wrapped -NoNewline
            }
        }
    }

    # wasm-bindgen-rayon emits `await import('../../..')`, which relies on Node-style
    # directory/package resolution. Browsers do not do that: the worker requests
    # `<outdir>/` and any static host (dev server, Vercel) answers 404, so every rayon
    # worker dies on "Failed to fetch dynamically imported module", initThreadPool times
    # out, and the pool silently degrades to single-threaded. Point it at the real file.
    Get-ChildItem -Path (Join-Path $outDir "snippets") -Recurse -Filter "workerHelpers.js" -ErrorAction SilentlyContinue | ForEach-Object {
        $f = $_.FullName
        $raw = Get-Content $f -Raw -ErrorAction SilentlyContinue
        if ($raw -and $raw.Contains("import('../../..')")) {
            Write-Host "  patching ${f} - directory import -> raw_converter_wasm.js"
            Set-Content -Path $f -NoNewline -Value `
                $raw.Replace("import('../../..')", "import('../../../raw_converter_wasm.js')")
        }
    }
}

function Invoke-WasmOpt([string]$wasmOptBin, [string]$wasmOut) {
    $tmp = "$wasmOut.opt"
    & $wasmOptBin $wasmOut -O2 --enable-threads --enable-bulk-memory --enable-simd `
        --enable-mutable-globals --enable-nontrapping-float-to-int --enable-sign-ext `
        -o $tmp
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path $tmp) { Remove-Item -Force $tmp }
        throw "wasm-opt failed for $wasmOut"
    }
    Move-Item -Force $tmp $wasmOut
}

function Write-BuildManifest([string]$pin, [string[]]$featureList, [string]$wasmOut, [string]$pkgDir, [string]$rustflags) {
    $manifestPath = Join-Path $pkgDir "build-manifest.json"
    @{
        builtAt   = (Get-Date).ToString("o")
        rustc     = (& rustup run $pin rustc -V)
        rustflags = $rustflags
        features  = ($featureList -join ",")
        wasmBytes = (Get-Item $wasmOut).Length
        sha256    = (Get-FileHash $wasmOut -Algorithm SHA256).Hash.ToLower()
    } | ConvertTo-Json | Set-Content $manifestPath
}

$featureCsv = $Features -join ','
$wasmBindgenVersion = Get-WasmBindgenVersion
$wasmBindgen = Resolve-WasmBindgenCli $wasmBindgenVersion
$wasmOptBin = Resolve-WasmOptBin

Write-Host "=== parallel-wasm: cargo +$nightly build ===" -ForegroundColor Cyan
Assert-RustupComponent $nightly "rust-src"

# NOTE: env RUSTFLAGS REPLACES .cargo/config.toml's rustflags (they do NOT merge), so
# +simd128 MUST be repeated here or the build loses SIMD. The threading link-args are all
# load-bearing — without them wasm-bindgen-rayon's pool fails at runtime:
#   --shared-memory : +atomics ALONE produces NON-shared memory (workers can't share heap)
#   --import-memory : wasm-bindgen's threads transform asserts the memory is imported
#   --export=__heap_base (+ tls) : release strips the name section → wasm-bindgen can't
#                                  find __heap_base by name unless it's exported
# (This set matches tools/build-mt-wasm.sh, verified end-to-end: initThreadPool OK, tone 4.7x.)
$env:RUSTFLAGS = "-C target-feature=+simd128,+atomics,+bulk-memory,+mutable-globals " +
  "-C link-arg=--shared-memory -C link-arg=--max-memory=2147483648 -C link-arg=--import-memory " +
  "-C link-arg=--export=__heap_base -C link-arg=--export=__tls_base " +
  "-C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__wasm_init_tls"

Push-Location $repoRoot
try {
    & cargo "+$nightly" build `
        --lib `
        --target wasm32-unknown-unknown `
        --release `
        --locked `
        --features $featureCsv `
        -Z build-std=std,panic_abort

    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

    $wasmIn = Join-Path $repoRoot "target\wasm32-unknown-unknown\release\raw_converter_wasm.wasm"
    Invoke-Bindgen $wasmBindgen $wasmIn $pkgDir

    $wasmOut = Join-Path $pkgDir "raw_converter_wasm_bg.wasm"
    if ($wasmOptBin) {
        Write-Host "=== wasm-opt (threads + bulk-mem + simd) ===" -ForegroundColor Cyan
        if (Test-Path $wasmOut) {
            Invoke-WasmOpt $wasmOptBin $wasmOut
        }
    } else {
        Write-Warning "wasm-opt not found in wasm-pack cache - shipping unoptimized wasm"
    }

    Write-BuildManifest $nightly $Features $wasmOut $pkgDir $env:RUSTFLAGS

    if (Test-Path $webPkgDir) { Remove-Item -Recurse -Force $webPkgDir }
    Copy-Item -Recurse -Force $pkgDir $webPkgDir

    $pkgHash = (Get-FileHash $wasmOut -Algorithm SHA256).Hash
    $webHash = (Get-FileHash (Join-Path $webPkgDir "raw_converter_wasm_bg.wasm") -Algorithm SHA256).Hash
    if ($pkgHash -ne $webHash) { throw "pkg and web/pkg wasm hashes diverged after copy" }

    # web/pkg carries a wasm-pack-generated .gitignore containing `*`, so everything in it is
    # ignored and the tracked files were force-added. A build that emits a NEW file therefore
    # leaves it untracked, and it silently never deploys — which is exactly how the rayon
    # worker snippet and a stale build-manifest went unnoticed. Name them; do not fail the
    # build, since some outputs are genuinely not meant to ship.
    $untracked = & git -C $repoRoot ls-files --others --exclude-standard --ignored -- web/pkg 2>$null
    if ($LASTEXITCODE -eq 0 -and $untracked) {
        $tracked = & git -C $repoRoot ls-files -- web/pkg
        $missing = $untracked | Where-Object { $tracked -notcontains $_ }
        if ($missing) {
            Write-Warning "web/pkg files NOT tracked by git - they will not deploy:"
            $missing | ForEach-Object { Write-Warning "    $_" }
            Write-Warning "  add with: git add -f <path>"
        }
    }

    Write-Host "=== done ===" -ForegroundColor Green
    Write-Host "Outputs: $pkgDir and $webPkgDir"
} finally {
    Pop-Location
    $env:RUSTFLAGS = $savedRustflags
    $env:PATH = $savedPath
}
