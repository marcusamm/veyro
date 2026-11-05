import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {validateLogisticsInput,canonicalizeInput,LogisticsValidationError,MAX_SAVED_INPUT_BYTES} from '../src/lib/logistics-input.mjs';
import {SAMPLES,eoq,rop,tco,abc} from '../src/lib/logistics-calculations.mjs';

describe('Saved logistics input boundary',()=>{
  it('round-trips all four complete calculation schemas with the exact calculator semantics',()=>{
    for(const [toolId,sample,calculate] of [['eoq',SAMPLES.eoq,eoq],['genbestilling',SAMPLES.rop,rop],['tco',SAMPLES.tco,tco],['abc',SAMPLES.abc,abc]]){
      const canonical=canonicalizeInput(toolId,sample);
      expect(calculate(validateLogisticsInput(toolId,JSON.parse(JSON.stringify(canonical))))).toEqual(calculate(sample));
    }
  });
  it('rejects unknown fields, foreign tool names, inactive fields, strings and malformed nested inputs',()=>{
    for(const input of [{...SAMPLES.eoq,owner:'foreign'},{...SAMPLES.eoq,annualDemand:'12000'},{...SAMPLES.eoq,unitCost:0}])expect(()=>validateLogisticsInput('eoq',input)).toThrow(LogisticsValidationError);
    expect(()=>validateLogisticsInput('stock',SAMPLES.eoq)).toThrow(LogisticsValidationError);
    expect(()=>validateLogisticsInput('genbestilling',SAMPLES.rop)).toThrow(LogisticsValidationError);
    const poisoned=JSON.parse('{"thresholdA":80,"thresholdB":95,"items":[{"name":"x","annualQuantity":1,"unitCost":1,"__proto__":{"admin":true}}]}');
    expect(()=>validateLogisticsInput('abc',poisoned)).toThrow(LogisticsValidationError);
    expect({}.admin).toBeUndefined();
  });
  it('supports full Unicode ABC capacity within the payload budget',()=>{
    const input={thresholdA:80,thresholdB:95,items:Array.from({length:200},(_,i)=>({name:`${'品'.repeat(150)}${i}`,annualQuantity:1,unitCost:1}))};
    expect(validateLogisticsInput('abc',input)).toEqual(input);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(MAX_SAVED_INPUT_BYTES);
  });
  it('server modules exactly match the deployed browser calculation modules',async()=>{
    for(const [server,browser] of [['logistics-calculations.mjs','calculations.mjs'],['logistics-input.mjs','saved-input.mjs']]){
      const actual=(await readFile(new URL(`../src/lib/${server}`,import.meta.url),'utf8')).replace(/^\/\/ Generated[^\n]*\n/,'').replace("from './logistics-calculations.mjs'","from './calculations.mjs'");
      const expected=await readFile(new URL(`../public/logistik/assets/${browser}`,import.meta.url),'utf8');
      expect(actual).toBe(expected);
    }
  });
});
