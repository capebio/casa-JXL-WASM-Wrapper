# run-metric-bench.ps1 — compile butter_time.exe and run the full comparison bench.
#
# Usage:
#   .\run-metric-bench.ps1 `
#     "c:\995\2026-02-20 Gobabeb To Windhoek\P2200717.ORF" `
#     "c:\995\2026-02-20 Gobabeb To Windhoek\P2200493 Grielum sinuatum.ORF" `
#     "c:\995\2026-02-20 Gobabeb To Windhoek\P2200571.ORF" `
#     "c:\995\2026-02-20 Gobabeb To Windhoek\P2200615 Jamesbrittenia fleckii.ORF" `
#     "c:\995\2026-02-20 Gobabeb To Windhoek\P2200637 Hermannia atrosanguinea.ORF" `
#     "c:\995\2026-02-20 Gobabeb To Windhoek\P2200629 Aptosimum arenarium.ORF"

param([Parameter(ValueFromRemainingArguments)][string[]]$OrfPaths)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root     = $PSScriptRoot
$BenchDir = Join-Path $Root 'bench'
$ButterExe = Join-Path $BenchDir 'butter_time.exe'

# ── 1. Compile butter_time.exe if not present or source is newer ──────────────
$SourceFile = Join-Path $BenchDir 'butter_time.cc'
$needsBuild = -not (Test-Path $ButterExe) -or
              ((Get-Item $SourceFile).LastWriteTime -gt (Get-Item $ButterExe).LastWriteTime)

if ($needsBuild) {
    Write-Host '[compile] butter_time.cc -> butter_time.exe ...'

    $ClangCL = 'C:\Program Files\LLVM\bin\clang-cl.exe'
    if (-not (Test-Path $ClangCL)) {
        Write-Error "clang-cl not found at $ClangCL — install LLVM"
    }

    $Bld = 'C:\Tmp\libjxl-012-build'
    $Src = Join-Path $Root 'external\libjxl-012'

    $CompileArgs = @(
        '/nologo', '-TP', '/O2', '/Ob2', '/std:c++17', '/MD', '/EHsc', '/W0',
        '-DFJXL_ENABLE_AVX512=0', '-DJXL_INTERNAL_LIBRARY_BUILD',
        '-DJXL_STATIC_DEFINE', '-D_CRT_SECURE_NO_WARNINGS',
        '-DWIN32', '-D_WINDOWS',
        '-DHWY_DISABLED_TARGETS=(HWY_AVX3|HWY_AVX3_SPR|HWY_AVX3_ZEN4|HWY_RVV|HWY_SSSE3|HWY_SVE|HWY_SVE_256|HWY_SVE2|HWY_SVE2_128)',
        '-DJPEGXL_ENABLE_SKCMS=1', '-DJPEGXL_ENABLE_TRANSCODE_JPEG=1', '-DJPEGXL_ENABLE_BOXES=1',
        "/I$Src",
        "/I$Src\third_party\highway",
        "/I$Src\third_party\brotli\c\include",
        "/I$Bld\lib\include",
        $SourceFile,
        "/Fe:$ButterExe",
        '/link',
        "$Bld\lib\jxl.lib",
        "$Bld\lib\jxl_cms.lib",
        "$Bld\lib\jxl_threads.lib",
        "$Bld\third_party\highway\hwy.lib",
        "$Bld\third_party\brotli\brotlicommon.lib",
        "$Bld\third_party\brotli\brotlidec.lib",
        "$Bld\third_party\brotli\brotlienc.lib",
        '/SUBSYSTEM:CONSOLE'
    )

    & $ClangCL @CompileArgs
    if ($LASTEXITCODE -ne 0) { Write-Error 'butter_time.cc compilation failed' }
    Write-Host '[compile] done.'
} else {
    Write-Host '[compile] butter_time.exe up-to-date, skipping.'
}

# ── 2. Build Rust perceptual bench ────────────────────────────────────────────
Write-Host '[rust] building orf_metric_bench (release, no-default-features, parallel)...'
$MsvcTarget = 'C:\Tmp\raw-converter-wasm-msvc-target'
Push-Location (Join-Path $Root 'crates\raw-pipeline')
& (Join-Path $Root 'build-msvc.ps1') build --release --no-default-features --features parallel --example orf_metric_bench 2>&1 |
    ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Write-Error 'cargo build failed' }
Pop-Location

# ── 3. Run Rust bench → collect JSON lines ────────────────────────────────────
Write-Host '[bench] running orf_metric_bench...'
$ExePath = Join-Path $MsvcTarget 'release\examples\orf_metric_bench.exe'
$RustLines = & $ExePath @OrfPaths 2>&1

# stderr to screen, stdout collect
$JsonLines = @()
foreach ($line in $RustLines) {
    if ($line -match '^\{') { $JsonLines += $line }
    else { Write-Host "  $line" }
}

# ── 4. For each pair run butter_time.exe, merge results ───────────────────────
$Results = @()
foreach ($json in $JsonLines) {
    $p = $json | ConvertFrom-Json
    Write-Host "[butter] $($p.pair) ($($p.w)x$($p.h))..."
    $bOut = & $ButterExe $p.w $p.h $p.ref_raw $p.test_raw 7
    $b = $bOut | ConvertFrom-Json

    $Results += [PSCustomObject]@{
        Pair          = $p.pair
        MP            = [math]::Round($p.w * $p.h / 1e6, 1)
        PercBuildMs   = $p.perc_build_ms
        PercMs        = $p.perc_ms
        ButterMs      = $b.butter_ms
        ButterMinMs   = $b.butter_min_ms
        ButterScore   = [math]::Round($b.butter_score, 4)
        Speedup       = [math]::Round($b.butter_ms / $p.perc_ms, 1)
    }
}

# ── 5. Print table ────────────────────────────────────────────────────────────
Write-Host ''
Write-Host ('─' * 110)
Write-Host ('{0,-42} {1,5} {2,11} {3,9} {4,11} {5,12} {6,9} {7,8}' -f
    'Pair', 'MP', 'Perc bld', 'Perc ms', 'Butter ms', 'Butter min', 'Score', 'Speedup')
Write-Host ('{0,-42} {1,5} {2,11} {3,9} {4,11} {5,12} {6,9} {7,8}' -f
    '', '', '(Cmp::new)', '(median)', '(median)', '(min)', '(jxl)', '(B/P)')
Write-Host ('─' * 110)
foreach ($r in $Results) {
    Write-Host ('{0,-42} {1,5} {2,11} {3,9} {4,11} {5,12} {6,9} {7,8}' -f
        $r.Pair, $r.MP,
        ('{0:F1}ms' -f $r.PercBuildMs),
        ('{0:F2}ms' -f $r.PercMs),
        ('{0:F2}ms' -f $r.ButterMs),
        ('{0:F2}ms' -f $r.ButterMinMs),
        $r.ButterScore,
        ('{0:F1}x' -f $r.Speedup))
}
Write-Host ('─' * 110)
Write-Host ''
Write-Host 'Speedup = libjxl Butteraugli median / perceptual-approx median (higher = approx faster)'
