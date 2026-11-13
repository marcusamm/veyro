# Satisfactory venner

A small private checklist and recipe planner for friends at satisfactoryvenner.veyro.dk.

## Local development

Node 22+, `npm ci`, `npm run build`, then `npx wrangler d1 migrations apply DB --local --persist-to .wrangler/friends` and `npm start`.
For frontend hot reload, run `npm run dev:worker` plus `npm run dev`.

This application has its own database, usernames, passwords and sessions. It does not use Veyro customer accounts or ChatGPT sign-in. Marcus is the only administrator. Marcus creates player accounts from **Players & account**. Players can edit the shared plan, assign tasks, maintain notes, and change their own password.

## Deployment

The `Deploy Satisfactory venner` GitHub Actions workflow builds and tests only this application, provisions its own D1 database, applies schema migrations and deploys its Worker/custom domain. It uses the existing CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets.

Passwords, real plan data, PDF documents, cookies, migration exports and bootstrap tokens must never be committed. The repository contains application code only. Actual plans and PDF originals are imported over authenticated HTTPS into the separate D1 database. A one-time setup endpoint uses a short-lived high-entropy token whose SHA-256 hash is configured on the Worker; it closes permanently after Marcus is created.

## Checks

`npm test`, `npm run typecheck`, and `npm run build`.

The live board has optimistic revision checks: a stale save cannot silently overwrite changes from another player. Use **Save changes** after editing. Original PDFs remain separate from editable plan data. Backups and print exports are available from the planner.

## Factory planner

Open **Factory planner** in the navigation. The separate shared layout is stored in
`factory_layouts`, with the same independent player accounts and revision protection.
Factory edits do not change either document. Navigation preserves an unsaved layout;
save it before leaving the site, or export a JSON backup.

The factory catalog is pinned to Satisfactory **1.2.5.0**, Steam build **26281294**:
276 production recipes (including alternates), 175 items and 11 production machines.
The normal recipe and power multipliers are **1×**. Each production machine has its
own **1–250% clock speed**, recipe and supported Somersloop count. Transport limits
cover belt Mk.1–6 and pipe Mk.1–2. All ingredient, output and power calculations use
the versioned game export; see [data provenance and formulas](app/factory/data/NOTICE.md).

The board is a schematic top-down planner. Positions and displayed machine sizes
are not verified in-game footprints. Calculations describe ideal steady production,
limited by supplied inputs, connected outputs and transport capacity. They are not
a game-tick, travel-time, pipe-pressure or head-lift simulation. Recycling loops are
marked unsupported for network flow; their individual recipe rates remain visible.
In networks where several splitters and mergers compete, the displayed feasible
allocation may differ from the game's round-robin scheduling. Power totals cover
production machines; resource extraction, standby draw and the power grid are excluded.
FICSMAS and handcraft-only recipes are excluded. The original PDF figures remain
editable reference text, independent of the calculator.

The additional checks exercise catalog normalization, production and power rates,
transport limits, splitting/merging, invalid layouts, authenticated shared saves,
concurrent revision conflicts and isolation from the original plans.

## Production calculator and build templates

The factory workspace now contains an output-driven production calculator alongside
the existing manual layout. Set one or more target rates, available inputs, recipe
choices, transport tiers and machine clocks. The calculator solves upstream
requirements and recycling loops, shows surplus, and offers target/maximize modes
with resource, power or building objectives. Input caps default off for targets and
on for maximum output; uncapped inputs can be supplemented by production. Raw resources not explicitly capped remain
available unless the closed budget is selected.

The template library provides 14 scalable, authored production chains with machine
counts, clocks, material flows and build steps. Templates update the calculator
draft and do not replace the existing shared manual layout. Somersloops can be set
manually per machine or allocated from a global whole-item inventory. Automatic
allocation uses recipe variants, greedy rounding and bounded branch-and-bound;
its result always respects installed stock and warns if the search was cut short.
The flow view
is schematic; transport counts are aggregate lower bounds. These are instructions
for building in the game, not downloadable game blueprints.

Migration **`0004_production_plan.sql`** creates the separate `production_plans`
table. It is applied by the existing deployment workflow along with earlier
migrations. The authenticated `/api/production` endpoint stores requests with the
same optimistic revision protection as other shared plans. Use **Save changes** to
publish a draft to the other players, or export a JSON backup.

The reference source, numerical benchmark cases and remaining differences are
documented in [production parity](docs/production-parity.md). Recipe data remains
pinned to 1.2.5.0; full one-to-one equivalence with every live Satisfactory Calculator
feature is not claimed.

## World map

Open **World map** for a separate top-down view in real game coordinates. The
terrain is a locally served, attributed game-map overview, not a server snapshot.
It is available before the dedicated server exists. Players can save proposed
machines, notes and areas on a separate shared layer. Heights, rotation and clock
speeds are editable; symbols are not precise building footprints. These proposals
never place, remove or change anything in the game, and do not alter the schematic
factory calculator or original documents.

Marcus can create or revoke an ingest-only connection token. A small Node 22
bridge runs beside the dedicated server, reads Ficsit Remote Monitoring and sends
bounded snapshots over HTTPS. Players see observed building positions, conveyor
and pipe geometry, selected reported machine properties and online players.
Unreported objects are not invented. The bridge uses only read endpoints and
does not publish inventories, account identifiers or server credentials.

The view distinguishes **not connected**, **waiting**, **live** and **stale** and
shows when data was last received. Updates are periodic snapshots, not a
frame-by-frame game stream. Planning drafts are preserved during updates and
concurrent saves require revision matching.

See [dedicated-server setup](docs/world-map-setup.md) for supported FRM/SML
versions, downloadable bridge, configuration and limits. No real dedicated
server was available during implementation: adapter fixtures, HTTP contracts,
authorization and local synthetic-world flows are tested; live-game connection,
server performance and mod compatibility still require checking on your host.
No game server is created or purchased by this application.
