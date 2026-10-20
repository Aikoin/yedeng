export type ImageDeclaration = 'unknown' | 'declared' | 'verified';
/**
 * Official model exception checked 2026-10-19:
 * https://api-docs.deepseek.com/quick_start/pricing/ (Vision: Flash yes, V4 Pro unsupported).
 * This is a negative override only: no gateway/provider capability is inferred from a model name.
 */
export function imageInputBlockReason(endpoint: string, model: string, declaration?: ImageDeclaration): string | null {
  let official=false;
  try { official=new URL(endpoint).hostname==='api.deepseek.com'; } catch { /* Endpoint validity is checked by the prepared snapshot factory. */ }
  // User explicitly authorized automatic official Flash image routing on 2026-10-19.
  if(official && model==='deepseek-flash')return null;
  if(official && model==='deepseek-v4-pro')return '官方 DeepSeek deepseek-v4-pro 不支持图像；请显式选择支持图像的型号并重新准备，未发送图片。';
  if(declaration!=='declared' && declaration!=='verified')return '此服务配置未声明图像输入能力；请在设置确认视觉能力后重新准备，图片仅保留在本机。';
  return null;
}
