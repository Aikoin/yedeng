import {describe,expect,it} from 'vitest';
import {DEFAULT_SETTINGS,mergeSettings,resolveMaterialRoute} from '../src/shared/settings';
function settings(baseUrl='https://api.deepseek.com/v1') {return mergeSettings({...DEFAULT_SETTINGS,providers:[{id:'p',baseUrl,apiKey:'fake',defaultModel:'deepseek-v4-pro',models:['deepseek-v4-pro'],imageInput:'unknown'}]});}
describe('final material routing',()=>{
 it('keeps text selection but automatically routes official images to Flash without changing provider',()=>{
 const s=settings();expect(resolveMaterialRoute(s,'explain','text')?.model).toBe('deepseek-v4-pro');
 const image=resolveMaterialRoute(s,'explain','image');expect(image?.model).toBe('deepseek-flash');expect(image?.provider.id).toBe('p');expect(image?.imageRouteError).toBeUndefined();
 expect(s.providers[0].defaultModel).toBe('deepseek-v4-pro');
 });
 it('never routes a gateway to a DeepSeek model without an explicit vision configuration',()=>{
 const s=settings('https://gateway.test/v1');s.providers[0].defaultModel='gateway-text';
 expect(resolveMaterialRoute(s,'explain','image')).toMatchObject({model:'gateway-text',imageRouteError:expect.stringContaining('视觉路由')});
 s.visionRoute={providerId:'p',model:'chosen-vision'};expect(resolveMaterialRoute(s,'explain','image')).toMatchObject({model:'chosen-vision'});
 expect(resolveMaterialRoute(s,'explain','text')?.model).toBe('gateway-text');
 });
 it('does not infer official routing for a lookalike hostname',()=>{
 expect(resolveMaterialRoute(settings('https://api.deepseek.com.evil.test'),'explain','image')?.imageRouteError).toBeTruthy();
 });
});
