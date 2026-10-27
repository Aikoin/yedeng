import {expect,it,vi} from 'vitest';
import {menuInstaller} from '../src/background/contextMenus';
it('coalesces overlapping install/start events and permits later reloads',async()=>{
 let done:()=>void=()=>{};const ids=new Set<string>();
 const removeAll=vi.fn((cb:()=>void)=>{done=()=>{ids.clear();cb();};});
 const create=vi.fn((item:chrome.contextMenus.CreateProperties,cb:()=>void)=>{if(ids.has(item.id!))throw new Error('duplicate');ids.add(item.id!);cb();return item.id!;});
 const install=menuInstaller({removeAll,create} as unknown as Pick<typeof chrome.contextMenus,'removeAll'|'create'>,()=>undefined);
 const a=install(),b=install();expect(a).toBe(b);done();await Promise.all([a,b]);expect(create).toHaveBeenCalledTimes(2);
 const c=install();done();await c;expect(ids.size).toBe(2);expect(removeAll).toHaveBeenCalledTimes(2);
});
it('consumes callback errors and can retry after failure',async()=>{
 let error:string|undefined='permission error';const last=vi.fn(()=>error);
 const api={removeAll:(cb:()=>void)=>cb(),create:(_item:unknown,cb:()=>void)=>{cb();return 'id';}};
 const install=menuInstaller(api as unknown as Pick<typeof chrome.contextMenus,'removeAll'|'create'>,last);
 await expect(install()).rejects.toThrow('permission error');error=undefined;await expect(install()).resolves.toBeUndefined();expect(last).toHaveBeenCalledTimes(4);
});
