import type { Env } from '../env';

export const bookingTimingNote = 'Varigheden er vejledende. Bilen kan blive færdig senere, afhængigt af arbejdet.';

export interface AjEnv extends Env { AJ_URL?: string; AJ_HOSTS?: string; AJ_OUTBOX_KEY?: string }
export interface Campaign { enabled: boolean; confirmed: boolean; title: string; priceOre: number; expiresOn: string | null }
export interface Settings { workshopEmail: string; bookingEnabled: boolean; campaign: Campaign }
export interface Service { id: number; name: string; description: string; durationMinutes: number | null; active: boolean }
export interface Staff { id: number; name: string; email: string; role: 'owner' | 'staff'; active: boolean; hasCalendarLink: boolean }
export interface Hours { id: number; staffId: number; weekday: number; startTime: string; endTime: string }
export interface Block { id: number; staffId: number; startAt: string; endAt: string; reason: string }
export interface Booking {
  id: string; serviceId: number; serviceName: string; staffId: number; staffName: string;
  startAt: string; endAt: string; name: string; email: string; phone: string; registration: string; note: string;
  status: 'confirmed' | 'cancelled'; version: number;
}
export interface AjUser { email: string; role: 'operator' | 'owner' | 'staff'; staffId: number | null }
export interface Slot { startAt: string; staffId: number; staffName: string }
export interface BookingInput { serviceId: number; staffId: number; startAt: string; name: string; email: string; phone: string; registration: string; note: string }
export class AjError extends Error { constructor(message: string, public status: 400 | 401 | 403 | 404 | 409 | 429 | 503 = 400) { super(message); } }
