// Generated from logistikvaerktoejer/src/transport-calculations.mjs. Edit the source and run sync-account-calculations.mjs.
import {CalculationError} from './logistics-calculations.mjs';
import {normalizeTransportInput,normalizeTransportFees,parseCalendarDate} from './logistics-transport-input.mjs';
import {TRANSPORT_IDS,VEHICLE_CATEGORIES} from './logistics-transport-contract.mjs';
export {TRANSPORT_IDS};
const maxResult=1e15,dayMs=86400000;
const finite=(value,path='')=>{if(!Number.isFinite(value)||Math.abs(value)>maxResult)throw new CalculationError('result_too_large',path,'Resultatet er for stort. Kontrollér mængder, priser og enheder.');return Object.is(value,-0)?0:value;};
const money=value=>Math.round((finite(value)+Number.EPSILON*Math.abs(value))*100)/100;
const sum=values=>finite(values.reduce((a,b)=>a+b,0));
const dimensionFactor={m:1,cm:0.01,mm:0.001};
// Decimal dimensions and rounding increments are not always exact in binary.
// Ignore only machine-scale noise when a computed weight meets a tariff edge.
const atLeast=(value,boundary)=>value>=boundary||boundary-value<=16*Number.EPSILON*Math.max(Math.abs(value),Math.abs(boundary));
const rankOffers=offers=>offers.map(offer=>({...offer,rank:1+offers.filter(other=>other.totalCost<offer.totalCost).length}));
const lowest=offers=>{if(!offers.length)return [];const cost=Math.min(...offers.map(o=>o.totalCost));return offers.filter(o=>o.totalCost===cost).map(o=>o.id);};
const calendarAt=(start,days)=>new Date(start+days*dayMs).toISOString().slice(0,19);

/** context quantities are linked to current model output; `base` is already in DKK.
 * percent base = rate/100 × base, never an accumulating fee subtotal.
 * Manual percent basis is in the fee's currency. Unit manual basis is a quantity.
 */
export function calculateFees(rawFees,context,toolId,path='fees'){
  const normalized=normalizeTransportFees(rawFees,toolId,path,false);
  const fees=normalized.flatMap((fee,index)=>{
    if(!fee.enabled)return [];
    let basisQuantity=1;
    if(fee.kind!=='fixed'){
      basisQuantity=fee.basis==='manual'?fee.manualBase:context[fee.basis];
      if(typeof basisQuantity!=='number'||!Number.isFinite(basisQuantity)||basisQuantity<0)throw new CalculationError('fee_basis',`${path}.${index}.basis`,'Gebyrgrundlaget mangler eller er ugyldigt.');
    }
    const sourceAmount=finite(fee.kind==='percent'?fee.rate/100*basisQuantity:fee.rate*basisQuantity);
    const amountDkk=money(sourceAmount*fee.fx);
    return [{id:fee.id,name:fee.name||'Gebyr uden navn',kind:fee.kind,basis:fee.basis,basisQuantity,currency:fee.currency,fx:fee.fx,rate:fee.rate,sourceAmount,amountDkk}];
  });
  return {fees,feeTotal:money(sum(fees.map(fee=>fee.amountDkk)))};
}

export function ladmeter(raw){
  const input=normalizeTransportInput('ladmeter',raw);
  const lines=input.lines.map(line=>{
    const factor=dimensionFactor[line.dimensionUnit],lengthM=finite(line.length*factor),widthM=finite(line.width*factor),areaM2=finite(lengthM*widthM*line.quantity);
    return {id:line.id,name:line.name,lengthM,widthM,quantity:line.quantity,areaM2,ldm:finite(areaM2/input.deckWidthM)};
  });
  const totalAreaM2=sum(lines.map(line=>line.areaM2)),totalLdm=sum(lines.map(line=>line.ldm)),totalPieces=sum(lines.map(line=>line.quantity));
  const fees=calculateFees(input.fees,{ldm:totalLdm,pieces:totalPieces,m2:totalAreaM2},'ladmeter');
  return {toolId:'ladmeter',lines,totalLdm,totalAreaM2,totalPieces,...fees,totalCost:fees.feeTotal,warnings:['area_estimate']};
}

