export interface SearchPage { pageIndex: number; text: string }
export interface SearchHit { pageIndex: number; start: number; end: number; excerpt: string; ordinal: number }
/** Preserve source offsets through compatibility characters and collapsed whitespace. */
export function searchTextMap(text: string): { text: string; starts: number[]; ends: number[] } {
  let normalized = '';
  const starts: number[] = [], ends: number[] = [];
  let offset = 0;
  for (const symbol of text) {
    for (const char of symbol.normalize('NFKC').toLowerCase()) {
      if (/\s/u.test(char)) {
        if (normalized.endsWith(' ')) { ends[ends.length - 1] = offset + symbol.length; continue; }
        normalized += ' ';
      } else normalized += char;
      starts.push(offset); ends.push(offset + symbol.length);
    }
    offset += symbol.length;
  }
  return { text: normalized, starts, ends };
}
export function searchPages(pages: SearchPage[], query: string, limit = 1000): SearchHit[] {
  const needle = searchTextMap(query).text.trim();
  if (!needle || limit <= 0) return [];
  const hits: SearchHit[] = [];
  for (const page of pages) {
    const mapped = searchTextMap(page.text);
    let from = 0, ordinal = 0;
    for (;;) {
      const at = mapped.text.indexOf(needle, from);
      if (at < 0) break;
      const start = mapped.starts[at], end = mapped.ends[at + needle.length - 1];
      hits.push({ pageIndex: page.pageIndex, start, end, ordinal: ordinal++, excerpt: page.text.slice(Math.max(0, start - 34), end + 50).replace(/\s+/g, ' ') });
      if (hits.length >= limit) return hits;
      from = at + needle.length;
    }
  }
  return hits;
}

/** Extracted paragraph order can differ from PDF TextLayer order (notably two columns).
 * Match local context rather than assuming the nth textual hit has the same DOM ordinal. */
export function locateSearchHitInLayer(source: string, hit: SearchHit, layerText: string, query: string): SearchHit | null {
  const candidates = searchPages([{ pageIndex: hit.pageIndex, text: layerText }], query);
  if (candidates.length <= 1) return candidates[0] ?? null;
  const before = searchTextMap(source.slice(Math.max(0, hit.start - 100), hit.start)).text.trimEnd();
  const after = searchTextMap(source.slice(hit.end, hit.end + 100)).text.trimStart();
  function score(candidate: SearchHit): number {
    const left = searchTextMap(layerText.slice(Math.max(0, candidate.start - 100), candidate.start)).text.trimEnd();
    const right = searchTextMap(layerText.slice(candidate.end, candidate.end + 100)).text.trimStart();
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(after.length, right.length, 80) && after[prefix] === right[prefix]) prefix++;
    while (suffix < Math.min(before.length, left.length, 80) && before[before.length - 1 - suffix] === left[left.length - 1 - suffix]) suffix++;
    return prefix + suffix;
  }
  const ranked = candidates.map(candidate => ({ candidate, score: score(candidate) })).sort((a,b) => b.score - a.score);
  return ranked[0].score >= 4 && ranked[0].score > ranked[1].score ? ranked[0].candidate : null;
}
