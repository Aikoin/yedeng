import {expect,it} from 'vitest';
import {setExternalPaperLink,durableReaderUrl} from '../src/viewer/readerNavigation';
it('always opens paper web references in a separate tab',()=>{
 const link={} as HTMLAnchorElement;setExternalPaperLink(link,'https://example.org/paper');
 expect(link).toMatchObject({href:'https://example.org/paper',target:'_blank',rel:'noopener noreferrer'});
});
it('does not enable executable or credential-bearing paper links',()=>{
 for(const url of ['javascript:alert(1)','https://user:pass@example.org/','file:///secret']){const link={} as HTMLAnchorElement;setExternalPaperLink(link,url);expect(link).toEqual({});}
});
it('makes local file and remote document reader URLs reopen the stable stored document',()=>{
 for(const current of ['chrome-extension://test/viewer/index.html','chrome-extension://test/viewer/index.html?src=https%3A%2F%2Fexample.org%2Fp.pdf']){
 const next=new URL(durableReaderUrl(current,'b:document'));expect(next.searchParams.get('doc')).toBe('b:document');expect(next.searchParams.has('src')).toBe(false);expect(next.pathname).toBe('/viewer/index.html');
 }
});
