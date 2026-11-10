# Webshop payment setup

SBB's shop uses Stripe-hosted Checkout for online payment and delivery in Denmark. Product prices and delivery fees are stored in øre. Checkout totals are computed on the server. Stock is reserved during checkout and an order becomes paid only after a signed Stripe event or an authenticated Stripe session lookup confirms the exact amount and currency.

## Isolated local testing

Use the dedicated Stripe CLI profile `sbb-local-development`. It is a claimable test sandbox created for `marcus@veyro.dk`, not a live merchant account and not Veyro's live payment account. The temporary sandbox expires on **17 November 2026** unless claimed. Claim it with:

```sh
stripe sandboxes claim --project-name sbb-local-development
```

Claiming/onboarding may require the account owner to sign in and accept Stripe's terms. Do not use the test environment to accept real orders.

The local ignored `stylebybrothers/.dev.vars` contains only local configuration and sandbox secrets:

- `DEV_LOGIN=1`
- `SITE_URL=http://localhost:8788`
- `SBB_STRIPE_SECRET_KEY`
- `SBB_STRIPE_WEBHOOK_SECRET`

Never commit `.dev.vars` or copy these test credentials to the public frontend.

Forward test events while running the local Worker:

```sh
stripe listen --project-name sbb-local-development \
  --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired \
  --forward-to http://localhost:8788/api/shop/webhook
```

The webhook signing secret must match the local listener's secret. The API key and signing secret are different credentials.

## Live launch requirements

Before enabling real payments:

1. Create or claim the correct SBB merchant account and complete Stripe onboarding with the barber's verified business and payout details. Changing an email address alone does not transfer merchant ownership.
2. Prefer a restricted API key with Checkout Sessions read and write access. It must permit creating, retrieving and listing sessions; write access must also allow expiring a session for operational cancellation. Validate those exact operations in the sandbox with the restricted key before launch (a key that only creates sessions cannot safely reconcile reserved stock). Store it as `SBB_STRIPE_SECRET_KEY` on the **stylebybrothers** Worker, separately from Veyro's payment credentials.
3. Register `https://sbb.veyro.dk/api/shop/webhook` in the SBB Stripe account for the four events listed above, and save its signing secret as `SBB_STRIPE_WEBHOOK_SECRET` on that Worker.
4. In the SBB product administration, enter the actual delivery price, delivery times, and approved sales-terms URL, then enable delivery. Add the barber's actual products and images, prices including VAT, and stock quantities.
5. Verify payment, cancellation, payment expiry, order appearance, delivery information and inventory changes in a sandbox before switching to live keys. Production refuses test keys; test Checkout is enabled only with `DEV_LOGIN=1` in local development. Never enable development login on the production Worker.

The storefront does not automatically purchase shipping labels or book a carrier. The barber dispatches the order and marks it as sent. Refunds are handled in Stripe. These are separate operational steps from accepting an online payment.

## Verification on 10 November 2026

A local test against the actual Stripe sandbox passed the following sequence:

- Existing admin login authenticated product management.
- Uploaded a local test image and created a clearly marked test product.
- Created a real Stripe-hosted Checkout Session with Denmark delivery and the expected server-calculated total.
- Repeated the checkout request with the same idempotency key: it returned the same session and reserved stock only once.
- Expired that session through Stripe. Stripe's signed `checkout.session.expired` event reached the local Worker through the CLI listener, set the order to expired and restored stock exactly once.
- Unpublished the temporary test product and restored the previous local delivery configuration.

No real money was charged. A completed customer payment and the live account's payout capability still require verification before launch.

## Inventory and operational limits

- Up to 200 product records, with draft/publish controls. Removing a product from the shop unpublishes it so historical order references remain valid.
- Up to 600 uploaded images. JPEG, PNG and WebP only; each upload is capped at 800 KiB and split into 64,000-byte chunks below the Durable Object value-size limit. The editor resizes images before uploading.
- The editor's stock field means **available stock excluding active reservations**. A revision conflict prevents an older editor from overwriting stock that changed during a checkout. Reload the product and apply the edit again.
- Each checkout accepts at most 20 distinct products, at most 20 of each. Duplicate lines are rejected. Checkout attempts are limited to 20 per hour per IP and 100 simultaneous pending sessions.
- Reservations last approximately 31 minutes. An expired session releases stock only once. A delayed webhook cannot release paid stock: reconciliation first asks Stripe whether the session is paid or expired. If Stripe cannot be reached, stock remains reserved until its status can be confirmed.
- After a lost session-creation response, the same attempt key is reused. Products, prices, delivery charges and Checkout metadata are frozen for that attempt; a changed cart requires a new key.
- The admin order view displays the latest 200 orders. Older records remain in durable storage; pagination/export is not included in this first version.
- Delivery uses one flat rate for Denmark. No carrier labels, tracking integration, automatic returns or automatic restocking after a refund are included. Refunded returns must be inspected and stock adjusted manually.
- Paid-order confirmation emails use the existing Resend integration and appear in **Sendte e-mails**. Payment events are idempotent, so duplicate events do not resend confirmations. Inspect failed email attempts in that log.

The current automated suite has 47 passing tests, including existing booking behavior, last-unit concurrency, multi-line inventory rollback, stale product edits, checkout retries, exact totals/currency, signature and origin validation, duplicate/late webhooks, image limits and production test-key blocking. A successfully created Checkout Session is not evidence of a completed customer payment.
