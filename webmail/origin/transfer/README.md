# Signed desktop update distribution

The release Mac publishes each complete, signed set through HTTPS at `post.veyro.dk`. The app checks `/webmail-downloads/update.json` and downloads its versioned installer from the same origin. After the initial setup, the release operator runs `npm run release:desktop` on the Mac. To resume an interrupted upload, use the existing signed output as described in the [desktop release instructions](../../desktop/README.md#publish-an-update).

## Install the publisher on the mail origin

Use a verified checkout containing both `webmail/origin` and `webmail/desktop/assets/update-signing-key.pem`. Confirm the public key fingerprint against the release Mac. The origin requires Python 3.9+, OpenSSL 3, Caddy and systemd. Back up existing Caddy routes before activating the new handler.

1. Supply the SHA-256 digest of the dedicated publisher token to the origin operator. Run `sh webmail/origin/install-signed-publisher.sh TOKEN_SHA256` there. This enables the dedicated unprivileged systemd service, installs the public verification key and reuses the existing public downloads directory. Existing installer files keep their paths and ownership.
2. Apply the `@signedDesktopRelease` and download handlers from `webmail/origin/mail-api.caddy` to the existing Veyro mail Caddy site. Preserve other site-specific configuration. Validate the amended Caddyfile before reload. Requests for release uploads go only to loopback port 18147. Keep Authorization redacted in access logs.
3. Confirm an uncredentialed POST to `/webmail-release-upload/v1/begin` returns 403. Publish the signed release from the Mac. Fetch the public manifest and all three installers and verify the published hashes.

The publisher verifies the manifest signature before accepting file metadata, stores partial files in its private 0700 state directory, bounds each chunk to 8 MiB and each installer to 512 MiB, and checks every digest. Promotion writes complete versioned files first and switches the public manifest atomically. Concurrent uploaders and retries share the verified offset. A restart resumes the last signed transfer. Old manifests cannot roll the feed back. A faulty application release is corrected by publishing a higher version. Disabling the publisher service stops new uploads while existing public downloads remain available.

## Legacy beta.2 transfer

This temporary tool copies the three **configured** 0.1.0-beta.2 installers
from the release Mac directly to the Veyro mail origin. It needs Python 3.8+
and the default CA trust store. Run it independently of the production mail API.
The receiver admits only the three declared release files. Each file is kept
private under a partial name until its complete SHA-256 verifies.

1. On the release Mac, create a private temporary directory and token. Keep
   the token on this Mac and send only the printed SHA-256 to the server
   operator. The plaintext token must not go in the URL, Git, or chat.

   ```sh
   release_tmp=$(mktemp -d)
   python3 transfer.py prepare "$release_tmp/token"
   ```

2. On the mail origin, run the receiver under a dedicated unprivileged account
   with an empty, private (0700), non-web-accessible staging directory owned by
   it. Supply the digest printed by the Mac. Launch from the terminal or a
   temporary systemd unit with a wall-clock runtime limit of 45 minutes.

   ```sh
   python3 transfer.py serve /path/to/private-stage TOKEN_SHA256
   ```

   The listener binds to 127.0.0.1:18146. Temporarily add the following handler
   inside the origin's existing post.veyro.dk route. Validate Caddy before
   reload. Ensure access logs redact Authorization (Caddy default). Do not
   enable logging of request headers or bodies.

   ```caddyfile
   @releaseStage {
       method HEAD PUT
       path /webmail-release-upload/mac-apple /webmail-release-upload/mac-intel /webmail-release-upload/windows
   }
   handle @releaseStage {
       request_body {
           max_size 8MiB
       }
       reverse_proxy 127.0.0.1:18146
   }
   ```

3. From the Mac, run the sender with the tested binary directory. It verifies
   local files first, sends over the canonical HTTPS origin, and retries from
   the last accepted chunk. Redirects are rejected. Rerunning the same command
   against a running receiver resumes the copy.

   ```sh
   python3 transfer.py send "$release_tmp/token" /path/to/webmail/desktop/dist
   ```

4. On the origin, check the final three checksums against the release manifest,
   then publish only the verified .dmg/.exe files under the read-only release
   route. Stop the receiver, remove the temporary Caddy handler, validate and
   reload Caddy. Check the upload paths are no longer routed. Remove this
   staging directory and local temporary token after the public download test.

Run the isolated round-trip tests with `python3 -m unittest discover -s
webmail/origin/transfer` from the repository root.
