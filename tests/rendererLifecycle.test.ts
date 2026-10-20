import { afterEach, expect, it, vi } from 'vitest';
vi.mock('pdfjs-dist',()=>({TextLayer:class{constructor(_:unknown){}render(){return Promise.resolve();}cancel(){}},AnnotationLayer:class{}}));
import { PdfViewer } from '../src/pdf/renderer';
class ElementStub{
  children:ElementStub[]=[];style:Record<string,unknown>={setProperty:()=>{}};dataset:Record<string,string>={};hidden=false;textContent='';width=1;height=1;scrollTop=0;clientTop=0;clientHeight=600;offsetHeight=800;classList={add:()=>{},remove:()=>{}};
  appendChild(el:ElementStub){this.children.push(el);return el;}append(...els:ElementStub[]){this.children.push(...els);}replaceChildren(...els:ElementStub[]){this.children=els;}
  addEventListener(){}removeEventListener(){}setAttribute(){}getBoundingClientRect(){return {top:0,left:0,width:600,height:800};}scrollTo(value:{top:number}){this.scrollTop=value.top;}getContext(){return {fillStyle:'',fillRect(){}};}
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
afterEach(()=>vi.unstubAllGlobals());
function harness(){
 vi.stubGlobal('document',{createElement:()=>new ElementStub(),createTextNode:(value:string)=>Object.assign(new ElementStub(),{textContent:value})});vi.stubGlobal('window',{devicePixelRatio:2,setTimeout});vi.stubGlobal('getComputedStyle',()=>({getPropertyValue:()=>''}));
 const status=new ElementStub(),canvas=new ElementStub(),container=new ElementStub();const task=deferred(),text=deferred();let textStarted=false;
 const page={getViewport:({scale}:{scale:number})=>({width:600*scale,height:800*scale,rotation:0}),render:vi.fn(()=>({promise:task.promise,cancel:vi.fn()})),getTextContent:vi.fn(()=>{textStarted=true;return text.promise.then(()=>({items:[]}));}),getAnnotations:async()=>[],cleanup:vi.fn()};
 const entry={index:0,el:new ElementStub(),canvas,textLayerDiv:new ElementStub(),linkLayerDiv:new ElementStub(),annoLayer:new ElementStub(),width:600,height:800,rendered:false,generation:0,status,textLayer:null,renderTask:null,page};
 const viewer=new PdfViewer({container:container as unknown as HTMLElement,pagesContainer:new ElementStub() as unknown as HTMLElement});
 const internals=viewer as unknown as {entries:typeof entry[];doc:unknown;render(index:number):Promise<void>;invalidatePage(entry:unknown):void;destroyed:boolean};internals.entries=[entry];internals.doc={getPage:async()=>page};
 return{viewer,internals,entry,page,task,text,textStarted:()=>textStarted};
}
it('an eviction during text extraction cannot publish a cleared raster as rendered',async()=>{
 const h=harness(),job=h.internals.render(0);await Promise.resolve();await Promise.resolve();h.task.resolve();
 for(let i=0;i<10&&!h.textStarted();i++)await Promise.resolve();expect(h.textStarted()).toBe(true);
 h.internals.invalidatePage(h.entry);h.internals.destroyed=true;h.text.resolve();await job;
 expect(h.entry.rendered).toBe(false);expect(h.entry.canvas.width).toBe(1);expect(h.entry.canvas.style.visibility).toBe('hidden');
});
it('zoom cancels an in-flight task even before its rendered flag becomes true',async()=>{
 const h=harness(),job=h.internals.render(0);await Promise.resolve();await Promise.resolve();
 const pending=h.entry.renderTask as unknown as {cancel:ReturnType<typeof vi.fn>};expect(pending).not.toBeNull();
 h.viewer.setZoom(1.15);expect(pending.cancel).toHaveBeenCalledOnce();expect(h.entry.canvas.style.visibility).toBe('hidden');
 h.internals.destroyed=true;h.task.resolve();h.text.resolve();await job;expect(h.entry.rendered).toBe(false);
});
it('reports the page occupying most of the viewport rather than the previous page tail',()=>{
 const h=harness();h.entry.height=792;h.entry.el.getBoundingClientRect=()=>({top:-866,left:0,width:600,height:1056});
 const next={...h.entry,index:1,el:new ElementStub()};next.el.getBoundingClientRect=()=>({top:218,left:0,width:600,height:1056});h.internals.entries=[h.entry,next];
 expect(h.viewer.currentPageIndex()).toBe(1);h.internals.destroyed=true;
});
