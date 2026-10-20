import katex from 'katex';

export type FormulaRender = { status: 'rendered'; html: string } | { status: 'unsupported' | 'invalid'; message: string };
/** A render check is not a recognition or mathematical correctness check. */
export function renderFormula(latex: string, displayMode = true): FormulaRender {
  if (latex.length > 12000) return { status: 'invalid', message: '公式超过预览长度上限，源码仍保留' };
  if (/\\(?:href|url|includegraphics|html\w*|gdef|global)\b/.test(latex)) {
    return { status: 'unsupported', message: '包含外部资源或不支持的全局命令；保留源码与原图' };
  }
  try {
    return { status: 'rendered', html: katex.renderToString(latex, {
      displayMode, throwOnError: true, trust: false,
      maxExpand: 1000, maxSize: 20, strict: 'error', macros: {},
    }) };
  } catch { return { status: 'unsupported', message: '当前数学环境或命令无法渲染；保留源码与原图，可继续校对' }; }
}
