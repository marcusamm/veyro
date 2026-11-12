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
