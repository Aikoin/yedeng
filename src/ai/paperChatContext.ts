/** Local adaptive reading: complete extracted text when it fits; ranked pages and chapter coverage otherwise. */
import type { DocText, PageText } from '../pdf/extract';
import { search, type Bm25Index, type Chunk } from '../pdf/bm25';

export const FULL_CHAT_TEXT_CHARS = 60000;
export interface ChatHistoryItem { role: 'user' | 'assistant'; content: string }
export interface ChatEvidenceEntry { label: string; pageIndices: number[]; text: string; truncated: boolean }
export interface ChatEvidencePlan {
  entries: ChatEvidenceEntry[];
  strategy: 'full-text' | 'cross-section';
  suppliedPages: number;
  extractedPages: number;
  budget: number;
  matched: boolean;
}
// Local bilingual hints improve Chinese questions over English papers without an extra model request.
const TERMS: readonly (readonly string[])[] = [
  ['全双工', 'full-duplex', 'full duplex'], ['半双工', 'half-duplex', 'half duplex'],
  ['双工', 'duplex'], ['插话', 'interruption', 'interrupt'], ['应和', 'backchannel'],
  ['上下文', 'context'], ['注意力', 'attention'], ['多头', 'multi-head', 'multihead'],
  ['蒸馏', 'distillation'], ['强化学习', 'reinforcement learning'], ['梯度', 'gradient'],
  ['消融', 'ablation'], ['推理', 'inference', 'reasoning'], ['训练', 'training'],
  ['数据集', 'dataset'], ['架构', 'architecture'], ['实验', 'experiment', 'evaluation'],
  ['局限', 'limitation'], ['结论', 'conclusion'], ['缓存', 'cache', 'caching'],
];
export function expandPaperQuery(question: string, history: readonly ChatHistoryItem[] = []): string {
  const prior = history.filter(m => m.role === 'user').slice(-2).map(m => m.content).join(' ').slice(-1200);
  const base = `${question} ${prior}`.trim();
  const folded = base.toLowerCase();
  const extra = TERMS.filter(group => group.some(term => folded.includes(term.toLowerCase()))).flat();
  // Include the most recent named English terms for follow-ups such as “它和另一种有什么不同”.
  const english = history.filter(m => m.role === 'assistant').at(-1)?.content.match(/\b[A-Za-z][A-Za-z-]{2,}\b/g)?.slice(0, 40) ?? [];
  return [...new Set([base, ...extra, ...english])].join(' ');
}
export function retrievePaperChat(index: Bm25Index, question: string, history: readonly ChatHistoryItem[] = []): Chunk[] {
  const primary = search(index, expandPaperQuery(question), 16);
  const followup = search(index, expandPaperQuery(question, history), 16);
  const seen = new Set<string>();
  return [...primary, ...followup].filter(hit => {
    if (seen.has(hit.chunk.id)) return false;
    seen.add(hit.chunk.id); return true;
  }).slice(0, 24).map(hit => hit.chunk);
}
export function isBroadPaperQuestion(question: string): boolean {
  return /全文|整篇|总体|整体|综述|总结|主要贡献|核心贡献|最重要|局限|不足|实验|消融|对比|比较|区别|不同|优缺点|详细|推导|证明|overall|contribution|limitation|experiment|compar|derive|proof/i.test(question);
}
function sectionName(doc: DocText, page: PageText): string {
  return [...doc.sections].reverse().find(s => s.pageIndex <= page.pageIndex && s.endPageIndex >= page.pageIndex)?.title ?? '正文';
}
export function planPaperChat(doc: DocText, question: string, hits: readonly Chunk[] = []): ChatEvidencePlan {
  const pages = doc.pages.filter(p => p.text.trim()).sort((a,b) => a.pageIndex-b.pageIndex);
  const allChars = pages.reduce((n,p) => n+p.text.trim().length,0);
  if (allChars <= FULL_CHAT_TEXT_CHARS) return {
    entries: pages.map(page => ({label: `全文文字 · ${sectionName(doc,page)}`,pageIndices:[page.pageIndex],text:page.text.trim(),truncated:false})),
    strategy:'full-text',suppliedPages:pages.length,extractedPages:pages.length,budget:FULL_CHAT_TEXT_CHARS,matched:hits.length>0,
  };
  const broad = isBroadPaperQuestion(question), budget = broad ? 60000 : 40000;
  const entries: ChatEvidenceEntry[] = [], used = new Set<number>(); let chars = 0;
  const add = (pageIndex: number, label: string, excerpt?: string) => {
    if(used.has(pageIndex))return;
    const page=pages.find(p=>p.pageIndex===pageIndex);if(!page)return;
    const text=page.text.trim();
    if(chars+text.length<=budget){entries.push({label:`${label} · ${sectionName(doc,page)}`,pageIndices:[pageIndex],text,truncated:false});chars+=text.length;used.add(pageIndex);return;}
    // Preserve the matching passage rather than clipping every source to an equal head/tail quota.
    const piece=excerpt?.trim();
    if(piece && text.includes(piece) && chars+piece.length<=budget){entries.push({label:`检索原文段落 · ${sectionName(doc,page)}`,pageIndices:[pageIndex],text:piece,truncated:true});chars+=piece.length;used.add(pageIndex);}
  };
  const ranked=hits.filter(h=>pages.some(p=>p.pageIndex===h.pageIndex));
  // Reserve chapter coverage before filling all space with similarly worded passages.
  for(const hit of ranked.slice(0,broad?4:6))add(hit.pageIndex,'相关页及完整上下文',hit.text);
  if(pages[0])add(pages[0].pageIndex,'论文开头');
  const chapters=doc.sections.filter(s=>/abstract|intro|method|model|approach|result|eval|exper|discuss|conclu|limit|摘要|引言|方法|模型|结果|实验|讨论|结论|局限/i.test(s.title));
  for(const section of chapters.slice(0,broad?16:8))add(section.pageIndex,'关键章节');
  for(const hit of ranked.slice(0,8))for(const page of [hit.pageIndex-1,hit.pageIndex+1])add(page,'命中段落的相邻页');
  for(const hit of ranked)add(hit.pageIndex,'补充相关页',hit.text);
  // Even an unmatched Chinese or broad question sees a spread of the paper, never just its first two paragraphs.
  const count=broad||!ranked.length?16:8;
  for(let i=0;i<count;i++)add(pages[Math.round(i*(pages.length-1)/(count-1))]?.pageIndex,'跨章节补充');
  if(!entries.length && pages[0]){
    // Pathological extraction: a single gigantic paragraph/page. Keep a visible, bounded excerpt.
    const page=pages[0];entries.push({label:'超长文字页节选',pageIndices:[page.pageIndex],text:page.text.trim().slice(0,budget),truncated:true});
  }
  return {entries,strategy:'cross-section',suppliedPages:used.size||entries.length,extractedPages:pages.length,budget,matched:ranked.length>0};
}
export function prepareChatHistory(history: readonly ChatHistoryItem[] = []): ChatHistoryItem[] {
  const selected: ChatHistoryItem[]=[];let size=0;
  for(const item of history.slice(-12).reverse()){
    if(!item.content.trim())continue;
    const original=item.role==='assistant'?item.content.replace(/\[E\d+\]/g,''):item.content;
    const max=item.role==='user'?2000:5000;
    const content=original.length<=max?original:original.slice(0,max-1400)+'\n[较早回答中段已省略，不能作为本文证据]\n'+original.slice(-1300);
    if(size+content.length>16000)break;
    selected.unshift({role:item.role,content});size+=content.length;
  }
  // Do not start a conversational context with an orphaned assistant reply.
  while(selected[0]?.role==='assistant')selected.shift();
  return selected;
}
