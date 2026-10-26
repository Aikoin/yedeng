/**
 * 提示词集中管理。PROMPT_VERSION 参与缓存键：改了提示词，旧缓存自动失效。
 * 摘要忠于论文；阅读解释允许通用背景，但不得冒充本文证据或联网结果。
 */
import type { ChatMessage } from './types';
import { translationSystem, translationMessages } from './translation';
import { READING_GUIDANCE } from './readingGuidance';

export const PROMPT_VERSION = 'v2.1.0';

const GUARDRAIL =
  '硬性要求：只依据我提供的论文内容作答，不得编造论文中不存在的数字、结论、方法名或引用；' +
  '若给定内容不足以回答，直接说明"给定内容未提及"，不要猜测。';

export interface PaperContext {
  title: string;
  authors?: string;
  sectionTitle?: string;
  pageNumber?: number;
  /** 选区所在段落 */
  paragraph?: string;
  /** 相邻上下文（前后各一段） */
  surroundings?: string;
}

function contextBlock(ctx: PaperContext): string {
  const lines: string[] = [`论文标题：${ctx.title}`];
  if (ctx.authors) lines.push(`作者：${ctx.authors}`);
  if (ctx.sectionTitle) lines.push(`所在章节：${ctx.sectionTitle}`);
  if (ctx.pageNumber) lines.push(`页码：第 ${ctx.pageNumber} 页`);
  if (ctx.surroundings) lines.push(`上下文段落：\n${ctx.surroundings}`);
  return lines.join('\n');
}

function withCustom(system: string, custom?: string): string {
  return custom && custom.trim() ? `${system}\n\n【用户自定义要求（优先级更高）】\n${custom.trim()}` : system;
}

export function translateMessages(
  texts: string[],
  ctx: PaperContext,
  targetLang: string,
  custom?: string
): ChatMessage[] {
  const system = withCustom(
    translationSystem(targetLang)+'\n批量模式：按以下 JSON 格式返回每一片段，不适用纯文本输出格式。\n' +
      '规则：\n' +
      '1) 保持术语准确，首次出现的专业术语用「中文（English）」形式；\n' +
      '2) 公式、变量、引用编号（如 [12]、Figure 3、Table 2、Eq. (5)）原样保留；\n' +
      '3) 只翻译，不加解释、不加译注；\n' +
      '4) 输出必须是严格的 JSON 数组，形如 [{"i":0,"t":"译文"}]，i 与输入下标一一对应，不要输出其他任何内容。',
    custom
  );
  const user =
    `${contextBlock(ctx)}\n\n` +
    `待翻译片段（JSON 数组，按 i 对应）：\n${JSON.stringify(texts.map((text, i) => ({ i, text })))}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function translateOneMessages(
  text: string,
  ctx: PaperContext,
  targetLang: string,
  custom?: string
): ChatMessage[] {
  return translationMessages(text,targetLang,ctx.paragraph||ctx.surroundings||'',custom);
}

export function explainMessages(text: string, ctx: PaperContext, custom?: string): ChatMessage[] {
  const system = withCustom(
    '你是耐心且严谨的论文助教，擅长把晦涩表述讲清楚。\n' +
      `输出格式（用 Markdown）：\n` +
      '**一句话**：用最直白的中文概括这段在说什么。\n' +
      '**要点**：3-5 条要点，逐条解释关键概念、变量含义、以及"为什么这么做"。\n' +
      '**术语**：涉及的专业术语给出简明解释（没有可省略）。\n' +
      `公式用 $...$ 包裹。区分"作者声称"与"已被广泛接受的事实"。\n${READING_GUIDANCE}`,
    custom
  );
  const user = `${contextBlock(ctx)}\n\n需要解释的原文：\n"""\n${text}\n"""`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function summaryMessages(title: string, headText: string, tailText: string, custom?: string): ChatMessage[] {
  const system = withCustom(
    '你是论文速读助手。基于给定论文内容输出三行摘要，每行不超过 30 个汉字，格式严格为：\n' +
      '问题：...\n方法：...\n结论：...\n' +
      `不要输出其他任何内容。\n${GUARDRAIL}`,
    custom
  );
  const user = `论文标题：${title}\n\n【开头部分】\n${headText}\n\n【结尾部分】\n${tailText}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function sectionSummaryMessages(
  docTitle: string,
  sectionTitle: string,
  sectionText: string,
  custom?: string
): ChatMessage[] {
  const system = withCustom(
    '你是论文精读助手。针对给定章节，输出三点，Markdown 无序列表，总长度不超过 200 字：\n' +
      '- 本节要解决什么\n- 具体怎么做（关键设计/公式/实验设置）\n- 结论与局限\n' +
      `不要复述原文长句，不要输出其他章节内容。\n${GUARDRAIL}`,
    custom
  );
  const user = `论文：${docTitle}\n章节：${sectionTitle}\n\n章节内容：\n${sectionText}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function keywordsMessages(docTitle: string, headText: string, custom?: string): ChatMessage[] {
  const system = withCustom(
    '你是文献标引专家。提取 5-8 个最能代表这篇论文的关键词。\n' +
      '输出严格 JSON 数组：[{"term":"英文术语","zh":"中文译名","why":"为什么是关键词，20 字以内"}]，不要输出其他内容。\n' +
      GUARDRAIL,
    custom
  );
  const user = `论文标题：${docTitle}\n\n论文开头内容：\n${headText}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export interface ChatContextChunk {
  pageIndex: number;
  sectionTitle: string;
  text: string;
}

export function chatSystemMessages(
  docTitle: string,
  chunks: ChatContextChunk[],
  custom?: string
): ChatMessage {
  const context = chunks
    .map((c) => `【第 ${c.pageIndex + 1} 页｜${c.sectionTitle || '未命名章节'}】\n${c.text}`)
    .join('\n\n');
  const system = withCustom(
    READING_GUIDANCE+'\n' +
      '回答要求：\n' +
      '1) 先给结论，再给依据；\n' +
      '2) 引用依据时用 [p.页码] 标注，例如 [p.3]，有章节名时写成 [p.3 §Method]；\n' +
      '3) 使用中文回答，保持学术准确；\n' +
      '4) 本文具体数字和结论需有原文支持；一般知识不要伪装成本文结论，不给背景知识硬贴论文引用。',
    custom
  );
  return {
    role: 'system',
    content: `${system}\n\n论文标题：${docTitle}\n\n以下是从论文中检索到的相关片段：\n\n${context}`,
  };
}

export function chatUserMessages(history: ChatMessage[], question: string, selection?: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (selection && selection.trim()) {
    messages.push({
      role: 'user',
      content: `（先看这段选中的原文，然后回答我的问题）\n"""\n${selection.trim()}\n"""`,
    });
  }
  messages.push(...history);
  messages.push({ role: 'user', content: question });
  return messages;
}

export function wordMessages(word: string, sentence: string, targetLang: string, custom?: string): ChatMessage[] {
  const system = withCustom(
    `你是学术英语词典。解释给定单词在论文语境下的含义，输出：\n` +
      `1) 最贴合本语境的中文释义（加粗）；\n2) 该词在论文中的常见义项 1-3 条；\n3) 一句${targetLang}释义。\n` +
      '输出不超过 120 字。',
    custom
  );
  return [
    { role: 'system', content: system },
    { role: 'user', content: `单词：${word}\n所在句子：${sentence}` },
  ];
}
