# TikTok measurement on veyro.dk

The production marketing site pairs TikTok Pixel with Events API for `Pageview`
events on public Danish/English pages. Both transports use the same random UUID
as `event_id`; TikTok deduplicates them. This does not add purchase, lead, or
registration conversions.

Set `TIKTOK_EVENTS_ACCESS_TOKEN` as a **Secret** on the Cloudflare Worker `veyro`.
Never add the token to wrangler vars, theme settings, source control, or browser
code. Existing Worker secrets are preserved by normal deployments. Without this
secret the relay returns 503 `not_configured`; the browser pixel still works.

Both the browser and `/marketing/tiktok/events` require fresh explicit marketing
and TikTok consent (v2, max one year). DNT/GPC are respected. Revocation aborts a
pending browser relay and disables the pixel; already transmitted events cannot
be recalled. There are no background retries. The relay rejects cross-origin
requests, bots, private/unknown paths and all hosts except https://veyro.dk.

Server payload: page URL without query/fragment, event UUID/time, Cloudflare
connection IP, browser user agent, and optional `_ttp` cookie / `ttclid` click ID.
No form fields, email, phone, account identity, referrer, or query strings are
forwarded. The relay is rate limited using an existing short-lived hashed-IP
bucket. It does not store event payloads or create a new visitor database.

Verification: after marketing opt-in, inspect the POST to
`/marketing/tiktok/events`. HTTP 200 with `accepted: true` means TikTok's API
returned success code 0. Check Test Events/diagnostics in TikTok Events Manager
for reporting and deduplication; an API acknowledgement alone does not establish
attribution or campaign performance. Declining consent produces no SDK or relay
requests. Provider failures return a generic 502/503 and never expose the token.

References:
- https://ads.tiktok.com/resources/help/article/event-deduplication
- https://github.com/tiktok/gtm-template-pixel/blob/main/template.js
- https://business-api.tiktok.com/portal/docs
