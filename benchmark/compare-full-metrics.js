import fs from 'fs';
import { join } from 'path';

const toonDir = 'docs/outputs/timing tests';
if (!fs.existsSync(toonDir)) {
  console.error('Toon directory not found!');
  process.exit(1);
}

const files = fs.readdirSync(toonDir)
  .filter(f => f.endsWith('.toon') && f.includes('StandardMultifileTest-general'))
  .map(f => ({ name: f, path: join(toonDir, f), mtime: fs.statSync(join(toonDir, f)).mtime }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, 6); // Grab the last 6 runs

console.log('| Metric | ' + files.map((_, i) => `Run ${i + 1}`).join(' | ') + ' |');
console.log('| :--- | ' + files.map(() => ':---:').join(' | ') + ' |');

const metrics = {
  cpu_load: { regex: /CpuActiveLoadPct:\s*(\d+|N\/A)/, label: '💻 CPU Load %', unit: '%' },
  raw_ms: { regex: /AvgRawMs:\s*(\d+)/, label: '📷 Avg RAW Decode', unit: ' ms' },
  first_paint: { regex: /AvgProgFirstMtMs:\s*(\d+)/, label: '⚡ First Paint (MT)', unit: ' ms' },
  tiled_roi: { regex: /RealJxtcTiledRoi_512_512_Ms:\s*(\d+)/, label: '🔎 Tiled JXTC Crop', unit: ' ms' },
  enc_prep: { regex: /EncInputPrepMs:\s*([\d\.]+|N\/A)/, label: '📦 Enc: Input Prep (JS)', unit: ' ms' },
  enc_malloc: { regex: /EncHeapMallocMs:\s*([\d\.]+|N\/A)/, label: '📦 Enc: WASM Malloc', unit: ' ms' },
  enc_copy: { regex: /EncHeapCopyMs:\s*([\d\.]+|N\/A)/, label: '📦 Enc: Heap Copy', unit: ' ms' },
  enc_cpp: { regex: /EncCoreCompressMs:\s*([\d\.]+|N\/A)/, label: '🚀 Enc: C++ Core Compress', unit: ' ms' },
  enc_read: { regex: /EncBufferReadMs:\s*([\d\.]+|N\/A)/, label: '📦 Enc: Buffer Read (JS)', unit: ' ms' },
};

const results = {};
Object.keys(metrics).forEach(k => { results[k] = [] });

for (const file of files) {
  try {
    const text = fs.readFileSync(file.path, 'utf-8');
    Object.entries(metrics).forEach(([k, config]) => {
      const match = text.match(config.regex);
      results[k].push(match ? match[1] + config.unit : 'N/A');
    });
  } catch (err) {
    Object.keys(metrics).forEach(k => results[k].push('N/A'));
  }
}

Object.entries(metrics).forEach(([k, config]) => {
  console.log(`| **${config.label}** | ${results[k].join(' | ')} |`);
});
