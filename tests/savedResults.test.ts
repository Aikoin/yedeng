import {expect,it} from 'vitest';
import {copyResultSources} from '../src/shared/savedResults';
it('durable source references whitelist identity and geometry without copying request material or keys',()=>{
 const source={id:'local',label:'E1 · source',pageIndices:[0],sourceQuads:[{pageIndex:0,quads:[[{x:1,y:2},{x:3,y:2},{x:3,y:4},{x:1,y:4}] as [{x:number;y:number},{x:number;y:number},{x:number;y:number},{x:number;y:number}]]}],assetId:'asset',assetVersion:1,text:'private selected original',image:'data:image/png;base64,YQ==',apiKey:'fake-secret',system:'system'};
 const result=copyResultSources([source]);source.sourceQuads[0].quads[0][0].x=999;
 expect(result[0].sourceQuads![0].quads[0][0].x).toBe(1);expect(JSON.stringify(result)).not.toContain('private selected');expect(JSON.stringify(result)).not.toContain('base64');expect(JSON.stringify(result)).not.toContain('fake-secret');expect(result[0]).not.toHaveProperty('system');
});
