/** Examples transcribed from Skabeloner_til_distributionseksamen (1).xlsx.
 * Source cells and independent expected values: tests/fixtures/distribution-reference.json.
 * These are exercise inputs, not current quotes. Original optional fees stay off.
 * Always structuredClone a preset before editing it in the UI.
 */
export const TRANSPORT_REFERENCE_FILE = 'Skabeloner_til_distributionseksamen (1).xlsx';
export const TRANSPORT_REFERENCE_NOTES = {
  ladmeter: 'Fra Excel-arkets Ladmeter: ét kolli på 8 × 0,75 m og en ladbredde på 2,4 m.',
  luftfragt: 'Fra Excel-arkets Lufttransport: fem kartonner, seks vægttrin og minimumsfragt på 950 kr.',
  palletransport: 'Fra Excel-arkets Paller: fire tilbud og eksempeldatoer fra oktober 2026. Tilbuddene sammenlignes i kalenderdage.',
  containertransport: 'Fra Excel-arkets Container: to tilbud, 12 % årlig kapitalrente og betaling ved afsendelse.',
  biltransport: 'Fra Excel-arkets Bil: månedernes timer summeres til 1.586 timer og 55.510 km pr. år. Løn indeholder allerede sociale omkostninger, og forsikring indeholder allerede afgifter. De to særskilte ekstra felter er derfor sat til 0.',
};
const cost = (category, name, amount, period) => ({id:`excel-${category}`,category,name,amount,period,currency:'DKK',fx:1});
export const TRANSPORT_REFERENCE_SAMPLES = {
  // Ladmeter!D3:D8
  ladmeter: {
    deckWidthM:2.4,
    lines:[{id:'excel-gods',name:'Eksempel fra Excel',length:8,width:0.75,dimensionUnit:'m',quantity:1}],
    fees:[],
  },
  // Lufttransport!B2:B6, D4:E11, E3
  luftfragt: {
    lines:[{id:'excel-kartoner',name:'Kartonner fra Excel',quantity:5,weightKg:20,length:55,width:95,height:25,dimensionUnit:'cm'}],
    volumeFactor:6000,roundingKg:0,minimumFreight:950,currency:'DKK',fx:1,
    breaks:[[0,24],[100,22],[200,20],[300,18.5],[400,17.5],[600,16.25]].map(([fromKg,rate],i)=>({id:`excel-trin-${i}`,fromKg,rate})),
    fees:[],
  },
  // Paller!B4:B5, B9:B11, C15:F17, C22:F22, C28:F28
  palletransport: {
    pallets:20,weightPerPalletKg:950,dispatchAt:'2026-10-13T09:00',deadlineAt:'2026-10-16T10:00',
    offers:[
      {id:'excel-a',name:'Tilbud A · eksempel',loadType:'LTL',priceBasis:'pallet',price:380,currency:'DKK',fx:1,minDays:3,maxDays:4,fees:[]},
      {id:'excel-b',name:'Tilbud B · eksempel',loadType:'FTL',priceBasis:'shipment',price:8200,currency:'DKK',fx:1,minDays:2,maxDays:3,fees:[]},
      {id:'excel-c',name:'Tilbud C · eksempel',loadType:'LTL',priceBasis:'pallet',price:44,currency:'EUR',fx:7.45,minDays:2,maxDays:4,fees:[]},
      {id:'excel-d',name:'Tilbud D · eksempel',loadType:'FTL',priceBasis:'shipment',price:750,currency:'EUR',fx:7.45,minDays:3,maxDays:3,fees:[]},
    ],
  },
  // Container!B4:B9, C14:D14, C25:D29. Excel B5 is a fraction; the UI takes percent.
  containertransport: {
    containers:1,valuePerContainer:450000,valueCurrency:'DKK',valueFx:1,annualRatePercent:12,
    offers:[
      {id:'excel-a',name:'Tilbud A · eksempel',freightPerContainer:3850,currency:'USD',fx:6.61,transitDays:45,paymentDay:0,fees:[]},
      {id:'excel-b',name:'Tilbud B · eksempel',freightPerContainer:3240,currency:'USD',fx:6.61,transitDays:56,paymentDay:0,fees:[]},
    ],
  },
  // Bil!B18:B29 sum to 1586 hours. B8 = 35 km/hour. Costs: B5:B12.
  // Combined costs must not be duplicated; undefined B13:B14 do not enter the model.
  biltransport: {
    annualKm:55510,annualHours:1586,fuelEfficiencyMode:'kmPerLitre',fuelEfficiency:3.5,fuelPricePerLitre:12.5,currency:'DKK',fx:1,
    costs:[
      cost('leasing','Leasing',125000,'month'),
      cost('salary','Løn inkl. sociale omkostninger',330000,'year'),
      cost('social','Allerede med i løn',0,'year'),
      cost('substitute','Vikar',45000,'year'),
      cost('maintenance','Reparation og vedligehold',0.9,'km'),
      cost('insurance','Forsikring inkl. afgifter',2000,'month'),
      cost('tax','Allerede med i forsikring',0,'year'),
    ],
    fees:[],
  },
};
