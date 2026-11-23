import { escapeHtml as esc } from '../lib/email';
import { AJ_PHONE, AJ_TELEPHONE } from './views';

export const carListPath = '/biler-til-salg';
const carsPerPage = 18;
const dk = new Intl.NumberFormat('da-DK');

interface Car {
  id: number;
  title: string;
  price_dkk: number;
  model_year: number | null;
  mileage_km: number | null;
  fuel: string;
  transmission: string;
}

interface Advert extends Car {
  description: string;
}

interface Preview extends Car {
  cover: number | null;
}

export async function publishedCars(db: D1Database, page: number): Promise<Preview[]> {
  const result = await db.prepare(`SELECT c.id, c.title, c.price_dkk, c.model_year, c.mileage_km, c.fuel, c.transmission,
    (SELECT id FROM aj_car_photos WHERE car_id=c.id ORDER BY id LIMIT 1) AS cover
    FROM aj_cars c WHERE c.status='published'
    ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`)
    .bind(carsPerPage + 1, (page - 1) * carsPerPage).all<Preview>();
  return result.results;
}

export async function publishedCar(db: D1Database, id: number) {
  const car = await db.prepare(`SELECT c.id, c.title, c.price_dkk, c.model_year, c.mileage_km, c.fuel, c.transmission, c.description,
    (SELECT json_group_array(id) FROM (SELECT id FROM aj_car_photos WHERE car_id=c.id ORDER BY id)) AS photos
    FROM aj_cars c WHERE c.id=? AND c.status='published'`).bind(id).first<Advert & { photos: string }>();
  return car ? { car, photoIds: JSON.parse(car.photos) as number[] } : null;
}

export async function publishedPhoto(db: D1Database, carId: number, photoId: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const data = await db.prepare(`SELECT data FROM aj_car_photos p JOIN aj_cars c ON c.id=p.car_id
    WHERE c.status='published' AND c.id=? AND p.id=?`).bind(carId, photoId).first<number[] | ArrayBuffer>('data');
  return data ? new Uint8Array(data) : null;
}

function specifications(car: Car): [string, string][] {
  const fields: [string, string][] = [];
  if (car.model_year != null) fields.push(['Årgang', String(car.model_year)]);
  if (car.mileage_km != null) fields.push(['Kilometerstand', dk.format(car.mileage_km) + ' km']);
  if (car.fuel) fields.push(['Drivmiddel', car.fuel]);
  if (car.transmission) fields.push(['Gearkasse', car.transmission]);
  return fields;
}

function pageLink(page: number): string {
  return page === 1 ? carListPath : carListPath + '?side=' + page;
}

function carPreview(car: Preview): string {
  const link = carListPath + '/' + car.id;
  const title = esc(car.title);
  const facts = specifications(car).map(([, value]) => esc(value)).join(' · ');
  return `<li class="car-preview"><article>
    <a class="car-preview-link" href="${link}">
      ${car.cover == null ? '' : `<img class="car-cover" src="${link}/billeder/${car.cover}" alt="" loading="lazy" decoding="async">`}
      <h2>${title}</h2>
    </a>
    ${facts ? `<p class="car-facts">${facts}</p>` : ''}
    <p class="car-preview-price">${dk.format(car.price_dkk)} kr.</p>
  </article></li>`;
}

export function carIndex(cars: Preview[], page: number): string {
  return `<section class="container cars-page">
    <header class="page-heading"><h1>Biler til salg</h1></header>
    ${cars.length ? `<ul class="car-grid">${cars.slice(0, carsPerPage).map(carPreview).join('')}</ul>` :
      `<div class="cars-empty"><p>Vi har ingen biler annonceret lige nu.</p>
      <p>Leder du efter en bestemt bil? <a href="${AJ_TELEPHONE}">Ring til os på ${AJ_PHONE}</a>.</p></div>`}
    ${page > 1 || cars.length > carsPerPage ? `<nav class="car-pages" aria-label="Sider med biler">
      ${page > 1 ? `<a href="${pageLink(page - 1)}" rel="prev">Forrige side</a>` : ''}
      ${cars.length > carsPerPage ? `<a href="${pageLink(page + 1)}" rel="next">Næste side</a>` : ''}
    </nav>` : ''}
  </section>`;
}

export function carDetail(car: Advert, photoIds: number[]): string {
  const title = esc(car.title);
  const facts = specifications(car);
  return `<article class="container car-detail">
    <header class="page-heading"><a href="${carListPath}">Alle biler til salg</a><h1>${title}</h1></header>
    <div class="car-details-layout${photoIds.length ? ' has-photos' : ''}">
      ${photoIds.length ? `<a class="car-primary-photo" href="${carListPath}/${car.id}/billeder/${photoIds[0]}">
        <img src="${carListPath}/${car.id}/billeder/${photoIds[0]}" alt="${title}" fetchpriority="high" decoding="async"></a>` : ''}
      <div class="car-terms"><p class="car-price">${dk.format(car.price_dkk)} kr.</p>
        ${facts.length ? `<dl class="car-specs">${facts.map(([label, value]) =>
          `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>` : ''}
        ${car.description ? `<p class="car-description">${esc(car.description)}</p>` : ''}
        <a class="button" href="${AJ_TELEPHONE}">Ring om bilen på ${AJ_PHONE}</a>
      </div>
      ${photoIds.length > 1 ? `<div class="car-gallery">${photoIds.slice(1).map((photo, i) => {
        const url = carListPath + '/' + car.id + '/billeder/' + photo;
        return `<a href="${url}"><img src="${url}" alt="${title}, foto ${i + 2} af ${photoIds.length}" loading="lazy" decoding="async"></a>`;
      }).join('')}</div>` : ''}
    </div>
  </article>`;
}
