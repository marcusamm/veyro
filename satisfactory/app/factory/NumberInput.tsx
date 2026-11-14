import { useEffect, useId, useRef, useState } from 'react';
import { parseNumericDraft } from './editor';
const format = (value: number) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 }).format(value);

export default function NumberInput({ value, onValue, min, max, step = 'any', integer = false, disabled = false, onValidity, ...inputProps }: { value: number; onValue: (n: number) => void; min: number; max: number; step?: number | 'any'; integer?: boolean; disabled?: boolean; onValidity?: (valid: boolean) => void; id?: string; name?: string; 'aria-label'?: string }) {
 const [draft, setDraft] = useState(String(value)), focused = useRef(false), errorId = useId(), validityCallback = useRef(onValidity);
 validityCallback.current = onValidity;
 const valid = parseNumericDraft(draft, min, max, integer) !== null;
 useEffect(() => { if (!focused.current) { setDraft(String(value)); validityCallback.current?.(parseNumericDraft(String(value), min, max, integer) !== null); } }, [value, min, max, integer]);
 return <span className="fp-number-input"><input {...inputProps} type="number" min={min} max={max} step={integer ? 1 : step} value={draft} disabled={disabled} aria-invalid={!valid} aria-describedby={!valid ? errorId : undefined} onFocus={() => { focused.current = true; }} onChange={e => { const next = e.target.value, n = parseNumericDraft(next, min, max, integer); setDraft(next); onValidity?.(n !== null); if (n !== null) onValue(n); }} onBlur={() => { focused.current = false; setDraft(String(value)); onValidity?.(parseNumericDraft(String(value), min, max, integer) !== null); }} />{!valid && <small id={errorId}>{integer ? 'Enter a whole number between' : 'Enter'} {format(min)}–{format(max)}. The last valid value is unchanged.</small>}</span>;
}
