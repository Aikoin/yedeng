import {h} from '../shared/dom';
export type HomePanel='ai'|'chat'|'marks';
export type ObjectPanel='formulas'|'figures'|'selection';
let home:HomePanel='ai',object:ObjectPanel|null=null;
const positions=new Map<string,number>();
let returnFocus:HTMLElement|null=null;
function remember(){const panel=document.querySelector<HTMLElement>(`[data-panel="${object??home}"]`);if(panel)positions.set(object??home,panel.scrollTop);}
function apply(){
 const sidebar=document.querySelector<HTMLElement>('#sidebar');if(sidebar)sidebar.hidden=false;document.body.classList.remove('ml-focus');
 document.querySelectorAll<HTMLElement>('.ml-assistant-heading,.ml-tabs').forEach(el=>el.hidden=!!object);
 document.querySelectorAll<HTMLElement>('.ml-tabpanel').forEach(panel=>{panel.hidden=panel.dataset.panel!==(object??home);if(!panel.hidden)panel.scrollTop=positions.get(object??home)??0;});
 document.querySelectorAll<HTMLElement>('[data-tab]').forEach(tab=>{const active=tab.dataset.tab===home;tab.classList.toggle('is-active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});
 const focus=document.querySelector('#btn-focus');if(focus){focus.textContent='专注阅读';focus.setAttribute('aria-pressed','false');}
 document.body.dataset.assistantObject=object??'';
}
export function showAssistant(panel:HomePanel):void{remember();object=null;home=panel;apply();if(panel==='marks')window.dispatchEvent(new Event('yedeng:notebook-refresh'));}
export function openObjectView(panel:ObjectPanel):void{remember();if(!object)returnFocus=document.activeElement as HTMLElement|null;object=panel;apply();}
export function closeObjectView():void{remember();object=null;apply();if(home==='marks')window.dispatchEvent(new Event('yedeng:notebook-refresh'));returnFocus?.isConnected&&returnFocus.focus({preventScroll:true});}
export function resetAssistantNavigation():void{positions.clear();object=null;home='ai';apply();}
export function objectNavigationBar():HTMLElement{return h('div',{class:'yd-object-bar'},h('button',{class:'ghost',on:{click:closeObjectView}},`← 返回${{ai:'概览',chat:'提问',marks:'笔记'}[home]}`),h('button',{class:'ghost','aria-label':'关闭内容详情',on:{click:closeObjectView}},'×'));}
export function initAssistantNavigation():void{
 const tabs=Array.from(document.querySelectorAll<HTMLButtonElement>('.ml-tabs [data-tab]'));
 tabs.forEach((tab,index)=>{tab.onclick=()=>showAssistant(tab.dataset.tab as HomePanel);tab.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].click();tabs[next].focus();};});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&object&&!document.querySelector('dialog[open]')&&!document.body.classList.contains('ml-region-selecting')&&!/INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement).tagName))closeObjectView();});apply();
}
export function notifyNotebook():void{window.dispatchEvent(new Event('yedeng:notebook-refresh'));}
