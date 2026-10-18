// App-ikoner (PNG) i butikkens farve, så bestillingen kan lægges på telefonens hjemmeskærm.
// Ikonet er en flade i accentfarven med en rund prik, ligesom logoet i toppen af siden.
// PNG'en bygges her uden afhængigheder: rå pixels komprimeres med CompressionStream (zlib).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const cache = new Map<string, Uint8Array<ArrayBuffer>>();

/** Kvadratisk PNG: baggrund i `bg` og en blødt kantet prik i `dot` midt i (inden for den sikre zone). */
export async function appIcon(size: number, bg: string, dot: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = `${size}${bg}${dot}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [br, bgG, bb] = rgb(bg);
  const [dr, dg, db] = rgb(dot);
  const raw = new Uint8Array(size * (size * 3 + 1));
  const c = (size - 1) / 2;
  const r = size * 0.2;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: ingen
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - c, y - c);
      const a = Math.min(1, Math.max(0, r + 0.5 - dist)); // antialiasing på kanten
      const i = row + 1 + x * 3;
      raw[i] = Math.round(br + (dr - br) * a);
      raw[i + 1] = Math.round(bgG + (dg - bgG) * a);
      raw[i + 2] = Math.round(bb + (db - bb) * a);
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size);
  v.setUint32(4, size);
  ihdr[8] = 8; // bitdybde
  ihdr[9] = 2; // RGB
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  if (cache.size > 20) cache.clear();
  cache.set(key, png);
  return png;
}
