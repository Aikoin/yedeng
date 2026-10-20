import type {Message}from'./messaging';
export function safeDocumentUrl(value:unknown):value is string{if(typeof value!=='string'||!value||value.length>16384)return false;try{const url=new URL(value);return['https:','http:','file:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}}
/** Web/content frames have only the PDF-open offer. Settings/logs/native bypass require own UI. */
export function validateRuntimeMessage(message:unknown,sender:{id?:string;url?:string;tab?:{id?:number}},runtimeId:string):message is Message{
 if(sender.id!==runtimeId||!message||typeof message!=='object')return false;const m=message as Record<string,unknown>;let internal=false;try{const u=new URL(sender.url??'');if(u.protocol==='chrome-extension:'&&u.hostname===runtimeId&&u.pathname==='/welcome/index.html')return m.type==='settings-changed';if(u.protocol==='chrome-extension:'&&u.hostname===runtimeId&&u.pathname==='/health/index.html')return m.type==='installation-health';internal=u.protocol==='chrome-extension:'&&u.hostname===runtimeId&&['/popup/index.html','/options/index.html','/library/index.html','/viewer/index.html','/background.js'].includes(u.pathname);}catch{/* untrusted origin */}
 if(!internal)return m.type==='open-viewer'&&!!sender.tab&&safeDocumentUrl(m.url);
 switch(m.type){case'settings-changed':case'open-options':case'open-library':case'get-intercept-log':case'clear-intercept-log':return true;case'open-viewer':return m.url===undefined||safeDocumentUrl(m.url);case'open-url':return safeDocumentUrl(m.url);case'allow-native':return safeDocumentUrl(m.url)&&(m.tabId===undefined||Number.isInteger(m.tabId)&&Number(m.tabId)>=0);case'get-pending-pdf':return Number.isInteger(m.tabId)&&Number(m.tabId)>=-1;case'set-hijack':return typeof m.enabled==='boolean';default:return false;}
}

export function redactInterceptEntry<T extends {url:string}>(entry:T):T{let url='';try{const parsed=new URL(entry.url);if(['http:','https:','file:'].includes(parsed.protocol)){parsed.username='';parsed.password='';parsed.search='';parsed.hash='';url=parsed.href;}}catch{/* invalid source */}return{...entry,url};}

/** Imported document metadata must never turn thumbnails into remote requests or active SVG. */
export function safeRasterThumbnail(value:unknown):value is string{return typeof value==='string'&&value.length<=2*1024*1024&&/^data:image\/(?:jpeg|png);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)&&(/;base64,\/9j\//.test(value)||/;base64,iVBORw0KGgo/.test(value));}
