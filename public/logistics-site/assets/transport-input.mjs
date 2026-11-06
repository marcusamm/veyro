import {CalculationError,parseNumber} from './calculations.mjs';
import {TRANSPORT_IDS,TRANSPORT_LIMITS,VEHICLE_CATEGORIES,FEE_BASES} from './transport-contract.mjs';
const fail=(code,path,message)=>{throw new CalculationError(code,path,message);};
function obj(v,keys,path,strict){
  if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('invalid_input',path,'Oplysningerne skal have det forventede format.');
  for(const k of Reflect.ownKeys(v)){
    const d=Object.getOwnPropertyDescriptor(v,k);
    if(typeof k!=='string'||['__proto__','prototype','constructor'].includes(k)||d?.get||d?.set)fail('invalid_field',path,'Oplysningerne indeholder et ugyldigt felt.');
    if(strict&&!keys.includes(k))fail('unknown_field',path?`${path}.${k}`:k,'Feltet hører ikke til beregningen.');
  }return v;
}
function num(v,p,strict,min=0,max=1e9,positive=false){
  if(strict&&typeof v!=='number')fail('invalid_number',p,'Gemte tal skal være numeriske værdier.');
  let n;try{n=parseNumber(v);}catch(e){if(e instanceof CalculationError)e.path=p;throw e;}
  if((positive?n<=min:n<min)||n>max)fail('out_of_range',p,`Brug et tal ${positive?'større end':'på mindst'} ${min} og højst ${max}.`);
  return n;
}
function integer(v,p,s,min=1,max=1e6){const n=num(v,p,s,min,max);if(!Number.isInteger(n))fail('integer',p,'Brug et helt antal.');return n;}
function txt(v,p,optional=false){if(optional&&(v===undefined||v===null||v===''))return '';if(typeof v!=='string'||(!optional&&!v.trim())||v.trim().length>160||/[\u0000-\u001f\u007f]/.test(v))fail('invalid_text',p,'Brug tekst på højst 160 tegn.');return v.trim();}
function pick(v,choices,p){if(!choices.includes(v))fail('invalid_choice',p,'Vælg en af de viste muligheder.');return v;}
function list(v,p,max,min=1){if(!Array.isArray(v)||v.length<min||v.length>max)fail('row_count',p,`Brug ${min}–${max} rækker.`);for(let i=0;i<v.length;i++)if(!Object.hasOwn(v,i))fail('invalid_input',`${p}.${i}`,'Rækken mangler.');return v;}
function unique(rows,p){const seen=new Set();rows.forEach((r,i)=>{if(seen.has(r.id))fail('duplicate_id',`${p}.${i}.id`,'Rækkerne skal have forskellige ID’er.');seen.add(r.id);});return rows;}
function currency(v,p){const c=txt(v,p);if(!/^[A-Z]{3}$/.test(c))fail('currency',p,'Brug en valutakode med tre store bogstaver, fx DKK eller EUR.');return c;}
function exchange(v,c,p,s){const fx=num(v,p,s,0,1e6,true);if(c==='DKK'&&fx!==1)fail('currency_rate',p,'DKK til DKK skal have kurs 1.');return fx;}
function nullable(v,p,s,min=0,max=1e9){return v===undefined||v===null||(!s&&v==='')?null:num(v,p,s,min,max);}
// A disabled browser row may still contain an unfinished draft (such as "-").
// Keep usable values; canonicalize unfinished values to null without hiding
// malformed API payloads, which remain subject to strict numeric validation.
function inactiveNumber(v,p,s,min=0,max=1e9){
  if(s)return nullable(v,p,s,min,max);
  try{return nullable(v,p,false,min,max);}catch(error){if(error instanceof CalculationError)return null;throw error;}
}
export function parseCalendarDate(v,p='date'){
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v))fail('date',p,'Angiv dato og klokkeslæt. Brug samme lokale tidszone for begge tidspunkter.');
  const [y,m,d,h,minute]=v.match(/\d+/g).map(Number),t=Date.UTC(y,m-1,d,h,minute),date=new Date(t);
  if(y<1900||y>2200||date.getUTCFullYear()!==y||date.getUTCMonth()!==m-1||date.getUTCDate()!==d||date.getUTCHours()!==h||date.getUTCMinutes()!==minute)fail('date',p,'Datoen eller klokkeslættet er ikke gyldigt.');
  return t;
}
function fees(raw,tool,p,s){
  return unique(list(raw,p,TRANSPORT_LIMITS.fees,0).map((raw,i)=>{
    const q=`${p}.${i}`,keys=['id','name','enabled','kind','rate','currency','fx','basis','manualBase'];obj(raw,keys,q,s);
    const id=txt(raw.id,`${q}.id`),name=txt(raw.name,`${q}.name`,true);
    if(typeof raw.enabled!=='boolean')fail('boolean',`${q}.enabled`,'Vælg, om gebyret er aktiveret.');
    const kind=pick(raw.kind,['fixed','percent','unit'],`${q}.kind`);
    const allowed=kind==='percent'?(tool==='ladmeter'?['manual']:['base','manual']):kind==='unit'?[...FEE_BASES[tool],'manual']:[];
    const basis=kind==='fixed'?null:raw.enabled?pick(raw.basis,allowed,`${q}.basis`):(raw.basis===null||raw.basis===undefined||raw.basis===''?null:pick(raw.basis,allowed,`${q}.basis`));
    const linkedPercent=kind==='percent'&&basis==='base';
    const c=raw.enabled?currency(raw.currency,`${q}.currency`):raw.currency===null||raw.currency===undefined||raw.currency===''?null:currency(raw.currency,`${q}.currency`);
    const fx=raw.enabled?exchange(raw.fx,c,`${q}.fx`,s):inactiveNumber(raw.fx,`${q}.fx`,s,0,1e6);
    if(raw.enabled&&linkedPercent&&(c!=='DKK'||fx!==1))fail('percent_currency',`${q}.currency`,'Basisfragten er allerede i DKK. Brug DKK og kurs 1 for procent af basisfragt.');
    const rate=raw.enabled?num(raw.rate,`${q}.rate`,s,0,1e8):inactiveNumber(raw.rate,`${q}.rate`,s,0,1e8);
    const manualBase=basis==='manual'?(raw.enabled?num(raw.manualBase,`${q}.manualBase`,s,0,1e12):inactiveNumber(raw.manualBase,`${q}.manualBase`,s,0,1e12)):null;
    return {id,name,enabled:raw.enabled,kind,rate,currency:c,fx,basis,manualBase};
  }),p);
}
function cargo(raw,air,s){return unique(list(raw,'lines',TRANSPORT_LIMITS.lines).map((r,i)=>{
  const p=`lines.${i}`,keys=['id','name','length','width','dimensionUnit','quantity',...(air?['height','weightKg']:[])];obj(r,keys,p,s);
  return {id:txt(r.id,`${p}.id`),name:txt(r.name,`${p}.name`,true),length:num(r.length,`${p}.length`,s,0,1e6,true),width:num(r.width,`${p}.width`,s,0,1e6,true),dimensionUnit:pick(r.dimensionUnit,['m','cm','mm'],`${p}.dimensionUnit`),quantity:integer(r.quantity,`${p}.quantity`,s),...(air?{height:num(r.height,`${p}.height`,s,0,1e6,true),weightKg:num(r.weightKg,`${p}.weightKg`,s,0,1e8)}:{})};
}),'lines');}
/** Strict storage boundary and Danish form adapter share all validation and bounds. */
export function normalizeTransportInput(tool,raw,strict=false){
  if(!TRANSPORT_IDS.includes(tool))fail('unknown_tool','toolId','Vælg et understøttet transportværktøj.');
  const s=strict;
  if(tool==='ladmeter'){
    obj(raw,['deckWidthM','lines','fees'],'',s);
    return {deckWidthM:num(raw.deckWidthM,'deckWidthM',s,0,20,true),lines:cargo(raw.lines,false,s),fees:fees(raw.fees,tool,'fees',s)};
  }
  if(tool==='luftfragt'){
    obj(raw,['lines','volumeFactor','roundingKg','minimumFreight','currency','fx','breaks','fees'],'',s);
    const c=currency(raw.currency,'currency');
    const breaks=unique(list(raw.breaks,'breaks',TRANSPORT_LIMITS.breaks).map((b,i)=>{const p=`breaks.${i}`;obj(b,['id','fromKg','rate'],p,s);return {id:txt(b.id,`${p}.id`),fromKg:num(b.fromKg,`${p}.fromKg`,s,0,1e12),rate:num(b.rate,`${p}.rate`,s,0,1e8)};}),'breaks');
    breaks.forEach((b,i)=>{if((i===0&&b.fromKg!==0)||(i>0&&b.fromKg<=breaks[i-1].fromKg))fail('weight_breaks',`breaks.${i}.fromKg`,'Første vægttrin skal starte ved 0 kg. De næste grænser skal være forskellige og stigende.');});
    return {lines:cargo(raw.lines,true,s),volumeFactor:num(raw.volumeFactor,'volumeFactor',s,0,1e9,true),roundingKg:num(raw.roundingKg,'roundingKg',s,0,1e6),minimumFreight:nullable(raw.minimumFreight,'minimumFreight',s,0,1e12),currency:c,fx:exchange(raw.fx,c,'fx',s),breaks,fees:fees(raw.fees,tool,'fees',s)};
  }
  if(tool==='palletransport'){
    obj(raw,['pallets','weightPerPalletKg','dispatchAt','deadlineAt','offers'],'',s);
    const dispatchAt=txt(raw.dispatchAt,'dispatchAt'),deadlineAt=txt(raw.deadlineAt,'deadlineAt');
    const start=parseCalendarDate(dispatchAt,'dispatchAt'),end=parseCalendarDate(deadlineAt,'deadlineAt');
    if(end<start)fail('deadline','deadlineAt','Leveringsfristen skal være efter eller lig med afsendelsen.');
    const offers=unique(list(raw.offers,'offers',TRANSPORT_LIMITS.offers).map((r,i)=>{
      const p=`offers.${i}`;obj(r,['id','name','loadType','priceBasis','price','currency','fx','minDays','maxDays','fees'],p,s);
      const c=currency(r.currency,`${p}.currency`),minDays=num(r.minDays,`${p}.minDays`,s,0,3650),maxDays=num(r.maxDays,`${p}.maxDays`,s,0,3650);
      if(maxDays<minDays)fail('transit_interval',`${p}.maxDays`,'Den længste transporttid må ikke være kortere end den korteste.');
      return {id:txt(r.id,`${p}.id`),name:txt(r.name,`${p}.name`),loadType:pick(r.loadType,['LTL','FTL'],`${p}.loadType`),priceBasis:pick(r.priceBasis,['pallet','shipment'],`${p}.priceBasis`),price:num(r.price,`${p}.price`,s,0,1e12),currency:c,fx:exchange(r.fx,c,`${p}.fx`,s),minDays,maxDays,fees:fees(r.fees,tool,`${p}.fees`,s)};
    }),'offers');
    return {pallets:integer(raw.pallets,'pallets',s),weightPerPalletKg:num(raw.weightPerPalletKg,'weightPerPalletKg',s,0,1e8),dispatchAt,deadlineAt,offers};
  }
  if(tool==='containertransport'){
    obj(raw,['containers','valuePerContainer','valueCurrency','valueFx','annualRatePercent','offers'],'',s);const vc=currency(raw.valueCurrency,'valueCurrency');
    const offers=unique(list(raw.offers,'offers',TRANSPORT_LIMITS.offers).map((r,i)=>{
      const p=`offers.${i}`;obj(r,['id','name','freightPerContainer','currency','fx','transitDays','paymentDay','fees'],p,s);const c=currency(r.currency,`${p}.currency`);
      return {id:txt(r.id,`${p}.id`),name:txt(r.name,`${p}.name`),freightPerContainer:num(r.freightPerContainer,`${p}.freightPerContainer`,s,0,1e12),currency:c,fx:exchange(r.fx,c,`${p}.fx`,s),transitDays:num(r.transitDays,`${p}.transitDays`,s,0,3650),paymentDay:num(r.paymentDay,`${p}.paymentDay`,s,-3650,3650),fees:fees(r.fees,tool,`${p}.fees`,s)};
    }),'offers');
    return {containers:integer(raw.containers,'containers',s),valuePerContainer:num(raw.valuePerContainer,'valuePerContainer',s,0,1e12),valueCurrency:vc,valueFx:exchange(raw.valueFx,vc,'valueFx',s),annualRatePercent:num(raw.annualRatePercent,'annualRatePercent',s,0,1000),offers};
  }
  obj(raw,['annualKm','annualHours','fuelEfficiencyMode','fuelEfficiency','fuelPricePerLitre','currency','fx','costs','fees'],'',s);const c=currency(raw.currency,'currency');
  const costs=unique(list(raw.costs,'costs',VEHICLE_CATEGORIES.length,VEHICLE_CATEGORIES.length).map((r,i)=>{
    const p=`costs.${i}`;obj(r,['id','category','name','amount','period','currency','fx'],p,s);
    const category=pick(r.category,VEHICLE_CATEGORIES,`${p}.category`),period=pick(r.period,['month','year','km','hour',...(category==='social'?['salaryPercent']:[])],`${p}.period`),cc=currency(r.currency,`${p}.currency`),fx=exchange(r.fx,cc,`${p}.fx`,s);
    if(period==='salaryPercent'&&(cc!=='DKK'||fx!==1))fail('percent_currency',`${p}.currency`,'Løngrundlaget er allerede i DKK. Brug DKK og kurs 1.');
    return {id:txt(r.id,`${p}.id`),category,name:txt(r.name,`${p}.name`,true),amount:num(r.amount,`${p}.amount`,s,0,1e12),period,currency:cc,fx};
  }),'costs');
  if(new Set(costs.map(x=>x.category)).size!==VEHICLE_CATEGORIES.length)fail('cost_categories','costs','Udfyld én post for hver af leasing, løn, sociale omkostninger, vikar, vedligehold, forsikring og afgifter.');
  return {annualKm:num(raw.annualKm,'annualKm',s,0,1e9),annualHours:num(raw.annualHours,'annualHours',s,0,8784),fuelEfficiencyMode:pick(raw.fuelEfficiencyMode,['kmPerLitre','litresPer100Km'],'fuelEfficiencyMode'),fuelEfficiency:num(raw.fuelEfficiency,'fuelEfficiency',s,0,1e6,true),fuelPricePerLitre:num(raw.fuelPricePerLitre,'fuelPricePerLitre',s,0,1e6),currency:c,fx:exchange(raw.fx,c,'fx',s),costs,fees:fees(raw.fees,tool,'fees',s)};
}
/** Shared fee normalizer for isolated fee calculations and workbook verification. */
export function normalizeTransportFees(raw,tool,path='fees',strict=false){
  if(!TRANSPORT_IDS.includes(tool))fail('unknown_tool','toolId','Vælg et understøttet transportværktøj.');
  return fees(raw,tool,path,strict);
}
