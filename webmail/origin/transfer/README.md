# Veyro Mail beta installer transfer

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