export function luftfragt(raw){
  const input=normalizeTransportInput('luftfragt',raw);
  const lines=input.lines.map(line=>{
    const factor=dimensionFactor[line.dimensionUnit],lengthM=finite(line.length*factor),widthM=finite(line.width*factor),heightM=finite(line.height*factor);
    return {id:line.id,name:line.name,lengthM,widthM,heightM,quantity:line.quantity,actualWeightKg:finite(line.weightKg*line.quantity),volumeM3:finite(lengthM*widthM*heightM*line.quantity)};
  });
  const actualWeightKg=sum(lines.map(line=>line.actualWeightKg)),volumeM3=sum(lines.map(line=>line.volumeM3)),volumeWeightKg=finite(volumeM3*1e6/input.volumeFactor),rawChargeableKg=Math.max(actualWeightKg,volumeWeightKg);
  const steps=input.roundingKg?rawChargeableKg/input.roundingKg:0;
  const chargeableKg=input.roundingKg?finite(Math.ceil(steps-4*Number.EPSILON*Math.abs(steps))*input.roundingKg):rawChargeableKg;
  let index=0;input.breaks.forEach((b,i)=>{if(atLeast(chargeableKg,b.fromKg))index=i;});
  const b=input.breaks[index],selectedBreak={...b,untilKg:input.breaks[index+1]?.fromKg??null};
  const priceRaw=finite(chargeableKg*b.rate*input.fx),minimumRaw=input.minimumFreight===null?null:finite(input.minimumFreight*input.fx);
  const baseFreight=money(Math.max(priceRaw,minimumRaw??0));
  const fees=calculateFees(input.fees,{base:baseFreight,actualKg:actualWeightKg,chargeableKg,volumeM3,pieces:sum(input.lines.map(line=>line.quantity))},'luftfragt');
  return {toolId:'luftfragt',lines,actualWeightKg,volumeM3,volumeWeightKg,rawChargeableKg,chargeableKg,selectedBreak,currency:input.currency,fx:input.fx,calculatedFreight:money(priceRaw),minimumFreight:minimumRaw===null?null:money(minimumRaw),baseFreight,...fees,totalCost:money(baseFreight+fees.feeTotal),warnings:['weight_break_current_weight']};
}

export function palletransport(raw){
  const input=normalizeTransportInput('palletransport',raw),start=parseCalendarDate(input.dispatchAt),end=parseCalendarDate(input.deadlineAt),availableDays=(end-start)/dayMs,totalWeightKg=finite(input.pallets*input.weightPerPalletKg);
  const offers=rankOffers(input.offers.map(offer=>{
    const baseFreight=money(offer.price*(offer.priceBasis==='pallet'?input.pallets:1)*offer.fx);
    const fees=calculateFees(offer.fees,{base:baseFreight,pallets:input.pallets,actualKg:totalWeightKg},'palletransport',`offers.${input.offers.indexOf(offer)}.fees`);
    const totalCost=money(baseFreight+fees.feeTotal),marginDays=availableDays-offer.maxDays;
    return {id:offer.id,name:offer.name,loadType:offer.loadType,baseFreight,...fees,totalCost,pricePerPallet:money(totalCost/input.pallets),minDays:offer.minDays,maxDays:offer.maxDays,marginDays,earliestArrival:calendarAt(start,offer.minDays),latestArrival:calendarAt(start,offer.maxDays),meetsDeadline:marginDays>=0};
  }));
  const lowestFeasibleIds=lowest(offers.filter(offer=>offer.meetsDeadline));
  return {toolId:'palletransport',availableDays,pallets:input.pallets,totalWeightKg,offers,lowestIds:lowest(offers),lowestFeasibleIds,warnings:['calendar_days',...(lowestFeasibleIds.length?[]:['no_feasible_offer'])]};
}

export function containertransport(raw){
  const input=normalizeTransportInput('containertransport',raw),goodsRaw=finite(input.containers*input.valuePerContainer*input.valueFx);
  const offers=rankOffers(input.offers.map((offer,index)=>{
    const baseFreight=money(input.containers*offer.freightPerContainer*offer.fx),fees=calculateFees(offer.fees,{base:baseFreight,containers:input.containers},'containertransport',`offers.${index}.fees`);
    const directCost=money(baseFreight+fees.feeTotal),capitalDays=Math.max(0,offer.transitDays-offer.paymentDay),capitalCost=money(goodsRaw*input.annualRatePercent/100*capitalDays/365);
    return {id:offer.id,name:offer.name,baseFreight,...fees,directCost,capitalDays,capitalCost,totalCost:money(directCost+capitalCost),transitDays:offer.transitDays,paymentDay:offer.paymentDay};
  }));
  return {toolId:'containertransport',containers:input.containers,goodsValueDkk:money(goodsRaw),offers,lowestIds:lowest(offers),warnings:['goods_value_excluded','transport_capital_only']};
}

