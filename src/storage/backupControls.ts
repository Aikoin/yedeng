import {h} from '../shared/dom';
import {createBackup,prepareRestore,approveRestore,commitRestore,type RestorePlan,MAX_BACKUP_BYTES} from './backup';
export function initBackupControls(host:HTMLElement):void {
 let plan:RestorePlan|null=null,busy=false;
 const status=h('p',{class:'muted',role:'status'},'备份不含设置与 Key。完整备份包含已留存 PDF；轻量备份保留原图和阅读记录，PDF 需重新关联。');
 const preview=h('pre',{style:'white-space:pre-wrap;font-size:12px;line-height:1.8'});
 const confirm=h('button',{class:'primary',disabled:true},'确认合并恢复');
 const full=h('button',{},'下载完整备份'),light=h('button',{},'下载轻量备份'),choose=h('button',{},'选择备份并预览');
 const input=h('input',{type:'file',accept:'.json,application/json',hidden:true});
 const buttons=[full,light,choose,confirm];
 function lock(value:boolean){busy=value;for(const button of buttons)button.disabled=value;confirm.disabled=value||!plan;}
 async function exportFile(mode:'full'|'light'){if(busy)return;lock(true);try{const data=await createBackup(mode),url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`yedeng-${mode}-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent=`备份已生成：${data.manifest.counts.docs} 份文献、${data.manifest.resources} 份去重资源。已排除 Key、缓存和运行中请求；自由填写的笔记正文会保留。`;}catch(error){status.textContent=`未生成备份：${error instanceof Error?error.message:String(error)}`;}finally{lock(false);}}
 full.onclick=()=>void exportFile('full');light.onclick=()=>void exportFile('light');choose.onclick=()=>input.click();
 input.onchange=()=>{void(async()=>{const file=input.files?.[0];plan=null;confirm.disabled=true;preview.textContent='';if(!file)return;lock(true);try{if(file.size>MAX_BACKUP_BYTES)throw new Error('备份超过220MiB，未读取文件，请使用轻量备份');plan=await prepareRestore(await file.text());preview.textContent=JSON.stringify(plan.summary,null,2);status.textContent='校验通过。恢复不会删除现有数据；相同ID内容冲突时整笔回滚，文献AI策略收紧为禁止，运行中请求不会恢复或发送。请核对以上数量后确认。';}catch(error){status.textContent=`未读取备份：${error instanceof Error?error.message:String(error)}`;}finally{input.value='';lock(false);}})();};
 confirm.onclick=()=>{void(async()=>{if(!plan||busy)return;lock(true);try{await commitRestore(approveRestore(plan));plan=null;preview.textContent='';status.textContent='恢复事务已完成。请重开文献；AI 默认禁止，没有发送任何模型请求。';}catch(error){status.textContent=`恢复未完成，事务已回滚：${error instanceof Error?error.message:String(error)}`;}finally{lock(false);}})();};
 host.append(h('h2',{},'本地备份与恢复'),h('div',{class:'row'},full,light,choose),status,preview,confirm,input);
}
