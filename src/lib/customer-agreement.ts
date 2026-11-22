import type { SubscriptionRow } from '../env';

export function isComplimentary(sub: Pick<SubscriptionRow, 'billing_mode'> | null | undefined): boolean {
  return sub?.billing_mode === 'complimentary';
}

export const COMPLIMENTARY_NOTICE = 'Din aftale koster 0 kr. Der sker ingen automatisk opkrævning. Et betalt abonnement kræver en ny skriftlig aftale.';

/** Only ordinary HTTPS website links; reject credentials, ports, IPs and unsafe schemes. */
export function customerWebsiteUrl(value: string | null | undefined): string | null {
  if (!value || value !== value.trim() || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
