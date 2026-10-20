import {qs} from '../shared/dom';
import {sendMessage,viewerUrl,type InterceptLogEntry} from '../shared/messaging';
import {isConfigured,loadSettings} from '../shared/settings';
let currentUrl='',isPdf=false,isReader=false;
async function open(url:string){await chrome.tabs.create({url});window.close();}
function pdfAddress(raw:string):boolean {try{const url=new URL(raw);return ['http:','https:','file:'].includes(url.protocol)&&(/\.pdf$/i.test(decodeURIComponent(url.pathname))||/\/pdf\/[^/]+\/?$/i.test(url.pathname)&&/arxiv\.org$/i.test(url.hostname));}catch{return false;}}
async function init(){
 const settings=await loadSettings();document.documentElement.dataset.theme=settings.ui.theme;
 qs('#setup-card').hidden=isConfigured(settings);
 const [tab]=await chrome.tabs.query({active:true,currentWindow:true});currentUrl=tab?.url??'';
 isReader=currentUrl.startsWith(chrome.runtime.getURL('viewer/'));isPdf=pdfAddress(currentUrl);
 if(!isPdf&&!isReader){const entries=await sendMessage<InterceptLogEntry[]>({type:'get-intercept-log'});isPdf=!!entries?.some(entry=>entry.url===currentUrl&&entry.contentType?.includes('pdf'));}
 qs('#btn-open').textContent=isReader?'继续阅读当前论文 ↗':isPdf?'用页灯阅读当前 PDF ↗':'打开 PDF 文件 ↗';
 qs('#reading-hint').textContent=isReader?'回到当前阅读位置，接着读。':isPdf?'正文、批注与 AI 助手，在同一处阅读。':'当前页面不是可识别的 PDF，选择一份文件开始阅读。';
 if(currentUrl.startsWith('file://'))qs('#config-hint').textContent='若无法读取本地文件，可从阅读器选择文件；也可在扩展详情允许访问文件网址。';
 qs('#btn-open').onclick=()=>{if(isReader){window.close();return;}void open(isPdf?viewerUrl(currentUrl):viewerUrl());};
 qs('#btn-viewer').onclick=()=>void open(viewerUrl());
 qs('#btn-library').onclick=()=>void open(chrome.runtime.getURL('library/index.html'));
 qs('#btn-settings').onclick=()=>{void sendMessage({type:'open-options'});window.close();};
 qs('#btn-setup').onclick=()=>{const target=new URL(chrome.runtime.getURL('welcome/index.html'));if(isReader||isPdf)target.searchParams.set('returnTo',isReader?currentUrl:viewerUrl(currentUrl));void open(target.href);};
}
void init().catch(()=>{qs('#reading-hint').textContent='当前页面暂时无法读取，你仍可选择本地 PDF。';qs('#btn-open').onclick=()=>void open(viewerUrl());qs('#btn-viewer').onclick=()=>void open(viewerUrl());qs('#btn-library').onclick=()=>void open(chrome.runtime.getURL('library/index.html'));qs('#btn-settings').onclick=()=>void chrome.runtime.openOptionsPage();});
