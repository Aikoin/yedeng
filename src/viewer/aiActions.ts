/** Reader-first AI actions: direct intent, one output, bounded context and durable request claims. */
import { prepareDocumentContext, type DocumentAction, type DocumentContext, type DocumentSource } from '../ai/documentContext';
import { productionDispatcher, ensureReaderAiAccess, setDocumentAiPolicy } from '../ai/dispatcher';
import { authorizeExplicitSend, supportsThinkingToggle } from '../ai/preparedRequest';
import { h, qs } from '../shared/dom';
import { idbGet, idbPut, type ChatRecord } from '../shared/idb';
import { isConfigured, loadSettings, saveSettings, type FeatureKey } from '../shared/settings';
import { toast } from '../shared/toast';
import { persistDocumentChatTurn } from '../shared/documentChat';
import type { Section } from '../pdf/extract';
import { sha256Hex } from '../shared/hash';
import { createStreamingAnswer, streamingPreview } from './streamingAnswer';
import { renderMarkdown } from './markdown';
import { jumpToPage, rebuildIndex, state } from './state';
import { retrievePaperChat } from '../ai/paperChatContext';
import { requestSessionGeneration } from './requestWorkspace';
import { openDocumentSource } from './documentSources';
import { AiOutputLimitError } from '../ai/types';
import { parseOverview } from '../ai/overview';

const dispatcher = productionDispatcher(() => ({ docId: state.docId, sessionGeneration: requestSessionGeneration() }));
interface StoredAnswer extends ChatRecord { sources?: DocumentSource[]; sourceRevision?: string }
let epoch = 0, registered = false, restoreGeneration = 0;
let chatRestored:Promise<void>=Promise.resolve();
let job: { action: DocumentAction; docId: string; viewer: object; epoch: number; controller: AbortController; output?: HTMLElement } | null = null;
let history: { role: 'user' | 'assistant'; content: string; at: number; sources?: DocumentSource[]; coverage?: string }[] = [];
const featureFor = (action: DocumentAction): FeatureKey => action === 'overview' ? 'summary' : action === 'sectionBatch' ? 'sectionSummary' : action;
const keyFor = (action: DocumentAction, index?: number) => `${state.docId}:g4-${action === 'sectionSummary' ? `section:${index}` : action}`;

