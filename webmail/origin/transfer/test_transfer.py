import hashlib
import http.client
import tempfile
import threading
import unittest
from http.server import HTTPServer
from pathlib import Path
from unittest.mock import patch

import transfer


class ReleaseTransferTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.content = b"hello again"
        self.name = "installer.bin"
        self.key = "mac-apple"
        self.token = "a" * 64
        manifest = {self.key: (self.name, len(self.content), hashlib.sha256(self.content).hexdigest())}
        chunk_patch = patch.object(transfer, "CHUNK", 8)
        chunk_patch.start()
        self.addCleanup(chunk_patch.stop)
        self.server = HTTPServer(("127.0.0.1", 0), transfer.Receiver)
        self.server.stage = transfer.Stage(self.root, manifest)
        self.server.token_hash = hashlib.sha256(self.token.encode()).hexdigest()
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, method, offset=None, data=None, key=None, token=None):
        headers = {"Authorization": "Bearer " + (token or self.token)}
        if offset is not None:
            headers["Upload-Offset"] = str(offset)
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request(method, transfer.PREFIX + (key or self.key), body=data, headers=headers)
            response = connection.getresponse()
            return response.status, response.getheader("Upload-Offset")
        finally:
            connection.close()

    def test_rejects_unrecognized_token_route_size_offset_and_method(self):
        self.assertEqual(self.request("HEAD", token="b"*64)[0], 403)
        self.assertEqual(self.request("HEAD", key="../installer.bin")[0], 404)
        self.assertEqual(self.request("DELETE")[0], 501)
        self.assertEqual(self.request("PUT", 8, b"x"), (409, "0"))
        self.assertEqual(self.request("PUT", 0, b"x"*9)[0], 400)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_recovers_torn_chunk_and_lost_acknowledgement(self):
        (self.root / (self.name + ".partial")).write_bytes(b"torn")
        self.assertEqual(self.request("HEAD"), (200, "0"))
        self.assertEqual(self.request("PUT", 0, self.content[:8]), (204, "8"))
        self.assertEqual(self.request("PUT", 0, self.content[:8]), (409, "8"))
        self.assertFalse((self.root/self.name).exists())
        self.assertEqual(self.request("PUT", 8, self.content[8:]), (204, "11"))
        self.assertEqual(self.request("HEAD"), (200, "11"))
        self.assertEqual((self.root/self.name).read_bytes(), self.content)
        self.assertEqual(self.request("PUT", 8, b"xxx"), (409, "11"))

    def test_corrupt_final_file_is_discarded_and_can_restart(self):
        self.assertEqual(self.request("PUT", 0, b"badbytes"), (204, "8"))
        self.assertEqual(self.request("PUT", 8, b"bad")[0], 422)
        self.assertFalse((self.root/self.name).exists())
        self.assertEqual(self.request("HEAD"), (200, "0"))

if __name__ == "__main__":
    unittest.main()
