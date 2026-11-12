import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Check, Copy, Download, Eye, Factory, Layers, Map, MapPin, Maximize2, Minus, Plug, Plus, RefreshCw, RotateCw, Save, Search, Settings2, ShieldCheck, Trash2, Unplug, X } from 'lucide-react';
import type { AccountUser, Player } from '../data/types';
import type { SavedWorldPlan, WorldConnection, WorldEntity, WorldMarker, WorldPlan, WorldPoint, WorldState } from './types';
import { createEmptyWorldPlan } from './types';
import { validateWorldPlan } from './validation';
import catalogData from '../factory/data/satisfactory-1.2.json';
import { WORLD_TERRAIN } from './terrain';
import './world.css';

type Props = { user: AccountUser; players: Player[]; onSignIn: () => void; onDirtyChange?: (dirty: boolean) => void; active?: boolean };
type Camera = { x: number; y: number; scale: number };
type Selection = { kind: 'actual' | 'planned'; id: string } | null;
type Drag = { id: number; startX: number; startY: number; camera: Camera; marker?: WorldMarker; changed: boolean };
type LayersState = { terrain: boolean; buildings: boolean; players: boolean; links: boolean; plans: boolean };
const fmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const format = (n: number) => fmt.format(n);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const recipes = catalogData.recipes;
const recipeName = (id?: string) => recipes.find(r => r.id === id)?.name || id || 'Not reported';
const normaliseRotation = (n: number) => (n % 360 + 360) % 360;
const sourceLabel = (e: WorldEntity) => e.name || e.className;
const displayTime = (date: string | null) => date ? new Date(date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Never';
const exportPlan = (data: WorldPlan, revision: number) => {
 const url = URL.createObjectURL(new Blob([JSON.stringify({ data, revision, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }));
 const a = document.createElement('a'); a.href = url; a.download = 'satisfactory-world-plan.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
 const response = await fetch(path, { method, cache: 'no-store', signal: AbortSignal.timeout(20000), headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
 const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
 if (!response.ok) throw Object.assign(new Error(typeof payload.error === 'string' ? payload.error : 'The server could not complete this request.'), { status: response.status });
 return payload as T;
}

function NumberField({ label, value, onChange, min, max, step = 1, disabled = false }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; step?: number; disabled?: boolean }) {
 const [draft, setDraft] = useState(String(value));
 useEffect(() => setDraft(String(value)), [value]);
 function commit() { const n = Number(draft); if (draft.trim() && Number.isFinite(n)) { const bounded = clamp(n, min, max); onChange(bounded); setDraft(String(bounded)); } else setDraft(String(value)); }
 return <label className="wm-field">{label}<input type="number" inputMode="decimal" value={draft} min={min} max={max} step={step} disabled={disabled} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} /></label>;
}

export default function WorldMap({ user, players, onSignIn, onDirtyChange, active = true }: Props) {
 const isAdmin = user.role === 'admin' && user.username === 'marcus';
 const [world, setWorld] = useState<WorldState>({ status: 'not_connected', configured: false, snapshot: null, lastReceivedAt: null });
 const [worldLoaded, setWorldLoaded] = useState(false), [worldError, setWorldError] = useState(''), [authError, setAuthError] = useState(false), [now, setNow] = useState(Date.now());
 const [plan, setPlan] = useState(createEmptyWorldPlan), [revision, setRevision] = useState(0), [loaded, setLoaded] = useState(false), [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false), [planError, setPlanError] = useState(''), [conflict, setConflict] = useState(false), [savedAt, setSavedAt] = useState<string | null>(null), [savedBy, setSavedBy] = useState<string | null>(null);
 const [connection, setConnection] = useState<WorldConnection | null>(null), [connectionError, setConnectionError] = useState(''), [connectionBusy, setConnectionBusy] = useState(false), [newToken, setNewToken] = useState(''), [tokenVisible, setTokenVisible] = useState(false), [notice, setNotice] = useState('');
 const [panel, setPanel] = useState<'inspect' | 'plan' | 'layers' | 'connect'>('inspect'), [selection, setSelection] = useState<Selection>(null), [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [floorEnabled, setFloorEnabled] = useState(false), [floor, setFloor] = useState(0), [floorRange, setFloorRange] = useState(16), [layers, setLayers] = useState<LayersState>({ terrain: true, buildings: true, players: true, links: true, plans: true });
 const [camera, setCamera] = useState<Camera>({ x: (WORLD_TERRAIN.minX + WORLD_TERRAIN.maxX) / 2, y: 0, scale: .0006 }), [size, setSize] = useState({ width: 800, height: 580 }), [measured, setMeasured] = useState(false), [tilesVersion, setTilesVersion] = useState(0), [terrainError, setTerrainError] = useState(false), [dragMarker, setDragMarker] = useState<WorldMarker | null>(null), [panning, setPanning] = useState(false), [confirm, setConfirm] = useState<'rotate' | 'revoke' | 'reload' | null>(null);
 const canvas = useRef<HTMLCanvasElement>(null), wrap = useRef<HTMLDivElement>(null), file = useRef<HTMLInputElement>(null), drag = useRef<Drag | null>(null), frame = useRef(0), initialFit = useRef(false), firstWorldFit = useRef<string | null>(null), initialPanel = useRef(false), terrainTiles = useRef<globalThis.Map<string, HTMLImageElement>>(new globalThis.Map()), mounted = useRef(true), worldInFlight = useRef(false), planInFlight = useRef(false), dirtyRef = useRef(false), savingRef = useRef(false), loadedRef = useRef(false), planGeneration = useRef(0), revisionRef = useRef(0), planRef = useRef(plan), worldRef = useRef(world), cameraRef = useRef(camera), draftRef = useRef<WorldMarker | null>(null), selectionRef = useRef(selection);
 planRef.current = plan; worldRef.current = world; cameraRef.current = camera; selectionRef.current = selection;
 const snapshot = world.snapshot;
 const selectedEntity = selection?.kind === 'actual' ? snapshot?.entities.find(e => e.id === selection.id) : undefined;
 const selectedMarker = selection?.kind === 'planned' ? plan.markers.find(m => m.id === selection.id) : undefined;
 const editable = loaded && !saving && (plan.worldId === null || !!snapshot && plan.worldId === snapshot.worldId);
 const age = world.lastReceivedAt ? Math.max(0, Math.floor((now - Date.parse(world.lastReceivedAt)) / 1000)) : null;
 const observedAge = snapshot ? Math.max(0, Math.floor((now - Date.parse(snapshot.observedAt)) / 1000)) : null;
 const state = !worldLoaded ? 'loading' : !world.configured ? 'not_connected' : !snapshot ? 'waiting' : worldError || age === null || age > 90 || observedAge === null || observedAge > 90 ? 'stale' : world.status;
 const stateLabels = { loading: 'Checking connection', not_connected: 'Not connected', waiting: 'Waiting for server', live: 'Live data', stale: 'Last known world' };
 const inFloor = useCallback((point: WorldPoint) => !floorEnabled || Math.abs(point.z / 100 - floor) <= floorRange / 2, [floorEnabled, floor, floorRange]);
 const visibleEntities = useMemo(() => (snapshot?.entities || []).filter(e => inFloor(e) && (e.kind === 'player' ? layers.players : layers.buildings) && (kind === 'all' || e.kind === kind)), [snapshot, inFloor, layers.players, layers.buildings, kind]);
 const searchResults = useMemo(() => visibleEntities.filter(e => `${e.name} ${e.className}`.toLowerCase().includes(query.toLowerCase())).slice(0, 80), [visibleEntities, query]);
 const mapMarkers = useMemo(() => layers.plans ? plan.markers.map(m => dragMarker?.id === m.id ? dragMarker : m).filter(inFloor) : [], [plan.markers, dragMarker, layers.plans, inFloor]);

 function reportError(error: unknown, fallback: string, setter: (s: string) => void) { if ((error as { status?: number })?.status === 401) { setAuthError(true); setter('Your session has ended. Sign in again to continue.'); } else setter(error instanceof Error ? error.message : fallback); }
 const loadWorld = useCallback(async () => {
  if (worldInFlight.current) return; worldInFlight.current = true;
  try { const data = await request<WorldState>('/api/world'); if (mounted.current) { setWorld(data); setWorldLoaded(true); setWorldError(''); setAuthError(false); } }
  catch (e) { if (mounted.current) reportError(e, 'Live updates could not be retrieved. The last received world is still shown.', setWorldError); }
  finally { worldInFlight.current = false; }
 }, []);
 const loadPlan = useCallback(async (force = false) => {
  if (planInFlight.current || savingRef.current || dirtyRef.current && !force || drag.current) return; planInFlight.current = true;
  const generation = planGeneration.current;
  try {
   const data = await request<SavedWorldPlan>('/api/world/plan');
   // A request can outlive an edit/save cycle even when the draft is clean again.
   if (!mounted.current || generation !== planGeneration.current || savingRef.current || drag.current || dirtyRef.current && !force || data.revision < revisionRef.current) return;
   planGeneration.current++; planRef.current = data.data; revisionRef.current = data.revision; loadedRef.current = true;
   setPlan(data.data); setRevision(data.revision); setSavedAt(data.updatedAt); setSavedBy(data.updatedBy); setLoaded(true); setPlanError(''); setConflict(false); dirtyRef.current = false; setDirty(false); if (force) setSelection(null);
  }
  catch (e) { if (mounted.current) reportError(e, 'Your planned layer could not be loaded.', setPlanError); }
  finally { planInFlight.current = false; }
 }, []);
 const loadConnection = useCallback(async () => { if (!isAdmin) return; try { const data = await request<WorldConnection>('/api/world/connection'); if (mounted.current) { setConnection(data); setConnectionError(''); } } catch (e) { if (mounted.current) reportError(e, 'Connection settings are unavailable.', setConnectionError); } }, [isAdmin]);
 useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelAnimationFrame(frame.current); }; }, []);
 useEffect(() => {
  if (!active) { setNewToken(''); setTokenVisible(false); return; }
  const refresh = () => { if (document.visibilityState === 'visible') { void loadWorld(); void loadPlan(); } };
  refresh(); void loadConnection();
  const worldTimer = setInterval(() => { if (document.visibilityState === 'visible') void loadWorld(); }, 15000), planTimer = setInterval(() => { if (document.visibilityState === 'visible') void loadPlan(); }, 30000), clock = setInterval(() => setNow(Date.now()), 5000);
  document.addEventListener('visibilitychange', refresh);
  return () => { clearInterval(worldTimer); clearInterval(planTimer); clearInterval(clock); document.removeEventListener('visibilitychange', refresh); };
 }, [active, loadWorld, loadPlan, loadConnection]);
 useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
 useEffect(() => { if (worldLoaded && !initialPanel.current) { initialPanel.current = true; setPanel(snapshot ? 'inspect' : 'connect'); } }, [worldLoaded, snapshot]);
 useEffect(() => {
  let cancelled = false;
  for (let x = 0; x < WORLD_TERRAIN.tilesAcross; x++) for (let y = 0; y < WORLD_TERRAIN.tilesAcross; y++) {
   const key = `${x}/${y}`; if (terrainTiles.current.has(key)) continue;
   const image = new Image(); terrainTiles.current.set(key, image);
   image.onload = () => { if (!cancelled) setTilesVersion(v => v + 1); };
   image.onerror = () => { if (!cancelled) setTerrainError(true); };
   image.src = WORLD_TERRAIN.tileUrl(x, y);
  }
  return () => { cancelled = true; };
 }, []);
 useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, []);
 useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timeout); }, [notice]);
 useEffect(() => {
  if (!wrap.current) return;
  const observer = new ResizeObserver(entries => { const rect = entries[0]?.contentRect; if (rect?.width && rect.height) { setSize({ width: rect.width, height: rect.height }); setMeasured(true); } });
  observer.observe(wrap.current); return () => observer.disconnect();
 }, [worldLoaded, !!snapshot]);

 function change(fn: (data: WorldPlan) => void) {
  const currentSnapshot = worldRef.current.snapshot, currentPlan = planRef.current;
  if (!loadedRef.current || savingRef.current || currentPlan.worldId !== null && currentPlan.worldId !== currentSnapshot?.worldId) return false;
  const next = structuredClone(currentPlan); if (!next.worldId && currentSnapshot) next.worldId = currentSnapshot.worldId; fn(next);
  planGeneration.current++; planRef.current = next; setPlan(next); dirtyRef.current = true; setDirty(true); setPlanError('');
  return true;
 }
 function patchMarker(patch: Partial<WorldMarker>) { if (selectedMarker) change(data => { const marker = data.markers.find(m => m.id === selectedMarker.id); if (marker) Object.assign(marker, patch); }); }
 async function save() {
  if (!dirtyRef.current || savingRef.current || conflict || !loaded) return;
  const currentSnapshot = worldRef.current.snapshot;
  if (planRef.current.worldId !== null && planRef.current.worldId !== currentSnapshot?.worldId) { setPlanError('This planned layer belongs to a different world. Export it before loading the connected world’s plan.'); return; }
  // Plans made before a server exists are bound only when the user edits or saves.
  const submitted = { ...planRef.current, worldId: planRef.current.worldId ?? currentSnapshot?.worldId ?? null }, generation = planGeneration.current;
  savingRef.current = true; setSaving(true); setPlanError('');
  try {
   const data = await request<SavedWorldPlan>('/api/world/plan', 'PUT', { data: submitted, revision: revisionRef.current });
   if (mounted.current) {
    revisionRef.current = data.revision; setRevision(data.revision); setSavedAt(data.updatedAt); setSavedBy(data.updatedBy);
    if (generation === planGeneration.current) { planGeneration.current++; planRef.current = data.data; setPlan(data.data); dirtyRef.current = false; setDirty(false); setNotice('Planned layer saved for everyone.'); }
    else setNotice('The submitted plan was saved. Your newer local changes are still unsaved.');
   }
  }
  catch (e) { if (mounted.current) { if ((e as { status?: number })?.status === 409) setConflict(true); reportError(e, 'Your changes have not been saved. Export your draft or retry.', setPlanError); } }
  finally { savingRef.current = false; if (mounted.current) setSaving(false); }
 }
 async function setup(action: 'rotate' | 'revoke') {
  if (!isAdmin || connectionBusy) return; setConnectionBusy(true); setConnectionError(''); setNewToken(''); setTokenVisible(false);
  try {
   if (action === 'rotate') { const data = await request<{ token: string }>('/api/world/connection', 'POST', {}); setNewToken(data.token); setNotice('Connection key created. Copy it into the bridge configuration.'); }
   else { await request('/api/world/connection', 'DELETE'); setNotice('Server updates disconnected. Your map and plans are retained.'); }
   await loadConnection(); await loadWorld();
  } catch (e) { reportError(e, 'The connection could not be updated.', setConnectionError); }
  finally { setConnectionBusy(false); setConfirm(null); }
 }
 async function copyToken() { try { await navigator.clipboard.writeText(newToken); setNotice('Connection key copied.'); } catch { setTokenVisible(true); setNotice('Clipboard unavailable. Select and copy the key manually.'); } }
 function addMarker(markerKind: WorldMarker['kind']) {
  if (!editable || plan.markers.length >= 2000) return;
  const recipe = recipes.find(r => r.name === 'Iron Ingot' && !r.alternate) || recipes[0];
  const marker: WorldMarker = { id: crypto.randomUUID(), kind: markerKind, label: markerKind === 'note' ? 'New note' : markerKind === 'area' ? 'Planned area' : recipe.name, x: Math.round(camera.x / 100) * 100, y: Math.round(camera.y / 100) * 100, z: floorEnabled ? Math.round(floor * 100) : selectedEntity?.z || 0, rotation: 0, ...(markerKind === 'area' ? { width: 3200, height: 3200 } : markerKind === 'machine' ? { recipeId: recipe.id, clockPercent: 100 } : {}) };
  change(data => data.markers.push(marker)); setSelection({ kind: 'planned', id: marker.id }); setPanel('inspect'); setLayers(value => ({ ...value, plans: true }));
 }
 async function importPlan(selectedFile: File) {
  if (!editable || savingRef.current) return;
  const generation = planGeneration.current;
  try {
   if (selectedFile.size > 1_000_000) throw Error('Choose a planned-layer export smaller than 1 MB.');
   const raw = JSON.parse(await selectedFile.text()), data = validateWorldPlan(raw.data ?? raw);
   if (!mounted.current) return;
   if (savingRef.current || generation !== planGeneration.current) throw Error('The planned layer changed while the file was being read. Import the file again after saving or editing.');
   const currentSnapshot = worldRef.current.snapshot;
   if (data.worldId !== null && data.worldId !== currentSnapshot?.worldId) throw Error('This plan belongs to another world. Import a plan for the connected world.');
   if (dirtyRef.current && !window.confirm('Replace your unsaved planned layer? Export it first if you need a copy.')) return;
   if (change(draft => { draft.markers = data.markers; draft.worldId = currentSnapshot?.worldId || null; })) { setSelection(null); setNotice('Plan imported into your draft. Save to share it.'); }
  } catch (e) { setPlanError(e instanceof Error ? e.message : 'The planned layer could not be imported.'); }
 }
 function fit() {
  const points = [...visibleEntities, ...mapMarkers];
  if (!points.length) { setCamera({ x: (WORLD_TERRAIN.minX + WORLD_TERRAIN.maxX) / 2, y: (WORLD_TERRAIN.minY + WORLD_TERRAIN.maxY) / 2, scale: Math.min((size.width - 30) / (WORLD_TERRAIN.maxX - WORLD_TERRAIN.minX), (size.height - 30) / (WORLD_TERRAIN.maxY - WORLD_TERRAIN.minY)) }); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  points.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
  mapMarkers.filter(marker => marker.kind === 'area').forEach(marker => {
   const angle = marker.rotation * Math.PI / 180, halfWidth = (marker.width || 800) / 2, halfHeight = (marker.height || 800) / 2;
   const extentX = Math.abs(Math.cos(angle)) * halfWidth + Math.abs(Math.sin(angle)) * halfHeight, extentY = Math.abs(Math.sin(angle)) * halfWidth + Math.abs(Math.cos(angle)) * halfHeight;
   minX = Math.min(minX, marker.x - extentX); maxX = Math.max(maxX, marker.x + extentX); minY = Math.min(minY, marker.y - extentY); maxY = Math.max(maxY, marker.y + extentY);
  });
  setCamera({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale: clamp(Math.min((size.width - 70) / Math.max(8000, maxX - minX), (size.height - 70) / Math.max(8000, maxY - minY)), .00005, .2) });
 }
 useEffect(() => { if (!measured || !loaded || !worldLoaded) return; if (!initialFit.current || snapshot && firstWorldFit.current !== snapshot.worldId) { initialFit.current = true; if (snapshot) firstWorldFit.current = snapshot.worldId; fit(); } }, [snapshot, size.width, size.height, measured, loaded, worldLoaded, visibleEntities]);
 function focusPoint(point: WorldPoint) { setCamera(c => ({ ...c, x: point.x, y: point.y, scale: Math.max(c.scale, .035) })); }
 function toScreen(point: WorldPoint, view = camera) { return { x: (point.x - view.x) * view.scale + size.width / 2, y: (point.y - view.y) * view.scale + size.height / 2 }; }
 function localPoint(e: PointerEvent<HTMLCanvasElement>) { const rect = e.currentTarget.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top }; }
 function hitTest(point: { x: number; y: number }): Selection {
  for (let i = mapMarkers.length - 1; i >= 0; i--) { const m = mapMarkers[i], p = toScreen(m), dx = point.x - p.x, dy = point.y - p.y; if (Math.hypot(dx, dy) < 16) return { kind: 'planned', id: m.id }; }
  let closest: WorldEntity | undefined, distance = 14;
  visibleEntities.forEach(e => { const p = toScreen(e), d = Math.hypot(point.x - p.x, point.y - p.y); if (d < distance) { closest = e; distance = d; } });
  return closest ? { kind: 'actual', id: closest.id } : null;
 }
 function pointerDown(e: PointerEvent<HTMLCanvasElement>) {
  if (e.button !== 0 || drag.current) return;
  e.currentTarget.focus(); const p = localPoint(e), hit = hitTest(p); setSelection(hit); if (hit) setPanel('inspect');
  const marker = hit?.kind === 'planned' && editable ? plan.markers.find(m => m.id === hit.id) : undefined;
  drag.current = { id: e.pointerId, startX: p.x, startY: p.y, camera: cameraRef.current, marker, changed: false }; e.currentTarget.setPointerCapture(e.pointerId); setPanning(!hit);
 }
 function pointerMove(e: PointerEvent<HTMLCanvasElement>) {
  const current = drag.current; if (!current || current.id !== e.pointerId) return;
  const p = localPoint(e), dx = p.x - current.startX, dy = p.y - current.startY; if (Math.hypot(dx, dy) > 3) current.changed = true;
  if (!current.changed) return;
  const next = current.marker ? { ...current.marker, x: clamp(Math.round((current.marker.x + dx / current.camera.scale) / 100) * 100, -2_000_000, 2_000_000), y: clamp(Math.round((current.marker.y + dy / current.camera.scale) / 100) * 100, -2_000_000, 2_000_000) } : null;
  draftRef.current = next; cancelAnimationFrame(frame.current);
  frame.current = requestAnimationFrame(() => { if (next) setDragMarker(next); else setCamera({ ...current.camera, x: current.camera.x - dx / current.camera.scale, y: current.camera.y - dy / current.camera.scale }); });
 }
 function pointerUp(e: PointerEvent<HTMLCanvasElement>, cancelled = false) {
  const current = drag.current; if (!current || current.id !== e.pointerId) return; cancelAnimationFrame(frame.current);
  const next = draftRef.current;
  if (!cancelled && current.changed && current.marker && next) change(data => { const at = data.markers.findIndex(m => m.id === next.id); if (at !== -1) data.markers[at] = next; });
  draftRef.current = null; setDragMarker(null); drag.current = null; setPanning(false); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
 }
 function mapKey(e: KeyboardEvent<HTMLCanvasElement>) {
  if (e.key === 'Escape') { setSelection(null); return; }
  if (e.key === '+' || e.key === '=') { e.preventDefault(); setCamera(c => ({ ...c, scale: clamp(c.scale * 1.4, .00005, .2) })); return; }
  if (e.key === '-') { e.preventDefault(); setCamera(c => ({ ...c, scale: clamp(c.scale / 1.4, .00005, .2) })); return; }
  if (selectedMarker && editable) {
   const amount = e.shiftKey ? 100 : 800;
   if (e.key.startsWith('Arrow')) { e.preventDefault(); patchMarker({ x: clamp(selectedMarker.x + (e.key === 'ArrowRight' ? amount : e.key === 'ArrowLeft' ? -amount : 0), -2_000_000, 2_000_000), y: clamp(selectedMarker.y + (e.key === 'ArrowDown' ? amount : e.key === 'ArrowUp' ? -amount : 0), -2_000_000, 2_000_000) }); }
   if (e.key.toLowerCase() === 'r') { e.preventDefault(); patchMarker({ rotation: normaliseRotation(selectedMarker.rotation + 15) }); }
  } else if (e.key.startsWith('Arrow')) { e.preventDefault(); setCamera(c => ({ ...c, x: c.x + (e.key === 'ArrowRight' ? 80 : e.key === 'ArrowLeft' ? -80 : 0) / c.scale, y: c.y + (e.key === 'ArrowDown' ? 80 : e.key === 'ArrowUp' ? -80 : 0) / c.scale })); }
 }

 useEffect(() => {
  if (!active || !canvas.current) return;
  const element = canvas.current, context = element.getContext('2d'); if (!context) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2); element.width = size.width * dpr; element.height = size.height * dpr; context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = '#111d24'; context.fillRect(0, 0, size.width, size.height);
  if (layers.terrain) {
   const tileWidth = (WORLD_TERRAIN.maxX - WORLD_TERRAIN.minX) / WORLD_TERRAIN.tilesAcross, tileHeight = (WORLD_TERRAIN.maxY - WORLD_TERRAIN.minY) / WORLD_TERRAIN.tilesAcross;
   // These tiles describe the island, not building-scale terrain detail.
   context.globalAlpha = .72 - .6 * clamp((camera.scale - .0015) / .0185, 0, 1);
   for (let x = 0; x < WORLD_TERRAIN.tilesAcross; x++) for (let y = 0; y < WORLD_TERRAIN.tilesAcross; y++) {
    const image = terrainTiles.current.get(`${x}/${y}`); if (!image?.complete || !image.naturalWidth) continue;
    context.drawImage(image, (WORLD_TERRAIN.minX + x * tileWidth - camera.x) * camera.scale + size.width / 2, (WORLD_TERRAIN.minY + y * tileHeight - camera.y) * camera.scale + size.height / 2, tileWidth * camera.scale, tileHeight * camera.scale);
   }
   context.globalAlpha = 1;
  }
  const screen = (point: { x: number; y: number }) => ({ x: (point.x - camera.x) * camera.scale + size.width / 2, y: (point.y - camera.y) * camera.scale + size.height / 2 });
  const left = camera.x - size.width / (2 * camera.scale), top = camera.y - size.height / (2 * camera.scale), right = camera.x + size.width / (2 * camera.scale), bottom = camera.y + size.height / (2 * camera.scale);
  let grid = 800; while (grid * camera.scale < 25) grid *= 10;
  context.lineWidth = 1; context.strokeStyle = '#b4c7d610'; context.beginPath();
  for (let x = Math.ceil(left / grid) * grid; x < right; x += grid) { const sx = screen({ x, y: 0 }).x; context.moveTo(sx, 0); context.lineTo(sx, size.height); }
  for (let y = Math.ceil(top / grid) * grid; y < bottom; y += grid) { const sy = screen({ x: 0, y }).y; context.moveTo(0, sy); context.lineTo(size.width, sy); }
  context.stroke();
  if (layers.links) for (const link of snapshot?.links || []) {
   if (floorEnabled && !link.points.some(inFloor)) continue;
   if (!link.points.some(p => p.x >= left && p.x <= right && p.y >= top && p.y <= bottom) && !link.points.some((p, i) => { const q = link.points[i + 1]; return q && Math.max(p.x, q.x) >= left && Math.min(p.x, q.x) <= right && Math.max(p.y, q.y) >= top && Math.min(p.y, q.y) <= bottom; })) continue;
   context.strokeStyle = link.kind === 'pipe' ? '#5fa5b9a0' : link.kind === 'rail' ? '#a0a5b1a0' : '#b78345b0'; context.lineWidth = link.kind === 'rail' ? 2 : 1.5; context.beginPath(); link.points.forEach((p, i) => { const s = screen(p); if (i === 0) context.moveTo(s.x, s.y); else context.lineTo(s.x, s.y); }); context.stroke();
  }
  for (const entity of visibleEntities) {
   const p = screen(entity); if (p.x < -30 || p.y < -30 || p.x > size.width + 30 || p.y > size.height + 30) continue;
   const selected = selection?.kind === 'actual' && selection.id === entity.id, radius = entity.kind === 'player' ? 5 : camera.scale < .002 ? 2 : 5;
   context.save(); context.translate(p.x, p.y); context.rotate(entity.yaw * Math.PI / 180);
   context.fillStyle = entity.kind === 'player' ? entity.online === true ? '#8bd7c6' : '#7b8e97' : entity.producing === false ? '#b48b69' : '#b7c3cb'; context.strokeStyle = selected ? '#ffffff' : '#111d24'; context.lineWidth = selected ? 2 : 1;
   if (entity.kind === 'player') { context.beginPath(); context.moveTo(0, -radius - 3); context.lineTo(radius + 1, radius); context.lineTo(-radius - 1, radius); context.closePath(); context.fill(); context.stroke(); }
   else { context.fillRect(-radius, -radius, radius * 2, radius * 2); context.strokeRect(-radius, -radius, radius * 2, radius * 2); }
   context.restore();
   if (selected || entity.kind === 'player' && camera.scale > .008) { context.font = '11px Arial'; context.textAlign = 'center'; const text = sourceLabel(entity).slice(0, 50); context.lineWidth = 4; context.strokeStyle = '#111d24'; context.strokeText(text, p.x, p.y - 15); context.fillStyle = '#f4f4ec'; context.fillText(text, p.x, p.y - 15); }
  }
  for (const marker of mapMarkers) {
   const p = screen(marker), selected = selection?.kind === 'planned' && selection.id === marker.id;
   context.save(); context.translate(p.x, p.y); context.rotate(marker.rotation * Math.PI / 180); context.strokeStyle = selected ? '#ffe0a7' : '#f4a84c'; context.fillStyle = '#f4a84c24'; context.lineWidth = selected ? 2 : 1.5; context.setLineDash([5, 4]);
   if (marker.kind === 'area') { const width = (marker.width || 800) * camera.scale, height = (marker.height || 800) * camera.scale; context.fillRect(-width / 2, -height / 2, width, height); context.strokeRect(-width / 2, -height / 2, width, height); }
   context.setLineDash([]); context.beginPath(); context.arc(0, 0, marker.kind === 'machine' ? 8 : 6, 0, Math.PI * 2); context.fillStyle = '#19252d'; context.fill(); context.stroke(); context.beginPath(); context.moveTo(-3, 0); context.lineTo(3, 0); context.moveTo(0, -3); context.lineTo(0, 3); context.stroke(); context.restore();
   if (camera.scale > .003 || selected) { context.font = '11px Arial'; context.textAlign = 'center'; context.lineWidth = 4; context.strokeStyle = '#111d24'; context.strokeText(marker.label.slice(0, 50), p.x, p.y + 22); context.fillStyle = '#f6bf78'; context.fillText(marker.label.slice(0, 50), p.x, p.y + 22); }
  }
 }, [active, snapshot, camera, size, visibleEntities, mapMarkers, selection, layers.links, layers.terrain, tilesVersion, floorEnabled, inFloor]);

 const connectPanel = <div className="wm-setup">
  <div className="wm-panel-title"><Plug size={18}/><h2>Connect your server</h2></div>
  <p className="wm-muted">{world.configured && snapshot ? 'Your server has sent map data. Manage its connection here.' : 'Connect your dedicated server to display the actual factory. You can use the base map for planning meanwhile.'}</p>
  <ol className="wm-steps"><li><strong>Set up Satisfactory</strong><span>Choose a dedicated-server host that supports mods and access to the server files.</span></li><li><strong>Add live monitoring</strong><span>Install Satisfactory Mod Loader and <a href="https://ficsit.app/mod/FicsitRemoteMonitoring" target="_blank" rel="noreferrer">Ficsit Remote Monitoring</a>. Keep its web endpoint private.</span></li><li><strong>Run the small bridge</strong><span>The bridge reads the monitoring API and sends map updates to this private website.</span><a className="wm-download" href="/integrations/world-map-bridge.mjs" download><Download size={14}/>Download bridge</a></li><li><strong>Use a connection key</strong><span>Marcus creates the key below and adds it to the bridge’s environment settings.</span></li></ol>
  <a className="wm-guide" href="https://github.com/marcusamm/veyro/blob/main/satisfactory/docs/world-map-setup.md" target="_blank" rel="noreferrer">Read the setup guide ↗</a>
  {isAdmin ? <div className="wm-connection-controls"><h3>Marcus · connection settings</h3><p className="wm-muted">{connection?.configured ? `Key created ${displayTime(connection.createdAt)}. The key can only send world updates.` : 'Create a key when you are ready to configure the bridge.'}</p>{connectionError && <p className="wm-error-text" role="alert">{connectionError}</p>}
   <button type="button" disabled={connectionBusy || connection === null} onClick={() => connection?.configured ? setConfirm('rotate') : void setup('rotate')}><Plug size={15}/>{connectionBusy ? 'Updating…' : connection?.configured ? 'Replace connection key' : 'Create connection key'}</button>
   {connection?.configured && <button className="wm-danger" disabled={connectionBusy} onClick={() => setConfirm('revoke')}><Unplug size={15}/>Disconnect updates</button>}
   {newToken && <div className="wm-token"><label className="wm-field">New connection key<input type={tokenVisible ? 'text' : 'password'} value={newToken} readOnly autoComplete="off" spellCheck={false} aria-label="New connection key" /></label><div className="wm-actions"><button onClick={() => void copyToken()}><Copy size={14}/>Copy key</button><button onClick={() => setTokenVisible(v => !v)}><Eye size={14}/>{tokenVisible ? 'Hide' : 'Show'}</button><button onClick={() => { setNewToken(''); setTokenVisible(false); }}>Dismiss</button></div><p>Shown once. Store it in the bridge settings; it is never included in your map or exports.</p></div>}
  </div> : <div className="wm-callout"><ShieldCheck size={18}/><p>Marcus manages the server connection. Everyone with an active account can view the map and save plans.</p></div>}
 </div>;

 return <section className="world-map" aria-label="Shared world map">
  <header className="wm-header"><div><p className="wm-eyebrow"><Map size={14}/>Your server · shared planning</p><h1>World map</h1><p>The real factory, with room to plan what comes next.</p></div><div className="wm-save"><button className="wm-primary" disabled={!dirty || saving || conflict} onClick={() => void save()}><Save size={16}/>{saving ? 'Saving…' : 'Save planned layer'}</button><small>{dirty ? 'Unsaved planned changes' : savedAt ? `Saved ${displayTime(savedAt)}${savedBy ? ` · ${players.find(p => p.id === savedBy)?.displayName || 'Player'}` : ' '}` : 'Plans are separate from the game'}</small></div></header>
  {(worldError || planError || authError) && <div className="wm-alert" role="alert"><div><strong>{planError || worldError}</strong>{conflict && <p>Another player saved a newer plan. Export your draft before loading their changes.</p>}{worldError && snapshot && <p>Showing the last successfully received world. It is not currently confirmed live.</p>}</div><div className="wm-actions">{authError ? <button onClick={onSignIn}>Sign in again</button> : <button onClick={() => { void loadWorld(); void loadPlan(); }}><RefreshCw size={14}/>Retry</button>}{conflict && <><button onClick={() => exportPlan(plan, revision)}>Export draft</button><button onClick={() => setConfirm('reload')}>Load latest plan</button></>}</div></div>}
  <div className="wm-statusbar"><span className={'wm-state ' + state}><i/>{stateLabels[state]}</span><span>{snapshot ? snapshot.worldName : 'Dedicated server not linked'}</span><small>{world.lastReceivedAt ? `Last received ${displayTime(world.lastReceivedAt)} · ${age}s ago` : 'No server data received'}</small><button aria-label="Refresh world map" onClick={() => { void loadWorld(); void loadPlan(); }}><RefreshCw size={15}/></button></div>
  {<>
   {!snapshot && <div className="wm-awaiting"><Map size={22}/><div><strong>{state === 'waiting' ? 'Ready for the first server update.' : 'Base map · your server is not connected yet.'}</strong><p>You can add shared plans now. Existing buildings and players will appear once the monitoring bridge sends your world.</p></div><button onClick={() => setPanel('connect')}><Plug size={14}/>Connection setup</button></div>}
   <div className="wm-toolbar"><div className="wm-actions"><button disabled={!editable || plan.markers.length >= 2000} onClick={() => addMarker('note')}><MapPin size={14}/>Add note</button><button disabled={!editable || plan.markers.length >= 2000} onClick={() => addMarker('machine')}><Factory size={14}/>Plan machine</button><button disabled={!editable || plan.markers.length >= 2000} onClick={() => addMarker('area')}><Plus size={14}/>Mark area</button></div><div className="wm-actions"><button onClick={() => exportPlan(plan, revision)}><Download size={14}/>Export plan</button><button disabled={!editable} onClick={() => file.current?.click()}>Import plan</button><input hidden ref={file} type="file" accept="application/json,.json" aria-label="Import planned layer" onChange={e => { const selected = e.target.files?.[0]; if (selected) void importPlan(selected); e.target.value = ''; }}/><button aria-label="Connection settings" aria-pressed={panel === 'connect'} onClick={() => setPanel('connect')}><Settings2 size={16}/></button></div></div>
   <div className="wm-workspace"><div className="wm-map-column"><div className={'wm-canvas-wrap' + (panning ? ' is-panning' : '')} ref={wrap}><canvas ref={canvas} aria-label="Server world map. Arrow keys pan; plus and minus zoom. Select a planned marker to move it with arrow keys or R to rotate. The searchable object list provides the same selections." role="img" tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={e => pointerUp(e)} onPointerCancel={e => pointerUp(e, true)} onKeyDown={mapKey}/><div className="wm-map-controls"><button aria-label="Zoom out" onClick={() => setCamera(c => ({ ...c, scale: clamp(c.scale / 1.5, .00005, .2) }))}><Minus size={15}/></button><button aria-label="Zoom in" onClick={() => setCamera(c => ({ ...c, scale: clamp(c.scale * 1.5, .00005, .2) }))}><Plus size={15}/></button><button aria-label="Fit visible world" onClick={fit}><Maximize2 size={15}/></button><button aria-label="Fit whole island" onClick={() => setCamera({ x: (WORLD_TERRAIN.minX + WORLD_TERRAIN.maxX) / 2, y: 0, scale: Math.min((size.width - 30) / (WORLD_TERRAIN.maxX - WORLD_TERRAIN.minX), (size.height - 30) / (WORLD_TERRAIN.maxY - WORLD_TERRAIN.minY)) })}><Map size={15}/></button></div><div className="wm-scale" aria-label="Map scale"><i style={{ width: 80 }}/>{format(80 / camera.scale / 100)} m</div><div className="wm-map-caption">{snapshot ? 'World coordinates · X → Y ↓' : 'Base map · no server objects'}{terrainError && ' · Terrain unavailable'}</div></div><div className="wm-legend"><span><i/>Existing world</span><span><i/>Planned overlay</span><small>Building symbols show positions, not exact footprints.</small><small className="wm-attribution">Map: <a href="https://www.satisfactorytools.com/" target="_blank" rel="noreferrer">Satisfactory Tools</a> / Coffee Stain Studios</small></div><div className="wm-map-summary"><div><strong>{format(snapshot?.entities.length || 0)}</strong><span>Server objects</span></div><div><strong>{format(snapshot?.links.length || 0)}</strong><span>Connections</span></div><div><strong>{format(plan.markers.length)}</strong><span>Planned items</span></div><div><strong>{snapshot?.entities.filter(e => e.kind === 'player' && e.online === true).length || 0}</strong><span>Players reported online</span></div></div></div>
   <aside className="wm-sidebar"><nav className="wm-tabs" aria-label="World map tools">{(['inspect', 'plan', 'layers'] as const).map(tab => <button key={tab} aria-pressed={panel === tab} onClick={() => setPanel(tab)}>{tab === 'inspect' ? 'Inspect' : tab === 'plan' ? 'Plans' : 'Layers'}</button>)}</nav><div className="wm-panel">
    {panel === 'connect' ? connectPanel : panel === 'layers' ? <><div className="wm-panel-title"><Layers size={18}/><h2>Map layers</h2></div>{(Object.entries({ terrain: 'Base terrain map', buildings: 'Factory buildings', players: 'Player positions', links: 'Belts, pipes and rails', plans: 'Planned overlay' }) as [keyof LayersState, string][]).map(([id, label]) => <label className="wm-checkbox" key={id}><input type="checkbox" checked={layers[id]} onChange={e => setLayers(prev => ({ ...prev, [id]: e.target.checked }))}/>{label}</label>)}<hr/><label className="wm-checkbox"><input type="checkbox" checked={floorEnabled} onChange={e => setFloorEnabled(e.target.checked)}/>Filter by elevation</label><p className="wm-muted">Separate stacked floors using their height in the world.</p><NumberField label="Floor centre (m)" value={floor} onChange={setFloor} min={-20000} max={20000}/><NumberField label="Visible height range (m)" value={floorRange} onChange={setFloorRange} min={1} max={40000}/><p className="wm-small">Grid spacing adapts to zoom. Close-up grid squares are 8 m, the size of a standard foundation.</p></> : panel === 'plan' ? <><div className="wm-panel-title"><MapPin size={18}/><h2>Planned layer</h2></div><p className="wm-muted">Only these markers can be moved here. Saving a plan never builds or changes anything in the game.</p>{plan.markers.length ? <div className="wm-object-list">{plan.markers.slice(0, 100).map(marker => <button key={marker.id} onClick={() => { setSelection({ kind: 'planned', id: marker.id }); setPanel('inspect'); focusPoint(marker); }}><span>{marker.label}</span><small>{marker.kind} · {format(marker.z / 100)} m elevation</small></button>)}{plan.markers.length > 100 && <p className="wm-small">Showing the first 100 planned items. Select other markers on the map.</p>}</div> : <div className="wm-no-selection"><MapPin size={24}/><p>Add a note, machine or area at the centre of the map.</p></div>}</> : selectedMarker ? <><p className="wm-eyebrow">Planned {selectedMarker.kind}</p><h2>{selectedMarker.kind === 'machine' ? 'Planned machine' : selectedMarker.kind === 'area' ? 'Planned area' : 'Map note'}</h2><label className="wm-field">Label<input value={selectedMarker.label} maxLength={300} disabled={!editable} onChange={e => patchMarker({ label: e.target.value })}/></label>{selectedMarker.kind === 'machine' && <><label className="wm-field">Recipe<select value={selectedMarker.recipeId} disabled={!editable} onChange={e => patchMarker({ recipeId: e.target.value })}>{recipes.map(recipe => <option key={recipe.id} value={recipe.id}>{recipe.name}</option>)}</select></label><NumberField label="Planned clock (%)" value={selectedMarker.clockPercent || 100} onChange={n => patchMarker({ clockPercent: n })} min={1} max={250} step={.01} disabled={!editable}/><p className="wm-small">Planning label only. Use the <a href="#/factory">factory planner</a> to calculate production and connect machines.</p></>}<div className="wm-coordinate-fields"><NumberField label="X (m)" value={selectedMarker.x / 100} onChange={n => patchMarker({ x: Math.round(n * 100) })} min={-20000} max={20000} step={1} disabled={!editable}/><NumberField label="Y (m)" value={selectedMarker.y / 100} onChange={n => patchMarker({ y: Math.round(n * 100) })} min={-20000} max={20000} step={1} disabled={!editable}/></div><NumberField label="Elevation (m)" value={selectedMarker.z / 100} onChange={n => patchMarker({ z: Math.round(n * 100) })} min={-20000} max={20000} step={1} disabled={!editable}/>{selectedMarker.kind === 'area' && <div className="wm-coordinate-fields"><NumberField label="Width (m)" value={(selectedMarker.width || 800) / 100} onChange={n => patchMarker({ width: Math.round(n * 100) })} min={1} max={2000} disabled={!editable}/><NumberField label="Length (m)" value={(selectedMarker.height || 800) / 100} onChange={n => patchMarker({ height: Math.round(n * 100) })} min={1} max={2000} disabled={!editable}/></div>}<div className="wm-actions"><button disabled={!editable} onClick={() => patchMarker({ rotation: normaliseRotation(selectedMarker.rotation + 15) })}><RotateCw size={14}/>Rotate {format(selectedMarker.rotation)}°</button><button className="wm-danger" disabled={!editable} onClick={() => { change(d => { d.markers = d.markers.filter(m => m.id !== selectedMarker.id); }); setSelection(null); }}><Trash2 size={14}/>Remove</button></div><p className="wm-small">Drag the marker, or use arrow keys on the map to move 8 m. Hold Shift for 1 m steps. R rotates 15°.</p></> : selectedEntity ? <><p className="wm-eyebrow">Actual server object · read only</p><h2>{sourceLabel(selectedEntity)}</h2><dl className="wm-details"><dt>Type</dt><dd>{selectedEntity.kind}</dd><dt>X / Y</dt><dd>{format(selectedEntity.x / 100)} / {format(selectedEntity.y / 100)} m</dd><dt>Elevation</dt><dd>{format(selectedEntity.z / 100)} m</dd><dt>Direction</dt><dd>{format(selectedEntity.yaw)}°</dd>{selectedEntity.recipeId && <><dt>Recipe</dt><dd>{recipeName(selectedEntity.recipeId)}</dd></>}{selectedEntity.clockPercent !== undefined && <><dt>Clock</dt><dd>{format(selectedEntity.clockPercent)}%</dd></>}{selectedEntity.powerMW !== undefined && <><dt>Reported power</dt><dd>{format(selectedEntity.powerMW)} MW</dd></>}{selectedEntity.producing !== undefined && <><dt>Producing</dt><dd>{selectedEntity.producing ? 'Yes' : 'No'}</dd></>}{selectedEntity.kind === 'player' && <><dt>Online</dt><dd>{selectedEntity.online === undefined ? 'Not reported' : selectedEntity.online ? 'Yes' : 'No'}</dd></>}</dl><p className="wm-small">Observed {displayTime(snapshot?.observedAt || null)}. {state === 'live' ? 'Updates come from the monitoring bridge.' : 'This is the last received state, not confirmed live.'}</p><button onClick={() => focusPoint(selectedEntity)}><Maximize2 size={14}/>Centre on object</button><button className="wm-full" onClick={() => setSelection(null)}>Back to object list</button></> : <><div className="wm-panel-title"><Search size={18}/><h2>Find an object</h2></div><label className="wm-field">Search the server<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Machine or player name"/></label><label className="wm-field">Object type<select value={kind} onChange={e => setKind(e.target.value)}><option value="all">All types</option>{['machine', 'extractor', 'storage', 'generator', 'splitter', 'merger', 'player', 'vehicle', 'other'].map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label><div className="wm-object-list">{searchResults.map(entity => <button key={entity.id} onClick={() => { setSelection({ kind: 'actual', id: entity.id }); focusPoint(entity); }}><span>{sourceLabel(entity)}</span><small>{entity.kind} · {format(entity.z / 100)} m elevation</small></button>)}{!searchResults.length && <p className="wm-muted">No objects match these filters.</p>}{visibleEntities.length > 80 && <p className="wm-small">Showing up to 80 matches. Search to narrow the list.</p>}</div></>}
   </div></aside></div>
  </>}
  <div className="wm-notice" role="status">{notice && <><Check size={15}/>{notice}</>}</div>
  {confirm && <Confirm title={confirm === 'rotate' ? 'Replace the connection key?' : confirm === 'revoke' ? 'Disconnect server updates?' : 'Load the latest plan?'} onClose={() => setConfirm(null)}><p>{confirm === 'rotate' ? 'The old key will stop working immediately. Update the bridge with the new key to resume map updates. Your world and plans stay saved.' : confirm === 'revoke' ? 'The bridge will no longer be able to send updates. The last world snapshot and everyone’s planned layer stay saved.' : 'This replaces your unsaved planned layer. Export your draft first if you want to keep it.'}</p><div className="wm-actions"><button onClick={() => setConfirm(null)}>Cancel</button><button className="wm-primary" disabled={connectionBusy} onClick={() => { if (confirm === 'reload') { setConfirm(null); void loadPlan(true); } else void setup(confirm); }}>{confirm === 'reload' ? 'Load latest plan' : confirm === 'rotate' ? 'Replace key' : 'Disconnect'}</button></div></Confirm>}
 </section>;
}

function Confirm({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
 const ref = useRef<HTMLDialogElement>(null);
 useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
 return <dialog ref={ref} className="wm-confirm" onCancel={onClose}><header><h2>{title}</h2><button aria-label="Close confirmation" onClick={onClose}><X size={18}/></button></header>{children}</dialog>;
}
