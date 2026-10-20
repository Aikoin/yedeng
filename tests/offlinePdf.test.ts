import {describe,expect,it} from 'vitest';
import {findStoredPdfForUrl,AmbiguousStoredPdfError} from '../src/evidence/offlinePdf';
import {sha256Hex} from '../src/shared/hash';
import type {DocRecord} from '../src/shared/idb';
describe('verified local PDF fallback',()=>{
 it('uses an exact source alias and verifies the full stored byte hash',async()=>{const bytes=new TextEncoder().encode('%PDF-offline-fixture').buffer;const doc={docId:`b:${await sha256Hex(bytes)}`,url:'https://example.org/current.pdf',sources:['https://example.org/original.pdf']} as DocRecord;const found=await findStoredPdfForUrl('https://example.org/original.pdf',undefined,{listDocuments:async()=>[doc],readBlob:async()=>({docId:doc.docId,bytes})});expect(found?.bytes).toEqual(bytes);expect(found?.bytes).not.toBe(bytes);expect(found?.source).toBe('verified-local-copy');});
 it('does not pick the last-opened paper when one URL has multiple byte versions',async()=>{const docs=[{docId:'b:a',url:'same',lastOpenedAt:1},{docId:'b:b',url:'same',lastOpenedAt:99}] as DocRecord[];await expect(findStoredPdfForUrl('same',undefined,{listDocuments:async()=>docs})).rejects.toBeInstanceOf(AmbiguousStoredPdfError);});
 it('rejects mismatched bytes and never copies old annotations to an unverified version',async()=>{const doc={docId:'b:incorrect',url:'same'} as DocRecord;await expect(findStoredPdfForUrl('same',undefined,{listDocuments:async()=>[doc],readBlob:async()=>({docId:doc.docId,bytes:new Uint8Array([1,2,3]).buffer})})).rejects.toThrow('不一致');});
 it('returns no fallback for an unrelated source even if a title matches',async()=>{expect(await findStoredPdfForUrl('new-url',undefined,{listDocuments:async()=>[{docId:'a',url:'old-url',title:'same title'} as DocRecord]})).toBeNull();});
});
