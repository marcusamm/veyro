-- Photos belong to a saved car. Start with a draft before publishing its gallery.
CREATE TRIGGER aj_car_published_insert BEFORE INSERT ON aj_cars
WHEN NEW.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'AJ_CAR_NEEDS_PHOTO');
END;

CREATE TRIGGER aj_car_published_update BEFORE UPDATE OF status ON aj_cars
WHEN NEW.status = 'published'
  AND NOT EXISTS (SELECT 1 FROM aj_car_photos WHERE car_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'AJ_CAR_NEEDS_PHOTO');
END;

CREATE TRIGGER aj_car_published_photo_delete BEFORE DELETE ON aj_car_photos
WHEN EXISTS (SELECT 1 FROM aj_cars WHERE id = OLD.car_id AND status = 'published')
  AND NOT EXISTS (SELECT 1 FROM aj_car_photos WHERE car_id = OLD.car_id AND id <> OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'AJ_CAR_LAST_PHOTO');
END;
