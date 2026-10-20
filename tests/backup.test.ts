import {expect,it} from 'vitest';
import {createBackup,prepareRestore,approveRestore,commitRestore,portableRecord,sanitizeSourceUrl} from '../src/storage/backup';
import {STORE_NAMES} from '../src/shared/migrations';
import {sha256Hex} from '../src/shared/hash';
function database(rows:Record<string,unknown[]>):IDBDatabase{return{transaction(){const tx={objectStore:(name:string)=>({getAll:()=>({result:rows[name]??[]})}),oncomplete:null as null|(()=>void)};queueMicrotask(()=>tx.oncomplete?.());return tx;}}as unknown as IDBDatabase;}
it('removes credential fields and strips credential/query/fragment source links without changing notes',()=>{
 expect(sanitizeSourceUrl('https://user:pass@example.com/a.pdf?token=secret#x')).toBe('https://example.com/a.pdf');
 expect(sanitizeSourceUrl('javascript:alert(1)')).toBe('');
 expect(portableRecord({apiKey:'synthetic-secret',providers:[{apiKey:'synthetic-key',name:'provider'}],url:'https://x.test/p?sig=x',note:'normal reading note'})).toEqual({providers:[{name:'provider'}],url:'https://x.test/p',note:'normal reading note'});
});
it('round trips real binary resources, deduplicates by content and forces restored AI to deny',async()=>{
 const bytes=new TextEncoder().encode('%PDF-1.7\nsynthetic codec fixture').buffer,docId=`b:${await sha256Hex(bytes)}`;
 const rows=Object.fromEntries(STORE_NAMES.map(name=>[name,[]]))as Record<string,unknown[]>;
 rows.docs=[{docId,url:'https://x.test/p.pdf?key=synthetic',stored:true,optionalLegacyField:undefined,policy:'allowed_to_configured_provider'}];rows.blobs=[{docId,bytes}];rows.cache=[{key:'discard',value:'cached',createdAt:1}];rows.tasks=[{id:'active',status:'running'},{id:'saved-result:x',status:'completed',resultText:'saved answer',docId}];
 const backup=await createBackup('full',database(rows));expect(backup.manifest.counts.cache).toBe(0);expect(backup.manifest.counts.tasks).toBe(1);expect(backup.manifest.resources).toBe(1);
 const plan=await prepareRestore(JSON.stringify(backup));expect(plan.rows.docs[0].policy).toBe('deny_all_ai');expect(plan.rows.docs[0].url).toBe('https://x.test/p.pdf');expect(await sha256Hex(plan.rows.blobs[0].bytes as ArrayBuffer)).toBe(docId.slice(2));expect(plan.summary.forcedDeny).toBe(1);
 const light=await createBackup('light',database(rows));const lightPlan=await prepareRestore(JSON.stringify(light));expect(lightPlan.rows.blobs).toHaveLength(0);expect(lightPlan.summary.pdfsRequiringRelink).toBe(1);
});
it('refuses modified manifests and forged restore approval before opening a database',async()=>{
 const backup=await createBackup('full',database({}));backup.manifest.resources=9;
 await expect(prepareRestore(JSON.stringify(backup))).rejects.toThrow(/manifest/);
 expect(()=>approveRestore({}as never)).toThrow(/未通过/);await expect(commitRestore({}as never)).rejects.toThrow(/预览/);
});
it('rejects cross-document pinned originals, saved results, and wrong formula record roles',async()=>{
 const base=()=>{const rows=Object.fromEntries(STORE_NAMES.map(name=>[name,[]]))as Record<string,unknown[]>;rows.docs=[{docId:'doc-a',url:'',stored:false},{docId:'doc-b',url:'',stored:false}];return rows;};
 const pins=base();pins.regions=[{id:'asset-b',docId:'doc-b'}];pins.readingState=[{docId:'doc-a',pinnedAssetIds:['asset-b']}];
 await expect(prepareRestore(JSON.stringify(await createBackup('light',database(pins))))).rejects.toThrow(/其他文献/);
 const tasks=base();tasks.tasks=[{id:'saved-result:orphan',docId:'missing',status:'completed',resultText:'orphan answer'}];
 await expect(prepareRestore(JSON.stringify(await createBackup('light',database(tasks))))).rejects.toThrow(/完成结果缺少/);
 const roles=base();roles.formulaRevisions=[{id:'f',docId:'doc-a',formulaId:'f',kind:'head',sourceRevisionId:'f'}];
 await expect(prepareRestore(JSON.stringify(await createBackup('light',database(roles))))).rejects.toThrow(/来源修订/);
});
it('rejects forged-but-rehashed executable source links, prototype keys and non-PNG originals',async()=>{
 const canonical=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
 const rows={docs:[{docId:'paper',url:'https://paper.invalid',stored:false}]};
 for(const attack of['url','prototype']){const backup=await createBackup('light',database(rows));const record=backup.records.docs[0]as Record<string,unknown>;if(attack==='url')record.url='javascript:alert(1)';else Object.defineProperty(record,'__proto__',{value:{polluted:true},enumerable:true});const base={...backup};delete(base as Partial<typeof backup>).digest;backup.digest=await sha256Hex(canonical(base));await expect(prepareRestore(JSON.stringify(backup))).rejects.toThrow(attack==='url'?/净化/:/危险对象/);}
 const svg=new Blob(['<svg onload="evil()"/>'],{type:'image/svg+xml'}),hash=await sha256Hex(await svg.arrayBuffer()),backup=await createBackup('light',database({...rows,regions:[{id:'r',docId:'paper',segments:[{cropBlob:svg,hash}]}]}));await expect(prepareRestore(JSON.stringify(backup))).rejects.toThrow(/原图字节/);
});
