import { expect,it } from 'vitest';
import { imageInputBlockReason } from '../src/ai/modelCapabilities';
it('known official negative overrides provider claims without inferring gateway support',()=>{
 expect(imageInputBlockReason('https://api.deepseek.com/v1/chat/completions','deepseek-v4-pro','verified')).toContain('不支持图像');
 expect(imageInputBlockReason('https://api.deepseek.com/chat/completions','deepseek-flash','declared')).toBeNull();
 expect(imageInputBlockReason('https://api.deepseek.com/chat/completions','deepseek-flash','unknown')).toBeNull();
 expect(imageInputBlockReason('https://gateway.test/v1/chat/completions','deepseek-v4-pro','declared')).toBeNull();
 expect(imageInputBlockReason('https://api.deepseek.com.evil.test/chat/completions','deepseek-v4-pro','declared')).toBeNull();
});
