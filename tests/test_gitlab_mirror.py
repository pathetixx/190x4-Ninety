import importlib.util
import json
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "gitlab_mirror.py"
SPEC = importlib.util.spec_from_file_location("gitlab_mirror", MODULE_PATH)
mirror = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mirror)


def metadata(version="1.2.3", signature="signed", url="https://github.invalid/setup.exe"):
    return {
        "version": version,
        "notes": "test",
        "platforms": {
            mirror.PLATFORM: {
                "signature": signature,
                "url": url,
            }
        },
    }


class FakeClient:
    def __init__(self):
        self.calls = []
        self.blobs = {}

    def url(self, version, filename):
        return mirror.package_url("https://gitlab.test/api/v4", "42", version, filename)

    def ensure_immutable(self, version, filename, body, content_type):
        self.calls.append(("immutable", version, filename, content_type))
        self.blobs[(version, filename)] = body
        return body

    def verify_blob(self, version, filename, expected):
        self.calls.append(("verify", version, filename))
        return self.blobs[(version, filename)]

    def promote_stable(self, body):
        self.calls.append(("promote", "stable", mirror.METADATA_NAME))
        return body


class GitLabMirrorTests(unittest.TestCase):
    def test_package_url_quotes_components(self):
        self.assertEqual(
            mirror.package_url("https://gitlab.test/api/v4/", "42", "1.2.3", "Ninety setup.exe"),
            "https://gitlab.test/api/v4/projects/42/packages/generic/ninety/1.2.3/Ninety%20setup.exe",
        )

    def test_metadata_preserves_signature_and_rewrites_only_url(self):
        source = metadata()
        result = mirror.gitlab_metadata(source, "1.2.3", "https://gitlab.test/setup.exe")
        self.assertEqual(result["platforms"][mirror.PLATFORM]["signature"], "signed")
        self.assertEqual(
            result["platforms"][mirror.PLATFORM]["url"],
            "https://gitlab.test/setup.exe",
        )
        self.assertEqual(source["platforms"][mirror.PLATFORM]["url"], "https://github.invalid/setup.exe")

    def test_rejects_version_mismatch(self):
        with self.assertRaises(mirror.MirrorError):
            mirror.validate_metadata(metadata("1.2.2"), "1.2.3", "https://github.invalid/setup.exe")

    def test_rejects_missing_installer_or_signature(self):
        client = FakeClient()
        with self.assertRaises(mirror.MirrorError):
            mirror.promote_release(client, metadata(), "setup.exe", b"", "signed")
        with self.assertRaises(mirror.MirrorError):
            mirror.promote_release(client, metadata(signature=""), "setup.exe", b"installer", "")

    def test_rejects_corrupt_downloaded_metadata(self):
        with self.assertRaises(mirror.MirrorError):
            mirror.validate_metadata_bytes(b"{broken", "1.2.3", "https://gitlab.test/setup.exe")

    def test_promotion_order_verifies_before_stable_switch(self):
        client = FakeClient()
        mirror.promote_release(client, metadata(), "setup.exe", b"installer", "signed")
        self.assertEqual(
            client.calls,
            [
                ("immutable", "1.2.3", "setup.exe", "application/octet-stream"),
                ("verify", "1.2.3", "setup.exe"),
                ("immutable", "1.2.3", "latest.json", "application/json"),
                ("promote", "stable", "latest.json"),
            ],
        )

    def test_downloaded_metadata_must_keep_expected_url(self):
        body = json.dumps(metadata()).encode()
        with self.assertRaises(mirror.MirrorError):
            mirror.validate_metadata_bytes(body, "1.2.3", "https://gitlab.test/setup.exe")


if __name__ == "__main__":
    unittest.main()
