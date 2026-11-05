// Generated from logistikvaerktoejer/src/saved-input.mjs. Edit the source and run sync-account-calculations.mjs.
import {CalculationError, parseNumber, eoq, rop, tco, abc, MAX_ABC_ROWS, MAX_TCO_COSTS} from './logistics-calculations.mjs';
export {CalculationError, CalculationError as LogisticsValidationError};
export const MAX_SAVED_INPUT_BYTES = 128 * 1024;

const calculators = {eoq, genbestilling:rop, tco, abc};
const fail = (code,path,message) => {throw new CalculationError(code,path,message);};

function object(value,keys,path,strict){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('invalid_input',path,'Oplysningerne skal have det forventede format.');
  for(const key of Reflect.ownKeys(value)){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||['__proto__','prototype','constructor'].includes(key)||descriptor?.get||descriptor?.set)fail('invalid_field',path,'Oplysningerne indeholder et ugyldigt felt.');
    if(strict&&!keys.includes(key))fail('unknown_field',path?`${path}.${key}`:key,'Oplysningerne indeholder et felt, som ikke hører til beregningen.');
  }
  return value;
}
function number(value,path,strict){
  if(strict&&typeof value!=='number')fail('invalid_number',path,'Gemte tal skal være gyldige numeriske værdier.');
  try{return parseNumber(value);}catch(error){if(error instanceof CalculationError)error.path=path;throw error;}
}
function text(value,path,message='Angiv et navn på højst 160 tegn.'){
  if(typeof value!=='string'||!value.trim()||value.trim().length>160||/[\u0000-\u001f\u007f]/.test(value))fail('invalid_text',path,message);
  return value.trim();
}
function choice(value,choices,path){
  if(!choices.includes(value))fail('invalid_choice',path,'Vælg en af de viste muligheder.');
  return value;
}
function rows(value,max,path){
  if(!Array.isArray(value)||value.length<1||value.length>max)fail('row_count',path,`Brug mellem 1 og ${max} rækker.`);
  for(let index=0;index<value.length;index++)if(!Object.hasOwn(value,index))fail('invalid_input',`${path}.${index}`,'En række mangler oplysninger.');
  return value;
}

