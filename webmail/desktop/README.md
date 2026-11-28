# Veyro Mail desktop

Veyro Mail `0.1.0-beta.1` is an Electron desktop app for macOS and Windows. It keeps the existing Veyro Mail interface and adds a compact account rail, independent account sessions, native attachment saving, and a native IMAP/SMTP client for other providers.

## Account support

- **Veyro:** the existing service at `https://mail.veyro.dk`, including its web login, mail, chat at `/team#chat`, and intranet at `/team#intranet`. Chat and intranet require a Veyro account and the matching web/backend deployment.
- **Other IMAP/SMTP services:** manually enter the provider's hostnames, ports, usernames and password or app password. TLS certificate verification is mandatory; port 143/587 uses required STARTTLS. The native client supports folders, paginated server search, message reading, compose/reply/forward, attachments, read/star/archive/trash, and encrypted local drafts.
- **Gmail:** app-password login where the account policy permits it. Browser OAuth is implemented but unavailable in the supplied build until Veyro supplies a registered desktop OAuth client.
- **Outlook / Microsoft 365:** requires the implemented browser OAuth flow and a registered Microsoft public-client app. The supplied build leaves this connection button disabled. Tenant policy must also permit IMAP and authenticated SMTP. An ordinary password is not presented as a workaround.

This is not a promise that every mail service can connect: providers without supported IMAP/SMTP access, POP-only services, provider-specific bridges and tenant policies may need separate support. No provider credentials or OAuth registrations have been invented. Live customer-provider authentication and delivery have not been verified in this workspace.

Native rich mail uses sanitized HTML in an opaque sandboxed frame, preserving supported passive typography, tables and inline raster images. Remote images require an explicit choice for each message. Only the sanitized message's exact HTTPS image URLs are admitted; redirects outside that list remain blocked. A plain-text view is available. Scripts, forms, embeds and external stylesheets/fonts never run. Attachments are saved through a native dialog and never opened automatically.

## Run and test

Use Node 22 or newer and npm in this directory. Electron `45.5.0` and electron-builder `26.18.0` are pinned; install from the committed lockfile.

```sh
npm ci
npm test
npm run test:smoke
npm start
```

`npm test` covers transport validation, MIME, pagination and UID handling, send outcomes, credential storage, URL policy and OAuth PKCE/callback/refresh rules. `npm run test:smoke` starts real Electron with a synthetic local HTTP mail server and temporary user data, checking renderer sandboxing, account isolation, trusted IPC, link handling, downloads, navigation, offline/retry, encrypted drafts, opaque email frames and account removal. It never logs into a real mailbox or sends real mail. The deliberate offline case prints an expected `ERR_EMPTY_RESPONSE` warning.

The test-origin override exists only in an explicitly invoked, unpackaged test harness with `VEYRO_DESKTOP_TEST=1`. The packaged app ignores that setting and cannot accept a development origin through command-line arguments. Test scripts are excluded from installer archives.

## Build installers

On macOS, build one architecture at a time if disk space is limited:

```sh
npx electron-builder --mac dmg --arm64 --publish never
npx electron-builder --mac dmg --x64 --publish never
npm run build:win
npm run checksums
```

The convenience command `npm run build:mac` builds both Mac architectures. Output names:

| Platform | Installer |
| --- | --- |
| Apple Silicon Mac | `dist/Veyro-Mail-0.1.0-beta.1-mac-arm64.dmg` |
| Intel Mac | `dist/Veyro-Mail-0.1.0-beta.1-mac-x64.dmg` |
| Windows x64 | `dist/Veyro-Mail-0.1.0-beta.1-win-x64.exe` |
| Integrity checks | `dist/SHA256SUMS.txt` |

Mac installers contain a drag-to-Applications app. The Windows installer uses NSIS, offers an installation directory, and installs per user. Uninstallation deliberately retains user data; use **Fjern fra computeren** in the app to remove a saved account and its local data.

