import {resolveWelcomeReturn} from './navigation';
import { h, qs } from '../shared/dom';
import { isConfigured, isOfficialDeepSeek, loadSettings, saveSettings, FEATURES, type ProviderConfig } from '../shared/settings';
import { configuredEndpoint } from '../ai/dispatcher';
import { normalizeRequestEndpoint } from '../ai/preparedRequest';
const marker='yedeng.onboarding.seen.v1';
const native=location.protocol==='chrome-extension:';
function read(){
 const fallback=native?chrome.runtime.getURL('viewer/index.html'):'/viewer/index.html';
 location.href=resolveWelcomeReturn(new URLSearchParams(location.search).get('returnTo'),new URL(fallback,location.href).href);
}
qs('#skip').onclick=read;
qs<HTMLSelectElement>('#service').onchange=()=>{
 const custom=qs<HTMLSelectElement>('#service').value==='custom';qs('#vision-label').hidden=!custom;
 qs('#route-hint').textContent=custom?'文字模型与图片模型分开。未填写图片模型时，图片任务会提示先配置；不会静默改用其他服务。':'文字模型可选择 Flash / Pro；含图片的任务自动使用 Flash。';
 if(!custom){qs<HTMLInputElement>('#base-url').value='https://api.deepseek.com/v1';qs<HTMLInputElement>('#text-model').value='deepseek-flash';}
};
qs<HTMLFormElement>('#setup').onsubmit=event=>{event.preventDefault();void(async()=>{
 const button=qs<HTMLButtonElement>('#save');button.disabled=true;
 try{
  const baseUrl=qs<HTMLInputElement>('#base-url').value.trim().replace(/\/+$/,''),apiKey=qs<HTMLInputElement>('#api-key').value.trim(),model=qs<HTMLInputElement>('#text-model').value.trim();
  normalizeRequestEndpoint(configuredEndpoint(baseUrl));if(!apiKey||!model)throw new Error('请填写 Key 和文字模型');
  const settings=await loadSettings(),id=crypto.randomUUID(),visionModel=qs<HTMLInputElement>('#vision-model').value.trim();
  const provider:ProviderConfig={id,name:qs<HTMLSelectElement>('#service').value==='deepseek'?'DeepSeek':'我的模型服务',kind:'openai',baseUrl,apiKey,models:isOfficialDeepSeek(baseUrl)?[...new Set(['deepseek-flash','deepseek-v4-pro',model])]:[model],defaultModel:model,temperature:.2,maxTokens:2048,imageInput:visionModel?'declared':'unknown'};
  settings.providers.push(provider);for(const feature of FEATURES)settings.routing[feature]={providerId:id,model};
  if(qs<HTMLSelectElement>('#service').value==='custom'){if(visionModel)settings.visionRoute={providerId:id,model:visionModel};else delete settings.visionRoute;}
  await saveSettings(settings);await chrome.storage.local.set({[marker]:true});qs<HTMLInputElement>('#api-key').value='';
  qs('#status').textContent='配置已保存，没有发起模型请求。';read();
 }catch(error){qs('#status').textContent=error instanceof Error?error.message:'保存未完成，请重试';}
 finally{button.disabled=false;}
})();};
void(async()=>{
 try{const settings=await loadSettings();document.documentElement.dataset.theme=settings.ui.theme;if(native)await chrome.storage.local.set({[marker]:true});
 if(isConfigured(settings)){qs('#setup').hidden=true;qs('#status').replaceChildren(h('strong',{},'已有可用配置，无需重复填写。'));qs('#skip').textContent='进入阅读器 →';}
 }catch{qs('#status').textContent='本机配置暂时无法读取，请稍后重试。';}
})();