function normalize(toolId,raw,strict){
  if(!Object.hasOwn(calculators,toolId))fail('unknown_tool','toolId','Vælg et af de understøttede værktøjer.');
  // Only these explicitly selected fields ever leave the calculator. Browser
  // FormData also contains import preferences and dynamic control names.
  let data;
  if(toolId==='eoq'){
    const fields=['annualDemand','orderCost','unitCost','holdingRatePercent','workingDays'];object(raw,fields,'',strict);
    data=Object.fromEntries(fields.map(key=>[key,number(raw[key],key,strict)]));
  }else if(toolId==='genbestilling'){
    object(raw,['mode','dailyDemand','leadDays','safetyMode','safetyStock','safetyDays','dailyStdDev','serviceLevelPercent'],'',false);
    const mode=choice(raw.mode,['simple','statistical'],'mode');
    const fields=['mode','dailyDemand','leadDays'];
    const safetyMode=mode==='simple'?choice(raw.safetyMode,['units','days'],'safetyMode'):null;
    if(mode==='simple')fields.push('safetyMode',safetyMode==='units'?'safetyStock':'safetyDays');
    else fields.push('dailyStdDev','serviceLevelPercent');
    object(raw,fields,'',strict);
    data=Object.fromEntries(fields.map(key=>[key,key==='mode'?mode:key==='safetyMode'?safetyMode:number(raw[key],key,strict)]));
  }else if(toolId==='tco'){
    object(raw,['periodYears','annualQuantity','alternatives','capital'],'',strict);
    const capitalEnabled=raw.capital!==undefined;
    let capital;
    if(capitalEnabled){
      object(raw.capital,['annualRatePercent'],'capital',strict);
      capital={annualRatePercent:number(raw.capital.annualRatePercent,'capital.annualRatePercent',strict)};
    }
    data={periodYears:number(raw.periodYears,'periodYears',strict),annualQuantity:number(raw.annualQuantity,'annualQuantity',strict),alternatives:rows(raw.alternatives,3,'alternatives').map((alternative,index)=>{
      const path=`alternatives.${index}`;
      object(alternative,['id','name','ordersPerYear','residualValue','costs',...(capitalEnabled?['capital']:[])],path,strict);
      let alternativeCapital;
      if(capitalEnabled){
        const cp=`${path}.capital`, source=object(alternative.capital,[],cp,false);
        const paymentStart=choice(source.paymentStart,['order','receipt','other'],`${cp}.paymentStart`);
        const interestMode=choice(source.interestMode,['add','replace','skip'],`${cp}.interestMode`);
        const keys=['purchaseCostId','leadDays','paymentStart','supplierCreditDays','inventoryDays','customerCreditDays','interestMode',...(paymentStart==='other'?['paymentStartDays']:[]),...(interestMode==='replace'?['existingInterestCostId','existingInterestAnnual']:[])];
        object(source,keys,cp,strict);
        alternativeCapital={purchaseCostId:text(source.purchaseCostId,`${cp}.purchaseCostId`,'Vælg en eksisterende indkøbspris med frekvensen Pr. enhed.'),leadDays:number(source.leadDays,`${cp}.leadDays`,strict),paymentStart,
          supplierCreditDays:number(source.supplierCreditDays,`${cp}.supplierCreditDays`,strict),inventoryDays:number(source.inventoryDays,`${cp}.inventoryDays`,strict),customerCreditDays:number(source.customerCreditDays,`${cp}.customerCreditDays`,strict),interestMode};
        if(paymentStart==='other')alternativeCapital.paymentStartDays=number(source.paymentStartDays,`${cp}.paymentStartDays`,strict);
        if(interestMode==='replace'){
          alternativeCapital.existingInterestCostId=text(source.existingInterestCostId,`${cp}.existingInterestCostId`,'Vælg den eksisterende omkostningspost, der indeholder renten. Varekøbet kan ikke vælges som rentepost.');
          alternativeCapital.existingInterestAnnual=number(source.existingInterestAnnual,`${cp}.existingInterestAnnual`,strict);
        }
      }
      return {id:text(!strict&&alternative.id===undefined?String(index+1):alternative.id,`${path}.id`),name:text(alternative.name,`${path}.name`),ordersPerYear:number(alternative.ordersPerYear,`${path}.ordersPerYear`,strict),residualValue:number(alternative.residualValue,`${path}.residualValue`,strict),...(alternativeCapital?{capital:alternativeCapital}:{}),costs:rows(alternative.costs,MAX_TCO_COSTS,`${path}.costs`).map((cost,costIndex)=>{
        const costPath=`${path}.costs.${costIndex}`;
        object(cost,['id','label','amount','frequency'],costPath,strict);
        return {id:text(!strict&&cost.id===undefined?String(costIndex+1):cost.id,`${costPath}.id`),label:text(cost.label,`${costPath}.label`),amount:number(cost.amount,`${costPath}.amount`,strict),frequency:choice(cost.frequency,['once','year','order','unit'],`${costPath}.frequency`)};
      })};
    }),...(capital?{capital}:{})};
  }else{
    object(raw,['thresholdA','thresholdB','items'],'',strict);
    data={thresholdA:number(raw.thresholdA,'thresholdA',strict),thresholdB:number(raw.thresholdB,'thresholdB',strict),items:rows(raw.items,MAX_ABC_ROWS,'items').map((item,index)=>{
      const path=`items.${index}`;object(item,['name','annualQuantity','unitCost'],path,strict);
      return {name:text(item.name,`${path}.name`),annualQuantity:number(item.annualQuantity,`${path}.annualQuantity`,strict),unitCost:number(item.unitCost,`${path}.unitCost`,strict)};
    })};
  }
  // Apply the exact same bounds and model checks as the live calculator,
  // including relationship constraints, unique IDs and result overflow.
  calculators[toolId](data);
  return data;
}

/** Browser-only form adapter: Danish numeric strings become numbers; UI-only fields are omitted. */
export function canonicalizeInput(toolId,raw){return normalize(toolId,raw,false);}

/** API/storage boundary: no coercion, unknown fields, partial inputs or inactive mode fields. */
export function validateLogisticsInput(toolId,input){return normalize(toolId,input,true);}
