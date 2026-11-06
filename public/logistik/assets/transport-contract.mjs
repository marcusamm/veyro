/** Transport schema v1. Amounts are DKK ex VAT in results unless explicitly marked.
 * Numeric input may be a Danish numeric string in the browser; storage is numeric.
 * Dates are YYYY-MM-DDTHH:mm in one common local time zone, arithmetic calendar days of 24h.
 * Money is rounded to øre on extended fee/base/cost lines; capital uses unrounded goods value.
 * INPUTS:
 * ladmeter {deckWidthM,lines:[{id,name,length,width,dimensionUnit:'m'|'cm'|'mm',quantity}],fees}
 * luftfragt {lines:[{id,name,length,width,height,dimensionUnit,quantity,weightKg}],volumeFactor,
 *   roundingKg,minimumFreight:null|number,currency,fx,breaks:[{id,fromKg,rate}],fees}
 *   weightKg is PER PARCEL; factor is cm³/kg. roundingKg=0 means none; first break starts at0.
 * palletransport {pallets,weightPerPalletKg,dispatchAt,deadlineAt,offers:[{id,name,loadType:'LTL'|'FTL',
 *   priceBasis:'pallet'|'shipment',price,currency,fx,minDays,maxDays,fees}]}
 * containertransport {containers,valuePerContainer,valueCurrency,valueFx,annualRatePercent,
 *   offers:[{id,name,freightPerContainer,currency,fx,transitDays,paymentDay,fees}]}
 * biltransport {annualKm,annualHours,fuelEfficiencyMode:'kmPerLitre'|'litresPer100Km',fuelEfficiency,
 *   fuelPricePerLitre,currency,fx,costs:[{id,category,name,amount,period,currency,fx}],fees}
 *   Exactly one row per VEHICLE_CATEGORIES. period month|year|km|hour, plus salaryPercent only for social.
 * FEE {id,name:'',enabled:boolean,kind:'fixed'|'percent'|'unit',rate,currency,fx,basis,manualBase}
 *   fixed: basis/manualBase ignored (canonical null). percent: basis base|manual only.
 *   percent base uses an already-DKK base; currency MUST DKK and fx MUST1. No fee-on-fee.
 *   unit: basis from FEE_BASES[id] or manual. manualBase is quantity for unit, money for percent.
 *   Inactive fees retain partial numeric fields as null, but never contribute to results.
 * RESULTS:
 * fees:[{id,name,kind,basis,basisQuantity,currency,fx,rate,sourceAmount,amountDkk}],feeTotal,totalCost,warnings.
 * ladmeter: lines:[{id,name,lengthM,widthM,quantity,areaM2,ldm}],totalLdm,totalAreaM2,totalPieces.
 * luftfragt: lines:[{id,name,lengthM,widthM,heightM,quantity,actualWeightKg,volumeM3}],actualWeightKg,
 * volumeM3,volumeWeightKg,rawChargeableKg,chargeableKg,selectedBreak:{id,fromKg,untilKg:null|number,rate},
 * currency,fx,calculatedFreight,minimumFreight,baseFreight. These freight outputs are DKK.
 * palletransport: availableDays,pallets,totalWeightKg,offers:[{id,name,loadType,baseFreight,feeTotal,fees,
 * totalCost,pricePerPallet,minDays,maxDays,marginDays,earliestArrival,latestArrival,meetsDeadline,rank}],
 * lowestIds,lowestFeasibleIds (empty if none). rank is price rank including ties; original offer order retained.
 * containertransport: containers,goodsValueDkk,offers:[{id,name,baseFreight,feeTotal,fees,directCost,
 * capitalDays,capitalCost,totalCost,transitDays,paymentDay,rank}],lowestIds.
 * biltransport: annualKm,annualHours,fuelLitres,fuelCost,costs:[{id,category,name,period,amount,annualCost}],
 * baseAnnualCost,feeTotal,fees,totalCost,costPerKm:null|number,costPerHour:null|number.
 */
export const TRANSPORT_IDS=Object.freeze(['ladmeter','luftfragt','palletransport','containertransport','biltransport']);
export const TRANSPORT_LIMITS=Object.freeze({lines:50,offers:5,fees:30,breaks:30});
export const VEHICLE_CATEGORIES=Object.freeze(['leasing','salary','social','substitute','maintenance','insurance','tax']);
export const FEE_BASES=Object.freeze({
  ladmeter:['ldm','pieces','m2'],
  luftfragt:['actualKg','chargeableKg','volumeM3','pieces'],
  palletransport:['pallets','actualKg'],
  containertransport:['containers'],
  biltransport:['km','hours','months','years'],
});
export const CURRENCIES=Object.freeze(['DKK','EUR','SEK','USD','NOK','GBP']);
