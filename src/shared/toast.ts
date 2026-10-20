/** 轻量 toast：右上角浮层提示 */

import { h } from './dom';

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (host && document.body.contains(host)) return host;
  host = h('div', { class: 'ml-toast-host' });
  document.body.appendChild(host);
  return host;
}

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info', ms = 3200): void {
  const node = h('div', { class: `ml-toast ml-toast--${kind}` }, message);
  ensureHost().appendChild(node);
  window.setTimeout(() => {
    node.classList.add('ml-toast--out');
    window.setTimeout(() => node.remove(), 250);
  }, ms);
}

export function toastError(err: unknown, fallback = '操作失败'): void {
  const msg = err instanceof Error ? err.message : String(err || fallback);
  toast(msg || fallback, 'error', 5000);
}

/** A reversible action remains available long enough to recover without leaving the reading task. */
export function toastUndo(message:string,undo:()=>Promise<void>):void {
 const node=h('div',{class:'ml-toast ml-toast--success',role:'status',style:{pointerEvents:'auto'}},h('span',{},message));const button=h('button',{},'撤销');button.onclick=()=>{button.disabled=true;void undo().then(()=>node.remove()).catch(error=>{button.disabled=false;toastError(error);});};node.append(button);ensureHost().append(node);window.setTimeout(()=>node.remove(),12000);
}
