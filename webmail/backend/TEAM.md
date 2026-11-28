# Company chat and intranet

`team.py` adds authenticated `/api/team/*` routes to the existing Flask gateway.
The existing origin-token, browser Origin, session, credential-generation and
CSRF checks remain mandatory. There are no public team routes or sharing links.

Each request calls the private Unix-socket broker's `POST /team/directory` with
an empty JSON body and the already authenticated address in `X-Veyro-Actor`.
The broker derives the domain from that address, verifies an active hosted
organization and eligible ordinary Mailcow mailboxes, and returns only the
colleagues' email addresses and display names. Disabled, shared, external-auth,
resource, native-administrator, forced-reset and unsupported-TFA accounts are
excluded. The home owner may participate in `veyro.dk`. A platform role never
selects another company's team. The broker rejects supplied domain/actor fields.

The webmail service defensively validates the broker response and requires the
actor to remain in the live directory on every request. Directory outages fail
closed. No directory cache delays disabling a colleague. Existing private
conversation history remains accessible to its other active participants, but
sending stops while any participant is disabled; start a new conversation with
active colleagues. Administrators cannot read or moderate DMs they did not join.

## Storage and rollout

Deploy `team.py` with `app.py` to the webmail service, and deploy the updated
`org_admin.py` and `org_broker.py` to the private administration broker. Restart
both services. The Worker must allowlist the team paths and permit at most
7 MiB JSON on `POST /api/team/files` only. Deploy the updated
`origin/mail-api.caddy` with `origin/publish.sh` as well: its exact POST upload
matcher permits 7 MiB before stripping `/webmail-api`, while every other method
and API route retains 256 KiB. Publishing validates Caddy before reloading and
restores the old configuration on failure.
No new native Mailcow API capability, privileged credentials or SQL grants are
needed by the webmail process. The broker reuses its existing Mailcow read and
role lookup facilities.

The first authorized request lazily creates
`/var/lib/veyro-webmail/team/team.sqlite3` under the existing durable data mount.
The child directory is mode `0700`; the database is `0600`. Documents are SQLite
BLOBs, so the database and its transaction journal are the complete persistent
state. Include this directory in the existing private backup/restore policy;
use SQLite's backup facility or stop the service before copying a live DB.
No migration command is needed for this initial additive schema.

Tables: `channels`, `participants`, `messages`, `reads`, `posts`, `files`,
`post_files` and `audit`. Each resource carries an immutable tenant and generated
UUID. Internal monotonic sequence numbers support stable pagination and read
positions. Foreign keys, unique client-send IDs, `BEGIN IMMEDIATE` transactions
and parameterized SQL protect integrity. The database is capped at about 1 GiB,
with a 250 MiB live-document quota per company and at most 2,000 conversations
per company. Failed writes roll back. Deletions clear message/post bodies or
document bytes and preserve identity/audit metadata. Audit records contain the
actor, tenant, action, target and UTC timestamp, never message bodies.

## API contract

All IDs, including `clientId`, are canonical lowercase UUID strings. Timestamps
are ISO 8601 UTC strings. POST accepts JSON and rejects unknown keys. Errors use
the existing `{error: string}` envelope. Deletions/read updates return `{ok:true}`.
Create operations return HTTP 201, updates/retries return 200, ownership failures
403, inaccessible/foreign resources 404, stale versions/reused IDs 409, excessive
payloads 413, unsupported files 415, throttled calls 429 and storage/broker outage
503. A withdrawn session fails at the gateway with 401.

- `GET /api/team/bootstrap` returns `{email,domain,companyName,canManage,members,
  channels}`. Members are `{email,name}`. It creates `Generelt` once per tenant.
  A channel is `{id,name,type,members,lastId,unread}`. Type is `channel` or `direct`;
  company channels have an empty members array and include all active colleagues.
  A DM's members array contains its participants' email addresses. `lastId` is
  null for an empty channel; `unread` excludes your own and deleted messages.
- `POST /api/team/channels` accepts `{type,name?,members?}` and returns `{channel}`.
  Admins create company channels (name required, at most 80 characters). Any
  colleague can create a direct conversation with 1–11 other active colleagues.
  Its sender is always included; an identical participant set reuses its DM.
- `GET /api/team/messages?channel=<uuid>&before=<uuid>&q=<text>` returns
  `{messages,nextBefore}`. Each message is `{id,channel,author,text,createdAt,
  deleted}`. The latest 50 matching messages are returned in chronological order;
  `nextBefore` is the oldest displayed UUID only if more earlier matches exist.
