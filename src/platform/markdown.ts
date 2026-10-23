/**
 * Markdown post-processing for chat platforms with a message size limit and no table support.
 */

const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim().replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'));
}

/** Renders a markdown table as a bulleted list (readable on phones, unlike aligned columns). */
function tableToList(header: string[], rows: string[][]): string {
  return rows
    .map((cells) => {
      const [first, ...rest] = cells;
      const details = rest
        .map((c, i) => (c ? `${header[i + 1] ? `${header[i + 1]}: ` : ''}${c}` : ''))
        .filter(Boolean)
        .join(' · ');
      return `- **${first || '—'}**${details ? ` — ${details}` : ''}`;
    })
    .join('\n');
}

/** Replaces GitHub-style tables (outside code blocks) with lists. */
export function convertTables(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (!inCode && line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
        rows.push(splitRow(lines[j]));
        j++;
      }
      out.push(tableToList(header, rows));
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Splits text into chunks of at most `max` characters, preferring paragraph, then line, then word
 * boundaries. A code block cut in two is closed at the end of one chunk and reopened (with its
 * language) at the start of the next.
 */
export function chunkMarkdown(text: string, max = 2000): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  let reopen = '';
  while (rest.length > 0) {
    const budget = max - reopen.length - 4; // room for a closing fence
    if (reopen.length + rest.length <= max) {
      chunks.push(reopen + rest);
      break;
    }
    let cut = -1;
    for (const sep of ['\n\n', '\n', ' ']) {
      const at = rest.lastIndexOf(sep, budget);
      if (at > budget * 0.4) {
        cut = at;
        break;
      }
    }
    if (cut <= 0) cut = budget;
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\s*\n/, '').replace(/^ /, '');
    const fenceLines = piece.match(/^\s*```.*$/gm) ?? [];
    let open = reopen ? 1 : 0;
    let lang = reopen.replace(/```/, '').trim();
    for (const f of fenceLines) {
      if (open) {
        open = 0;
      } else {
        open = 1;
        lang = f.trim().slice(3).trim();
      }
    }
    piece = reopen + piece;
    if (open) {
      piece += '\n```';
      reopen = '```' + lang + '\n';
    } else {
      reopen = '';
    }
    chunks.push(piece);
  }
  return chunks.filter((c) => c.trim().length > 0);
}

/** Makes an agent answer ready to post: tables become lists, then it is chunked. */
export function prepareForChat(text: string, max: number): string[] {
  return chunkMarkdown(convertTables(text), max);
}

/** Prefixes every line with "> " so a block shows as a quote. */
export function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}
