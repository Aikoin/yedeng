import { openDb, type ChatRecord } from './idb';
import type { DocumentSource } from '../ai/documentContext';
export interface DocumentChatMessage { role: 'user' | 'assistant'; content: string; at: number; turnId?: string; sources?: DocumentSource[]; coverage?: string }
export function appendChatTurn(previous: DocumentChatMessage[], turn: { id: string; question: string; answer: string; at: number; sources: DocumentSource[]; coverage?: string }): DocumentChatMessage[] {
  if (previous.some(m => m.turnId === turn.id && m.role === 'assistant')) return previous;
  const index=previous.findIndex(m=>m.turnId===turn.id&&m.role==='user');
  const user:DocumentChatMessage={role:'user',content:turn.question,at:turn.at,turnId:turn.id};
  const answer:DocumentChatMessage={role:'assistant',content:turn.answer,at:turn.at,turnId:turn.id,sources:structuredClone(turn.sources),...(turn.coverage?{coverage:turn.coverage}:{})};
  if(index>=0)return [...previous.slice(0,index),user,answer,...previous.slice(index+1)];
  return [...previous,user,answer];
}
/** Serialize appends across tabs; a late response must not overwrite another completed turn. */
async function updateChat(docId:string,update:(previous:DocumentChatMessage[])=>DocumentChatMessage[]):Promise<DocumentChatMessage[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['docs', 'chats'], 'readwrite');
    let messages: DocumentChatMessage[] = [], failure: unknown;
    tx.oncomplete = () => resolve(messages);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('对话保存未完成'));
    tx.onerror = () => { failure ??= tx.error; };
    const doc = tx.objectStore('docs').get(docId);
    doc.onsuccess = () => {
      if (!doc.result) { failure = new Error('文献已移除，没有写入孤立对话'); tx.abort(); return; }
      const store = tx.objectStore('chats'), key = `${docId}:chat`, get = store.get(key);
      get.onsuccess = () => {
        messages = update((get.result as ChatRecord | undefined)?.messages ?? []);
        store.put({ key, docId, messages, updatedAt: Date.now() });
      };
    };
  });
}

export function appendChatQuestion(previous:DocumentChatMessage[],turn:{id:string;question:string;at:number}):DocumentChatMessage[]{
 if(previous.some(m=>m.turnId===turn.id))return previous;
 return [...previous,{role:'user',content:turn.question,at:turn.at,turnId:turn.id}];
}
export function persistDocumentChatQuestion(docId:string,turn:{id:string;question:string;at:number}):Promise<DocumentChatMessage[]>{
 return updateChat(docId,previous=>appendChatQuestion(previous,turn));
}
export function persistDocumentChatTurn(docId:string,turn:Parameters<typeof appendChatTurn>[1]):Promise<DocumentChatMessage[]>{
 return updateChat(docId,previous=>appendChatTurn(previous,turn));
}
