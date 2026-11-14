import { useMemo } from 'react';
import { constructionMaterials, planExtraction, productionBoosts, manifoldMaterials, junctionBuildingNames, type ManifoldConstruction, type ExtractionOptions, type ExtractionPlan, type ExtractionRow } from './construction';
import { itemById } from './engine';
import type { ProductionPlan, ProductionRequest } from './production';
import type { MaterialRate } from './types';
import NumberInput from './NumberInput';
import './requirements.css';

const fmt = (n: number) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 4 }).format(n);
const itemName = (id: string) => itemById[id]?.name || id;
function Materials({ title, rows }: { title: string; rows: MaterialRate[] }) {
  return <div className="br-materials"><h4>{title}</h4>{rows.length ? <dl>{rows.map(row => <div key={row.itemId}><dt>{itemName(row.itemId)}</dt><dd>{fmt(row.rate)}</dd></div>)}</dl> : <p>No buildings needed.</p>}</div>;
}

type Props = { plan: ProductionPlan; request: ProductionRequest; extractionOptions?: ExtractionOptions; onExtractionChange?: (value: ExtractionOptions) => void; extractionPlan?: ExtractionPlan; disabled?: boolean; manifold?: ManifoldConstruction };
function ExtractionClocks({ row }: { row: ExtractionRow }) {
  if (row.clockGroups) return <>{row.clockGroups.map((group, index) => <small key={index}>{group.count} × {fmt(group.clock)}%{group.dutyCycle < 1 && ` · ${fmt(group.dutyCycle * 100)}% on-time`}</small>)}</>;
  return <><small>{row.fullMachines > 0 && <>{row.fullMachines} × {fmt(row.clock)}%<br/></>}{row.count > row.fullMachines && <>1 × {fmt(row.lastClock)}%</>}</small>{row.dutyCycle < 1 && <small>Final machine: {fmt(row.dutyCycle * 100)}% on-time</small>}</>;
}
export function ExtractionSettings({ value = {}, onChange, disabled = false }: { value?: ExtractionOptions; onChange: (value: ExtractionOptions) => void; disabled?: boolean }) {
  return <div className="br-settings">
    <label>Miner tier<select aria-label="Miner tier" disabled={disabled} value={value.minerTier ?? 1} onChange={event => onChange({ ...value, minerTier: Number(event.target.value) as 1 | 2 | 3 })}><option value={1}>Miner Mk.1</option><option value={2}>Miner Mk.2</option><option value={3}>Miner Mk.3</option></select></label>
    <label>Resource-node purity<select aria-label="Resource-node purity" disabled={disabled} value={value.purity ?? 'normal'} onChange={event => onChange({ ...value, purity: event.target.value as NonNullable<ExtractionOptions['purity']> })}><option value="impure">Impure · 0.5×</option><option value="normal">Normal · 1×</option><option value="pure">Pure · 2×</option></select></label>
    <label>Extractor max clock %<NumberInput disabled={disabled} aria-label="Extractor max clock percent" min={1} max={250} step={0.01} value={value.clock ?? 100} onValue={clock => onChange({ ...value, clock })}/></label>
  </div>;
}
export default function BuildRequirements({ plan, request, extractionOptions = {}, onExtractionChange, extractionPlan, disabled = false, manifold }: Props) {
  const { minerTier = 1, purity = 'normal', clock = 100 } = extractionOptions;
  const production = useMemo(() => constructionMaterials(plan), [plan]);
  const boosts = useMemo(() => productionBoosts(plan), [plan]);
  const junctionMaterials = useMemo(() => manifold ? manifoldMaterials(manifold) : [], [manifold]);
  const extraction = useMemo(() => {
    try { return { plan: extractionPlan || planExtraction(plan, request, { minerTier, purity, clock }), error: '' }; }
    catch (error) { return { plan: null, error: error instanceof Error ? error.message : 'Check the extraction settings.' }; }
  }, [plan, request, minerTier, purity, clock, extractionPlan]);
  const supply = extraction.plan;
  return <section className="build-requirements" aria-label="Construction materials and resource extraction">
    <header><h3>What to bring</h3><p>Exact building costs for this production schedule. Quantities below are inventory items, not rates per minute.</p></header>
    <div className="br-production"><Materials title={`${plan.totals.machines} production buildings`} rows={production}/><div className="br-boosts"><h4>Installed production boosts</h4><dl><div><dt>Power Shards</dt><dd>{fmt(boosts.powerShards)}</dd></div><div><dt>Somersloops</dt><dd>{fmt(boosts.somersloops)}</dd></div></dl><p>These are separate from construction ingredients and remain installed in the calculated machines.</p></div></div>
    {manifold && <><header><h3>Manifold components</h3><p>Splitters, mergers and pipeline junctions in the generated schematic. Production machines are already listed above.</p></header>{manifold.componentsComplete ? <div className="br-production"><div className="br-materials"><h4>Junctions to build</h4>{manifold.components.some(row => row.count > 0) ? <dl>{manifold.components.filter(row => row.count > 0).map(row => <div key={row.machineId}><dt>{junctionBuildingNames[row.machineId as keyof typeof junctionBuildingNames]}</dt><dd>{fmt(row.count)}</dd></div>)}</dl> : <p>No junctions needed in this schematic.</p>}</div><Materials title="Junction construction materials" rows={junctionMaterials}/></div> : <p className="br-unavailable">Manifold junction counts and materials are excluded from this bill. {manifold.message || 'A complete manifold schematic is required before its components can be counted.'}</p>}<p className="br-note">These counts cover the schematic’s machine manifolds and connecting junctions. Supply endpoints are factory inlets. Deliver the shown rate on each listed inlet belt or pipe. Miners and extractors are sized separately; their connections to these inlets, including any splitters, mergers and pipe junctions, are not shown or included in the junction bill. Belt and pipe lengths, supports, pumps, valves, foundations and power connections depend on placement and are not counted.</p></>}
    <header><h3>Resource extraction</h3><p>Size miners and extractors for the raw resources above. Each counted miner or oil extractor needs its own node of the selected purity. Existing supplied inputs are already available and are excluded.</p></header>
    {onExtractionChange && <ExtractionSettings value={extractionOptions} onChange={onExtractionChange} disabled={disabled}/>}
    <p className="br-note">Miner Mk.{minerTier} · {purity} nodes · max {fmt(clock)}% clock. Water has no purity. The chosen belt and pipe tiers cap each extractor’s output.</p>
    {extraction.error && <p role="alert" className="br-unavailable">{extraction.error}</p>}
    {supply && <>
      {supply.rows.length > 0 ? <div className="pp-table-scroll"><table className="br-table"><thead><tr><th>Resource / extractor</th><th>Supply</th><th>Build / clocks</th><th>Power</th><th>Shards</th></tr></thead><tbody>{supply.rows.map(row => <tr key={row.itemId}><td><strong>{itemName(row.itemId)}</strong><small>{row.name || 'Resource well'}</small></td><td>{fmt(row.rate)}<small>{itemById[row.itemId]?.form === 'solid' ? 'items/min' : 'm³/min'}</small></td>{row.supported ? <><td><strong>{row.count} total</strong><ExtractionClocks row={row}/>{row.clockLimited && <small>Limited by outgoing transport</small>}</td><td>{fmt(row.powerMW)} MW{row.dutyCycle < 1 && <small>{fmt(row.powerMaxMW)} MW while active</small>}</td><td>{row.powerShards}</td></> : <td colSpan={3} className="br-unavailable">{row.reason}</td>}</tr>)}</tbody></table></div> : <p className="br-note">This plan uses existing inputs and needs no additional raw-resource extraction.</p>}
      <div className="br-production"><Materials title={`${supply.count} ${supply.complete ? '' : 'modeled '}extraction buildings`} rows={supply.materials}/><div className="br-boosts"><h4>{supply.complete ? 'Extraction totals' : 'Partial extraction totals'}</h4><dl><div><dt>Installed Power Shards</dt><dd>{fmt(supply.powerShards)}</dd></div><div><dt>Extraction draw</dt><dd>{fmt(supply.powerMW)} MW</dd></div><div><dt>Production + extraction</dt><dd>{fmt(plan.totals.powerMW + supply.powerMW)} MW</dd></div><div><dt>Combined active peak</dt><dd>{fmt(plan.totals.powerMaxMW + supply.powerMaxMW)} MW</dd></div></dl>{!supply.complete && <p className="br-unavailable">Resource-well infrastructure is missing from these totals.</p>}<p>Check node availability in your save. Belts, pipes, pumps, foundations, power poles and their construction costs depend on the physical layout and are not included. {manifold ? 'Schematic junctions are counted separately in the manifold section.' : 'Splitter, merger and pipeline-junction costs require a complete manifold schematic.'}</p></div></div>
    </>}
  </section>;
}

