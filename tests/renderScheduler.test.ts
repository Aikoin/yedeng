import { describe, expect, it, vi } from 'vitest';
import { createRenderScheduler } from '../src/pdf/renderScheduler';
describe('shared PDF page render leases',()=>{
 it('limits mixed viewport/crop/thumbnail work to two and drains in order',async()=>{
  const scheduler=createRenderScheduler(),page={cleanup:vi.fn()};
  const viewport=await scheduler.acquire(page),crop=await scheduler.acquire(page);
  let started=false;const thumb=scheduler.acquire(page).then(release=>{started=true;return release;});
  await Promise.resolve();expect(started).toBe(false);expect(scheduler.stats()).toEqual({active:2,queued:1,limit:2});
  viewport();const releaseThumb=await thumb;expect(started).toBe(true);expect(scheduler.stats().active).toBe(2);
  crop();releaseThumb();expect(scheduler.stats().active).toBe(0);
 });
 it('defers cleanup until every consumer of the same page releases its lease',async()=>{
  const scheduler=createRenderScheduler(),page={cleanup:vi.fn()};
  const viewport=await scheduler.acquire(page),crop=await scheduler.acquire(page);
  scheduler.cleanup(page);viewport();expect(page.cleanup).not.toHaveBeenCalled();crop();expect(page.cleanup).toHaveBeenCalledOnce();
  crop();expect(scheduler.stats().active).toBe(0);
 });
 it('releases failed work in finally so queued tasks can proceed',async()=>{
  const scheduler=createRenderScheduler(1),page={cleanup:vi.fn()};
  const release=await scheduler.acquire(page),next=scheduler.acquire(page);
  try{throw new Error('failed render');}catch{}finally{release();}
  const done=await next;done();scheduler.cleanup(page);expect(page.cleanup).toHaveBeenCalledOnce();
 });
});
