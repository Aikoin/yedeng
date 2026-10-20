import {mergeSettings,type ProviderConfig,type Settings} from '../shared/settings';
/** Include legacy selected models even when they are absent from an edited candidate list. */
export function modelChoices(settings:Settings):{value:string;label:string}[]{
 const options:{value:string;label:string}[]=[];
 for(const provider of settings.providers){
  const selected=Object.values(settings.routing).filter(route=>route?.providerId===provider.id).map(route=>route!.model);
  if(settings.visionRoute?.providerId===provider.id)selected.push(settings.visionRoute.model);
  for(const model of new Set([provider.defaultModel,...provider.models,...selected].filter(Boolean)))options.push({value:`${provider.id}::${model}`,label:`${provider.name} · ${model}`});
 }
 for(const route of [...Object.values(settings.routing),settings.visionRoute])if(route&&!options.some(option=>option.value===`${route.providerId}::${route.model}`))options.push({value:`${route.providerId}::${route.model}`,label:`已保存的型号 · ${route.model}`});
 return options;
}
/** Key-free settings import must not erase a matching local connection, nor reuse a key at a new endpoint. */
export function importCompatibleSettings(raw:unknown,current:Settings):Settings{
 const imported=mergeSettings(raw),local=new Map<string,ProviderConfig>(current.providers.map(provider=>[provider.id,provider]));
 for(const provider of imported.providers){const existing=local.get(provider.id);if(!provider.apiKey&&existing?.baseUrl===provider.baseUrl)provider.apiKey=existing.apiKey;}
 return imported;
}
