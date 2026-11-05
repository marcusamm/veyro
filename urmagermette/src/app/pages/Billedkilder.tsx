import { SideHero } from '../components/Dele';
import kilder from '../billedkilder.json';

interface Kilde {
  fil: string;
  titel: string;
  fotograf: string;
  licens: string;
  licensUrl: string;
  side: string;
}

export default function Billedkilder() {
  const liste = kilder as Kilde[];
  return (
    <>
      <SideHero over="Billedkilder" titel="Billeder på hjemmesiden" tekst="Billederne er frit licenserede og bruges som illustration. De forestiller ikke UrmagerMette, Mette eller værkstedet." />
      <section className="beholder max-w-4xl py-14 sm:py-20">
        <ul className="divide-y divide-linje border-y border-linje">
          {liste.map((k) => (
            <li key={k.fil} className="flex flex-col gap-1 py-4 sm:flex-row sm:items-center sm:gap-6">
              <img src={`/billeder/${k.fil}-800.jpg`} alt="" className="h-16 w-24 shrink-0 rounded-lg object-cover" loading="lazy" />
              <p className="text-[0.97rem]">
                <a href={k.side} target="_blank" rel="noopener" className="font-semibold text-groen underline decoration-messing/60 underline-offset-2">{k.titel || 'Uden titel'}</a>
                {k.fotograf && <> af {k.fotograf}</>} · <a href={k.licensUrl} target="_blank" rel="noopener" className="underline decoration-messing/60 underline-offset-2">{k.licens}</a>
              </p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
