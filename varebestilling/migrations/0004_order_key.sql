-- Engangsnøgle pr. udfyldt kasse: samme bestilling sendt to gange (dobbeltklik, genforsøg efter timeout,
-- tilbage-knappen) giver kun én ordre og trækker/reserverer kun lageret én gang.
ALTER TABLE orders ADD COLUMN client_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_key ON orders(client_key) WHERE client_key IS NOT NULL;
