/** 从模型输出里稳健地抠出 JSON：容忍 ```json 围栏、前后废话、数组/对象混排。 */

export function extractJsonText(text: string): string | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = firstIndexOfAny(body, ['{', '[']);
  if (start < 0) return null;
  const openChar = body[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  // 截断的 JSON：尽量补齐
  if (depth > 0) return body.slice(start);
  return null;
}

function firstIndexOfAny(text: string, chars: string[]): number {
  let best = -1;
  for (const ch of chars) {
    const i = text.indexOf(ch);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

export function parseJsonLoose<T>(text: string): T | null {
  const jsonText = extractJsonText(text);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    // 常见问题：尾随逗号、单引号
    const repaired = jsonText
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3');
    try {
      return JSON.parse(repaired) as T;
    } catch {
      return null;
    }
  }
}

/** 从可能带编号/前后缀的列表文本里抠出条目（兜底用） */
export function parseLineList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
    .filter((l) => l.length > 0)
    .slice(0, 40);
}
