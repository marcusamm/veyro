-- Hvor ordren kom fra. Ordrer fra webshoppen er 'hjemmeside'; medarbejdere kan oprette ordrer
-- fra telefon, e-mail eller direkte salg i administrationspanelet.
ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'hjemmeside'
  CHECK (source IN ('hjemmeside', 'telefon', 'email', 'direkte'));
CREATE INDEX idx_orders_created ON orders(created_at);
