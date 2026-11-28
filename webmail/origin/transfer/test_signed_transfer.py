import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import signed_transfer as signed
import transfer
from signed_transfer import releases


class SignedDelivery(unittest.TestCase):
    def setUp(self):
        box = tempfile.TemporaryDirectory()
        self.addCleanup(box.cleanup)
        self.root = Path(box.name)
        self.key, self.pub = self.root / "fixture.key", self.root / "fixture.pub"
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", self.key], check=True, capture_output=True)
        subprocess.run(["openssl", "pkey", "-in", self.key, "-pubout", "-out", self.pub], check=True, capture_output=True)
        self.stage, self.public = self.root / "staging", self.root / "public"
        self.stage.mkdir(mode=0o700)
        self.public.mkdir()
        self.token = "1" * 64
        self.server = signed.ReleaseServer(("127.0.0.1", 0), signed.Receiver)
        self.server.token_hash = hashlib.sha256(self.token.encode()).hexdigest()
        self.server.manager = signed.Publisher(self.stage, self.public, self.pub)
        self.addCleanup(self.server.server_close)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval":0.01}, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.data = b"1234567890"
        self.chunk = patch.object(transfer, "CHUNK", 8)
        self.chunk.start()
        self.addCleanup(self.chunk.stop)

    def feed(self, version="0.1.0-beta.6", data=None):
        folder = self.root / version
        folder.mkdir(exist_ok=True)
        for suffix in releases.ARTIFACTS.values():
            (folder / f"Veyro-Mail-{version}-{suffix}").write_bytes(self.data if data is None else data)
        script = Path(__file__).resolve().parents[2] / "desktop/scripts/sign-update.cjs"
        node = "require(process.argv[1]).signUpdate(...process.argv.slice(2)).catch(e=>{console.error(e.message);process.exit(1)})"
        subprocess.run(["node", "-e", node, script, folder, version, self.key, self.pub], capture_output=True, check=True)
        return (folder / "update.json").read_bytes()

    def request(self, method, key, body=None, tag=None, offset=None, token=None):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        headers={"Authorization":"Bearer " + (token if token is not None else self.token)}
        if tag is not None:
            headers["X-Veyro-Release"] = tag
        if offset is not None:
            headers["Upload-Offset"] = str(offset)
        try:
            conn.request(method, signed.PREFIX + key, body, headers)
            response = conn.getresponse()
            response.read()
            return response.status, response.getheader("Upload-Offset")
        finally:
            conn.close()

    def test_publishes_verified_installer_set_once_and_rejects_conflicts(self):
        feed = self.feed()
        tag = hashlib.sha256(feed).hexdigest()
        self.assertEqual(self.request("POST","begin",feed), (200,"0"))
        for key in signed.PLATFORMS:
            self.assertEqual(self.request("HEAD",key,tag=tag),(200,"0"))
            self.assertEqual(self.request("PUT",key,self.data[:8],tag,0),(204,"8"))
        # New service instance reads the signed in-progress manifest and resumes each file.
        self.server.manager = signed.Publisher(self.stage,self.public,self.pub)
        self.server.manager.restore()
        self.assertEqual(self.request("POST","publish",b"",tag)[0],422)
        self.assertFalse((self.public/"update.json").exists())
        for key in signed.PLATFORMS:
            puts = lambda _: self.request("PUT",key,self.data[8:],tag,8)[0]
            self.assertEqual(sorted(ThreadPoolExecutor(2).map(puts, range(2))), [204,409])
        self.assertEqual(self.request("POST","publish",b"",tag)[0],204)
        self.assertEqual((self.public/"update.json").read_bytes(),feed)
        for f in (self.public/"0.1.0-beta.6").iterdir():
            self.assertEqual(f.read_bytes(),self.data)
        self.assertEqual(self.request("POST","begin",feed),(200,"1"))
        self.assertEqual(self.request("POST","begin",self.feed("0.1.0-beta.5"))[0],422)
        self.assertEqual(self.request("POST","begin",self.feed(data=b"replaced"))[0],422)
        self.assertEqual((self.public/"update.json").read_bytes(),feed)

    def test_rejects_incomplete_or_corrupt_release_and_requires_bearer(self):
        feed = self.feed()
        for _ in range(10):
            self.assertEqual(self.request("POST","begin",feed,token="0"*64)[0],403)
        self.assertEqual(self.request("POST","begin",feed,token="0"*64)[0],429)
        obj=json.loads(feed)
        obj["signature"]=base64.b64encode(b"x"*64).decode()
        self.assertEqual(self.request("POST","begin",json.dumps(obj).encode())[0],422)
        self.assertEqual(self.request("POST","begin",feed)[0],200)
        tag=hashlib.sha256(feed).hexdigest()
        self.assertEqual(self.request("PUT","windows",self.data[:8],"wrong",0)[0],409)
        self.assertEqual(self.request("PUT","windows",self.data[:8],tag,0)[0],204)
        self.assertEqual(self.request("PUT","windows",b"xx",tag,8)[0],422)
        self.assertEqual(self.request("HEAD","windows",tag=tag),(200,"0"))
        self.assertEqual(self.request("POST","begin",b"z"*17000)[0],413)
        self.assertFalse((self.public/"update.json").exists())

    def test_sender_verifies_and_repeats_without_writing_again(self):
        version="0.1.0"
        feed=self.feed(version)
        token=self.root/"token"
        token.write_text(self.token)
        token.chmod(0o600)
        def local(method,key,credential,offset=None,data=None,*,prefix,extra,timeout):
            self.assertEqual(prefix,signed.PREFIX)
            status,pos=self.request(method,key,data,extra.get("X-Veyro-Release"),offset,credential)
            self.assertIn(status,(200,204))
            return int(pos)
        with patch.object(transfer,"request",local), patch.object(releases,"REPO_KEY",self.pub):
            signed.publish(token,self.root/version)
            signed.publish(token,self.root/version)
        self.assertEqual((self.public/"update.json").read_bytes(),feed)