`.github/workflows/mail-desktop.yml` tests and builds on native `macos-15` (arm64), `macos-15-intel` (x64), and `windows-2022` (x64) runners. It also installs and launches the Windows artifact in the disposable runner, and verifies each Mac bundle's ad-hoc signature. A pull request touching the desktop directory or a manual workflow dispatch produces downloadable workflow artifacts and SHA256 files. It has read-only repository permissions and **does not publish a release or deploy production**. GitHub runner labels were checked against the [current runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Cross-building Windows on a Mac is best effort; native Windows CI remains the authoritative build and installation environment. See [electron-builder's multi-platform guidance](https://www.electron.build/docs/features/multi-platform-build/). Allow several GB of free disk space for Electron caches, staged apps and installers.

## Signing and public distribution

These are beta artifacts. The Mac app has an **ad-hoc signature**, which is not an Apple Developer ID publisher signature, and is **not notarized**. The Windows EXE has **no Authenticode publisher signature**. Gatekeeper or SmartScreen may prevent or warn about installation. No signing identity, certificate, Apple account, private key or timestamp service credentials are included.

Before unrestricted public distribution, obtain the owner's Developer ID Application certificate and Apple notarization credentials, replace `build.mac.identity: "-"` and `notarize: false` with the real signed/notarized configuration, and configure Windows signing with the owner's certificate or trusted signing service. Keep signing secrets in a protected CI environment, never in this repository. Validate the signed app/installer and notarization ticket on clean target machines before publishing. See [macOS build options](https://www.electron.build/docs/mac/) and [code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing).

The application has no automatic updater in this prerelease. Users install a newer verified installer to update. Files in `dist/` are local build outputs and are ignored by Git; upload approved installers and the matching checksum file only after deciding on a release destination.

## Google and Microsoft OAuth registration

`oauth-config.json` intentionally contains empty client IDs. The UI reports provider login as unavailable until configured. Set the public desktop IDs in that file before packaging, or use these process environment variables for a controlled development run:

```text
VEYRO_GOOGLE_CLIENT_ID
VEYRO_GOOGLE_CLIENT_SECRET       # only when issued for a Google Desktop client
VEYRO_MICROSOFT_CLIENT_ID
```

Endpoints, scopes and redirect paths are fixed in `oauth.cjs`; renderer input cannot supply an authorization/token endpoint. Never put a confidential web-server client secret into a distributable app. A Google desktop-client secret, when issued, is a public-client credential and cannot be treated as confidential inside a desktop package.

**Google:** create an OAuth client of type **Desktop app**, configure the consent screen, approved users/testing status and Gmail scope `https://mail.google.com/`. The app uses a random port on `http://127.0.0.1:<port>/oauth/callback`, an external system browser, S256 PKCE, state validation and offline access. Gmail's full mail scope may require provider verification/security assessment before broad use. Follow [Google's desktop OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app) and [Gmail OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

**Microsoft:** register a **Mobile and desktop applications / public client** app. Choose the intended account audience (organizational accounts and personal Microsoft accounts if both are supported). Register `http://localhost/oauth/callback`; Microsoft ignores the ephemeral port for localhost matching. Enable the required delegated permissions `https://outlook.office.com/IMAP.AccessAsUser.All`, `https://outlook.office.com/SMTP.Send`, and `offline_access`. Administrative consent and mailbox/tenant SMTP AUTH policy may be required. The app binds its callback listener to IPv4 loopback and verifies the exact Host, callback path and state. Follow [Microsoft's IMAP/SMTP OAuth guide](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth) and [localhost redirect rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url#localhost-exceptions).

The user enters a mail address before browser authorization. The resulting token is tested against the provider's fixed IMAP/SMTP hosts for that address before it is stored. There is no trust in unvalidated ID-token claims. Refresh tokens and access tokens stay in the OS-encrypted vault; only provider availability and public account settings reach the renderer. OAuth tests use synthetic callbacks and token responses. A real consent/refresh/send verification remains necessary after the registrations are supplied.

## Security and local data

- Every Veyro account has a unique persistent Chromium partition. Adding a second account never copies another account's cookies or local storage.
- Remote Veyro pages load only from `https://mail.veyro.dk`, with sandboxing, context isolation and Node integration disabled. They receive **no preload or desktop bridge**. The website's own authenticated API remains unchanged.
- The local shell and native mail client use different `veyro://` origins and fixed packaged resources. IPC checks the exact document, WebContents and main frame; a sender cannot choose a different account's identity.
- Native account credentials, OAuth tokens and drafts use Electron's asynchronous OS-backed `safeStorage`; unsupported/plaintext storage backends are refused. Metadata in `accounts.json` contains only IDs, labels and account kind. This protects data at rest, not against someone already controlling the logged-in OS user.
- Changing an endpoint or username requires a new password; a blank password only reuses an existing credential for the exact previous host, port, TLS mode and username.
- The confirmed remove operation rejects new account IPC, cancels pending OAuth/downloads, drains existing operations, closes the renderer, and clears cookies, storage, cache, HTTP authentication data and the encrypted vault. Server mail is untouched.
- Remote-image consent is account/message bound, expires, and is cleared on a new message. Network headers omit Cookie, Authorization, Referer and Origin; image responses cannot set cookies.
- External HTTP(S)/mailto links require native confirmation. File, script, data and arbitrary OS protocols are rejected. Permission requests and webview creation are denied.
- Packaged Electron fuses disable RunAsNode, Node option/inspector environment entry points and non-ASAR application loading; cookie encryption and ASAR integrity validation are enabled.

User data normally lives under `~/Library/Application Support/Veyro Mail` on macOS and `%APPDATA%\Veyro Mail` on Windows. Do not copy credentials between operating-system users: the vault depends on the originating OS user's encryption keys.

The shell follows [Electron's security recommendations](https://www.electronjs.org/docs/latest/tutorial/security) and uses [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view). Keep the pinned runtime/dependencies current and rerun the native smoke/security suite when updating Electron.

The logo and Manrope font were copied from the existing Veyro webmail assets. The font's OFL license is included in `assets/Manrope-OFL.txt`.
