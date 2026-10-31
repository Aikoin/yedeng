import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({
  get:vi.fn(), send:vi.fn(), prepare:vi.fn(), access:vi.fn(), toast:vi.fn(), persist:vi.fn(), persistQuestion:vi.fn(),
  state:{docId:'doc',viewer:{},docText:{pages:[],sections:[]},info:{title:'Paper',numPages:2},index:null,settings:{providers:[],routing:{},prompts:{},cache:{enabled:true},reading:{}}} as any,
}));
vi.mock('../src/ai/dispatcher',()=>({productionDispatcher:()=>({prepare:mocks.prepare,send:mocks.send,subscribe:vi.fn(),invalidate:vi.fn()}),ensureReaderAiAccess:mocks.access,setDocumentAiPolicy:vi.fn()}));
vi.mock('../src/ai/types',()=>{class AiOutputLimitError extends Error {constructor(public partialText:string,public maxTokens?:number){super('达到输出上限');}}return {AiOutputLimitError};});
vi.mock('../src/ai/documentContext',()=>({prepareDocumentContext:()=>({messages:[],sources:[],coverage:'已提供全部文字'})}));
vi.mock('../src/ai/preparedRequest',()=>({authorizeExplicitSend:()=>({}),supportsThinkingToggle:()=>false}));
vi.mock('../src/shared/idb',()=>({idbGet:mocks.get,idbPut:vi.fn()}));
vi.mock('../src/shared/settings',()=>({isConfigured:()=>true,loadSettings:vi.fn(),saveSettings:vi.fn()}));
vi.mock('../src/shared/toast',()=>({toast:mocks.toast}));
vi.mock('../src/shared/documentChat',()=>({persistDocumentChatTurn:mocks.persist,persistDocumentChatQuestion:mocks.persistQuestion}));
vi.mock('../src/shared/hash',()=>({sha256Hex:async()=> 'hash'}));
vi.mock('../src/viewer/markdown',()=>({renderMarkdown:(text:string)=>document.createTextNode(text)}));
vi.mock('../src/viewer/state',()=>({state:mocks.state,jumpToPage:vi.fn(),rebuildIndex:vi.fn()}));
vi.mock('../src/ai/paperChatContext',()=>({retrievePaperChat:()=>[]}));
vi.mock('../src/viewer/requestWorkspace',()=>({requestSessionGeneration:()=>0}));
vi.mock('../src/viewer/documentSources',()=>({openDocumentSource:vi.fn()}));

