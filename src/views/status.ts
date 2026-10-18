import type { SubscriptionRow } from '../env';
import { formatDate } from '../lib/format';

export type Tone = 'ok' | 'warn' | 'err' | 'neutral';

export interface SubState {
  label: string;
  tone: Tone;
  /** Abonnementet kan ændres (plan, opsigelse) */
  manageable: boolean;
  /** Opsigelse er planlagt */
  cancelPending: boolean;
  cancelDate: number | null;
  ended: boolean;
}

export function subscriptionState(sub: SubscriptionRow | null): SubState | null {
  if (!sub) return null;
  const ended = sub.status === 'canceled' || sub.status === 'incomplete_expired';
  if (ended) {
    return { label: 'Afsluttet', tone: 'neutral', manageable: false, cancelPending: false, cancelDate: null, ended };
  }
  const cancelDate = sub.cancel_at ?? (sub.cancel_at_period_end ? sub.current_period_end : null);
  const cancelPending = !!sub.cancel_at_period_end || !!sub.cancel_at;
  const manageable = ['active', 'trialing', 'past_due'].includes(sub.status);
  if (sub.payment_failed || sub.status === 'past_due' || sub.status === 'unpaid') {
    return { label: 'Betaling fejlet', tone: 'err', manageable, cancelPending, cancelDate, ended };
  }
  if (sub.status === 'incomplete') {
    return { label: 'Afventer betaling', tone: 'warn', manageable: false, cancelPending, cancelDate, ended };
  }
  if (sub.status === 'paused') {
    return { label: 'Sat på pause', tone: 'neutral', manageable: false, cancelPending, cancelDate, ended };
  }
  if (cancelPending) {
    return { label: `Opsagt pr. ${formatDate(cancelDate)}`, tone: 'warn', manageable, cancelPending, cancelDate, ended };
  }
  return { label: 'Aktiv', tone: 'ok', manageable, cancelPending, cancelDate, ended };
}

export const REQUEST_TYPES: Record<string, string> = {
  content: 'Indholdsændring',
  bug: 'Fejl',
  question: 'Spørgsmål',
};

export const REQUEST_STATUSES: Record<string, { label: string; tone: Tone }> = {
  received: { label: 'Modtaget', tone: 'neutral' },
  in_progress: { label: 'I gang', tone: 'warn' },
  resolved: { label: 'Løst', tone: 'ok' },
};

const BADGE_CLASS: Record<Tone, string> = { ok: 'b-ok', warn: 'b-warn', err: 'b-err', neutral: 'b-neutral' };
export function badgeClass(t: Tone): string {
  return BADGE_CLASS[t];
}
