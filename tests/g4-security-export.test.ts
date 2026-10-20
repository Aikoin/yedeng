import{it,expect}from'vitest';
import{zipStore}from'../src/storage/archive';
import{literalMarkdown}from'../src/storage/portableExport';
import{validateRuntimeMessage,redactInterceptEntry,safeRasterThumbnail}from'../src/shared/messageGuard';
import{renderFormula}from'../src/formula/render';
it('restricts settings/log/native permissions to own UI and keeps only PDF offers for web content',()=>{const id='own',own={id,url:'chrome-extension://own/options/index.html'},web={id,url:'https://attacker.invalid',tab:{id:3}};
 expect(validateRuntimeMessage({type:'set-hijack',enabled:false},own,id)).toBe(true);
 for(const sender of[web,{...own,id:'foreign'},{...own,url:'https://own/options/index.html'},{...own,url:'chrome-extension://own.evil/options/index.html'}])for(const type of['set-hijack','get-intercept-log','clear-intercept-log','allow-native'])expect(validateRuntimeMessage({type,enabled:false,url:'https://paper.invalid',tabId:1},sender,id)).toBe(false);
 expect(validateRuntimeMessage({type:'open-viewer',url:'https://paper.invalid/p.pdf'},web,id)).toBe(true);
 for(const url of['javascript:alert(1)','data:text/html,evil','chrome://extensions','chrome-extension://foreign/options/index.html','https://user:pass@paper.invalid'])expect(validateRuntimeMessage({type:'open-viewer',url},own,id)).toBe(false);
 expect(validateRuntimeMessage({type:'set-hijack',enabled:'false'},own,id)).toBe(false);
});
it('keeps attacker prose literal and disallows global macros, external formula resources and expansion bombs',()=>{
 for(const value of['https://evil.invalid/track','data:image/svg+xml;base64,PHN2Zy8+','javascript:evil'])expect(safeRasterThumbnail(value)).toBe(false);
 expect(safeRasterThumbnail('data:image/jpeg;base64,/9j/AA==')).toBe(true);
 const text=literalMarkdown('<img src=x onerror=alert(1)> [send](javascript:evil) ![remote](https://evil.invalid/x)');expect(text).not.toContain('<img');expect(text).not.toContain('](javascript');expect(text).not.toContain('![remote]');
 for(const latex of['\\href{javascript:evil}{x}','\\includegraphics{https://evil.invalid/x}','\\htmlData{onclick=evil}{x}','\\gdef\\x{evil}','x'.repeat(12001)])expect(renderFormula(latex).status).not.toBe('rendered');
 expect(renderFormula('\\def\\x{\\x}\\x').status).not.toBe('rendered');
});
it('strips URL credentials/query fragments from intercept logs',()=>{expect(redactInterceptEntry({url:'https://u:secret@example.test/p?key=synthetic#token',decision:'offered'}).url).toBe('https://example.test/p');});
it('writes a ZIP with matching local/central offsets and refuses traversal/duplicates',()=>{const bytes=new TextEncoder().encode('hello'),archive=zipStore([{path:'README.md',bytes},{path:'images/abc.png',bytes}]),v=new DataView(archive.buffer);expect(v.getUint32(0,true)).toBe(0x04034b50);const end=archive.length-22;expect(v.getUint32(end,true)).toBe(0x06054b50);expect(v.getUint16(end+10,true)).toBe(2);const central=v.getUint32(end+16,true);expect(v.getUint32(central,true)).toBe(0x02014b50);expect(v.getUint32(central+42,true)).toBe(0);expect(()=>zipStore([{path:'../evil',bytes}])).toThrow();expect(()=>zipStore([{path:'a',bytes},{path:'a',bytes}])).toThrow();});
it('allows only a credential-free health ping from the own installation page',()=>{
 const id='own',health={id,url:'chrome-extension://own/health/index.html'};
 expect(validateRuntimeMessage({type:'installation-health'},health,id)).toBe(true);
 for(const type of['get-intercept-log','clear-intercept-log','set-hijack','open-options','open-library'])expect(validateRuntimeMessage({type,enabled:true},health,id)).toBe(false);
 for(const sender of[{id,url:'https://attacker.invalid',tab:{id:2}},{id:'foreign',url:health.url},{id,url:'chrome-extension://own.evil/health/index.html'}])expect(validateRuntimeMessage({type:'installation-health'},sender,id)).toBe(false);
});
it('lets the first-run configuration page notify settings changes without granting unrelated message actions',()=>{
 const sender={id:'own',url:'chrome-extension://own/welcome/index.html'};
 expect(validateRuntimeMessage({type:'settings-changed'},sender,'own')).toBe(true);
 for(const type of['set-hijack','get-intercept-log','clear-intercept-log','installation-health'])expect(validateRuntimeMessage({type,enabled:false},sender,'own')).toBe(false);
 expect(validateRuntimeMessage({type:'settings-changed'},{...sender,id:'foreign'},'own')).toBe(false);
});
