/** Resolve only the source snapshot stored with this exact answer. Never infer E numbers from the live request. */
import type { DocumentSource } from '../ai/documentContext';
import { h } from '../shared/dom';
import { state } from './state';
import { toastError } from '../shared/toast';
export function sourcePages(source:DocumentSource,totalPages:number):number[]{
  return [...new Set(source.pageIndices)].filter(page=>Number.isSafeInteger(page)&&page>=0&&page<totalPages);
}
export async function openDocumentSource(source:DocumentSource):Promise<void>{
  const viewer=state.viewer,docId=state.docId;if(!viewer)return;
  const pages=sourcePages(source,state.info.numPages);if(!pages.length){toastError(new Error('这条引用没有有效的原文页码'));return;}
  document.querySelector('.yd-source-peek')?.remove();
  const close=h('button',{class:'ghost','aria-label':'关闭原文证据'},'×');
  const title=h('strong',{},`原文证据 · PDF 第 ${pages.map(page=>page+1).join('、')} 页`);
  const status=h('small',{class:'ml-muted',role:'status'},'正在定位原文…');
  const panel=h('section',{class:'yd-source-peek',role:'dialog','aria-label':'原文证据'},h('div',{class:'yd-source-peek-head'},title,close),h('p',{class:'ml-muted'},source.truncated?'这是生成时实际使用的文字节选，未包含该页全部内容。':'这是这条引用在生成时实际使用的原文材料。'),h('pre',{},source.text),status);
  const closePanel=()=>{panel.remove();document.removeEventListener('keydown',escape);};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')closePanel();};close.onclick=closePanel;document.addEventListener('keydown',escape);
  const jump=async(page:number)=>{
    if(state.viewer!==viewer||state.docId!==docId){closePanel();return;}
    viewer.scrollToPage(page,true);
    try{await viewer.ensurePageRendered(page);if(state.viewer!==viewer||state.docId!==docId){closePanel();return;}status.textContent=`已定位 PDF 第 ${page+1} 页 · 原文证据编号与公式编号无关`;}
    catch(error){status.textContent='原文页面加载失败，可以点击页码重试';toastError(error);}
  };
  const actions=h('div',{class:'yd-source-pages'});for(const page of pages){const button=h('button',{class:'ghost'},`定位第 ${page+1} 页`);button.onclick=()=>void jump(page);actions.append(button);}panel.append(actions);document.body.append(panel);await jump(pages[0]);
}
