import type {PageText} from '../pdf/extract';
import type {ResultSourceReference} from '../shared/savedResults';
/** Legacy records lack selected text. Recover nearby lines, never label them as the exact selection. */
export function legacySelectionPreview(source:ResultSourceReference|undefined,pages:readonly PageText[]):string {
 if(!source?.sourceQuads?.length)return '';
 const texts:string[]=[];
 for(const region of source.sourceQuads){
  const page=pages.find(p=>p.pageIndex===region.pageIndex);if(!page)continue;
  for(const line of page.lines){
   if(region.quads.some(quad=>{
    const left=Math.min(...quad.map(p=>p.x)),right=Math.max(...quad.map(p=>p.x));
    const bottom=Math.min(...quad.map(p=>p.y)),top=Math.max(...quad.map(p=>p.y));
    return Math.min(right,line.xEnd)>Math.max(left,line.x)&&Math.min(top,line.y+line.h)-Math.max(bottom,line.y)>line.h*.4;
   }))texts.push(line.text);
  }
 }
 return texts.join(' ').replace(/\s+/g,' ').trim();
}
