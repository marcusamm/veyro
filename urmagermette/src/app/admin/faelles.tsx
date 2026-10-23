import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Ikon } from '../components/Ikon';
import type { BookingStatus } from '../../shared/typer';
import { STATUS_TEKST } from '../../shared/typer';

export interface AdminKontekst {
  aabnBooking: (id: string) => void;
  opdatering: number;
  opdater: () => void;
  demo: boolean;
  besked: (t: string) => void;
}

export const Kontekst = createContext<AdminKontekst>({ aabnBooking: () => {}, opdatering: 0, opdater: () => {}, demo: false, besked: () => {} });
export const useAdmin = () => useContext(Kontekst);

export const STATUS_STIL: Record<BookingStatus, { pille: string; blok: string }> = {
  anmodet: { pille: 'bg-[#f6ead2] text-[#7a5e30] ring-1 ring-[#e3cb9a]', blok: 'border-l-[#c99a45] bg-[#fbf1dc] text-[#5c4521] border border-dashed border-[#d9b878]' },
  bekraeftet: { pille: 'bg-[#dfeae3] text-groen ring-1 ring-[#b9d0c1]', blok: 'border-l-groen bg-[#e4eee8] text-groen-moerk border border-[#c3d7ca]' },
  gennemfoert: { pille: 'bg-[#ecebe6] text-[#4f5a52] ring-1 ring-[#d6d4cb]', blok: 'border-l-[#7c8a80] bg-[#efeee9] text-[#4f5a52] border border-[#dddbd2]' },
  afvist: { pille: 'bg-[#f5e1e1] text-fejl ring-1 ring-[#e7bebe]', blok: 'border-l-fejl bg-[#f8e9e9] text-fejl border border-[#ecc9c9] line-through' },
  aflyst: { pille: 'bg-[#f5e1e1] text-fejl ring-1 ring-[#e7bebe]', blok: 'border-l-fejl bg-[#f8e9e9] text-fejl/80 border border-[#ecc9c9] line-through' },
  udeblevet: { pille: 'bg-[#ecebe6] text-graa ring-1 ring-[#d6d4cb]', blok: 'border-l-graa bg-[#efeee9] text-graa border border-[#dddbd2]' },
};

export function StatusPille({ status }: { status: BookingStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[0.8rem] font-semibold ${STATUS_STIL[status].pille}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {STATUS_TEKST[status]}
    </span>
  );
}

export function DemoMaerke() {
  return <span className="rounded-md bg-messing/15 px-1.5 py-0.5 text-[0.7rem] font-bold uppercase tracking-wider text-[#7a5e30]">Demo</span>;
}

export function Panel({ titel, children, handling, className = '' }: { titel?: ReactNode; children: ReactNode; handling?: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-linje bg-white ${className}`}>
      {titel && (
        <div className="flex items-center justify-between gap-3 border-b border-linje px-5 py-4">
          <h2 className="font-sans text-[1.05rem] font-semibold text-koks">{titel}</h2>
          {handling}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Modal({ titel, onLuk, children, bred = false }: { titel: string; onLuk: () => void; children: ReactNode; bred?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onLuk();
    window.addEventListener('keydown', esc);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', esc);
      document.body.style.overflow = '';
    };
  }, [onLuk]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-groen-moerk/40 backdrop-blur-[2px] sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onLuk()}>
      <div role="dialog" aria-modal="true" aria-label={titel} className={`ind flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-3xl bg-creme shadow-2xl sm:rounded-3xl ${bred ? 'sm:max-w-3xl' : 'sm:max-w-xl'}`}>
        <div className="flex items-center justify-between gap-3 border-b border-linje bg-papir px-5 py-4">
          <h2 className="font-sans text-[1.15rem] font-semibold text-koks">{titel}</h2>
          <button type="button" onClick={onLuk} className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-sand" aria-label="Luk">
            <Ikon navn="luk" />
          </button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export const knapP = 'knap-lille bg-groen text-creme hover:bg-groen-moerk disabled:opacity-50';
export const knapS = 'knap-lille border border-linje bg-white text-koks hover:border-groen disabled:opacity-50';
export const knapFare = 'knap-lille border border-fejl/30 bg-white text-fejl hover:bg-fejl/5 disabled:opacity-50';
export const feltA = 'felt !min-h-[2.75rem] !py-2';
