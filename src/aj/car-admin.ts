import { AjError } from './types';

export const carPhotoUploadPath = /^\/api\/admin\/cars\/[1-9]\d*\/photos$/;
const photoMaxBytes = 480 * 1024;
const photoMaxCount = 8;

function numberField(value: unknown, label: string, min: number, max: number): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) return value;
  throw new AjError(`Indtast et gyldigt heltal for ${label}.`);
}

function textField(value: unknown, max: number): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new AjError('Et tekstfelt er for langt eller indeholder ugyldige tegn.');
  }
  return value.trim();
}

export function carId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AjError('Annoncen findes ikke.', 404);
  return Number(value);
}

export async function adminCars(db: D1Database) {
  const [cars, photos] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT id, title, price_dkk AS priceDkk, model_year AS modelYear, mileage_km AS mileageKm,
      fuel, transmission, description, status, version FROM aj_cars ORDER BY updated_at DESC, id DESC`),
    db.prepare('SELECT id, car_id FROM aj_car_photos ORDER BY car_id, id'),
  ]);
  const grouped = new Map<number, number[]>();
  for (const photo of photos!.results as { id: number; car_id: number }[]) {
    const ids = grouped.get(photo.car_id) ?? [];
    ids.push(photo.id);
    grouped.set(photo.car_id, ids);
  }
  return cars!.results.map(car => ({ ...car, photos: grouped.get(Number(car.id)) ?? [] }));
}

export async function saveCar(db: D1Database, input: Record<string, unknown>) {
  const title = textField(input.title, 120);
  if (!title) throw new AjError('Skriv bilens mærke og model.');
  const price = numberField(input.priceDkk, 'pris', 1, 999999999);
  const year = input.modelYear == null ? null : numberField(input.modelYear, 'årgang', 1886, new Date().getUTCFullYear() + 1);
  const mileage = input.mileageKm == null ? null : numberField(input.mileageKm, 'kilometertal', 0, 9999999);
  const status = input.status ?? 'draft';
  if (status !== 'published' && status !== 'sold' && status !== 'draft') throw new AjError('Vælg en gyldig annoncestatus.');
  const values = [title, price, year, mileage, textField(input.fuel, 60), textField(input.transmission, 60),
    textField(input.description, 4000), status];
  if (input.id !== undefined) {
    const id = numberField(input.id, 'bilens nummer', 1, Number.MAX_SAFE_INTEGER);
    const version = numberField(input.version, 'annoncens version', 1, Number.MAX_SAFE_INTEGER);
    const updated = await db.prepare(`UPDATE aj_cars SET title=?, price_dkk=?, model_year=?, mileage_km=?,
      fuel=?, transmission=?, description=?, status=?, updated_at=unixepoch(), version=version+1
      WHERE id=? AND version=? RETURNING id, version`).bind(...values, id, version).first();
    if (!updated) throw new AjError('Annoncen er ændret. Åbn oversigten igen for at hente den nyeste udgave.', 409);
    return updated;
  }
  const key = input.requestId ?? crypto.randomUUID();
  if (typeof key !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(key)) throw new AjError('Genåbn formularen, og prøv igen.');
  const insert = await db.prepare(`INSERT INTO aj_cars
    (title, price_dkk, model_year, mileage_km, fuel, transmission, description, status, create_key)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(create_key) DO NOTHING RETURNING id, version`).bind(...values, key).first();
  return insert ?? await db.prepare('SELECT id, version FROM aj_cars WHERE create_key=?').bind(key).first();
}

function jpegBytes(data: unknown): Uint8Array {
  if (typeof data !== 'string' || !data || data.length > 4 * Math.ceil(photoMaxBytes / 3)) throw new AjError('Billedet er for stort eller mangler.');
  let raw: string;
  try { raw = atob(data); } catch { throw new AjError('Billedfilen kunne ikke læses.'); }
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  const invalid = () => new AjError('Billedet skal være et gyldigt JPEG-foto.');
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw invalid();
  const view = new DataView(bytes.buffer);
  let hasFrame = false;
  for (let i = 2; i + 4 < bytes.length; ) {
    if (bytes[i] !== 255) throw invalid();
    const marker = bytes[i + 1], size = view.getUint16(i + 2);
    if (size < 2 || i + size + 2 > bytes.length - 2) throw invalid();
    if (marker === 192 || marker === 194) {
      if (size < 11) throw invalid();
      const height = view.getUint16(i + 5), width = view.getUint16(i + 7);
      if (!width || !height || width > 2000 || height > 2000) throw invalid();
      hasFrame = true;
    }
    if (marker === 218 && hasFrame) return bytes;
    i += size + 2;
  }
  throw invalid();
}

export async function addCarPhoto(db: D1Database, id: number, data: unknown) {
  const bytes = jpegBytes(data);
  const added = await db.prepare(`INSERT INTO aj_car_photos(car_id, content_type, data)
    SELECT id,'image/jpeg',? FROM aj_cars WHERE id=?
    AND (SELECT COUNT(*) FROM aj_car_photos WHERE car_id=?) < ?
    AND NOT EXISTS (SELECT 1 FROM aj_car_photos WHERE car_id=? AND data=?)
    RETURNING id`).bind(bytes, id, id, photoMaxCount, id, bytes).first();
  if (added) return added;
  const existing = await db.prepare('SELECT id FROM aj_car_photos WHERE car_id=? AND data=?').bind(id, bytes).first();
  if (existing) return existing;
  if (!await db.prepare('SELECT id FROM aj_cars WHERE id=?').bind(id).first()) throw new AjError('Annoncen findes ikke.', 404);
  throw new AjError('Der er plads til otte billeder. Fjern et billede, før du tilføjer et nyt.', 409);
}
