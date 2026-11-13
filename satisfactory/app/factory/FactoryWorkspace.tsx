import { useEffect, useState } from 'react';
import { Calculator, LayoutGrid } from 'lucide-react';
import type { AccountUser, Player } from '../data/types';
import FactoryPlanner from './FactoryPlanner';
import ProductionPlanner from './ProductionPlanner';
import './production.css';

export default function FactoryWorkspace(props: { user: AccountUser; players: Player[]; onSignIn: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [mode, setMode] = useState<'production' | 'layout'>('production');
  const [layoutVisited, setLayoutVisited] = useState(false);
  const [productionDirty, setProductionDirty] = useState(false), [layoutDirty, setLayoutDirty] = useState(false);
  useEffect(() => { props.onDirtyChange?.(productionDirty || layoutDirty); }, [productionDirty, layoutDirty, props.onDirtyChange]);
  return <div className="factory-workspace"><nav className="production-mode" aria-label="Factory workspace"><button aria-pressed={mode === 'production'} onClick={() => setMode('production')}><Calculator size={17}/>Production calculator & templates</button><button aria-pressed={mode === 'layout'} onClick={() => { setLayoutVisited(true); setMode('layout'); }}><LayoutGrid size={17}/>Manual factory layout{layoutDirty && <span aria-label="Unsaved layout"> •</span>}</button></nav><div hidden={mode !== 'production'}><ProductionPlanner user={props.user} onSignIn={props.onSignIn} onDirtyChange={setProductionDirty}/></div>{layoutVisited && <div hidden={mode !== 'layout'}><FactoryPlanner {...props} onDirtyChange={setLayoutDirty}/></div>}</div>;
}
