import {describe,it,expect} from 'vitest';
import {captureBounds} from '../src/pdf/capture';
import type {PdfQuad} from '../src/pdf/geometry';
const v={width:4000,height:4000,transform:[1,0,0,1,0,0]};
const q=(x:number,y:number,w:number,h:number):PdfQuad=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
describe('PDF crop input and resource boundaries',()=>{
 it('clips outside-page ROI and rounds outward to preserve edge symbols',()=>{expect(captureBounds(v,q(-.5,20.2,30.7,10.1))).toEqual({left:0,top:20,width:31,height:11});});
 it('rejects tiny and entirely outside regions',()=>{expect(()=>captureBounds(v,q(0,0,2,2))).toThrow('过小');expect(()=>captureBounds(v,q(5000,5000,10,10))).toThrow('超出');});
 it('rejects above 4MP and longest edge 2400 before allocating a canvas',()=>{expect(()=>captureBounds(v,q(0,0,2100,2100))).toThrow('4MP');expect(()=>captureBounds(v,q(0,0,2500,10))).toThrow('2400');expect(captureBounds(v,q(0,0,2000,2000)).width).toBe(2000);});
 it('rejects nonfinite coordinates instead of creating a corrupt crop',()=>{expect(()=>captureBounds(v,q(NaN,0,10,10))).toThrow('坐标');expect(()=>captureBounds({...v,width:0},q(0,0,10,10))).toThrow();});
});
