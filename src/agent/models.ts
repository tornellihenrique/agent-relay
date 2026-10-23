/** Display helpers for model ids and context windows. */

export interface ModelCatalogRow {
  value: string;
  displayName: string;
  resolvedModel?: string;
}

const FAMILY = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

/** "claude-opus-5-5" → "Opus 5.5"; uses the CLI's catalog when it knows the id. */
export function modelLabel(id: string | undefined, catalog?: ModelCatalogRow[]): string {
  if (!id) return 'default model';
  const bare = id.replace(/\[.*\]$/, '');
  const row = catalog?.find((r) => r.value !== 'default' && (r.value === bare || r.resolvedModel === bare));
  if (row) return row.displayName;
  const m = bare.match(FAMILY);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  return bare;
}

/** 1000000 → "1M", 200000 → "200k". */
export function windowLabel(tokens: number | undefined): string {
  if (!tokens) return '?';
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1000)}k`;
}

/** 23456 → "23k", 1234567 → "1.2M". */
export function tokensLabel(tokens: number | undefined): string {
  if (tokens === undefined) return '?';
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}
