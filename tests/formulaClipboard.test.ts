import {expect,it,vi}from'vitest';
import{copyFormulaCode}from'../src/formula/clipboard';
it('copies exactly the supplied LaTeX and reports success only after the browser acknowledges it',async()=>{
 let complete!:()=>void;const pending=new Promise<void>(r=>complete=r);const write=vi.fn(()=>pending),text=String.raw`x^{j}=\\frac{a}{b}`;let done=false;
 const result=copyFormulaCode(text,write).then(value=>{done=true;return value;});await Promise.resolve();expect(done).toBe(false);expect(write).toHaveBeenCalledWith(text);complete();expect(await result).toBe('copied');
});
it('offers manual copy when the browser denies clipboard access, without claiming success or retrying',async()=>{
 const write=vi.fn().mockRejectedValue(new Error('NotAllowedError'));expect(await copyFormulaCode('x_i',write)).toBe('manual');expect(write).toHaveBeenCalledTimes(1);expect(await copyFormulaCode('x_i')).toBe('manual');
});
it('rejects empty results before attempting a clipboard write',async()=>{
 const write=vi.fn();await expect(copyFormulaCode(' ',write)).rejects.toThrow('先提取');expect(write).not.toHaveBeenCalled();
});
