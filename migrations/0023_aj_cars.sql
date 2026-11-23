CREATE TABLE aj_cars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  price_dkk INTEGER NOT NULL CHECK (price_dkk >= 0),
  model_year INTEGER,
  mileage_km INTEGER CHECK (mileage_km >= 0),
  fuel TEXT NOT NULL DEFAULT '',
  transmission TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'sold')),
  create_key TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX aj_cars_status_date ON aj_cars(status, created_at DESC, id DESC);

-- Keep photo bytes out of inventory queries. The first photo by id is the cover.
CREATE TABLE aj_car_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL REFERENCES aj_cars(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type = 'image/jpeg'),
  data BLOB NOT NULL CHECK (typeof(data) = 'blob' AND length(data) BETWEEN 1 AND 491520)
);
CREATE INDEX aj_car_photos_car ON aj_car_photos(car_id, id);
