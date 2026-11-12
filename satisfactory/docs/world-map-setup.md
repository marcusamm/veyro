# Dedicated-server world map

The integration is prepared for Satisfactory 1.2 with Ficsit Remote Monitoring (FRM) 1.5.5. The website is a read-only view of the game world with a separate, shared planning overlay. It does not place buildings, change recipes, or send commands into the game.

**The friends’ dedicated server has not been set up yet.** Fixture, network-failure and website integration tests do not replace a connection test against that server. Until a real server sends a snapshot, the map must show “not connected” or “waiting,” not a demonstration labelled live.

## What the server needs

- A Satisfactory 1.2 dedicated server that supports Satisfactory Mod Loader and server-side mods. Install [FRM](https://ficsit.app/mod/FicsitRemoteMonitoring) with the compatible SML dependency; the FRM 1.5.5 listing specifies SML `^3.12.0`.
- A Node.js 22+ process on the same machine, container network, or a private network with access to FRM. A game-only hosting plan that prohibits both mods and an adjacent process will not support this setup. The bridge can run elsewhere on a private network if needed.
- Outbound HTTPS from the bridge to `satisfactoryvenner.veyro.dk`. The website never needs the game administrator password. The browser never receives a server API key.

Keep FRM’s port private with the host firewall/container network. Do not publish it to the Internet just to connect the map. FRM’s authentication token protects certain requests, not necessarily all read endpoints; it is not a substitute for network isolation. Public FRM URLs require explicit HTTPS and a trusted certificate in this bridge. TLS verification is never disabled.

## Enable FRM on Satisfactory 1.2

Use FRM’s **Dedicated Server** configuration in the in-game Server Manager. Enable HTTP server autostart and select its TCP port (default `8080`). Read the authentication token from the server configuration or startup log when needed.

As documented in [FRM’s current configuration guide](https://docs.ficsit.app/ficsitremotemonitoring/latest/config/current/config.html), 1.2 uses `GameUserSettings.ini`; old `WebServer.cfg`/`MonitoringConfig.cfg` settings no longer control it. Dedicated-server keys start with `FicsitRemoteMonitoring.Server`:

| Setting | Key suffix | Setting type |
| --- | --- | --- |
| HTTP autostart | `.uWS.Autostart` | `mIntValue` |
| HTTP port | `.uWS.Port` | `mStringValue` |
| API token | `.uWS.AuthenticationToken` | `mStringValue` |
| Spline sample spacing | `.General.SplineSampleDistance` | `mFloatValue` |

The saved configuration is under `FactoryGame/Saved/Config/LinuxServer/GameUserSettings.ini` on Linux or `FactoryGame/Saved/Config/WindowsServer/GameUserSettings.ini` on Windows. Prefer the supported settings UI to hand-writing Unreal’s serialized settings entries. For a large save, try a spline spacing of 200–1000 cm to reduce payloads; smaller spacing preserves finer curves. Restart/reload as required by the host and verify the HTTP server is running.

## Create the website connection

1. Sign in to [Satisfactory Venner](https://satisfactoryvenner.veyro.dk/) as **marcus** and open the world map’s server connection settings.
2. Create a connection token and copy it directly into the bridge host’s secret/environment settings. It can only upload map snapshots; it cannot sign in as a user or administer the website.
3. Set a stable, explicit `WORLD_ID`, for example `friends-main-world`. Keep this value when restarting the bridge or continuing the same save. Never reuse it for a different save: FRM cannot detect that an operator has pointed the bridge at another world. Keep only one running bridge per world. A token rotation does not silently change the connected world or erase plans.

Do not paste a token into chat, source control, a URL, or command-line arguments. Store it in the host’s secret store or a service environment file readable only by the service account. The token can be revoked/rotated by Marcus if needed. The optional FRM token and the website connection token are different credentials.

## Start the bridge

Download the bundled bridge from the website’s connection panel (published as `/integrations/world-map-bridge.mjs`). It is a single dependency-free Node.js file. The source version also runs from this repository as `node scripts/world-map-bridge.mjs`.

Configure these environment variables on the host:

| Variable | Required/default | Meaning |
| --- | --- | --- |
| `WORLD_INGEST_TOKEN` | Required | The 64-character token created by Marcus |
| `WORLD_ID` | Required | Stable identifier for this save/world, max 128 characters |
| `WORLD_NAME` | Required | Display name, max 160 characters |
| `FRM_URL` | `http://127.0.0.1:8080` | FRM root URL, without an endpoint path |
| `FRM_AUTH_TOKEN` | Optional | FRM token, sent only as `X-FRM-Authorization` to FRM |
| `WORLD_POLL_SECONDS` | `15`, minimum `10` | Delay after a completed upload, in seconds |
| `FRM_ENDPOINTS` | All endpoints listed below | Optional explicit comma-separated subset |
| `WORLD_INGEST_URL` | `https://satisfactoryvenner.veyro.dk/api/world/ingest` | Only override for an intentionally configured HTTPS website endpoint |

After the environment is set, run:

```sh
node --version
node world-map-bridge.mjs
```

Use the host’s normal process supervisor to keep it running. With Node 22 you may alternatively use `node --env-file=/absolute/private/path/world-bridge.env world-map-bridge.mjs`; keep that file outside the repository, restrict its permissions, and do not publish it. For separate containers, `127.0.0.1` refers to the bridge container itself: use the game container’s private IP/network address. HTTP permits loopback/RFC1918/IPv6 ULA addresses; public names require HTTPS with a valid certificate. Private DNS names can be replaced with their private IP.

Success logs show only the observation time and entity/connection counts. The bridge never logs tokens, player names, inventories, or raw API bodies. Request errors back off up to five minutes. A failed endpoint, malformed schema, oversized response, or rejected upload keeps the last accepted map; the UI can mark that map stale.

## What is synchronized

Default read endpoints: `getFactory`, `getExtractor`, `getGenerators`, `getPlayer`, `getStorageInv`, `getSplitterMerger`, `getBelts`, `getLifts`, `getPipes`.

- Building class, actor ID, display name, position/elevation and orientation; recipe class, clock, reported power consumption and production state where supplied.
- Players’ **in-game display names**, positions and online state. Remove `getPlayer` from `FRM_ENDPOINTS` if you do not want player positions shared with signed-in friends.
- Sampled belt/pipe geometry and actual connector positions, including conveyor lifts. No item throughput is inferred from belt capacity. No geometry is made up for unsupported classes.
- No inventories, item contents, account/Steam identifiers, chat, email addresses, game administration credentials, vehicles, train rails, terrain tiles or save files are uploaded by this adapter. Unknown building classes are retained as markers. The website’s separately supplied terrain background is static; the bridge synchronizes the factory overlay, not a live rendered view of the terrain.

The HTTP endpoints are polled sequentially, so this is a near-live observation, not an atomic game save or frame-by-frame stream. The observation timestamp records the start of collection, conservatively covering the oldest read; the sequence number uses completion time. A growing factory may need a slower interval or coarser spline sampling. Each raw endpoint is limited to 16 MB, each request to 12 seconds, and the whole read cycle to 90 seconds; normalized uploads are limited to 8 MB, 30,000 entities, 30,000 connections, and 100,000 spline points. Responses exceeding a limit are rejected rather than truncated.

An unavailable endpoint is never automatically ignored. Update FRM to the supported version, or deliberately choose a documented subset in `FRM_ENDPOINTS`. Subsets intentionally omit those categories from the world map. No `getAll`, write endpoint, fallback administrator login, or insecure TLS bypass is attempted.

## Mapping assumptions and primary sources

The adapter is original code and copies no upstream implementation or player saves. The website separately serves an attributed static terrain asset from Satisfactory Tools; see `public/world-map/NOTICE.txt`. Field names and units were checked against upstream source at commit [`1d66b7b46513381f099029db7b7dd9f8a25fd085`](https://github.com/porisius/FicsitRemoteMonitoring/tree/1d66b7b46513381f099029db7b7dd9f8a25fd085), alongside the FRM 1.5.5 release listing. Some older endpoint examples differ from modern source:

- [`FactoryLibrary.cpp`](https://github.com/porisius/FicsitRemoteMonitoring/blob/1d66b7b46513381f099029db7b7dd9f8a25fd085/Source/FicsitRemoteMonitoring/Private/Endpoints/Factory/FactoryLibrary.cpp) emits `ManuSpeed` as percent. [`Power.cpp`](https://github.com/porisius/FicsitRemoteMonitoring/blob/1d66b7b46513381f099029db7b7dd9f8a25fd085/Source/FicsitRemoteMonitoring/Private/Endpoints/Factory/Power.cpp) also emits `CurrentPotential` as percent. The adapter does **not** multiply these by 100 or guess from their magnitude.
- [`RemoteMonitoringLibrary.cpp`](https://github.com/porisius/FicsitRemoteMonitoring/blob/1d66b7b46513381f099029db7b7dd9f8a25fd085/Source/FicsitRemoteMonitoring/Private/RemoteMonitoringLibrary.cpp) emits Unreal world coordinates in centimeters and rotates UE yaw into a compass bearing. The adapter keeps centimeters and converts bearing back to UE yaw with `(rotation - 90 + 360) % 360`.
- [`Logistics.cpp`](https://github.com/porisius/FicsitRemoteMonitoring/blob/1d66b7b46513381f099029db7b7dd9f8a25fd085/Source/FicsitRemoteMonitoring/Private/Endpoints/Factory/Logistics.cpp) supplies world-space spline samples and connector positions. Missing final samples are completed with the reported connector, not an estimated location.
- Actor IDs come from FRM. They are not regenerated per poll or derived from coordinates. Rebuilt actors, newly joined player characters, or changes made by the game/mod may receive different IDs; overlay planning notes remain separate from those live actors.

## First real-server verification still required

Once the dedicated server exists, check a known machine’s position/orientation, 100% and 250% clocks, a curved belt, a lift, a pipe and a player movement against the game. Place and remove a test building and verify its marker updates. Then stop FRM and confirm the last map remains with a stale indicator; restart it and confirm updates resume. Test a token rotation and ensure the old token stops uploading. Keep game settings at the agreed normal multipliers. These checks are intentionally outstanding until the actual server is available.
