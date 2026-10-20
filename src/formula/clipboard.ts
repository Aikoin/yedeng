/** Never claim a successful copy before the browser acknowledges the write. */
export async function copyFormulaCode(text:string,write?:(text:string)=>Promise<void>):Promise<'copied'|'manual'>{
 if(!text.trim())throw new Error('还没有可复制的结果，请先提取公式');
 if(!write)return 'manual';
 try{await write(text);return 'copied';}catch{return 'manual';}
}
