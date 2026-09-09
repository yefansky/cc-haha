"""Standard-library-only checks: no pip install, network, private repo or accounts.

Run: python -I -B -m unittest discover -s desktop/gateway-client/tests -v
CLI tests load the real entry module with only its supervisor dependency stubbed.
Build tests execute real orchestration with external processes mocked; they do
not establish native-build or gateway HTTP/WebSocket interoperability evidence.
"""
from __future__ import annotations

import ast
from contextlib import contextmanager
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULES = {"__init__.py", "__main__.py", "client.py", "supervisor.py", "protocol.py", "flow_control.py", "local_ws_channel.py"}
ORIGINAL_MODULE = "src/cc_haha_tunnel/local_ws_channel.py"
# Original Git blob hashes remain pinned even when the public copy evolves.
# Updating a copied source baseline requires deliberate review of these values.
COPIED_SOURCE_HASHES = {
    "src/cc_haha_tunnel/__init__.py": "3038577c489088c4f7c75120faa03cbddac771cf6788e4dc99bbe4a6ceb4ac8b",
    "src/cc_haha_tunnel/__main__.py": "2e6deadbfa8ba683d742614a4226cb0124b036118b76e32da1e9486d88e7fcd5",
    "src/cc_haha_tunnel/client.py": "27a7de02d50370c5d70e00c2f8e646dc1b31e9b00a007c3fb85a19dbf7d9a9de",
    "src/cc_haha_tunnel/supervisor.py": "5f13daa07d4aa6cabaaa0273c9475c138b220b817436241de4875c55938220e6",
    "src/cc_haha_gateway/protocol.py": "b24477b1389f2df795d4ac1637764092f1fb7774d75b611a8a357bd54432610b",
    "src/cc_haha_gateway/flow_control.py": "0871e951d5ed0c4536659929cf45f35fbc12eff05513b0dffd8ad662c40ea435",
    "requirements-build.txt": "96919e5940e2ca9e30bdcdba0b1e489acbcf67c40bfb4b5443f3fc19bbb674fd",
    "requirements/runtime.txt": "089156c0087fd412e9e7773cc4c877cf64b48ec4911c2b20d2287c0e61d17ef6",
}


@contextmanager
def load_file(name, path, extra=None):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {name: module, **(extra or {})}):
        spec.loader.exec_module(module)
        yield module


class OfflineTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(patch.stopall)
        patch.object(socket, "create_connection", side_effect=AssertionError("offline test attempted network")).start()
        patch.object(socket.socket, "connect", side_effect=AssertionError("offline test attempted network")).start()

    @contextmanager
    def cli(self):
        package = types.ModuleType("offline_client")
        package.__path__ = [str(ROOT / "src/cc_haha_tunnel")]
        supervisor = types.ModuleType("offline_client.supervisor")
        supervisor.SupervisorState = types.SimpleNamespace(TERMINAL_ERROR="terminal_error")
        supervisor.TunnelSupervisor = lambda **kwargs: self.fail("validation must not start supervisor")
        with load_file("offline_client.__main__", ROOT / "src/cc_haha_tunnel/__main__.py",
                       {"offline_client": package, "offline_client.supervisor": supervisor}) as module, \
             patch.dict(os.environ, {}, clear=True):
            yield module

    def test_source_allowlist_and_real_build_validator(self):
        files = {p.relative_to(ROOT / "src").as_posix() for p in (ROOT / "src").rglob("*")
                 if p.is_file() and "__pycache__" not in p.parts}
        self.assertEqual(files, {"cc_haha_tunnel/" + name for name in MODULES})
        for name in MODULES:
            path = ROOT / "src/cc_haha_tunnel" / name
            self.assertFalse(path.is_symlink())
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"cgk_[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}", text),
                              "credential-shaped literal (content withheld)")
            self.assertNotIn("class GatewayApp", text)
            self.assertNotIn("class GatewayStore", text)
        with load_file("offline_build", ROOT / "build.py") as build:
            build.validate_source()
        entry = ast.parse((ROOT / "entry.py").read_text(encoding="utf-8"))
        imports = [n.module for n in ast.walk(entry) if isinstance(n, ast.ImportFrom)]
        self.assertEqual(imports, ["cc_haha_tunnel.__main__"])

    def test_public_lineage_hashes_and_local_dependency_pins(self):
        # A public clone can verify copied bytes, not an unavailable private
        # Git commit. The private gate separately verifies original blob hashes.
        manifest = json.loads((ROOT / "SOURCE.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["source_commit"], "5d5762bbf380ee050cd3bb76f47358024b9d76ed")
        expected = {"src/cc_haha_tunnel/" + name for name in MODULES} | {"requirements-build.txt", "requirements/runtime.txt"}
        self.assertEqual({r["path"] for r in manifest["files"]}, expected)
        self.assertEqual(len(manifest["files"]), len(expected))
        for record in manifest["files"]:
            path = ROOT / record["path"]
            self.assertTrue(path.resolve().is_relative_to(ROOT))
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), record["sha256"])
            if record["path"] == ORIGINAL_MODULE:
                self.assertEqual(record["origin"], "public-original")
                self.assertIsNone(record["source"])
                self.assertIsNone(record["source_sha256"])
                self.assertTrue(record["adaptation"])
            else:
                self.assertNotEqual(record.get("origin"), "public-original")
                expected_source = record["path"]
                if Path(expected_source).name in {"protocol.py", "flow_control.py"}:
                    expected_source = expected_source.replace("cc_haha_tunnel", "cc_haha_gateway")
                self.assertEqual(record["source"], expected_source)
                self.assertEqual(record["source_sha256"], COPIED_SOURCE_HASHES[expected_source])
        packages = set()
        for name in ("requirements-build.txt", "requirements/runtime.txt"):
            text = (ROOT / name).read_text(encoding="utf-8").replace("\\\n", " ")
            for line in text.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("-r "):
                    self.assertEqual(line, "-r requirements/runtime.txt")
                    continue
                match = re.match(r"([\w.-]+)==([^\s;]+)", line)
                self.assertIsNotNone(match)
                self.assertRegex(line, r"--hash=sha256:[0-9a-f]{64}")
                self.assertNotRegex(line, r"https?://|git\+|file:|--trusted-host")
                packages.add(match.group(1).lower())
        self.assertTrue({"aiohttp", "pip", "pyinstaller"} <= packages)

    def test_cli_help_and_unknown_secret_argument_are_safe(self):
        with self.cli() as cli:
            output = io.StringIO()
            with patch("sys.stdout", output), self.assertRaises(SystemExit) as result:
                cli._parse_args(["--help"])
            self.assertEqual(result.exception.code, 0)
            self.assertIn("--gateway", output.getvalue())
            error = io.StringIO()
            with patch("sys.stderr", error), self.assertRaises(SystemExit) as result:
                cli._parse_args(["--gateway", "http://127.0.0.1:1", "--upstream", "http://127.0.0.1:2",
                                 "--access-key", "fixture-secret-not-echoed"])
            self.assertEqual(result.exception.code, 2)
            self.assertNotIn("fixture-secret-not-echoed", error.getvalue())

    def test_cli_secret_input_crlf_limit_and_eof(self):
        with self.cli() as cli:
            value = cli._load_secrets(io.StringIO('{"access_key":"fixture-key","forwarder_token":"fixture-token"}\r\n'))
            self.assertEqual(value.access_key, "fixture-key")
            self.assertEqual(value.forwarder_token, "fixture-token")
            self.assertEqual(cli._read_secret_line(io.StringIO("x" * 8192 + "\r\n")), "x" * 8192)
            for value in ("", "{}", "[]", "malformed", "x" * 8193):
                with self.subTest(kind=len(value)), self.assertRaises(ValueError):
                    cli._load_secrets(io.StringIO(value))

    def test_cli_configuration_failure_and_event_allowlist(self):
        with self.cli() as cli:
            out, err = io.StringIO(), io.StringIO()
            code = cli.main(["--gateway", "http://127.0.0.1:1", "--upstream", "http://127.0.0.1:2"],
                            stdin=io.StringIO('{"access_key":"fixture-secret"}'), stdout=out, stderr=err)
            self.assertEqual(code, 2)
            self.assertEqual(out.getvalue(), "")
            self.assertEqual(json.loads(err.getvalue()), {"event": "error", "error_code": "CONFIG_ERROR"})
            cli._json_line_sink(out)({"event": "state", "state": "online", "access_key": "fixture-secret", "body": "private"})
            self.assertEqual(json.loads(out.getvalue()), {"event": "state", "state": "online"})

    def test_build_environment_removes_credentials_and_python_injection(self):
        with load_file("offline_build", ROOT / "build.py") as build, tempfile.TemporaryDirectory() as temporary, \
             patch.dict(os.environ, {"PYTHONPATH": "untrusted", "PYTHONHOME": "untrusted",
                                     "CC_HAHA_GATEWAY_SOURCE": "untrusted", "CC_HAHA_TUNNEL_ACCESS_KEY": "fixture",
                                     "PIP_INDEX_URL": "https://invalid.example/"}):
            env = build.build_environment(Path(temporary))
            for name in ("PYTHONPATH", "PYTHONHOME", "CC_HAHA_GATEWAY_SOURCE", "CC_HAHA_TUNNEL_ACCESS_KEY", "PIP_INDEX_URL"):
                self.assertNotIn(name, env)
            self.assertEqual(env["PIP_CONFIG_FILE"], os.devnull)

    def test_bootstrap_approved_hash_executes_only_local_wheel(self):
        self._bootstrap_case("valid")

    def test_bootstrap_bad_hash_url_redirect_or_download_never_executes(self):
        for mode in ("hash", "url", "redirect", "download", "yanked", "unlocked"):
            with self.subTest(mode=mode):
                self._bootstrap_case(mode)

    def _bootstrap_case(self, mode):
        payload = b"fixture-wheel-never-executed"
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory(prefix="offline-pip-") as temporary, load_file("offline_build", ROOT / "build.py") as build:
            root = Path(temporary)
            (root / "requirements-build.txt").write_text(f"pip==25.2 \\\n    --hash=sha256:{digest}\n", encoding="utf-8")
            url = "https://files.pythonhosted.org/packages/pip-25.2-py3-none-any.whl"
            item = {"filename": "pip-25.2-py3-none-any.whl", "url": "https://invalid.example/pip.whl" if mode == "url" else url,
                    "digests": {"sha256": "0" * 64 if mode == "unlocked" else digest}, "yanked": mode == "yanked"}
            metadata = io.BytesIO(json.dumps({"urls": [item]}).encode())
            wheel = io.BytesIO(b"changed" if mode == "hash" else payload)
            wheel.geturl = lambda: "https://invalid.example/pip.whl" if mode == "redirect" else url
            responses = [metadata, OSError("offline fixture") if mode == "download" else wheel]
            with patch.object(build, "ROOT", root), patch.object(build.urllib.request, "urlopen", side_effect=responses), \
                 patch.object(build.subprocess, "run") as run:
                if mode != "valid":
                    with self.assertRaises(RuntimeError):
                        build.bootstrap_pip(root / "venv-python", root, {})
                    run.assert_not_called()
                    self.assertFalse((root / "pip-25.2-py3-none-any.whl").exists())
                else:
                    build.bootstrap_pip(root / "venv-python", root, {})
                    args = run.call_args.args[0]
                    self.assertEqual(args[0], str(root / "venv-python"))
                    self.assertEqual(args[1:3], ["-I", "-c"])
                    self.assertTrue({"--isolated", "--no-index", "--no-deps"} <= set(args))
                    self.assertEqual(Path(args[-1]).read_bytes(), payload)

    def test_build_pipeline_and_analysis_exclusions_not_collected_modules(self):
        self._build_case(False)

    def test_build_collected_server_is_rejected(self):
        self._build_case(True)

    def _build_case(self, server):
        with tempfile.TemporaryDirectory(prefix="offline-build-") as temporary, load_file("offline_build", ROOT / "build.py") as build:
            root = Path(temporary)
            inputs = root / "client"
            inputs.mkdir()
            for name in ("SOURCE.json", "LICENSE.txt", "entry.py", "requirements-build.txt"):
                shutil.copyfile(ROOT / name, inputs / name)
            shutil.copytree(ROOT / "src", inputs / "src", ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copytree(ROOT / "requirements", inputs / "requirements")
            calls = []

            def run(args, **kwargs):
                calls.append(args)
                if "PyInstaller" in args:
                    directory = Path(args[args.index("--workpath") + 1]) / "cc-haha-tunnel"
                    directory.mkdir(parents=True)
                    name = "cc_haha_gateway.store" if server else "cc_haha_tunnel.client"
                    (directory / "Analysis-00.toc").write_text(repr(["cc_haha_gateway", [(name, "file.py", "PYMODULE")]]), encoding="utf-8")
                    output = Path(args[args.index("--distpath") + 1]) / "cc-haha-tunnel"
                    output.mkdir(parents=True)
                    (output / ("cc-haha-tunnel.exe" if os.name == "nt" else "cc-haha-tunnel")).write_bytes(b"fixture")
                return subprocess.CompletedProcess(args, 0)

            with patch.object(build, "ROOT", inputs), patch.object(build.venv, "EnvBuilder") as builder, \
                 patch.object(build, "bootstrap_pip") as bootstrap, patch.object(build.subprocess, "run", side_effect=run):
                if server:
                    with self.assertRaisesRegex(RuntimeError, "Server module"):
                        build.build("fixture-target", root / "output")
                    self.assertFalse((root / "output").exists())
                else:
                    result = build.build("fixture-target", root / "output")
                    self.assertTrue((result / "manifest.json").is_file())
                builder.assert_called_once_with(with_pip=False)
                bootstrap.assert_called_once()
                self.assertIn("--require-hashes", calls[0])
                self.assertIn("--only-binary=:all:", calls[0])
                self.assertEqual(calls[1][1:], ["-m", "pip", "check"])
                self.assertEqual(Path(calls[2][-1]), inputs / "entry.py")
                self.assertEqual(calls[2][calls[2].index("--exclude-module") + 1], "cc_haha_gateway")


if __name__ == "__main__":
    unittest.main()
