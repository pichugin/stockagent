/** Minimal fixed-width text table — keeps Phase 1 dependency-light. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );

  const pad = (cells: string[]) =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ');

  const sep = widths.map((w) => '-'.repeat(w)).join('  ');

  return [pad(headers), sep, ...rows.map(pad)].join('\n');
}
