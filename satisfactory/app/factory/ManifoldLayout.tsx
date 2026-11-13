import { useState } from 'react';
import { GitFork, Minus, Plus } from 'lucide-react';
import { itemById, machineById, recipeById } from './engine';
import { buildManifolds } from './manifolds';
import { buildManifoldGuide } from './manifold-guide';
import './manifolds.css';

type Layout = ReturnType<typeof buildManifolds>;
type Rail = Layout['rails'][number];
const fmt = (n: number) => n !== 0 && Math.abs(n) < .001 ? n.toExponential(2) : new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 }).format(n);
const itemName = (id: string) => itemById[id]?.name || id;
const unit = (id: string) => itemById[id]?.form === 'solid' ? 'items/min' : 'm³/min';
const kindName = (kind: string) => kind === 'pipe-junction' ? 'Pipe junction' : kind === 'splitter' ? 'Splitter' : 'Merger';

function Junction({ kind, x, y }: { kind: string; x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`} className={`mf-junction ${kind}`}><rect x="-10" y="-10" width="20" height="20" rx={kind === 'pipe-junction' ? 10 : 3}/><text y="3" textAnchor="middle">{kind === 'splitter' ? 'S' : kind === 'merger' ? 'M' : 'J'}</text></g>;
}

function RecipeManifold({ layout, recipeId, open }: { layout: Layout; recipeId: string; open: boolean }) {
  const [zoom, setZoom] = useState(1);
  const machines = layout.machines.filter(m => m.recipeId === recipeId);
  const inputs = layout.rails.filter(r => r.recipeId === recipeId && r.direction === 'input');
  const outputs = layout.rails.filter(r => r.recipeId === recipeId && r.direction === 'output');
  const allRails = [...inputs, ...outputs];
  const arrowId = `manifold-arrow-${recipeId}`;
  const machineY = 80 + inputs.length * 56;
  const width = Math.max(700, 225 + machines.length * 175), height = machineY + 145 + outputs.length * 56;
  const xOf = (id: string) => 210 + machines.findIndex(m => m.id === id) * 175;
  const railKind = (rail: Rail) => rail.transport === 'pipe' ? 'pipe-junction' : rail.direction === 'input' ? 'splitter' : 'merger';
  function renderRail(rail: Rail, index: number) {
    const input = rail.direction === 'input', color = rail.transport === 'pipe' ? '#79b5e2' : input ? '#f0b86f' : '#a2c4a5';
    const y = input ? 80 + index * 56 : machineY + 135 + index * 56;
    const portIndex = [...new Set((input ? inputs : outputs).map(r => r.itemId))].indexOf(rail.itemId);
    const points = rail.branches.map(branch => ({ branch, x: xOf(branch.machineId) + 30 + portIndex * 15 }));
    const first = points[0]?.x || 210, last = points.at(-1)?.x || first;
    return <g key={rail.id} className="mf-rail"><title>{`${rail.label}: ${itemName(rail.itemId)}, ${fmt(rail.totalRate)} ${unit(rail.itemId)}. ${rail.transport} Mk.${rail.tier}, capacity ${rail.capacity}/min.`}</title>
      <text x="16" y={y - 24} className="mf-rail-label">{rail.label} · {itemName(rail.itemId)}</text>
      <text x="16" y={y - 9} className="mf-rail-rate">{fmt(rail.totalRate)} {unit(rail.itemId)} · Mk.{rail.tier}</text>
      <path d={`M${input ? 155 : first} ${y}H${input ? last : width - 20}`} stroke={color} fill="none" strokeWidth="3" markerEnd={`url(#${arrowId})`}/>
      {points.map(({ branch, x }, branchIndex) => <g key={branch.id}><title>{`${input ? `${rail.label} → ${machines.find(m => m.id === branch.machineId)?.label}` : `${machines.find(m => m.id === branch.machineId)?.label} → ${rail.label}`}: ${fmt(branch.rate)} ${unit(rail.itemId)}${branch.junctionId ? `; ${kindName(railKind(rail))}` : '; direct endpoint'}`}</title><path d={`M${x} ${input ? y : machineY + 88}V${input ? machineY : y}`} stroke={color} fill="none" strokeWidth="2" markerEnd={`url(#${arrowId})`}/>{branch.junctionId && <><Junction kind={railKind(rail)} x={x} y={y}/><text x={x - 16} y={y + (input ? -16 : 24)} className="mf-rate">{layout.junctions.find(j => j.id === branch.junctionId)?.label}</text></>}
        <text x={x + 13} y={input ? y + 15 : y - 9} className="mf-rate">{fmt(branch.rate)}</text>
        {branchIndex < points.length - 1 && <text x={(x + points[branchIndex + 1].x) / 2} y={y - 8} className="mf-rate mf-trunk-rate">{fmt(input ? points.slice(branchIndex + 1).reduce((sum, p) => sum + p.branch.rate, 0) : points.slice(0, branchIndex + 1).reduce((sum, p) => sum + p.branch.rate, 0))} →</text>}
      </g>)}
    </g>;
  }
  return <details className="mf-module" open={open}><summary><strong>{recipeById[recipeId]?.name || recipeId}</strong><span>{machines.length} machines · {allRails.length} manifold lines</span></summary>
    <div className="mf-module-toolbar"><span>Inputs above · collection below · flow left to right</span><div className="pp-actions"><button onClick={e => { const canvas = e.currentTarget.closest('.mf-module')?.querySelector('.mf-canvas'); if (canvas) setZoom(Math.max(.2, Math.min(1, canvas.clientWidth / width))); }}>Fit</button><button aria-label={`Zoom out ${recipeId} manifold`} onClick={() => setZoom(z => Math.max(.2, z - .2))}><Minus size={14}/></button><span>{Math.round(zoom * 100)}%</span><button aria-label={`Zoom in ${recipeId} manifold`} onClick={() => setZoom(z => Math.min(1.8, z + .2))}><Plus size={14}/></button></div></div>
    <div className="mf-canvas"><svg width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${recipeById[recipeId]?.name} manifold schematic. The branch schedule below contains every connection.`}>
      <defs><marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L10 5L0 10z" fill="#bcccd2"/></marker></defs>
      {inputs.map(renderRail)}{outputs.map(renderRail)}
      {machines.map(m => <g className="mf-machine" key={m.id} transform={`translate(${xOf(m.id)} ${machineY})`}><title>{`${m.label}: ${machineById[m.machineId]?.name}; ${fmt(m.clock)}% clock; ${m.sloops} Somersloops; ${fmt(m.dutyCycle * 100)}% duty`}</title><rect width="145" height="88" rx="6"/><text x="12" y="22" className="mf-machine-label">{m.label} · {machineById[m.machineId]?.name}</text><text x="12" y="43">{fmt(m.clock)}% clock</text><text x="12" y="62">{m.sloops} Somersloops</text>{m.dutyCycle < 1 && <text x="12" y="79">{fmt(m.dutyCycle * 100)}% duty</text>}</g>)}
    </svg></div>
    <details className="mf-branch-schedule"><summary>Branch schedule and line capacity</summary><div className="pp-table-scroll"><table><thead><tr><th>Line / material</th><th>Machine</th><th>Branch demand</th><th>Connection</th></tr></thead><tbody>{allRails.flatMap(rail => rail.branches.map(branch => <tr key={branch.id}><td>{rail.label} · {itemName(rail.itemId)}<small>{rail.direction} · {fmt(rail.totalRate)}/{rail.capacity} per minute · Mk.{rail.tier}{rail.peakRate > rail.totalRate * (1 + 1e-7) && ` · ${fmt(rail.peakRate)} peak reserved`}</small></td><td>{machines.find(m => m.id === branch.machineId)?.label}</td><td>{fmt(branch.rate)} {unit(rail.itemId)}</td><td>{branch.junctionId ? `${kindName(railKind(rail))} ${layout.junctions.find(j => j.id === branch.junctionId)?.label}` : 'Direct endpoint'}</td></tr>))}</tbody></table></div></details>
  </details>;
}

export function ManifoldInstructions({ layout }: { layout: Layout }) {
  const guide = buildManifoldGuide(layout);
  return <section className="mf-instructions"><h4>Build the manifolds</h4><p>{guide.overview}</p>{guide.rails.map(rail => <details key={rail.railId}><summary>{rail.title}</summary><p>{rail.summary}</p><ol>{rail.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></details>)}{guide.ready && <details><summary>Connect the module lines</summary><ol>{guide.connections.map(c => <li key={c.id}>{c.instruction}</li>)}</ol></details>}{guide.routing.filter(chain => chain.steps.length > 1).map(chain => <details key={chain.chainId}><summary>{chain.title}</summary><ol>{chain.steps.map((step, i) => <li key={i}>{step}</li>)}</ol></details>)}<h4>Fill and commission</h4><ul>{guide.startup.map((s, i) => <li key={i}>{s}</li>)}</ul>{guide.warnings.length > 0 && <ul className="pp-warnings">{guide.warnings.map((s, i) => <li key={i}>{s}</li>)}</ul>}</section>;
}

function RoutingChains({ layout }: { layout: Layout }) {
  const endpoint = (id: string) => layout.endpoints.find(e => e.id === id);
  return <div className="mf-routing-chains">{layout.routingChains.filter(chain => chain.junctions.length > 0).map(chain => {
    const split = chain.direction === 'split', fluid = itemById[chain.itemId]?.form !== 'solid';
    const kind = fluid ? 'pipe-junction' : split ? 'splitter' : 'merger';
    const arrowId = `route-arrow-${chain.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    const width = Math.max(640, 100 + chain.branches.length * 170), railY = split ? 55 : 140, boxY = split ? 120 : 20;
    return <details className="mf-module" key={chain.id}><summary><strong>{kindName(kind)} chain</strong><span>{endpoint(chain.endpointId)?.label} · {fmt(chain.totalRate)} {unit(chain.itemId)}</span></summary><div className="mf-canvas"><svg role="img" aria-label={`${kindName(kind)} chain at ${endpoint(chain.endpointId)?.label}`} width={width} height="205" viewBox={`0 0 ${width} 205`}><defs><marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a8c3ce"/></marker></defs><path d={`M${split ? 20 : 95} ${railY}H${split ? 95 + (chain.branches.length - 1) * 170 : width - 20}`} fill="none" stroke="#8bafbe" strokeWidth="3" markerEnd={`url(#${arrowId})`}/>{chain.branches.map((branch, index) => {
      const connection = layout.connections.find(c => c.id === branch.connectionId)!;
      const other = endpoint(split ? connection.to : connection.from), x = 95 + index * 170;
      const otherLabel = layout.rails.find(r => r.id === other?.railId)?.label || other?.label || '';
      return <g key={branch.connectionId}><title>{`${split ? 'To' : 'From'} ${other?.label}: ${fmt(branch.rate)} ${unit(chain.itemId)}`}</title><path d={`M${x} ${split ? railY : boxY + 45}V${split ? boxY : railY}`} fill="none" stroke="#8bafbe" strokeWidth="2" markerEnd={`url(#${arrowId})`}/>{branch.junctionId && <><Junction kind={kind} x={x} y={railY}/><text x={x + 15} y={railY + (split ? -8 : 18)}>{layout.junctions.find(j => j.id === branch.junctionId)?.label}</text></>}<rect x={x - 66} y={boxY} width="132" height="45" rx="4" fill="#263c47" stroke="#5b7a8a"/><text x={x} y={boxY + 17} textAnchor="middle">{otherLabel.length > 23 ? otherLabel.slice(0, 21) + '…' : otherLabel}</text><text x={x} y={boxY + 33} textAnchor="middle">{fmt(branch.rate)} {unit(chain.itemId)}</text></g>;
    })}</svg></div></details>;
  })}</div>;
}

