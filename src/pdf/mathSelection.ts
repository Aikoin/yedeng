/** A display equation is better represented by its source crop than PDF glyph order. */
export function looksLikeFormula(text:string):boolean {
 const symbols=(text.match(/[=∑∫∏√≤≥≠≈∈∂∇∞θπλσΣΠ]/gu)??[]).length;
 const proseWords=(text.match(/\b[A-Za-z]{3,}\b/g)??[]).length;
 return proseWords<10 && ((symbols>=3 && (text.length<220 || symbols/Math.max(1,text.length)>.04)) || (symbols>=2&&proseWords<6&&text.length<220) || (/=/.test(text)&&/\b(Attention|softmax|FFN)\b/.test(text)));
}
