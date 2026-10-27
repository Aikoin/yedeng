import {expect,it} from 'vitest';
import {validatePdfBytes} from '../src/pdf/validateBytes';
const bytes=(s:string)=>new TextEncoder().encode(s).buffer;
it('rejects an HTTP-success HTML login/error page before PDF parsing',()=>{for(const s of ['<!DOCTYPE html><html>Login</html>',' \n<html>Error</html>','<script>location="login"</script>'])expect(()=>validatePdfBytes(bytes(s))).toThrow('收到的是网页');});
it('preserves real and recoverable PDFs rather than suppressing parser diagnostics',()=>{for(const s of ['%PDF-1.7\n','prefix\n%PDF-1.4','nonstandard binary content'])expect(()=>validatePdfBytes(bytes(s))).not.toThrow();expect(()=>validatePdfBytes(bytes(''))).toThrow('为空');});
