// Append-only revert manifest: each banked change isolated for cherry-pick / revert.
// `status` distinguishes what actually moves the after-benchmark:
//   landed-harness  = wired into StandardMultifileTest.mjs (reflected in after-dump)
//   landed-worktree = accepted diff committed in an isolated worktree, NOT rebuilt into
//                     the shipped pkg/dist the benchmark loads (invisible to after-dump)
//   not-landed      = config-only flipflop-validated candidate never wired to production
//                     source (no diff to revert; kept as a flipflop test)

export function addEntry(list, e) {
  return [...list, {
    id: e.id, layer: e.layer, lens: e.lens, file: e.file,
    accept_reason: e.accept_reason, saved_pct: e.saved_pct, diffPath: e.diffPath,
    status: e.status ?? 'landed-harness', note: e.note ?? '',
  }];
}

export function renderManifest(list) {
  const head = `# optimize-codec-times — revert manifest\n\n| id | status | layer | lens | file | reason | saved% | diff | note |\n|----|--------|-------|------|------|--------|--------|------|------|\n`;
  const rows = list.map(e =>
    `| ${e.id} | ${e.status ?? 'landed-harness'} | ${e.layer} | ${e.lens} | ${e.file} | ${e.accept_reason} | ${e.saved_pct} | ${e.diffPath} | ${e.note ?? ''} |`
  ).join('\n');
  return head + rows + '\n';
}
