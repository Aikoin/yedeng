/** Pipe tables, parsed as text only. Cells are rendered through the same safe inline renderer as prose. */
export type TableAlignment = 'left' | 'center' | 'right';
export interface MarkdownTable { headers: string[]; alignments: TableAlignment[]; rows: string[][]; end: number }

export function splitTableRow(raw: string): string[] | null {
  const line = raw.trim(), cells: string[] = [], separators: number[] = [];
  let cell = '', ticks = 0, mathEnd = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i], next = line[i + 1];
    if (mathEnd) {
      if (line.startsWith(mathEnd, i)) { cell += mathEnd; i += mathEnd.length - 1; mathEnd = ''; }
      else cell += char;
      continue;
    }
    if (!ticks && char === '\\' && next === '(' && line.indexOf('\\)', i + 2) >= 0) {
      cell += '\\('; i++; mathEnd = '\\)'; continue;
    }
    if (char === '\\' && next) {
      cell += next === '|' ? '|' : char + next; i++; continue;
    }
    if (char === '`') {
      let length = 1; while (line[i + length] === '`') length++;
      if (ticks === length) ticks = 0;
      else if (!ticks && line.indexOf('`'.repeat(length), i + length) >= 0) ticks = length;
      cell += '`'.repeat(length); i += length - 1; continue;
    }
    if (char === '|' && !ticks) { cells.push(cell.trim()); cell = ''; separators.push(i); }
    else cell += char;
  }
  if (!separators.length) return null;
  cells.push(cell.trim());
  if (separators[0] === 0) cells.shift();
  if (separators.at(-1) === line.length - 1) cells.pop();
  return cells;
}

export function parseMarkdownTable(lines: readonly string[], start: number): MarkdownTable | null {
  if (start + 1 >= lines.length) return null;
  const headers = splitTableRow(lines[start]), delimiter = splitTableRow(lines[start + 1]);
  if (!headers?.length || !delimiter || headers.length !== delimiter.length || !delimiter.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  const alignments = delimiter.map((cell): TableAlignment => cell.endsWith(':') ? cell.startsWith(':') ? 'center' : 'right' : 'left');
  const rows: string[][] = []; let end = start + 2;
  while (end < lines.length) {
    if (/^\s*(?:#{1,6}\s|```|~~~|[-*+]\s|\d+[.)]\s)/.test(lines[end])) break;
    const cells = splitTableRow(lines[end]); if (!cells) break;
    rows.push(headers.map((_, i) => cells[i] ?? '')); end++;
  }
  return { headers, alignments, rows, end };
}
