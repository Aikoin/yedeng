import {listInterpretations} from '../shared/interpretations';
import {listSavedResults} from '../shared/savedResults';
import {openInterpretation,openLegacyInterpretation} from './requestWorkspace';
import {h,qs} from '../shared/dom';
import {state} from './state';
import {listFormulas,setFormulaDeleted} from '../formula/repository';
import {loadRegionAssets,loadRemovedRegionAssets,blobDataUrl} from '../evidence/repository';
import {openFormulaWorkspace} from './formulaWorkspace';
import {openFigureAsset,restoreFigureAsset} from './evidenceWorkspace';
import {toastError} from '../shared/toast';
import {renderFormula} from '../formula/render';
let filter='all',read=0,timer:number|undefined;
export function initNotebook():void{window.addEventListener('yedeng:notebook-refresh',()=>{window.clearTimeout(timer);timer=window.setTimeout(()=>void refreshNotebook().catch(toastError),80);});const host=qs('#notebook-filters');for(const [id,label] of [['all','全部'],['text','文字'],['figure','图表'],['formula','公式'],['interpretation','解读'],['trash','回收站']]){const button=h('button',{class:'ghost',dataset:{noteFilter:id}},label);button.onclick=()=>{filter=id;void refreshNotebook().catch(toastError);};host.append(button);}}
export async function refreshNotebook():Promise<void>{
 const id=state.docId,viewer=state.viewer,version=++read,host=qs('#notebook-objects');if(!id){host.replaceChildren();return;}
 const [formulas,assets,removed,readings,legacy]=await Promise.all([listFormulas(id,true),loadRegionAssets(id),loadRemovedRegionAssets(id),listInterpretations(id),listSavedResults(id)]);if(state.docId!==id||state.viewer!==viewer||version!==read)return;
 host.replaceChildren();qs('#notebook-text').hidden=!['all','text'].includes(filter);document.querySelectorAll<HTMLElement>('[data-note-filter]').forEach(b=>b.classList.toggle('is-active',b.dataset.noteFilter===filter));
 const button=(label:string,action:()=>Promise<void>)=>h('button',{class:'ghost',on:{click:()=>void action().catch(toastError)}},label);
 const entries:{page:number;date:number;node:HTMLElement}[]=[];
 for(const formula of formulas){if(filter==='trash'?!formula.deletedAt:formula.deletedAt||!['all','formula'].includes(filter))continue;const image=formula.segments[0],card=h('article',{class:'yd-notebook-object'},h('small',{},`公式 · 第 ${[...new Set(formula.segments.map(s=>s.pageIndex+1))].join('、')} 页`));if(formula.latex){const result=renderFormula(formula.latex),preview=h('div',{class:'yd-formula-preview'});if(result.status==='rendered')preview.innerHTML=result.html;else preview.textContent='已保存公式与原图';card.append(preview);}else if(image){const img=h('img',{alt:'已保存公式原图'});card.append(img);void blobDataUrl(image.cropBlob).then(src=>{if(version===read&&card.isConnected)img.src=src;});}card.append(formula.deletedAt?button('恢复公式',async()=>{await setFormulaDeleted(formula.id,false,formula.revision);await refreshNotebook();}):button('继续查看 →',()=>openFormulaWorkspace(formula.id)));entries.push({page:image?.pageIndex??0,date:formula.history[0]?.createdAt??0,node:card});}
 const figures=filter==='trash'?removed:assets.filter(a=>a.kind!=='formula');if(['all','figure','trash'].includes(filter))for(const asset of figures){const segment=asset.segments?.[0],card=h('article',{class:'yd-notebook-object'},h('small',{},`图表 · 第 ${(segment?.pageIndex??0)+1} 页`),h('h3',{},asset.caption||'图表'));if(segment){const img=h('img',{alt:'已保存图表原图'});card.append(img);void blobDataUrl(segment.cropBlob).then(src=>{if(version===read&&card.isConnected)img.src=src;});}card.append(filter==='trash'?button('恢复图表',async()=>{await restoreFigureAsset(asset.id);await refreshNotebook();}):button('查看图表 →',()=>openFigureAsset(asset.id)));entries.push({page:segment?.pageIndex??0,date:asset.createdAt,node:card});}
 if(['all','interpretation'].includes(filter)){
  const covered=new Set(readings.flatMap(r=>r.turns.map(t=>'saved-result:'+t.cacheKey)));
  for(const reading of readings){const card=h('article',{class:'yd-notebook-object'},h('small',{},`解读 · 第 ${reading.snapshot.pageIndex+1} 页 · ${new Date(reading.updatedAt).toLocaleString()}`),h('h3',{},reading.snapshot.text.slice(0,120)),button('继续阅读 →',()=>openInterpretation(reading.id)));entries.push({page:reading.snapshot.pageIndex,date:reading.updatedAt,node:card});}
  for(const row of legacy.filter(r=>r.action==='explain'&&!covered.has(r.id))){const page=row.sources[0]?.pageIndices[0]??0;const card=h('article',{class:'yd-notebook-object'},h('small',{},`解读 · 第 ${page+1} 页 · ${new Date(row.updatedAt).toLocaleString()}`),h('p',{},row.resultText.slice(0,120)),button('查看解读 →',()=>openLegacyInterpretation(row.id)));entries.push({page,date:row.updatedAt,node:card});}
 }
 entries.sort((a,b)=>a.page-b.page||a.date-b.date);host.append(...entries.map(e=>e.node));if(!entries.length&&!['all','text'].includes(filter))host.append(h('p',{class:'ml-muted'},filter==='trash'?'回收站是空的。':filter==='interpretation'?'选中文字并点击解释，完成后会自动保存在这里。':'在正文框选后，会自动保存在这里。'));
}
