/** Configuration may return only to a reader/library owned by this exact installation. */
export function resolveWelcomeReturn(raw:string|null,fallback:string):string {
 try{const home=new URL(fallback);if(!raw)return home.href;const target=new URL(raw,home);
  if(target.protocol!==home.protocol||target.host!==home.host||target.username||target.password||!['/viewer/index.html','/library/index.html'].includes(target.pathname))return home.href;
  return target.href;
 }catch{return fallback;}
}
