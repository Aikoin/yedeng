/** Viewport, crop and thumbnail jobs share two page-render leases. */
export interface RenderLeasePage { cleanup(): unknown }
export function createRenderScheduler(limit = 2) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid render concurrency');
  let active = 0;
  const jobs: (() => void)[] = [];
  const leases = new WeakMap<RenderLeasePage, number>();
  const pendingCleanup = new WeakSet<RenderLeasePage>();
  function drain() { while (active < limit && jobs.length) jobs.shift()!(); }
  function acquire(page: RenderLeasePage): Promise<() => void> {
    return new Promise(resolve => {
      jobs.push(() => {
        active++; leases.set(page,(leases.get(page) ?? 0)+1);
        let released = false;
        resolve(() => {
          if (released) return; released = true;
          active--; const count=(leases.get(page) ?? 1)-1;
          if (count) leases.set(page,count); else {
            leases.delete(page);
            if (pendingCleanup.has(page)) { pendingCleanup.delete(page); try { page.cleanup(); } catch { /* destroyed documents need no cleanup */ } }
          }
          drain();
        });
      });
      drain();
    });
  }
  function cleanup(page: RenderLeasePage): void {
    if ((leases.get(page) ?? 0) > 0) pendingCleanup.add(page);
    else page.cleanup();
  }
  return { acquire, cleanup, stats: () => ({ active, queued: jobs.length, limit }) };
}
export const pdfRenderScheduler = createRenderScheduler(2);
