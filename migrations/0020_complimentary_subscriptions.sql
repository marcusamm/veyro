-- Explicit non-billing agreements. Existing Stripe subscriptions retain their behavior.
ALTER TABLE subscriptions ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'stripe'
  CHECK (billing_mode IN ('stripe', 'complimentary'));
ALTER TABLE subscriptions ADD COLUMN agreement_note TEXT;
ALTER TABLE subscriptions ADD COLUMN website_url TEXT;
ALTER TABLE subscriptions ADD COLUMN website_admin_url TEXT;

CREATE TRIGGER complimentary_subscription_insert BEFORE INSERT ON subscriptions
WHEN NEW.billing_mode = 'complimentary' AND
  (NEW.amount IS NOT 0 OR NEW.price_id IS NOT NULL OR NEW.item_id IS NOT NULL OR
   NEW.current_period_end IS NOT NULL OR NEW.payment_failed != 0 OR NEW.id LIKE 'sub_%')
BEGIN SELECT RAISE(ABORT, 'INVALID_COMPLIMENTARY_SUBSCRIPTION'); END;
CREATE TRIGGER complimentary_subscription_update BEFORE UPDATE ON subscriptions
WHEN NEW.billing_mode = 'complimentary' AND
  (NEW.amount IS NOT 0 OR NEW.price_id IS NOT NULL OR NEW.item_id IS NOT NULL OR
   NEW.current_period_end IS NOT NULL OR NEW.payment_failed != 0 OR NEW.id LIKE 'sub_%')
BEGIN SELECT RAISE(ABORT, 'INVALID_COMPLIMENTARY_SUBSCRIPTION'); END;

-- An operation can run once only; subsequent deployments never reactivate an ended agreement.
CREATE TABLE customer_provisioning_operations (
  id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  document_sha256 TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  verified INTEGER NOT NULL CHECK (verified = 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
