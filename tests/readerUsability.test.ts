import { expect, it } from 'vitest';
import { annotationHit } from '../src/viewer/annotations';
import { shouldOfferOnboarding } from '../src/shared/onboarding';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
it('hits the painted annotation without intercepting text selection, using current screen projection',()=>{
 const rects=[{id:'cross-page-logical-id',left:100,top:120,right:250,bottom:140},{id:'newer-overlap',left:110,top:120,right:150,bottom:140}];
 expect(annotationHit(rects,105,125)).toBe('cross-page-logical-id');expect(annotationHit(rects,130,125)).toBe('newer-overlap');
 expect(annotationHit(rects,300,125)).toBeNull();expect(annotationHit(rects,NaN,125)).toBeNull();
 expect(annotationHit([{id:'same-id',left:200,top:240,right:500,bottom:280}],250,260)).toBe('same-id');
});
it('offers one-time setup for empty or keyless placeholder profiles and preserves already-configured users',()=>{
 const settings=structuredClone(DEFAULT_SETTINGS);
 expect(shouldOfferOnboarding(settings,undefined)).toBe(true);expect(shouldOfferOnboarding(settings,true)).toBe(false);
 settings.providers=[{id:'partial',name:'Placeholder',kind:'openai',baseUrl:'https://api.deepseek.com/v1',apiKey:'',models:['deepseek-flash'],defaultModel:'deepseek-flash',temperature:0,maxTokens:2048}];
 expect(shouldOfferOnboarding(settings,undefined)).toBe(true);settings.providers[0].apiKey='synthetic-not-a-key';expect(shouldOfferOnboarding(settings,undefined)).toBe(false);
});