// Enough real DOM behavior to exercise actual initAiPanels click/keyboard handlers,
// removal of the first-turn placeholder, rendering, persistence and cleanup.
class Element {
  children:Element[]=[];parent:Element|null=null;className='';style={};dataset={};value='';disabled=false;hidden=false;onclick:any;onkeydown:any;onchange:any;scrollTop=0;scrollHeight=0;data='';
  classList={toggle:vi.fn()};
  constructor(public tagName:string){}
  setAttribute(){} addEventListener(){} focus(){}
  appendChild(node:Element){node.parent=this;this.children.push(node);return node;}
  append(...nodes:Element[]){nodes.forEach(node=>this.appendChild(node));}
  replaceChildren(...nodes:Element[]){this.children=[];this.data='';this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
  before(){}
  set textContent(text:string){this.data=text;this.children=[];}
  get textContent():string{return this.data+this.children.map(n=>n.textContent).join('');}
  querySelector(selector:string):Element|null{return this.children.flatMap(flat).find(n=>selector[0]==='.'?n.className.split(' ').includes(selector.slice(1)):n.tagName===selector)||null;}
}
const flat=(node:Element):Element[]=>[node,...node.children.flatMap(flat)];
let elements:Record<string,Element>;
let extracted:typeof import('../src/viewer/aiActions').onTextExtracted;
let ready:typeof import('../src/viewer/aiActions').restoreDocumentChat;
let init:typeof import('../src/viewer/aiActions').initAiPanels;
let reset:typeof import('../src/viewer/aiActions').resetAiPanels;
const input=()=>elements['chat-input'];
const button=()=>elements['btn-chat-send'];
async function settle(){await vi.waitFor(()=>expect(button().disabled).toBe(false));}
function enter(text:string){input().value=text;input().onkeydown({key:'Enter',shiftKey:false,isComposing:false,preventDefault:vi.fn()});}
function click(text:string){input().value=text;button().onclick();}
beforeEach(async()=>{
  vi.resetModules();vi.resetAllMocks();
  elements=Object.fromEntries(['btn-setup-ai','btn-summary-regen','btn-sections-all','btn-sections-stop','btn-chat-send','btn-chat-stop','btn-chat-clear','chat-input','model-select','summary-body','keywords-body','section-list','chat-log'].map(id=>[id,new Element('div')]));
  const query=(selector:string)=>{if(selector.includes(' ')){const [root,child]=selector.split(' ');return elements[root.slice(1)]?.querySelector(child)||null;}return selector[0]==='#'?elements[selector.slice(1)]||null:null;};
  vi.stubGlobal('document',{querySelector:query,querySelectorAll:()=>[],getElementById:(id:string)=>elements[id],createElement:(tag:string)=>new Element(tag),createTextNode:(text:string)=>{const node=new Element('#text');node.textContent=text;return node;}});
  vi.stubGlobal('chrome',{runtime:{onMessage:{addListener:vi.fn()}},storage:{onChanged:{addListener:vi.fn()}}});vi.stubGlobal('BroadcastChannel',undefined);
  mocks.state.settings.cache.enabled=true;mocks.state.docId='doc';mocks.state.viewer={};
  mocks.get.mockResolvedValue(undefined);mocks.state.settings.reading={autoOverview:false};mocks.access.mockResolvedValue(true);mocks.prepare.mockResolvedValue({request:{id:'request',endpoint:'',model:''}});
  mocks.persistQuestion.mockResolvedValue([]);
  mocks.send.mockResolvedValue({text:'Answer'});
  let history:any[]=[];mocks.persist.mockImplementation(async(_id,turn)=>{history.push({role:'user',content:turn.question},{role:'assistant',content:turn.answer,sources:[]});return history;});
  const module=await import('../src/viewer/aiActions');ready=module.restoreDocumentChat;init=module.initAiPanels;reset=module.resetAiPanels;extracted=module.onTextExtracted;init();
});
afterEach(()=>vi.unstubAllGlobals());
describe('paper chat repeated send lifecycle',()=>{
  it('sends three consecutive turns using click and Enter after the placeholder is gone',async()=>{
    expect(elements['chat-log'].querySelector('.yd-chat-empty')).not.toBeNull();
    click('first');await settle();expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(elements['chat-log'].querySelector('.yd-chat-empty')).toBeNull();
    enter('second');await settle();click('third');await settle();
    expect(mocks.send).toHaveBeenCalledTimes(3);expect(mocks.persist).toHaveBeenCalledTimes(3);expect(input().value).toBe('');
    expect(elements['chat-log'].textContent).toContain('second');expect(button().hidden).toBe(false);
  });
  it('allows repeat sending with answer caching disabled',async()=>{
    mocks.state.settings.cache.enabled=false;click('first');await settle();enter('second');await settle();expect(mocks.send).toHaveBeenCalledTimes(2);expect(mocks.persist).toHaveBeenCalledTimes(2);
  });
  it('releases the job after preparation fails and allows resending',async()=>{
    mocks.prepare.mockRejectedValueOnce(new Error('configuration changed'));click('first');await settle();expect(elements['chat-log'].textContent).toContain('configuration changed');enter('second');await settle();expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('clears immediately and retries the captured question without consuming a new draft or duplicating bubbles',async()=>{
    mocks.send.mockRejectedValueOnce(new Error('failed'));click('original');expect(input().value).toBe('');await settle();
    input().value='new draft';
    const retry=flat(elements['chat-log']).find(n=>n.tagName==='button'&&n.textContent==='重试')!;retry.onclick();await settle();
    expect(mocks.persist.mock.calls[0][1].question).toBe('original');expect(input().value).toBe('new draft');expect(elements['chat-log'].children.filter(n=>n.tagName==='article').length).toBe(2);
    expect(mocks.send.mock.calls[1][2]).toMatchObject({force:true,retryInterrupted:true});
  });
  it('manual send authorizes interrupted-task recovery without forcing past completed caches',async()=>{
    click('question');await settle();expect(mocks.send.mock.calls[0][2]).toMatchObject({force:false,retryInterrupted:true});
  });
  it('omits legacy provider output limits on every normal chat request',async()=>{
    click('Explain in detail');await settle();
    expect(mocks.prepare.mock.calls[0][2]).toMatchObject({maxTokens:0});
  });
  it('reports service-side truncation without introducing a smaller retry cap',async()=>{
    const {AiOutputLimitError}=await import('../src/ai/types');
    mocks.send.mockRejectedValueOnce(new AiOutputLimitError('Partial answer'));click('question');await settle();
    expect(elements['chat-log'].textContent).toContain('页灯未设置输出额度');
    expect(elements['chat-log'].textContent).not.toContain('提高至');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    flat(elements['chat-log']).find(n=>n.tagName==='button'&&n.textContent==='重试')!.onclick();await settle();
    expect(mocks.prepare.mock.calls.at(-1)![2]).toMatchObject({maxTokens:0});
  });
  it('retains incomplete answers and raises the budget only on a deliberate retry',async()=>{
    const {AiOutputLimitError}=await import('../src/ai/types');
    mocks.send.mockRejectedValueOnce(new AiOutputLimitError('Partial explanation',2048));click('original');await settle();
    expect(elements['chat-log'].textContent).toContain('Partial explanation');expect(mocks.persist).not.toHaveBeenCalled();expect(mocks.send).toHaveBeenCalledTimes(1);
    input().value='next draft';const retry=flat(elements['chat-log']).find(n=>n.tagName==='button'&&n.textContent==='提高至 8192 tokens 重试')!;retry.onclick();await settle();
    expect(mocks.prepare.mock.calls.at(-1)![2]).toMatchObject({maxTokens:8192});expect(input().value).toBe('next draft');
  });
  it('retains received stream text after a network error rather than replacing it with the error',async()=>{
    mocks.send.mockImplementationOnce(async(_p,_a,options)=>{options.onDelta('Useful partial answer');throw new Error('connection lost');});click('question');await settle();expect(elements['chat-log'].textContent).toContain('Useful partial answer');expect(elements['chat-log'].textContent).toContain('connection lost');expect(mocks.persist).not.toHaveBeenCalled();
  });
  it('scrolls once on send but preserves user position through streaming and completion',async()=>{
    const log=elements['chat-log'];log.scrollHeight=900;log.scrollTop=12;
    let finish!:(value:any)=>void;let delta!:(text:string)=>void;
    mocks.send.mockImplementationOnce(async(_p,_a,options)=>{delta=options.onDelta;return new Promise(r=>{finish=r;});});
    click('question');expect(log.scrollTop).toBe(900);await vi.waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(1));
    log.scrollTop=42;delta('**Live answer**');await vi.waitFor(()=>expect(log.textContent).toContain('Live answer'));expect(log.scrollTop).toBe(42);
    finish({text:'Final answer'});await settle();expect(log.scrollTop).toBe(42);expect(log.textContent).toContain('Final answer');
  });
  it('keeps completed answer visible when storage fails and retries only local saving',async()=>{
    mocks.persist.mockRejectedValueOnce(new Error('disk unavailable'));click('question');await settle();
    expect(elements['chat-log'].textContent).toContain('Answer');expect(elements['chat-log'].textContent).toContain('本地保存失败');
    const retry=flat(elements['chat-log']).find(n=>n.tagName==='button'&&n.textContent==='重试保存')!;retry.onclick();
    await vi.waitFor(()=>expect(mocks.persist).toHaveBeenCalledTimes(2));expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('restores completed conversations after reset even with result cache disabled and overview loading stalled',async()=>{
    mocks.state.settings.cache.enabled=false;click('last question');await settle();
    const turn=mocks.persist.mock.calls[0][1];
    mocks.get.mockImplementation((store,key)=>store==='chats'&&key==='doc:chat'?Promise.resolve({messages:[{role:'user',content:turn.question},{role:'assistant',content:turn.answer,sources:[]}]}):new Promise(()=>{}));
    reset();init();extracted();
    await vi.waitFor(()=>expect(elements['chat-log'].textContent).toContain('last question'));expect(elements['chat-log'].textContent).toContain('Answer');expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('does not claim local saving is complete until the persistence promise commits',async()=>{
    let commit!:(messages:any[])=>void;mocks.persist.mockImplementationOnce(()=>new Promise(r=>{commit=r;}));click('question');
    await vi.waitFor(()=>expect(elements['chat-log'].textContent).toContain('正在保存对话'));expect(elements['chat-log'].textContent).not.toContain('已保存到本机');
    commit([{role:'user',content:'question'},{role:'assistant',content:'Answer',sources:[]}]);await settle();expect(elements['chat-log'].textContent).toContain('已保存到本机');
  });
  it('recovers from network failure and keeps the failed question in its message bubble',async()=>{
    mocks.send.mockRejectedValueOnce(new Error('network unavailable'));enter('question');await settle();
    expect(input().value).toBe('');expect(elements['chat-log'].textContent).toContain('question');expect(elements['chat-log'].textContent).toContain('network unavailable');
    click('question');await settle();expect(mocks.send).toHaveBeenCalledTimes(2);expect(input().value).toBe('');
  });
  it('cancels an in-flight answer then accepts another question',async()=>{
    mocks.send.mockImplementationOnce(async(_p,_a,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))));
    click('first');await vi.waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(1));elements['btn-chat-stop'].onclick();await settle();
    expect(elements['chat-log'].textContent).toContain('已取消');enter('next');await settle();expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it('does not abort or duplicate the current chat on repeated Enter',async()=>{
    let resolve!:(value:any)=>void;mocks.send.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    enter('first');await vi.waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(1));enter('next draft');
    expect(mocks.send).toHaveBeenCalledTimes(1);expect(mocks.toast).toHaveBeenCalled();resolve({text:'Answer'});await settle();
    expect(input().value).toBe('next draft');enter('next draft');await settle();expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it('cleans up a UI initialization error rather than leaving a stale job',async()=>{
    const original=elements['chat-log'].append;elements['chat-log'].append=()=>{elements['chat-log'].append=original;throw new Error('render failed');};
    click('first');await settle();elements['chat-log'].append=original;
    expect(elements['chat-log'].textContent).toContain('render failed');click('next');await settle();expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('clears the busy state on document reset and preserves Shift+Enter / IME composition',async()=>{
    const prevent=vi.fn();input().onkeydown({key:'Enter',shiftKey:true,isComposing:false,preventDefault:prevent});input().onkeydown({key:'Enter',shiftKey:false,isComposing:true,preventDefault:prevent});expect(prevent).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();
    mocks.access.mockImplementationOnce(()=>new Promise(()=>{}));click('first');expect(button().disabled).toBe(true);reset();expect(button().disabled).toBe(false);expect(button().hidden).toBe(false);
  });
});

it('commits the question before network dispatch and restores it if the page leaves mid-answer',async()=>{
 let commit!:()=>void;mocks.persistQuestion.mockImplementationOnce(()=>new Promise<void>(r=>{commit=r;}));
 click('question before navigation');await vi.waitFor(()=>expect(mocks.persistQuestion).toHaveBeenCalledOnce());expect(mocks.send).not.toHaveBeenCalled();
 const question=mocks.persistQuestion.mock.calls[0][1];
 mocks.send.mockImplementationOnce(()=>new Promise(()=>{}));commit();await vi.waitFor(()=>expect(mocks.send).toHaveBeenCalledOnce());
 reset();init();mocks.get.mockResolvedValue({messages:[{role:'user',content:question.question,at:question.at,turnId:question.id}]});ready();
 await vi.waitFor(()=>expect(elements['chat-log'].textContent).toContain('question before navigation'));expect(elements['chat-log'].textContent).toContain('问题已保留');expect(mocks.send).toHaveBeenCalledOnce();
});
it('restores completed answers without waiting for text extraction or requesting a model',async()=>{
 mocks.state.docText=null;
 mocks.get.mockResolvedValue({messages:[{role:'user',content:'saved question',turnId:'t'},{role:'assistant',content:'saved answer',turnId:'t'}]});ready();
 await vi.waitFor(()=>expect(elements['chat-log'].textContent).toContain('saved answer'));expect(mocks.send).not.toHaveBeenCalled();
 mocks.state.docText={pages:[],sections:[]};
});
it('does not incur a model request when the initial question cannot be saved',async()=>{
 mocks.persistQuestion.mockRejectedValueOnce(new Error('quota'));click('keep this question');await settle();expect(mocks.send).not.toHaveBeenCalled();expect(elements['chat-log'].textContent).toContain('尚未调用模型');expect(elements['chat-log'].textContent).toContain('keep this question');
});
