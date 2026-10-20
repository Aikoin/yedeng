/** One bounded response supplies both overview and keyword chips. */
export interface OverviewAnswer { summary: string; keywords: string[] }
export function parseOverview(text: string): OverviewAnswer {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data: unknown;
  try { data = JSON.parse(clean); } catch { throw new Error('概览返回格式不完整，请点击重新生成'); }
  if (!data || typeof data !== 'object') throw new Error('概览格式不完整');
  const value = data as Partial<OverviewAnswer>;
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 6000 || !Array.isArray(value.keywords) || value.keywords.length > 8 || value.keywords.some(k => typeof k !== 'string' || !k.trim() || k.length > 100)) throw new Error('概览格式不完整，请点击重新生成');
  return { summary: value.summary, keywords: [...new Set(value.keywords)] };
}
