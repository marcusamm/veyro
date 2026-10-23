import { Link } from 'react-router';
import { Ikon } from '../components/Ikon';

export default function IkkeFundet() {
  return (
    <section className="beholder flex min-h-[60vh] flex-col items-center justify-center py-20 text-center">
      <p className="overtekst">Fejl 404</p>
      <h1 className="mt-4 text-[2.8rem] sm:text-[3.6rem]">Siden er gået i stå</h1>
      <p className="mt-4 max-w-md text-graa">Vi kan ikke finde den side, du leder efter. Måske er den flyttet, eller adressen er skrevet forkert.</p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link to="/" className="knap-primaer">Til forsiden</Link>
        <Link to="/bestil" className="knap-sekundaer"><Ikon navn="kalender" /> Bestil tid</Link>
      </div>
    </section>
  );
}