export default function ManifoldLayout({ layout, expanded, onExpand }: { layout: Layout; expanded?: boolean; onExpand?: () => void }) {
  const recipeIds = [...new Set(layout.machines.map(m => m.recipeId))];
  const endpoint = (id: string) => layout.endpoints.find(e => e.id === id)?.label || id;
  return <section className="manifold-layout" aria-label="Factory manifold layout"><header className="mf-heading"><span className="pp-eyebrow">A BUILDABLE CONNECTION PLAN</span><h3><GitFork size={20}/> Manifold layout</h3>{onExpand && <button className="mf-expand" onClick={onExpand}>{expanded ? "Show calculation settings" : "Expand workspace"}</button>}<p>Place each recipe in a row. Run a separate input manifold for each ingredient, then collect each output on its own line. Matching line labels connect the modules below.</p></header>
    {layout.status !== 'ready' ? <div className="pp-alert" role="status">{layout.message}</div> : <>
      <div className="mf-totals">{layout.components.map(c => <div key={c.machineId}><strong>{c.count}</strong><span>{c.machineId.includes('Splitter') ? 'Splitters' : c.machineId.includes('Merger') ? 'Mergers' : 'Pipe junctions'}</span></div>)}<div><strong>{layout.rails.length}</strong><span>Manifold lines</span></div></div>
      <div className="mf-legend"><span><b className="splitter">S</b> Splitter</span><span><b className="merger">M</b> Merger</span><span><b className="pipe-junction">J</b> Pipe junction</span><span>Crossing lines connect only at a marked junction.</span></div>
      <p className="pp-footnote">One machine branch per junction; the last input and first output connect directly. Arrows show belt direction. Flow labels are steady-state demand, not splitter settings. Leave room for lifts, pipe crossings and access; this drawing is not to scale.</p>
      {recipeIds.map((recipeId, index) => <RecipeManifold key={recipeId} layout={layout} recipeId={recipeId} open={index < 2}/>)}
      <section className="mf-routing"><h4>Connect the module lines</h4><p>Run the matching material between these endpoints. At a source with several destinations, chain one splitter per extra branch; at a destination with several sources, chain one merger per extra feed. Use pipe junctions for fluids. These junctions are included in the component totals.</p><RoutingChains layout={layout}/><div className="pp-table-scroll"><table><thead><tr><th>From</th><th>To</th><th>Material / flow</th></tr></thead><tbody>{layout.connections.map(c => <tr key={c.id}><td>{endpoint(c.from)}</td><td>{endpoint(c.to)}</td><td>{itemName(c.itemId)}<small>{fmt(c.rate)} {unit(c.itemId)}</small></td></tr>)}</tbody></table></div></section>
    </>}
    {layout.warnings.length > 0 && <ul className="pp-warnings">{layout.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
  </section>;
}