export function resetAiPanels(): void {
  document.querySelector('.yd-source-peek')?.remove();
  restoreGeneration++;chatRestored=Promise.resolve();epoch++; job?.controller.abort(); job = null; history = []; dispatcher.invalidate('已切换论文');
  setChatBusy(false);
  for (const id of ['summary-body','keywords-body','section-list','chat-log']) document.getElementById(id)?.replaceChildren();
}
export function initAiPanels(): void {
  qs('#btn-setup-ai').onclick = () => { void chrome.tabs.create({ url: chrome.runtime.getURL('welcome/index.html')+'?returnTo='+encodeURIComponent(location.href) }); };
  qs('#btn-summary-regen').textContent = '重新生成';
  qs('#btn-sections-all').hidden = true;
  qs('#btn-summary-regen').onclick = () => void run('overview', undefined, undefined, true);
  qs('#btn-sections-stop').onclick = () => job?.controller.abort();
  qs('#btn-chat-send').textContent = '发送 ↑';
  qs('#btn-chat-send').onclick = () => void run('chat');
  qs('#btn-chat-stop').onclick = () => job?.controller.abort();
  qs('#btn-chat-clear').onclick = () => void clearChat();
  qs<HTMLTextAreaElement>('#chat-input').onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void run('chat'); }
  };
  qs<HTMLSelectElement>('#model-select').onchange = event => {
    const value = (event.target as HTMLSelectElement).value;
    if (value === '__settings__') { void chrome.runtime.sendMessage({ type: 'open-options' }); return; }
    const [providerId, ...parts] = value.split('::');
    void (async () => { try {
      const settings = await loadSettings();
      for (const feature of ['chat','explain','translate','summary','sectionSummary','keywords'] as const) settings.routing[feature] = { providerId, model: parts.join('::') };
      await saveSettings(settings); state.settings = await loadSettings(); dispatcher.invalidate('模型已切换'); toast('文字模型已切换', 'success');
    } catch(error) { toast(String(error), 'error'); } })();
  };
  const auto = document.querySelector<HTMLInputElement>('#auto-overview');
  if (auto) auto.onchange = () => { void (async () => { const settings=await loadSettings();settings.reading={autoOverview:auto.checked};await saveSettings(settings);state.settings=settings; })().catch(error=>toast(String(error),'error')); };
  const docAi = document.querySelector<HTMLInputElement>('#document-ai-enabled');
  if (docAi) docAi.onchange = () => { const docId=state.docId; if(!docId)return;void setDocumentAiPolicy(docId,docAi.checked?'allowed_to_configured_provider':'deny_all_ai').then(()=>{dispatcher.invalidate('本篇AI设置已改变');const channel=new BroadcastChannel('yedeng-document-ai-policy');channel.postMessage({docId});channel.close();}).catch(error=>toast(String(error),'error')); };
  dispatcher.subscribe(() => { epoch++;const previous=job;previous?.controller.abort();if(previous?.output)previous.output.textContent='任务已暂停，可点击重新生成或重新发送。';document.querySelectorAll('.yd-inline-progress').forEach(e=>e.remove());job=null;setChatBusy(false); });
  if (!registered) {
    registered=true;
    chrome.runtime.onMessage.addListener((m:{type?:string})=>{if(m?.type==='settings-changed')dispatcher.invalidate('配置变化');});
    chrome.storage?.onChanged?.addListener((changes,area)=>{if(area==='local'&&'settings.v1' in changes)dispatcher.invalidate('配置变化');});
    if(typeof BroadcastChannel!=='undefined'){const c=new BroadcastChannel('yedeng-document-ai-policy');c.onmessage=()=>dispatcher.invalidate('文献设置变化');}
  }
  renderModelSelect();renderChat();
}
export function renderModelSelect():void {
  const select=qs<HTMLSelectElement>('#model-select');select.replaceChildren();select.setAttribute('aria-label','文字任务模型');select.title='文字任务使用此模型；图片自动使用视觉路由';
  qs('#btn-setup-ai').hidden=isConfigured(state.settings);
  const route=state.settings.routing.chat;
  for(const p of state.settings.providers.filter(p=>p.baseUrl&&p.apiKey)) for(const model of p.models.length?p.models:[p.defaultModel]) if(model)select.append(h('option',{value:`${p.id}::${model}`,selected:route?.providerId===p.id&&route.model===model},`${p.name} · ${model}`));
  select.append(h('option',{value:'__settings__'},'管理模型…'));
  const auto=document.querySelector<HTMLInputElement>('#auto-overview');if(auto)auto.checked=state.settings.reading?.autoOverview!==false;
}
function sourceDetails(sources:DocumentSource[],coverage?:string):HTMLElement {
  const mode=coverage?.includes('本轮未联网')?(!sources.length?' · 无可用正文 · 未联网':coverage.startsWith('已提供全部')?' · 全文可提取文字 · 未联网':' · 跨章节选段 · 未联网'):'';
  const details=h('details',{class:'yd-answer-sources'},h('summary',{},'来源与范围'+mode));
  if(coverage)details.append(h('p',{class:'ml-muted'},coverage));
  for(const s of sources){const b=h('button',{class:'ghost'},`原文 · 第 ${s.pageIndices.map(p=>p+1).join('、')} 页`);b.onclick=()=>void openDocumentSource(s);details.append(b);}
  return details;
}
function showStreamingAnswer(output:HTMLElement,text:string,sources:DocumentSource[]):void {
  // Keep source controls functional while streaming, without appending a source list each tick.
  const valid=sources.map(s=>({...s,pageIndices:s.pageIndices.filter(p=>Number.isSafeInteger(p)&&p>=0&&p<state.info.numPages)})).filter(s=>s.pageIndices.length);
  const pages=[...new Set(valid.flatMap(s=>s.pageIndices))];
  output.replaceChildren(renderMarkdown(text,{validPageIndices:pages,evidenceSources:valid,onEvidenceCite:id=>{const source=valid.find(s=>s.id===id);if(source)void openDocumentSource(source);},onCite:page=>{if(pages.includes(page))jumpToPage(page);}}));
  output.append(h('small',{class:'ml-muted'},'正在生成，尚未保存…'));
}
function showAnswer(output:HTMLElement,text:string,sources:DocumentSource[],coverage?:string):void {
  sources=sources.map(source=>({...source,pageIndices:source.pageIndices.filter(page=>Number.isSafeInteger(page)&&page>=0&&page<state.info.numPages)})).filter(source=>source.pageIndices.length>0);
  const pages=[...new Set(sources.flatMap(s=>s.pageIndices))];
  output.replaceChildren(renderMarkdown(text,{validPageIndices:pages,evidenceSources:sources,onEvidenceCite:id=>{const s=sources.find(s=>s.id===id);if(s)void openDocumentSource(s);},onCite:p=>{if(pages.includes(p))jumpToPage(p);}}));
  if(sources.length||coverage)output.append(sourceDetails(sources,coverage));
}
function showOverview(text:string,sources:DocumentSource[]):void {
  const value=parseOverview(text);showAnswer(qs('#summary-body'),value.summary,sources);
  qs('#keywords-body').replaceChildren(...value.keywords.map(word=>h('span',{class:'yd-keyword'},word)));
}
async function restore(key:string,output:HTMLElement|null,docId:string,viewer:object|null,version:number):Promise<boolean>{
  try{const saved=await idbGet('chats',key) as StoredAnswer|undefined;
    if(state.docId!==docId||state.viewer!==viewer||epoch!==version||!saved?.messages[0]?.content)return false;
    if(output)showAnswer(output,saved.messages[0].content,saved.sources??[]);else showOverview(saved.messages[0].content,saved.sources??[]);return true;
  }catch{return false;}
}
export function onTextExtracted():void {
  rebuildIndex();renderModelSelect();const docId=state.docId,viewer=state.viewer,version=++epoch;
  restoreChatHistory(docId,viewer);
  qs('#summary-body').textContent=isConfigured(state.settings)?'正在整理这篇论文…':'连接 AI 服务后，自动生成摘要与关键词。';
  qs('#keywords-body').textContent='';const host=qs('#section-list');host.replaceChildren();
  const sections=state.docText?.sections.filter(s=>s.text.trim().length>120)??[];
  if(!sections.length)host.textContent='未检测到章节目录。';
  sections.forEach((section,index)=>{
    const body=h('div',{class:'ml-section-item__body',id:`document-section-${index}`});
    const toggle=h('button',{class:'yd-section-toggle','aria-expanded':'false'},h('span',{},section.title),h('small',{},`P${section.pageIndex+1}  ›`));
    const card=h('section',{class:'yd-section-card'},toggle,body);body.hidden=true;
    toggle.onclick=()=>{body.hidden=!body.hidden;toggle.setAttribute('aria-expanded',String(!body.hidden));if(!body.hidden&&!body.textContent)void run('sectionSummary',section,index);};host.append(card);
    void restore(`${docId}:g4-section:${index}`,body,docId,viewer,version);
  });
  void(async()=>{
    const stored=await idbGet('docs',docId);if(state.docId!==docId||state.viewer!==viewer||epoch!==version)return;
    const toggle=document.querySelector<HTMLInputElement>('#document-ai-enabled');if(toggle)toggle.checked=stored?.policy!=='deny_all_ai';
    const overview=await restore(`${docId}:g4-overview`,null,docId,viewer,version);
    if(!overview){const old=await Promise.all([restore(`${docId}:g4-summary`,qs<HTMLElement>('#summary-body'),docId,viewer,version),restore(`${docId}:g4-keywords`,qs<HTMLElement>('#keywords-body'),docId,viewer,version)]);
      if(state.docId!==docId||state.viewer!==viewer||epoch!==version)return;
      if(state.settings.reading?.autoOverview!==false&&isConfigured(state.settings)&&stored?.policy!=='deny_all_ai')await run('overview');
      else if(!old[0])qs('#summary-body').textContent=stored?.policy==='deny_all_ai'?'本篇已关闭 AI，可在下方阅读设置中开启。':!isConfigured(state.settings)?'连接 AI 服务后，自动生成摘要与关键词。':'自动概览已关闭，点击“重新生成”查看摘要。';
    }
    if(state.docId!==docId||state.viewer!==viewer||epoch!==version)return;
  })().catch(error=>{if(state.docId===docId)qs('#summary-body').textContent=String(error);});
}
function restoreChatHistory(docId:string,viewer:object|null):void {
  const generation=++restoreGeneration;
  chatRestored=(async()=>{
    try{
      const saved=await idbGet('chats',`${docId}:chat`);
      if(state.docId!==docId||state.viewer!==viewer||generation!==restoreGeneration)return;
      history=saved?.messages.filter(m=>!m.error).map(m=>({...m,role:m.role as 'user'|'assistant'}))??[];
      if(job?.action!=='chat')renderChat();
    }catch{if(state.docId===docId&&generation===restoreGeneration)toast('本地对话暂未读取成功，请重新打开论文；没有删除历史记录','error');}
  })();
}
function renderChat(scrollToLatest=true):void {
  const previousScroll=document.getElementById('chat-log')?.scrollTop??0;
  const log=qs('#chat-log');log.replaceChildren();
  if(!history.length){const empty=h('div',{class:'yd-chat-empty'},h('span',{class:'yd-chat-orbit'},'✧'),h('h3',{},'从一个问题开始'),h('p',{},'结合这篇论文，聊聊你想弄懂的地方。'));
    for(const text of ['这篇论文最重要的发现是什么？','方法有哪些局限？']){const b=h('button',{class:'yd-suggestion'},text);b.onclick=()=>{qs<HTMLTextAreaElement>('#chat-input').value=text;qs('#chat-input').focus();};empty.append(b);}log.append(empty);
  }
  for(const message of history){const bubble=h('article',{class:`ml-bubble ml-bubble--${message.role==='user'?'user':'ai'}`});if(message.role==='user')bubble.textContent=message.content;else showAnswer(bubble,message.content,message.sources??[],message.coverage);log.append(bubble);}
  log.scrollTop=scrollToLatest?log.scrollHeight:previousScroll;
}
function setChatBusy(value:boolean):void {
  const send=document.querySelector<HTMLButtonElement>('#btn-chat-send');
  if(send){send.disabled=value;send.hidden=value;}
  document.querySelector('#btn-chat-stop')?.classList.toggle('ml-hidden',!value);
}
async function run(action:DocumentAction,section?:Section,index?:number,force=false,retryTarget?:{question:string;reply:HTMLElement;docId:string;viewer:object;maxTokens?:number}):Promise<void>{
  if(retryTarget&&(state.docId!==retryTarget.docId||state.viewer!==retryTarget.viewer)){toast('请回到原论文再重试','info');return;}
  if(job&&action==='chat'&&job.action!=='chat'){epoch++;job.controller.abort();if(job.output)job.output.textContent='概览已暂停，可稍后重新生成。';job=null;}
  if(job){toast('正在处理当前任务，可以先取消','info');return;}
  const docId=state.docId,viewer=state.viewer,doc=state.docText;if(!docId||!viewer||!doc){toast('请先打开论文','info');return;}
  if(!isConfigured(state.settings)){void chrome.tabs.create({url:chrome.runtime.getURL('welcome/index.html')+'?returnTo='+encodeURIComponent(location.href)});return;}
  const question=action==='chat'?(retryTarget?.question??qs<HTMLTextAreaElement>('#chat-input').value.trim()):'';if(action==='chat'&&!question)return;
  const owned={action,docId,viewer,epoch,controller:new AbortController(),output:undefined as HTMLElement|undefined};job=owned;const current=()=>job===owned&&state.docId===docId&&state.viewer===viewer&&epoch===owned.epoch;
  let reply:HTMLElement|undefined;
  let progress:HTMLElement|undefined;
  let context:DocumentContext|undefined;
  let streamedText='';
  const stream=createStreamingAnswer(text=>{if(current()&&reply&&context)showStreamingAnswer(reply,streamingPreview(text),context.sources);});
  try{
    const output=action==='overview'?qs<HTMLElement>('#summary-body'):action==='keywords'?qs<HTMLElement>('#keywords-body'):action==='sectionSummary'?qs<HTMLElement>(`#document-section-${index}`):qs<HTMLElement>('#chat-log');
    reply=output;
    if(action==='chat'){
      // The empty-state card is absent after the first turn; its absence is normal.
      output.querySelector('.yd-chat-empty')?.remove();
      if(retryTarget){reply=retryTarget.reply;reply.textContent='正在重试…';}
      else{
        output.append(h('article',{class:'ml-bubble ml-bubble--user'},question));
        reply=h('article',{class:'ml-bubble ml-bubble--ai'},'正在阅读相关段落…');output.append(reply);
        qs<HTMLTextAreaElement>('#chat-input').value='';
      }
      setChatBusy(true);
      output.scrollTop=output.scrollHeight;
    }else output.textContent='正在阅读与整理…';
    owned.output=reply;
    progress=h('div',{class:'yd-inline-progress'},h('span',{class:'ml-spinner'}),h('span',{},'生成中'),h('button',{class:'ghost'},'取消'));
    progress.querySelector('button')!.onclick=()=>owned.controller.abort();if(action!=='chat')output.before(progress);
    if(!await ensureReaderAiAccess(docId))throw new Error('本篇已关闭 AI，请在阅读设置中开启');if(!current())return;
    if(action==='chat'){await chatRestored;if(!current())return;}
    const hits=action==='chat'&&state.index?retrievePaperChat(state.index,question,history):[];
    context=prepareDocumentContext({action,question,title:state.info.title,doc,totalPages:state.info.numPages,section,hits,history,custom:[state.settings.prompts[featureFor(action)],state.settings.prompts.custom].filter(Boolean).join('\n')});
    if(action==='chat')reply.textContent=context.coverage.startsWith('已提供全部')?'正在通读可提取的论文文字并组织回答…':'正在结合相关上下文与关键章节回答…';
    const revision=await sha256Hex(new TextEncoder().encode(JSON.stringify(context.messages)).buffer);
    const scope={type:'document_action' as const,action:`document_${action}`,feature:featureFor(action),docId,sessionGeneration:requestSessionGeneration(),sourceRevision:revision,resultSources:context.sources};
    // Chat follows the provider's configured output budget and thinking defaults, instead of forcing 1600 tokens / thinking off.
    const parameters={temperature:.2,...(action==='chat'?(retryTarget?.maxTokens?{maxTokens:retryTarget.maxTokens}:{}):{maxTokens:action==='overview'?1200:1600})};
    let prepared=await dispatcher.prepare(scope,context.messages,parameters);
    if(action!=='chat'&&supportsThinkingToggle(prepared.request.endpoint,prepared.request.model))prepared=await dispatcher.prepare(scope,context.messages,{...parameters,thinking:'disabled'});
    if(!current())return;
    const result=await dispatcher.send(prepared,authorizeExplicitSend(prepared.request),{force,retryInterrupted:action==='chat',signal:owned.controller.signal,onDelta:delta=>{if(!current())return;streamedText+=delta;if(action!=='overview')stream.push(delta);}});
    if(!current())return;
    stream.stop();
    if(action==='overview')showOverview(result.text,context.sources);else showAnswer(reply,result.text,context.sources,context.coverage);
    if(action==='chat'){
      const at=Date.now();history.push({role:'user',content:question,at},{role:'assistant',content:result.text,at,sources:context.sources,coverage:context.coverage});
      // Conversation history is user data, independent of reusable model-result caching.
      const turn={id:prepared.request.id,question,answer:result.text,at,sources:context.sources,coverage:context.coverage};
      const notice=h('small',{class:'ml-muted'},'正在保存对话…');reply.append(notice);
      const save=async()=>{
        try{const merged=await persistDocumentChatTurn(docId,turn);
          notice.remove();
          if(state.docId===docId&&state.viewer===viewer){if(current()){history=merged;renderChat(false);const saved=h('small',{class:'ml-muted'},'已保存到本机');qs('#chat-log').append(saved);}else if(!job)history=merged;}
        }catch{
          notice.textContent='回答已生成，但本地保存失败。刷新前请重试保存或复制回答。';
          const retrySave=h('button',{class:'ghost'},'重试保存');
          retrySave.onclick=()=>{retrySave.remove();notice.textContent='正在保存对话…';void save();};notice.append(retrySave);
        }
      };
      await save();
    }else if(state.settings.cache.enabled)await idbPut('chats',{key:keyFor(action,index),docId,messages:[{role:'assistant',content:result.text,at:Date.now()}],sources:context.sources,sourceRevision:revision,updatedAt:Date.now()} as StoredAnswer);
    if(current()&&result.storageWarning)reply.append(h('small',{class:'ml-muted'},result.storageWarning));
  }catch(error){stream.stop();if(current()){
    const message=owned.controller.signal.aborted?'已取消，未自动重试。':error instanceof Error?error.message:String(error);
    if(reply){
      const partial=error instanceof AiOutputLimitError?error.partialText:streamedText;
      if(partial.trim())showAnswer(reply,partial,context?.sources??[],context?.coverage);else reply.replaceChildren();
      reply.append(h('p',{class:'yd-status'},message));
      if(partial.trim())reply.append(h('small',{class:'ml-muted'},'以上为未完成的回答，仅保留在当前页面，尚未存入完整对话。'));
      const limit=error instanceof AiOutputLimitError?error.maxTokens:undefined;
      const higher=error instanceof AiOutputLimitError&&action==='chat'&&(!limit||limit<32768)?Math.min(32768,Math.max(8192,(limit??4096)*2)):undefined;
      if(error instanceof AiOutputLimitError){
        reply.append(h('small',{class:'ml-muted'},limit?`本次输出上限：${limit} tokens。`:'服务未返回具体输出上限。'));
        const settings=h('button',{class:'ghost'},'调整输出额度');settings.onclick=()=>void chrome.runtime.sendMessage({type:'open-options'});reply.append(settings);
      }
      const retry=h('button',{class:'ghost'},higher?`提高至 ${higher} tokens 重试`:'重试');
      retry.onclick=()=>void run(action,section,index,true,action==='chat'?{question,reply:reply!,docId,viewer,...(higher?{maxTokens:higher}:retryTarget?.maxTokens?{maxTokens:retryTarget.maxTokens}:{})}:undefined);reply.append(retry);
    }else toast(message,'error');
  }}finally{stream.stop();progress?.remove();if(job===owned){job=null;setChatBusy(false);}}
}
async function clearChat():Promise<void>{
  if(job){toast('先取消当前回答','info');return;}if(!state.docId)return;
  if(history.length&&!window.confirm('清空这篇论文的本地对话？'))return;
  const docId=state.docId;await idbPut('chats',{key:`${docId}:chat`,docId,messages:[],updatedAt:Date.now()});if(state.docId===docId){history=[];renderChat();}
}
