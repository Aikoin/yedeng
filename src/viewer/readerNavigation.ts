/** Keep the current paper in its tab and make browser return/reload recoverable. */
export function setExternalPaperLink(link:HTMLAnchorElement,url:string):void {
 try{const target=new URL(url);if(!['https:','http:'].includes(target.protocol)||target.username||target.password)return;}catch{return;}
 link.href=url;link.rel='noopener noreferrer';link.target='_blank';
}
export function durableReaderUrl(current:string,docId:string):string{
 const url=new URL(current);url.searchParams.delete('src');url.searchParams.set('doc',docId);return url.href;
}
