# Google release readiness

Reviewed 2026-11-28. Developer checklist; this is not a published privacy policy or a claim of Google approval.

## Current beta status

- Project `carbon-mediator-516101-q2` has a Google Auth Platform profile and **Desktop app** OAuth client. The owner accepted Google Cloud terms and the User Data Policy. Audience is **External / Testing**, with a test user added. Keep tester identities out of the repository.
- The requested scopes are `https://mail.google.com/ openid email profile`. Google Auth Platform includes the corresponding non-sensitive `openid`, `userinfo.email` and `userinfo.profile` entries alongside the restricted mail scope. The fixed Google UserInfo endpoint supplies a verified email, stable subject and display name; renderer input and unverified ID-token claims are not accepted as identity. Microsoft registration is deferred and its sign-in remains disabled.
- Registration values live in ignored `oauth-config.local.json`; committed `oauth-config.json` is an empty template. For development, use `VEYRO_OAUTH_CONFIG_FILE=./oauth-config.local.json npm start` from this directory. See [README](README.md) for configured builds. Ordinary CI builds have no registration and disable Google sign-in.
- A configured installer intentionally contains the Desktop client's registration values, including its issued public-client credential. Desktop clients cannot keep that credential confidential. User passwords and OAuth access/refresh tokens must never enter source, build artifacts or logs. Preserve GitHub's credential protection; do not bypass it or commit the local configuration.
- Real Google authentication, token refresh and delivery still need explicit beta validation; mocked tests do not establish provider approval or successful live mail delivery.

## Protocol and public-release decision

The implemented flow uses an external browser, S256 PKCE, random state, offline access and an ephemeral IPv4 loopback callback: `http://127.0.0.1:<port>/oauth/callback`. Authorization uses [Google's authorization endpoint](https://accounts.google.com/o/oauth2/v2/auth), token exchange/refresh uses [Google's token endpoint](https://oauth2.googleapis.com/token), and mail uses `imap.gmail.com:993` with TLS plus `smtp.gmail.com:587` with required STARTTLS and certificate validation. See [native-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app) and [Gmail XOAUTH2](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol).

This connector makes no Gmail REST API calls. Google documents full-mail OAuth authorization for IMAP/SMTP separately from Gmail REST. From that protocol design, Gmail REST API enablement is not a prerequisite for this connector; this is an inference, not a live test with the API disabled. Enablement is required for Gmail REST access. Do not treat it as solving scope verification.

**Public verification is unresolved.** Google says IMAP/SMTP apps should request the full mail scope only when they also need immediate permanent deletion that bypasses Trash. This client moves messages to Trash and has no such deletion feature. A public release needs a reviewed decision: implement Gmail REST with the minimum necessary scopes, or demonstrate a genuine product requirement that Google accepts for full-mail access. Changing the scope string alone cannot make IMAP work with Gmail API scopes. Do not invent a deletion requirement. [Google's IMAP/SMTP verification FAQ](https://support.google.com/cloud/answer/13463817?hl=en)

`https://www.googleapis.com/auth/gmail.modify` is a possible REST scope for the current mail feature set; it is still **restricted**, so migration does not remove verification obligations. Google determines whether a security assessment is required. This document claims no exemption, certification or completed assessment. [Scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes) · [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

## Small, non-destructive beta check

External Testing permits up to 100 listed testers and shows an unverified-app warning. Gmail authorization and offline refresh tokens expire **seven days after consent**; reconnect when prompted. Workspace administrator policy or Advanced Protection may block authorization. [Testing audience rules](https://support.google.com/cloud/answer/15549945?hl=en) · [Token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)

1. Start the configured build. On the welcome screen, choose **Log ind med Google**; existing users choose **Tilføj konto → Log ind med Google**. No name, email, password or mail-server settings are required. Choose an allowlisted account at Google. The app creates its local profile only after verified identity and mail connection checks succeed; cancellation must leave no empty profile.
2. In the system browser, check the account, Veyro app identity and requested permission before consenting. Return to the app after the loopback confirmation. Stop and record a sanitized error if authorization or either mail-protocol login fails; do not weaken provider settings to force success.
3. Confirm folders and search/pagination load. Open an **already-read, harmless message**: opening a message marks it read. Check text/HTML and any embedded images; keep external images blocked for this first check. Optionally save a harmless attachment using the native save dialog.
4. Create a local draft with a benign subject/body and **no recipients**. Close its window, restart the app, and confirm the draft persists. Do not click Send, Archive, Trash or remove the account during this check.
5. After the access token naturally expires, refresh the folder list to exercise refresh-token use. After the seven-day testing lifetime, confirm the reconnect message and reconnect manually. Do not alter the machine clock or inspect token values.

Record build/OS, timestamp and pass/fail by step without mailbox content, addresses, authorization codes or tokens. This checklist sends no mail and does not test delivery; a later send test requires an explicitly selected recipient and deliberate user action.

## Public materials still needed

Use a relevant, unauthenticated Veyro Mail homepage, verified ownership of `veyro.dk`, and accurate name/logo/support contact. Canonical repository routes are [privacy](https://veyro.dk/pages/privatlivspolitik) and [terms](https://veyro.dk/pages/handelsbetingelser). Existing text describes broader business services; it needs review for this product. Automated requests returned HTTP 403 during review, so reviewer accessibility must be checked. Prepare a working build, truthful data-flow/scope explanation and an English demonstration of consent and the features using each requested scope. [Brand requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification) · [Verification materials](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

### Privacy wording draft — owner/legal review required

> Veyro Mail's desktop Google connection accesses your mailbox to display, search and organize messages and attachments, and to send messages when you choose Send. The desktop app connects directly to Google's mail and authorization servers; this connector does not route Gmail message content through Veyro's servers or into Veyro Chat, Intranet or an AI service.
>
> Google account identity (verified email, stable account identifier and display name) is used to configure your local profile automatically and prevent duplicate or mismatched connections. It does not grant access to a Veyro company chat or intranet.
>
> OAuth tokens, account configuration and local drafts are stored on your computer using operating-system-backed encryption. The account list separately stores account identifiers and display labels. The app has no offline inbox database. Attachments you choose to download are saved to your selected location and are not encrypted by Veyro Mail. External message images are blocked until you enable them for the message; enabling them contacts the image host, which can observe that request. Sending mail shares its contents with the recipients you select through Google's mail service.
>
> Removing an account from Veyro Mail deletes its local saved login, drafts and account session data. It does not delete mail from Google, remove files you downloaded, or revoke the Google authorization. You can separately revoke access in your Google Account's third-party connections settings. Uninstalling the desktop app alone retains its user data.

These paragraphs describe the inspected implementation, not the organization's complete legal policy. Before publication, review them against actual releases and operating practices; provide the responsible entity/contact and appropriate retention/rights information. Review and publish accurate Limited Use commitments under the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy) and [Workspace API User Data and Developer Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy). Acceptance of those policies does not itself establish verification or compliance.
