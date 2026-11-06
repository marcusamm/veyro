import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {TRANSPORT_REFERENCE_SAMPLES} from '../public/logistik/assets/transport-reference.mjs';
import {transportCalculators as browserCalculators} from '../public/logistik/assets/transport-calculations.mjs';
import {transportCalculators} from '../src/lib/logistics-transport-calculations.mjs';
import {canonicalizeInput,validateLogisticsInput,MAX_SAVED_INPUT_BYTES} from '../src/lib/logistics-input.mjs';

// Independent cells/cached outcomes extracted from the supplied reference workbook.
// This verifies compatibility and baseline values, not recalculation in Microsoft Excel.
const reference=JSON.parse(readFileSync(new URL('./fixtures/distribution-reference.json',import.meta.url),'utf8'));
const value=(sheet,cell)=>reference.sheets[sheet][cell].value;
const money=(sheet,cell)=>Math.round(value(sheet,cell)*100)/100;

describe('Supplied transport examples across browser and saved-account boundaries',()=>{
  for(const [id,preset] of Object.entries(TRANSPORT_REFERENCE_SAMPLES)){
    it(`${id} survives canonical serialization and strict validation without changing the browser result`,()=>{
      const input=structuredClone(preset),canonical=canonicalizeInput(id,input),serialized=JSON.stringify(canonical);
      expect(Buffer.byteLength(serialized)).toBeLessThan(MAX_SAVED_INPUT_BYTES);
      const restored=validateLogisticsInput(id,JSON.parse(serialized));
      const result=transportCalculators[id](restored);
      expect(result).toEqual(browserCalculators[id](input));
      expect(restored).toEqual(canonical);
      for(const fees of restored.offers?restored.offers.map(offer=>offer.fees):[restored.fees])expect(fees).toEqual([]);
      for(const item of result.offers||[result])expect(item.feeTotal).toBe(0);
    });
  }

  it('matches the loading-meter and corrected air-freight source outcomes',()=>{
    const loading=transportCalculators.ladmeter(TRANSPORT_REFERENCE_SAMPLES.ladmeter);
    expect(loading.totalLdm).toBe(value('Ladmeter','D6'));
    const air=transportCalculators.luftfragt(TRANSPORT_REFERENCE_SAMPLES.luftfragt);
    expect(air.actualWeightKg).toBe(value('Lufttransport','B9'));
    expect(air.volumeM3).toBeCloseTo(value('Lufttransport','B10'),10);
    expect(air.chargeableKg).toBeCloseTo(value('Lufttransport','B12'),10);
    expect(air.selectedBreak.rate).toBe(value('Lufttransport','E12'));
    expect(air.baseFreight).toBe(money('Lufttransport','C17'));
    expect(air.totalCost).toBe(money('Lufttransport','C23'));
  });

  it('retains all pallet offers, currency conversions, calendar margins and the cheapest feasible offer',()=>{
    const input=TRANSPORT_REFERENCE_SAMPLES.palletransport,result=transportCalculators.palletransport(input);
    expect(result.offers).toHaveLength(4);
    expect(input.dispatchAt).toBe(value('Paller','B10').replace(' ','T').slice(0,16));
    expect(input.deadlineAt).toBe(value('Paller','B11').replace(' ','T').slice(0,16));
    expect(result.availableDays).toBeCloseTo(value('Paller','C23'),9);
    for(const [i,col] of [...'CDEF'].entries()){
      expect(result.offers[i].totalCost).toBe(money('Paller',`${col}20`));
      expect(result.offers[i].pricePerPallet).toBe(money('Paller',`${col}21`));
      expect(result.offers[i].rank).toBe(value('Paller',`${col}26`));
      expect(result.offers[i].marginDays).toBeCloseTo(value('Paller',`${col}24`),9);
    }
    expect(result.lowestFeasibleIds).toEqual([input.offers[3].id]);
  });

  it('uses source interest as 12 percent and separates direct freight from capital',()=>{
    const input=TRANSPORT_REFERENCE_SAMPLES.containertransport,result=transportCalculators.containertransport(input);
    expect(input.annualRatePercent).toBe(value('Container','B5')*100);
    for(const [i,col] of [...'CD'].entries()){
      expect(result.offers[i].directCost).toBe(money('Container',`${col}20`));
      expect(result.offers[i].capitalCost).toBe(money('Container',`${col}21`));
      expect(result.offers[i].totalCost).toBe(money('Container',`${col}22`));
      expect(result.offers[i].capitalDays).toBe(value('Container',`${col}29`));
    }
  });

  it('keeps annual vehicle totals without duplicating grouped source costs',()=>{
    const input=TRANSPORT_REFERENCE_SAMPLES.biltransport,result=transportCalculators.biltransport(input);
    const annualHours=Array.from({length:12},(_,i)=>value('Bil',`B${i+18}`)).reduce((sum,n)=>sum+n,0);
    expect(input.annualHours).toBe(annualHours);
    expect(input.annualKm).toBe(annualHours*value('Bil','B8'));
    expect(input.costs.find(row=>row.category==='social').amount).toBe(0);
    expect(input.costs.find(row=>row.category==='tax').amount).toBe(0);
    expect(result.totalCost).toBe(money('Bil','C39'));
    expect(result.costPerKm).toBe(money('Bil','C40'));
    expect(result.costPerHour).toBe(money('Bil','C41'));
  });
});
