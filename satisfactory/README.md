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
