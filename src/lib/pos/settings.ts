// Kassens indstillinger, gemt som nøgle/værdi i pos_settings. Ukendte nøgler ignoreres, og
// manglende nøgler får standardværdien, så nye indstillinger ikke kræver en migrering.

export type ReceiptWidth = '80mm' | '58mm' | 'a4';

export interface PosSettings {
  /** Butiksoplysninger på kvitteringen */
  store_name: string;
  store_address: string;
  store_phone: string;
  store_email: string;
  store_website: string;
  cvr: string;
  receipt_header: string;
  receipt_footer: string;
  receipt_width: ReceiptWidth;
  /** Åbn udskrift af kvitteringen automatisk efter hvert salg */
  receipt_auto_print: boolean;
  /** Momssats i procent. Priserne er inkl. moms. */
  vat_rate: number;
  /** Hurtigknapper til rabat i procent */
  discount_presets: string;
  /** Største rabat (procent af prisen), en kasseassistent må give uden godkendelse */
  cashier_max_discount: number;
  /** Største rabat, en leder må give uden godkendelse af en administrator */
  manager_max_discount: number;
  cash_enabled: boolean;
  /** Afrund kontantbetalinger til nærmeste 50 øre */
  cash_rounding: boolean;
  /** Kort på en separat betalingsterminal (registreres manuelt, når terminalen har godkendt) */
  card_terminal_enabled: boolean;
  card_terminal_label: string;
  /** Stripe Terminal-kortlæser (tmr_...) på Veyros Stripe-konto */
  stripe_reader_id: string;
  /** Andre betalingsformer, én pr. linje (fx MobilePay, Faktura) */
  other_methods: string;
  /** Vis udsolgte varer i kassen (kan ikke sælges) */
  show_out_of_stock: boolean;
  /** Kasseassistenter kan se alle kassesalg (ellers kun deres egne) */
  cashier_sees_all: boolean;
  scanner_enabled: boolean;
  /** En scanning med præcist match lægger varen direkte i kurven */
  scanner_auto_add: boolean;
}

export const DEFAULT_POS_SETTINGS: PosSettings = {
  store_name: 'Veyro',
  store_address: '',
  store_phone: '',
  store_email: 'kontakt@veyro.dk',
  store_website: 'veyro.dk',
  cvr: '',
  receipt_header: '',
  receipt_footer: 'Tak for handlen',
  receipt_width: '80mm',
  receipt_auto_print: false,
  vat_rate: 25,
  discount_presets: '5, 10, 15, 20',
  cashier_max_discount: 10,
  manager_max_discount: 50,
  cash_enabled: true,
  cash_rounding: true,
  card_terminal_enabled: true,
  card_terminal_label: 'Kort (terminal)',
  stripe_reader_id: '',
  other_methods: '',
  show_out_of_stock: true,
  cashier_sees_all: false,
  scanner_enabled: true,
  scanner_auto_add: true,
};

type Key = keyof PosSettings;

export async function getPosSettings(db: D1Database): Promise<PosSettings> {
  const { results } = await db.prepare('SELECT key, value FROM pos_settings').all<{ key: string; value: string }>();
  const s: PosSettings = { ...DEFAULT_POS_SETTINGS };
  const rec = s as unknown as Record<string, unknown>;
  for (const { key, value } of results) {
    if (!(key in DEFAULT_POS_SETTINGS)) continue;
    const def = DEFAULT_POS_SETTINGS[key as Key];
    if (typeof def === 'boolean') rec[key] = value === '1';
    else if (typeof def === 'number') rec[key] = Number.isFinite(Number(value)) ? Number(value) : def;
    else rec[key] = value;
  }
  return s;
}

export async function savePosSettings(db: D1Database, s: PosSettings): Promise<void> {
  await db.batch(
    (Object.keys(DEFAULT_POS_SETTINGS) as Key[]).map((key) => {
      const v = s[key];
      const value = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
      return db.prepare('INSERT INTO pos_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value);
    }),
  );
}

export function discountPresets(s: PosSettings): number[] {
  return [
    ...new Set(
      s.discount_presets
        .split(/[,;\s]+/)
        .map((x) => Number(x.replace(',', '.')))
        .filter((x) => Number.isFinite(x) && x > 0 && x <= 100),
    ),
  ].slice(0, 8);
}

/** Andre betalingsformer fra indstillingerne (navn, højst 12). */
export function otherMethods(s: PosSettings): string[] {
  return [
    ...new Set(
      s.other_methods
        .split(/\r?\n/)
        .map((x) => x.trim().slice(0, 40))
        .filter(Boolean),
    ),
  ].slice(0, 12);
}

export type PaymentMethod = 'kontant' | 'kort_terminal' | 'stripe_terminal' | 'andet';

export interface MethodOption {
  /** Nøgle, kassen sender: "kontant", "kort_terminal", "stripe_terminal" eller "andet:<navn>" */
  key: string;
  method: PaymentMethod;
  label: string;
}

/** De betalingsformer, kassen kan bruge lige nu. Stripe kræver både nøgle og kortlæser. */
export function methodOptions(s: PosSettings, env: { STRIPE_SECRET_KEY?: string }): MethodOption[] {
  const out: MethodOption[] = [];
  if (s.cash_enabled) out.push({ key: 'kontant', method: 'kontant', label: 'Kontant' });
  if (stripeReady(s, env)) out.push({ key: 'stripe_terminal', method: 'stripe_terminal', label: 'Kort (Stripe)' });
  if (s.card_terminal_enabled) out.push({ key: 'kort_terminal', method: 'kort_terminal', label: s.card_terminal_label || 'Kort (terminal)' });
  for (const name of otherMethods(s)) out.push({ key: `andet:${name}`, method: 'andet', label: name });
  return out;
}

export function stripeReady(s: PosSettings, env: { STRIPE_SECRET_KEY?: string }): boolean {
  return !!env.STRIPE_SECRET_KEY && /^tmr_[A-Za-z0-9]+$/.test(s.stripe_reader_id);
}

/** Momssats i basispoint (25 % = 2500). */
export function vatBp(s: PosSettings): number {
  return Math.round(s.vat_rate * 100);
}
