import {beforeEach,expect,it,vi} from 'vitest';
const db=vi.hoisted(()=>new Map<string,unknown>());
const put=vi.hoisted(()=>vi.fn(async(_store:string,row:{id:string})=>{db.set(row.id,structuredClone(row));}));
vi.mock('../src/shared/idb',()=>({idbPut:put,idbGet:async(_store:string,id:string)=>structuredClone(db.get(id)),idbGetAll:async()=>structuredClone([...db.values()])}));
import {interpretationId,loadInterpretation,listInterpretations,saveInterpretation} from '../src/shared/interpretations';
const snapshot={docId:'paper',text:'Synthetic selected paragraph',pageIndex:1,pageBoxes:[],firstRect:{left:0,top:0,width:10,height:10},pdfRegions:[]};
const input=async()=>({id:await interpretationId('paper',snapshot),docId:'paper',snapshot,context:'Synthetic nearby paragraph',contextQuads:[],sourceId:'selection',turns:[{question:'解释这段原文',answer:'Synthetic answer',cacheKey:'first',sources:[{id:'source',label:'选中文字',pageIndices:[1]}]}]});
beforeEach(()=>{db.clear();put.mockClear();});
it('restores original, answer and follow-up together after a fresh repository import, without cache settings',async()=>{
 const row=await input();await saveInterpretation(row);row.turns.push({question:'Why?',answer:'Because.',cacheKey:'follow',sources:[]});await saveInterpretation(row);
 vi.resetModules();const fresh=await import('../src/shared/interpretations');const restored=await fresh.loadInterpretation(row.id);
 expect(restored?.snapshot.text).toBe(snapshot.text);expect(restored?.turns.map(t=>t.answer)).toEqual(['Synthetic answer','Because.']);expect(await fresh.listInterpretations('paper')).toHaveLength(1);expect(await fresh.listInterpretations('other')).toEqual([]);
});
it('groups identical selections while separating documents and different passages',async()=>{
 const id=await interpretationId('paper',snapshot);expect(await interpretationId('paper',structuredClone(snapshot))).toBe(id);
 expect(await interpretationId('other',snapshot)).not.toBe(id);expect(await interpretationId('paper',{...snapshot,text:'Different'})).not.toBe(id);
});
it('whitelists saved fields and never copies credentials or provider request configuration',async()=>{
 const row=await input();await saveInterpretation({...row,apiKey:'fake-private-key',system:'private-system',turns:[{...row.turns[0],sources:[{...row.turns[0].sources[0],apiKey:'fake-source-key',image:'data:private'}]}]} as unknown as typeof row);
 const saved=await loadInterpretation(row.id);expect(JSON.stringify(saved)).not.toMatch(/fake-private-key|private-system|fake-source-key|data:private/);expect(saved?.context).toBe(row.context);
});
it('propagates transaction failure and leaves the previous complete history intact for retry',async()=>{
 const row=await input();await saveInterpretation(row);put.mockRejectedValueOnce(new Error('disk full'));row.turns.push({question:'next',answer:'new',cacheKey:'next',sources:[]});
 await expect(saveInterpretation(row)).rejects.toThrow('disk full');expect((await listInterpretations('paper'))[0].turns).toHaveLength(1);
 await saveInterpretation(row);expect((await loadInterpretation(row.id))?.turns).toHaveLength(2);
});
