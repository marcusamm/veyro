// Honeypot-felt mod spam-robotter (skjult for mennesker og skærmlæsere).
export function Honeypot({ vaerdi, saet }: { vaerdi: string; saet: (v: string) => void }) {
  return (
    <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
      <label>
        Firma (udfyld ikke)
        <input type="text" name="firma" tabIndex={-1} autoComplete="off" value={vaerdi} onChange={(e) => saet(e.target.value)} />
      </label>
    </div>
  );
}