export function biltransport(raw){
  const input=normalizeTransportInput('biltransport',raw),multipliers={month:12,year:1,km:input.annualKm,hour:input.annualHours};
  const salary=input.costs.find(cost=>cost.category==='salary'),salaryAnnual=money(salary.amount*multipliers[salary.period]*salary.fx);
  const costs=input.costs.map(cost=>({id:cost.id,category:cost.category,name:cost.name,period:cost.period,amount:cost.amount,annualCost:cost.period==='salaryPercent'?money(salaryAnnual*cost.amount/100):money(cost.amount*multipliers[cost.period]*cost.fx)}));
  const fuelLitres=finite(input.fuelEfficiencyMode==='kmPerLitre'?input.annualKm/input.fuelEfficiency:input.annualKm*input.fuelEfficiency/100),fuelCost=money(fuelLitres*input.fuelPricePerLitre*input.fx),baseAnnualCost=money(sum(costs.map(cost=>cost.annualCost))+fuelCost);
  const fees=calculateFees(input.fees,{base:baseAnnualCost,km:input.annualKm,hours:input.annualHours,months:12,years:1},'biltransport'),totalCost=money(baseAnnualCost+fees.feeTotal);
  return {toolId:'biltransport',annualKm:input.annualKm,annualHours:input.annualHours,fuelLitres,fuelCost,costs,baseAnnualCost,...fees,totalCost,costPerKm:input.annualKm?money(totalCost/input.annualKm):null,costPerHour:input.annualHours?money(totalCost/input.annualHours):null,warnings:[...(!input.annualKm?['zero_km']:[]),...(!input.annualHours?['zero_hours']:[])]};
}

export const transportCalculators=Object.freeze({ladmeter,luftfragt,palletransport,containertransport,biltransport});
export const TRANSPORT_CALCULATORS=transportCalculators;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
/** Entirely fictitious editable examples, never market rates. No fees are enabled or included. */
export const TRANSPORT_SAMPLES=freeze({
  ladmeter:{deckWidthM:2.4,lines:[{id:'cargo-1',name:'EUR-paller',length:120,width:80,dimensionUnit:'cm',quantity:6},{id:'cargo-2',name:'Kasse',length:200,width:100,dimensionUnit:'cm',quantity:1}],fees:[]},
  luftfragt:{lines:[{id:'air-1',name:'Kasser',length:60,width:40,height:50,dimensionUnit:'cm',quantity:10,weightKg:12}],volumeFactor:6000,roundingKg:0.5,minimumFreight:1000,currency:'DKK',fx:1,breaks:[{id:'rate-1',fromKg:0,rate:18},{id:'rate-2',fromKg:100,rate:15},{id:'rate-3',fromKg:300,rate:12}],fees:[]},
  palletransport:{pallets:10,weightPerPalletKg:400,dispatchAt:'2026-11-09T08:00',deadlineAt:'2026-11-12T08:00',offers:[{id:'pallet-a',name:'Dellæs · eksempel',loadType:'LTL',priceBasis:'pallet',price:350,currency:'DKK',fx:1,minDays:3,maxDays:5,fees:[]},{id:'pallet-b',name:'Fuldlæs · eksempel',loadType:'FTL',priceBasis:'shipment',price:5000,currency:'DKK',fx:1,minDays:1,maxDays:2,fees:[]}]},
  containertransport:{containers:2,valuePerContainer:250000,valueCurrency:'DKK',valueFx:1,annualRatePercent:8,offers:[{id:'container-a',name:'Direkte rute · eksempel',freightPerContainer:18000,currency:'DKK',fx:1,transitDays:25,paymentDay:0,fees:[]},{id:'container-b',name:'Længere rute · eksempel',freightPerContainer:16000,currency:'DKK',fx:1,transitDays:40,paymentDay:-10,fees:[]}]},
  biltransport:{annualKm:80000,annualHours:1800,fuelEfficiencyMode:'kmPerLitre',fuelEfficiency:4,fuelPricePerLitre:12,currency:'DKK',fx:1,costs:VEHICLE_CATEGORIES.map((category,index)=>({id:`vehicle-${category}`,category,name:['Leasing','Løn','Sociale omkostninger','Vikar','Vedligehold','Forsikring','Afgifter'][index],amount:[15000,32000,12,18000,0.8,30000,18000][index],period:['month','month','salaryPercent','year','km','year','year'][index],currency:'DKK',fx:1})),fees:[]},
});
