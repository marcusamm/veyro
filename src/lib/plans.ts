import type { Env } from '../env';

export type PlanKey = 'starter' | 'business' | 'premium';

export interface Plan {
  key: PlanKey;
  name: string;
  /** Månedspris i øre inkl. 25 % moms (kun til visning; Stripe-prisen er den gældende). */
  amount: number;
  badge?: string;
  features: string[];
  rank: number;
}

export const PLANS: Plan[] = [
  {
    key: 'starter',
    name: 'Starter',
    amount: 29900,
    rank: 1,
    features: [
      'Enkel, professionel hjemmeside',
      'Webhosting og SSL-certifikat',
      'Tilkobling af domæne',
      'Grundlæggende vedligeholdelse',
    ],
  },
  {
    key: 'business',
    name: 'Business',
    amount: 59900,
    rank: 2,
    badge: 'Mest populær',
    features: [
      'Skræddersyet virksomhedshjemmeside',
      'Webhosting, SSL og sikkerhedskopier',
      'Løbende opdateringer',
      'Mindre indholdsændringer hver måned',
    ],
  },
  {
    key: 'premium',
    name: 'Premium',
    amount: 109900,
    rank: 3,
    features: [
      'Avanceret hjemmeside',
      'Webhosting og udvidet vedligeholdelse',
      'Flere indholdsændringer',
      'Prioriteret kundesupport',
    ],
  },
];

export function isPlanKey(v: unknown): v is PlanKey {
  return v === 'starter' || v === 'business' || v === 'premium';
}

export function getPlan(key: string | null | undefined): Plan | undefined {
  return PLANS.find((p) => p.key === key);
}

export function priceIdFor(env: Env, key: PlanKey): string {
  switch (key) {
    case 'starter':
      return env.PRICE_STARTER;
    case 'business':
      return env.PRICE_BUSINESS;
    case 'premium':
      return env.PRICE_PREMIUM;
  }
}

export function planForPriceId(env: Env, priceId: string | null | undefined): PlanKey | null {
  if (!priceId) return null;
  if (priceId === env.PRICE_STARTER) return 'starter';
  if (priceId === env.PRICE_BUSINESS) return 'business';
  if (priceId === env.PRICE_PREMIUM) return 'premium';
  return null;
}

export function minMonths(env: Env): number {
  const n = Number.parseInt(env.MIN_MONTHS ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 120) : 0;
}

/** Lægger hele kalendermåneder til et unix-tidspunkt (UTC); dag klemmes til månedens sidste dag. */
export function addMonths(unixSec: number, months: number): number {
  const d = new Date(unixSec * 1000);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()),
  );
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return Math.floor(target.getTime() / 1000);
}

/** Tidligste tidspunkt, hvor abonnementet må opsiges, eller null hvis der ikke er binding. */
export function cancellableFrom(env: Env, startedAt: number | null): number | null {
  const m = minMonths(env);
  if (!m || !startedAt) return null;
  return addMonths(startedAt, m);
}
