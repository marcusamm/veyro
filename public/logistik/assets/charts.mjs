export const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n = (v, max=0) => new Intl.NumberFormat('da-DK', Math.abs(v) >= 1e6 ? {notation:'compact',maximumFractionDigits:1} : (v !== 0 && Math.abs(v) < 1 ? {maximumSignificantDigits:3} : {maximumFractionDigits:max})).format(v);
const colors = ['#163d3b','#b77d19','#6b8170'];
export function lineChart(points, series, {title='Omkostninger ved forskellige ordrestørrelser',xLabel='Ordrestørrelse · enheder',yLabel='Årlige omkostninger · kr.',marker=null}={}) {
  if (!points.length) return '';
  const w=680,h=310,p={l:72,r:22,t:25,b:52},pw=w-p.l-p.r,ph=h-p.t-p.b;
  const xmax=Math.max(...points.map(p=>p.quantity)),ymax=Math.max(1,...points.flatMap(p=>series.map(s=>p[s.key])))*1.08;
  const x=v=>p.l+v/xmax*pw, y=v=>p.t+ph-v/ymax*ph;
  return `<figure class="chart"><figcaption>${escape(title)}</figcaption><div class="chart-plot" tabindex="0" role="region" aria-label="Graf; rul vandret på små skærme"><svg role="img" aria-label="${escape(title)}. ${escape(xLabel)}. ${escape(yLabel)}." viewBox="0 0 ${w} ${h}">
  ${[0,.25,.5,.75,1].map(t=>`<line x1="${p.l}" x2="${w-p.r}" y1="${y(t*ymax)}" y2="${y(t*ymax)}" class="grid-line"/><text x="${p.l-10}" y="${y(t*ymax)+4}" text-anchor="end">${n(t*ymax)}</text><text x="${x(t*xmax)}" y="${h-28}" text-anchor="middle">${n(t*xmax)}</text>`).join('')}
  ${series.map((s,i)=>`<polyline fill="none" stroke="${s.color??colors[i]}" stroke-width="${i===0?3:2}" ${i===2?'stroke-dasharray="5 5"':''} points="${points.map(v=>`${x(v.quantity)},${y(v[s.key])}`).join(' ')}"/>`).join('')}
  ${marker?`<line x1="${x(marker)}" x2="${x(marker)}" y1="${p.t}" y2="${p.t+ph}" stroke="#b77d19" stroke-dasharray="3 5"/><text x="${x(marker)+6}" y="${p.t+12}" class="accent-text">EOQ</text>`:''}
  <text x="${p.l}" y="13">${escape(yLabel)}</text><text x="${w/2}" y="${h-4}" text-anchor="middle">${escape(xLabel)}</text></svg></div><div class="chart-legend">${series.map((s,i)=>`<span><i style="background:${s.color??colors[i]}"></i>${escape(s.label)}</span>`).join('')}</div></figure>`;
}
export function ropChart(r){
  const total=r.expectedDemand+r.safetyStock;
  return `<figure class="chart rop-chart"><figcaption>Det består genbestillingspunktet af</figcaption><div class="stock-bar ${total ? '' : 'zero'}" role="img" aria-label="Forventet forbrug ${n(r.expectedDemand,2)} enheder plus sikkerhedslager ${n(r.safetyStock,2)} enheder"><span style="flex:${total?r.expectedDemand/total:0}" class="expected"></span><span style="flex:${total?r.safetyStock/total:0}" class="buffer"></span></div><div class="chart-legend"><span><i style="background:#163d3b"></i>Forbrug i leveringstiden: ${n(r.expectedDemand,2)}</span><span><i style="background:#d6a94c"></i>Sikkerhedslager: ${n(r.safetyStock,2)}</span></div></figure>`;
}
export function paretoChart(r){
  if(!r.totalValue)return '<p class="muted">Grafen vises, når listen har en positiv samlet forbrugsværdi.</p>';
  const w=720,h=310,l=80,t=24,pw=590,ph=225,bw=pw/r.items.length;
  const max=Math.max(...r.items.map(i=>i.annualValue));const x=i=>l+(i+.5)*bw;
  return `<figure class="chart"><figcaption>Pareto · årlig forbrugsværdi</figcaption><div class="chart-plot" tabindex="0" role="region" aria-label="Pareto-graf; rul vandret på små skærme"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Varer sorteret efter faldende årlig forbrugsværdi. Søjler viser kroner; kurven viser kumuleret procent.">${[0,.5,1].map(f=>`<line x1="${l}" x2="670" y1="${t+ph-f*ph}" y2="${t+ph-f*ph}" class="grid-line"/><text x="${l-8}" y="${t+ph-f*ph+4}" text-anchor="end">${n(f*max)}</text><text x="680" y="${t+ph-f*ph+4}">${f*100}%</text>`).join('')}${r.items.map((v,i)=>`<rect x="${l+i*bw+1}" y="${t+ph-v.annualValue/max*ph}" width="${Math.max(.5,bw-2)}" height="${v.annualValue/max*ph}" fill="${v.class==='A'?'#163d3b':v.class==='B'?'#d6a94c':'#bcc6bb'}"><title>${escape(v.name)}: ${n(v.annualValue,2)} kr. · ${v.class}</title></rect>`).join('')}<polyline fill="none" stroke="#b76136" stroke-width="2.5" points="${r.items.map((v,i)=>`${x(i)},${t+ph-v.cumulativePercent/100*ph}`).join(' ')}"/><text x="${l}" y="13">Forbrugsværdi · kr.</text><text x="670" y="13" text-anchor="end">Kumuleret andel</text><text x="${l}" y="278">Vare 1</text><text x="670" y="278" text-anchor="end">Vare ${r.items.length}</text><text x="360" y="302" text-anchor="middle">Varer i faldende rækkefølge efter værdi</text></svg></div><div class="chart-legend"><span><i style="background:#163d3b"></i>A</span><span><i style="background:#d6a94c"></i>B</span><span><i style="background:#bcc6bb"></i>C</span><span><i style="background:#b76136"></i>Kumuleret andel</span></div></figure>`;
}