- `POST /api/team/messages` accepts `{channel,text,clientId}` and returns
  `{message}`. Text is 1–8,000 characters. Retrying the same sender/clientId and
  content returns the original message even after restart. Reusing that ID for
  another channel or content is a conflict. Persist the clientId until a send
  succeeds; a retry of a subsequently deleted message returns its tombstone.
- `POST /api/team/messages/<uuid>/delete` accepts `{}`. The author or a company
  admin who can access that conversation can remove its text. The visible
  tombstone retains author/time and its read/pagination position.
- `POST /api/team/read` accepts `{channel,lastId}`. `lastId` must be an existing
  message in that channel. Read positions only move forward.
- `GET /api/team/posts?q=<text>&before=<uuid>` returns `{posts,nextBefore}`.
  Posts are `{id,title,body,pinned,author,createdAt,updatedAt,version,attachments}`.
  Attachments are file metadata objects. Pinned posts come first, then ordinary
  posts, newest first within each group, at most 50 per page. The UUID cursor
  resolves both the pinned state and internal sequence, so an old pinned post
  appears above newer ordinary posts across page boundaries.
- `POST /api/team/posts` accepts `{title,body,pinned?,attachments?}` and returns
  `{post}`. Title is 1–180 and body 1–30,000 characters. Attachments are up to ten
  existing company file UUIDs. Any active colleague can publish. Only admins can
  pin; authors can edit a pinned post without changing its pinned state.
- `POST /api/team/posts/<uuid>/update` accepts the same full content plus required
  integer `version`. Only the author or current company admin can update. A
  successful edit increments the version. Omitted attachments clear the list;
  omitted pinned retains its current value. Stale versions return 409.
- `POST /api/team/posts/<uuid>/delete` accepts `{version?}`. It checks author/admin
  rights and any supplied version, and detaches documents without deleting them.
- `GET /api/team/files?q=<text>&before=<uuid>` returns `{files,nextBefore}`,
  newest first, at most 50. Metadata is `{id,name,contentType,size,author,createdAt}`.
- `POST /api/team/files` accepts `{name,contentType,data}` where data is strict
  standard base64, and returns `{file}`. File bytes must be 1–5 MiB. These are
  **company-shared documents**, not private DM attachments. The original filename
  is validated; its extension, content type and content signature must agree.
  Allowed: PDF, PNG, JPEG, GIF, WebP, UTF-8 TXT, DOCX and XLSX. SVG, HTML, scripts,
  arbitrary ZIP and Office files containing VBA project payloads are rejected.
  Office ZIP metadata is bounded and traversal paths are rejected.
- `GET /api/team/files/<uuid>` downloads a document; `/download` is an alias.
  Both require live membership and matching tenant ownership. Responses use
  attachment disposition, safe Unicode filenames, `nosniff`, a sandbox CSP and
  `Cache-Control: no-store, private`.
- `POST /api/team/files/<uuid>/delete` accepts `{}` and checks author/admin rights.
  It removes bytes, unlinks the file from posts, and leaves an audit record.

Search is literal substring matching (SQL wildcards are escaped), max 120
characters. UUID cursors are resolved within the current tenant and, for
messages, the requested conversation. Render all text as plain text using
`textContent`; API input is not trusted HTML. Files are delivered as downloads,
not embedded as active content. File signature validation is not antivirus
scanning.

Rate limits use the existing bounded per-process gateway limiter keyed by the
authenticated mailbox: 240 list reads/minute, 60 messages/minute, 120 read
updates/minute, 60 other mutations/minute, 60 downloads/minute, 20 channel
creations/hour, 30 post writes/hour and 20 uploads/hour. Limits reset on worker
restart; persistent quotas and transactional uniqueness remain in the DB.

## Verification

`python -m unittest test_team test_org_broker -q` uses only synthetic companies,
temporary private SQLite files and mocked credential/broker sources. It covers
tenant and private-conversation isolation, role boundaries, authoritative
membership revocation, strict payloads, concurrent idempotent retries, durable
state, read cursors, pagination/literal search, conflict detection, audit records,
document validation/quotas/deletion, and the real gateway's session, Origin,
CSRF, generation-revocation and upload-size boundaries. No fixture sends mail,
contacts a live broker, or changes production data.

`CADDY_BIN=/path/to/caddy python3 webmail/origin/test_body_limits.py` additionally
adapts/validates the real Caddy snippet and runs it against a disposable loopback
upstream. It verifies 7 MiB upload/256 KiB ordinary limits for declared and chunked
bodies, method/path boundaries, prefix stripping and removal of untrusted proxy
headers. No production endpoint is used.
