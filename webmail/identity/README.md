# Veyro Konto

The identity service uses authentik 2026.8.7 and PostgreSQL 16.16. The Compose file pins both Linux amd64 image digests and publishes HTTP only on the guest loopback address `127.0.0.1:18081`. The server and worker share the authentik database and media volume. Keep both volumes and the protected runtime environment in backups.

Install the files on the mail guest in a root-owned directory such as `/etc/veyro-identity` and run `sh stage.sh` as root there. The script generates private keys and passwords on the guest during initial setup. Existing credentials are reused. Limit access to the runtime directory to administrators. Restart the service with `docker compose up -d` from that directory. For a health check, request `/-/health/ready/` on the loopback port.

After the initial migrations finish, run `sh configure-system.sh` as root. This sets the canonical base URL and keeps usernames and recovery addresses administrator-managed for the tenant.

The public hostname for the issuer is `konto.veyro.dk`. Terminate TLS at the trusted reverse proxy, preserve the Host header and pass `X-Forwarded-Proto: https`. The OpenID discovery document is at `https://konto.veyro.dk/application/o/veyro-mail/.well-known/openid-configuration`. The OIDC client ID is `veyro-webmail` and the sole registered callback is `https://post.veyro.dk/`. The confidential client uses the protected `VEYRO_OIDC_SECRET` runtime value.

## Employee assignment

Create the employee with the canonical lowercase Veyro mailbox address as their username, and use a separately verified address for recovery. Membership in `Veyro Mail` enables eligibility. An administrator must also assign exactly one group named `veyro-mailbox:<canonical mailbox address>` to the employee. The OIDC application verifies that the group has exactly one active member and matches the employee's username. The signed mailbox address claim comes from this assignment. The separate profile email remains private from the email scope. Employees cannot edit their own account username or profile email. Keep the original identity record when changing an assignment so its OIDC subject remains stable.

## Sign-in and account settings

The browser starts at the application's OIDC authorization request. Password sign-in requires a registered second factor. An employee without one enrolls a TOTP device or a discoverable passkey during the first login. The passkey flow requires user verification. Native authentik account settings provide password changes, additional authenticators and backup codes. Only activate optional phone and recovery flows after their transports, delivery addresses and enrollment checks have been verified.

Link and test each existing mailbox explicitly before changing its production sign-in method. OIDC authenticates the web session. IMAP and SMTP clients require their own tested mailcow credential or app-password plan. Verify separation between the two employees and test the current fallback before switching the production sign-in.
