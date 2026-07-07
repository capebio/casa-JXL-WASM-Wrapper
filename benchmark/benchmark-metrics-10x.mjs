import { spawn } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';

const results = [];
const runCount = 10;

console.log(`Starting ${runCount} benchmark runs...\n`);

async function runBenchmark(runNum) {
  return new Promise((resolve) => {
    console.log(`=== Run ${runNum}/${runCount} ===`);
    const child = spawn('node', ['test-metrics-performance.mjs'], {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let error = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      error += data.toString();
    });

    child.on('close', (code) => {
      const fullOutput = output + error;

      // Extract timing metrics
      const psnrMatch = fullOutput.match(/Total PSNR time: ([\d.]+) ms/);
      const ssimMatch = fullOutput.match(/Total SSIM time: ([\d.]+) ms/);
      const buttTotalMatch = fullOutput.match(/Grand total Butteraugli time \(with precompute\): ([\d.]+) ms/);
      const grandTotalMatch = fullOutput.match(/Total metric compute time: ([\d.]+) ms/);
      const passesMatch = fullOutput.match(/Decoded (\d+) passes/);
      const passedMatch = fullOutput.match(/Final pass \d+ vs lossless master: ([\d.]+) dB.*OK/);

      if (psnrMatch && ssimMatch && buttTotalMatch && grandTotalMatch) {
        const result = {
          run: runNum,
          psnr_ms: parseFloat(psnrMatch[1]),
          ssim_ms: parseFloat(ssimMatch[1]),
          butt_total_ms: parseFloat(buttTotalMatch[1]),
          total_ms: parseFloat(grandTotalMatch[1]),
          passes: passesMatch ? parseInt(passesMatch[1]) : 0,
          psnr_db: passedMatch ? parseFloat(passedMatch[1]) : null,
          passed: passedMatch ? true : false,
        };
        results.push(result);
        console.log(`✓ ${result.total_ms.toFixed(2)}ms\n`);
      } else {
        console.log(`✗ Parse failed\n`);
      }

      resolve();
    });
  });
}

// Run benchmarks sequentially
for (let i = 1; i <= runCount; i++) {
  await runBenchmark(i);
}

// Generate .toon file
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5) + 'Z';
const toonContent = generateToonFile(results, timestamp);

// Save
mkdirSync('docs/benchmarks', { recursive: true });
const filename = `docs/benchmarks/metrics-performance-${timestamp}.toon`;
writeFileSync(filename, toonContent);

console.log(`\n✓ Results saved to ${filename}\n`);
console.log(toonContent);

function generateToonFile(results, timestamp) {
  const avgTotal = results.length ? results.reduce((sum, r) => sum + r.total_ms, 0) / results.length : 0;
  const avgPsnr = results.length ? results.reduce((sum, r) => sum + r.psnr_ms, 0) / results.length : 0;
  const avgSsim = results.length ? results.reduce((sum, r) => sum + r.ssim_ms, 0) / results.length : 0;
  const avgButt = results.length ? results.reduce((sum, r) => sum + r.butt_total_ms, 0) / results.length : 0;

  let toon = `TestName: metrics-performance
RunTimestamp: ${timestamp}
Agent: haiku
Metric: psnr,ssim,butteraugli
Source: Pogonospermum cleomoides
Target: 1920x1433
Quality: 85
Effort: 0
Passes: 2
TimeBase: ${timestamp.slice(0, 10)}T${timestamp.slice(11, 13)}:

---
runs[${results.length}]{run|psnr_ms|ssim_ms|butt_ms|total_ms}:
`;

  for (const r of results) {
    toon += `  ${r.run} | ${r.psnr_ms.toFixed(2)} | ${r.ssim_ms.toFixed(2)} | ${(r.butt_total_ms).toFixed(2)} | ${r.total_ms.toFixed(2)}\n`;
  }

  toon += `
# Aggregates
RunCount: ${results.length}
AvgTotal: ${avgTotal.toFixed(2)} ms
AvgPsnr: ${avgPsnr.toFixed(2)} ms
AvgSsim: ${avgSsim.toFixed(2)} ms
AvgButteraugli: ${avgButt.toFixed(2)} ms
`;

  if (results.length > 0) {
    const totals = results.map(r => r.total_ms);
    toon += `MinTotal: ${Math.min(...totals).toFixed(2)} ms
MaxTotal: ${Math.max(...totals).toFixed(2)} ms
StdDev: ${calculateStdDev(totals).toFixed(2)} ms
PassedGate: ${results.filter(r => r.passed).length}/${results.length}
`;
  }

  return toon;
}

function calculateStdDev(values) {
  if (values.length < 2) return 0;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}
