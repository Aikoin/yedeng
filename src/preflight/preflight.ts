import {openExistingDatabase}from'../storage/preflight';
import {createBackup,prepareRestore,MAX_BACKUP_BYTES}from'../storage/backup';
const button=document.querySelector<HTMLButtonElement>('#backup')!,status=document.querySelector('#status')!;
button.onclick=()=>{void(async()=>{button.disabled=true;let db:IDBDatabase|undefined;try{
 db=await openExistingDatabase();
 const version=db.version,backup=await createBackup('full',db),blob=new Blob([JSON.stringify(backup)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`yedeng-preupgrade-v${version}-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent=`已从原库版本 ${version} 生成备份，未升级数据库。文献 ${backup.manifest.counts.docs}，批注 ${backup.manifest.counts.annotations}，去重资源 ${backup.manifest.resources}。请确认文件已经下载保存后再升级。`;
 }catch(error){status.textContent=`备份未完成：${error instanceof Error?error.message:String(error)}。不要继续覆盖原扩展。`;}finally{db?.close();button.disabled=false;}})();};

const verifyFile=document.querySelector<HTMLInputElement>('#verify-file')!,verifyStatus=document.querySelector('#verify-status')!;
verifyFile.onchange=()=>void(async()=>{const file=verifyFile.files?.[0];if(!file)return;verifyFile.disabled=true;verifyStatus.textContent='正在本机校验文件，未写入数据库…';try{
 if(file.size>MAX_BACKUP_BYTES)throw new Error('文件超过220MiB，未读取；请保留原文件并安排分批备份');
 const plan=await prepareRestore(await file.text());verifyStatus.textContent=`完整性校验通过：文献 ${plan.summary.counts.docs}，批注 ${plan.summary.counts.annotations}，已留存PDF ${plan.summary.counts.blobs}，公式记录 ${plan.summary.counts.formulaRevisions}，去重资源 ${plan.summary.resources}；${plan.summary.pdfsRequiringRelink} 份文献不含PDF，需保留原文件或可访问来源。校验未写库、未恢复、未请求模型。请核对数量并妥善保存此文件；校验通过不代表G3质量门或原扩展升级已获准。`;
 }catch(error){verifyStatus.textContent=`备份未通过校验：${error instanceof Error?error.message:String(error)}。请停止升级，原库未被修改。`;}finally{verifyFile.disabled=false;verifyFile.value='';}})();
