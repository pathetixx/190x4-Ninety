import os
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "src-tauri" / "dpi" / "gen_strategies.py"
CORE_STEMS = [
    "general",
    "general (ALT)",
    *(f"general (ALT{i})" for i in range(2, 13)),
    "general (FAKE TLS AUTO)",
    "general (FAKE TLS AUTO ALT)",
    "general (FAKE TLS AUTO ALT2)",
    "general (FAKE TLS AUTO ALT3)",
    "general (SIMPLE FAKE)",
    "general (SIMPLE FAKE ALT)",
    "general (SIMPLE FAKE ALT2)",
]


def write_core_strategies(directory: Path) -> None:
    body = '@echo off\nstart "" "%~dp0bin\\winws.exe" --new\n'
    for stem in CORE_STEMS:
        (directory / f"{stem}.bat").write_text(body, encoding="utf-8")


class DpiStrategyGuardTests(unittest.TestCase):
    def run_generator(self, source: Path, output: Path) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(GENERATOR), str(source), str(output)],
            capture_output=True,
            text=True,
            check=False,
            # Reproduce the Windows runner console that cannot encode the
            # generator's Russian diagnostics and previously crashed post-write.
            env={**os.environ, "PYTHONIOENCODING": "cp1252"},
        )

    def test_core_allowlist_generates_only_reviewed_autopick_profiles(self):
        with tempfile.TemporaryDirectory() as raw:
            source = Path(raw)
            output = source / "strategies.json"
            write_core_strategies(source)

            result = self.run_generator(source, output)

            self.assertEqual(result.returncode, 0, result.stderr)
            strategies = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(len(strategies), 20)
            self.assertTrue(all(not item["experimental"] for item in strategies))

    def test_unknown_elevated_winws_flag_is_rejected(self):
        with tempfile.TemporaryDirectory() as raw:
            source = Path(raw)
            output = source / "strategies.json"
            write_core_strategies(source)
            (source / "general.bat").write_text(
                '@echo off\nstart "" "%~dp0bin\\winws.exe" '
                "--debug=@C:\\Windows\\Temp\\ninety-should-not-write.log ^\n"
                "--new\n",
                encoding="utf-8",
            )

            result = self.run_generator(source, output)

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unsafe/unknown winws argument", result.stderr + result.stdout)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
