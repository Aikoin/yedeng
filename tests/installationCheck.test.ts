import { describe, expect, it, vi } from 'vitest';
import { runInstallationCheck, type InstallationCheckDeps, type InstallationMarker } from '../src/health/check';
function harness() {
 const id='p'.repeat(32); let marker: InstallationMarker | null = null;
 const d: InstallationCheckDeps={protocol:'chrome-extension:',originHost:id,extensionId:id,version:'0.1.4',userAgent:'synthetic',pageInstance:'page-1',
  readMarker:vi.fn(async()=>marker),writeMarker:vi.fn(async value=>{marker=value;}),
  readPermissions:vi.fn(async()=>({permissions:['storage'],origins:['https://private.company/*']})),fileAccess:vi.fn(async()=>false),
  background:vi.fn(async()=>({extensionId:id,version:'0.1.4'})),checkAssets:vi.fn(async()=>true),checkDatabase:vi.fn(async()=>true)};
 return {d};
}
describe('native installation report is conservative and local only',()=>{
 it('refuses a web/shim context before any storage, permissions or background read',async()=>{
  const {d}=harness();d.protocol='http:';const r=await runInstallationCheck(d);
  expect(r.state).toBe('blocked');expect(r.nativeExtension).toBe(false);
  expect(d.readMarker).not.toHaveBeenCalled();expect(d.readPermissions).not.toHaveBeenCalled();expect(d.background).not.toHaveBeenCalled();
 });
 it('rejects a native-looking URL whose host does not match the runtime identity',async()=>{const {d}=harness();d.originHost='a'.repeat(32);expect((await runInstallationCheck(d)).state).toBe('blocked');expect(d.readPermissions).not.toHaveBeenCalled();});
 it('requires a different page instance and same version before reporting reopened marker',async()=>{
  const {d}=harness();expect((await runInstallationCheck(d)).state).toBe('needs_reopen');
  expect((await runInstallationCheck(d)).previousPageRecovered).toBe(false);
  d.pageInstance='page-2';const r=await runInstallationCheck(d);expect(r.state).toBe('ready_for_manual');expect(r.previousPageRecovered).toBe(true);
  d.version='0.1.5';d.background=async()=>({extensionId:d.extensionId,version:'0.1.5'});expect((await runInstallationCheck(d)).previousPageRecovered).toBe(false);
 });
 it('does not turn disabled file-url access into a false failure or leak granted private origins',async()=>{
  const {d}=harness();const r=await runInstallationCheck(d);
  expect(r.checks.find(c=>c.id==='file-access')?.status).toBe('info');expect(JSON.stringify(r)).not.toContain('private.company');expect(r.realModelRequests).toBe(0);
 });
 it('fails wrong background identity, missing assets and storage errors without exporting exception secrets',async()=>{
  const {d}=harness();d.background=async()=>({extensionId:'foreign',version:d.version});d.checkAssets=async()=>false;d.writeMarker=async()=>{throw new Error('secret-not-for-report');};
  const r=await runInstallationCheck(d);expect(r.state).toBe('blocked');expect(r.checks.filter(c=>c.status==='fail').map(c=>c.id)).toEqual(['background','assets','storage']);expect(JSON.stringify(r)).not.toContain('secret-not-for-report');
 });
});
