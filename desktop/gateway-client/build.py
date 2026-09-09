"""Build only the vendored tunnel client using an isolated, hash-locked toolchain."""
from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import sysconfig
import tempfile
import urllib.parse
import urllib.request
import venv

ROOT = Path(__file__).resolve().parent


def native_target(requested: str | None = None) -> str:
    system = {"Windows": "win32", "Linux": "linux", "Darwin": "darwin"}.get(platform.system())
    arch = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower())
    if not system or not arch or sys.version_info[:2] not in {(3, 11), (3, 12)}:
        raise ValueError("Use native 64-bit Python 3.11 or 3.12 on Windows, Linux or macOS")
    target = f"{system}-{arch}"
    if requested is not None and requested != target:
        raise ValueError("Cross-compilation is unsupported; use a matching native Python interpreter")
    return target


def validate_source() -> None:
    package = ROOT / "src" / "cc_haha_tunnel"
    allowed = {"__init__.py", "__main__.py", "client.py", "supervisor.py", "protocol.py", "flow_control.py"}
    if {p.name for p in package.glob("*.py")} != allowed:
        raise ValueError("Unexpected client source modules")
    if any(p.name != "cc_haha_tunnel" for p in (ROOT / "src").iterdir() if p.is_dir()):
        raise ValueError("Only the client package may be bundled")
    for path in package.glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""] if isinstance(node, ast.ImportFrom) else []
            if any(name == "cc_haha_gateway" or name.startswith("cc_haha_gateway.") for name in names):
                raise ValueError("Server package imports are forbidden")


def build_environment(work: Path) -> dict[str, str]:
    allowed = {"SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432"}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    env.update(PYINSTALLER_CONFIG_DIR=str(work / "cache"), PIP_CONFIG_FILE=os.devnull,
               PIP_DISABLE_PIP_VERSION_CHECK="1", PYTHONHASHSEED="0", PYTHONUTF8="1",
               PYTHONNOUSERSITE="1", SOURCE_DATE_EPOCH="315532800")
    return env


def bootstrap_pip(python: Path, work: Path, env: dict[str, str]) -> None:
    """Seed only this venv from a hash-locked wheel; no system ensurepip needed."""
    locked = (ROOT / "requirements-build.txt").read_text(encoding="utf-8")
    blocks = re.findall(r"(?m)^pip==([0-9]+(?:\.[0-9]+)*)\s*\\\n((?:[ \t]+--hash=sha256:[0-9a-f]{64}\s*\\?\n)+)", locked)
    if len(blocks) != 1:
        raise RuntimeError("Bootstrap pip must have one exact version and SHA-256 lock")
    version, block = blocks[0]
    hashes = set(re.findall(r"--hash=sha256:([0-9a-f]{64})", block))
    filename = f"pip-{version}-py3-none-any.whl"
    try:
        with urllib.request.urlopen(f"https://pypi.org/pypi/pip/{version}/json", timeout=30) as response:
            metadata_bytes = response.read(2 * 1024 * 1024 + 1)
        if len(metadata_bytes) > 2 * 1024 * 1024:
            raise ValueError("metadata limit")
        metadata = json.loads(metadata_bytes)
        item = next(item for item in metadata["urls"] if item["filename"] == filename
                    and not item.get("yanked") and item["digests"]["sha256"] in hashes)
        def approved_url(value):
            url = urllib.parse.urlsplit(value)
            return (url.scheme == "https" and url.hostname == "files.pythonhosted.org"
                    and url.username is None and url.password is None and url.port in (None, 443))
        if not approved_url(item["url"]):
            raise ValueError("unapproved wheel source")
        with urllib.request.urlopen(item["url"], timeout=60) as response:
            if not approved_url(response.geturl()):
                raise ValueError("unapproved wheel redirect")
            content = response.read(8 * 1024 * 1024 + 1)
        if len(content) > 8 * 1024 * 1024 or hashlib.sha256(content).hexdigest() not in hashes:
            raise ValueError("wheel hash mismatch")
    except (OSError, ValueError, KeyError, TypeError, StopIteration):
        raise RuntimeError("Cannot obtain the approved bootstrap pip wheel; nothing was executed") from None
    wheel = work / filename
    wheel.write_bytes(content)
    subprocess.run([str(python), "-I", "-c",
                    "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('pip',run_name='__main__')",
                    str(wheel), "--isolated", "install", "--no-index", "--no-deps",
                    "--disable-pip-version-check", str(wheel)], check=True, env=env, cwd=work)


def collect_notices(output: Path) -> None:
    names = set()
    for filename in (ROOT / "requirements-build.txt", ROOT / "requirements/runtime.txt"):
        names.update(re.findall(r"(?m)^([A-Za-z0-9_-]+)==", filename.read_text(encoding="utf-8")))
    inventory = []
    for name in sorted(names):
        try:
            dist = importlib.metadata.distribution(name)
        except importlib.metadata.PackageNotFoundError:
            continue  # Platform-specific build tools.
        copies = []
        for item in dist.files or []:
            if not any(word in item.name.lower() for word in ("license", "licence", "copying", "notice")) or item.suffix in {".py", ".pyc"}:
                continue
            source = Path(dist.locate_file(item))
            if source.is_file():
                target = output / "licenses" / name / Path(*[part for part in item.parts if part not in {"..", "."}])
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                copies.append(target.relative_to(output).as_posix())
        if not copies:
            raise RuntimeError(f"Missing third-party license: {name}")
        inventory.append({"name": name, "version": dist.version, "licenses": copies})
    candidates = [Path(sys.base_prefix) / "LICENSE.txt", Path(sysconfig.get_path("stdlib")) / "LICENSE.txt",
                  Path(f"/usr/share/doc/python{sys.version_info.major}.{sys.version_info.minor}/copyright")]
    python_license = next((p for p in candidates if p.is_file()), None)
    if python_license is None:
        raise RuntimeError("Build interpreter must include its Python license")
    shutil.copyfile(python_license, output / "licenses/Python-LICENSE.txt")
    (output / "THIRD-PARTY-NOTICES.json").write_text(json.dumps({"python": platform.python_version(), "distributions": inventory}, indent=2) + "\n", encoding="utf-8")


def build(target: str, output_dir: Path) -> Path:
    validate_source()
    output_dir = output_dir.absolute()
    destination = output_dir / "cc-haha-tunnel"
    if destination.exists():
        raise ValueError("Output already exists; choose a fresh output directory")
    with tempfile.TemporaryDirectory(prefix="cc-haha-client-build-") as temporary:
        work = Path(temporary)
        env = build_environment(work)
        environment = work / "venv"
        venv.EnvBuilder(with_pip=False).create(environment)
        python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        bootstrap_pip(python, work, env)
        subprocess.run([str(python), "-m", "pip", "--isolated", "install", "--index-url", "https://pypi.org/simple",
                        "--require-hashes", "--only-binary=:all:", "-r", str(ROOT / "requirements-build.txt")], check=True, env=env, cwd=work)
        subprocess.run([str(python), "-m", "pip", "check"], check=True, env=env, cwd=work)
        subprocess.run([str(python), "-I", "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
                        "--name", "cc-haha-tunnel", "--paths", str(ROOT / "src"),
                        "--exclude-module", "cc_haha_gateway", "--distpath", str(work / "dist"),
                        "--workpath", str(work / "work"), "--specpath", str(work), str(ROOT / "entry.py")],
                       check=True, env=env, cwd=work)
        # Inspect the actual collected module graph, not only the entry source.
        analysis = ast.literal_eval((work / "work/cc-haha-tunnel/Analysis-00.toc").read_text(encoding="utf-8"))
        def contains_server(value):
            # Analysis also records excluded names; only collected module rows
            # are evidence that a package is actually included.
            if isinstance(value, (tuple, list)) and len(value) == 3 and value[2] in ("PYMODULE", "PYSOURCE", "EXTENSION"):
                name = value[0]
                return isinstance(name, str) and (name == "cc_haha_gateway" or name.startswith("cc_haha_gateway."))
            return isinstance(value, (tuple, list)) and any(contains_server(item) for item in value)
        if contains_server(analysis):
            raise RuntimeError("Server module found in client build graph")
        payload = work / "dist/cc-haha-tunnel"
        executable = payload / ("cc-haha-tunnel.exe" if os.name == "nt" else "cc-haha-tunnel")
        subprocess.run([str(executable), "--help"], check=True, env=env, timeout=30, cwd=work)
        subprocess.run([str(python), str(ROOT / "build.py"), "--collect-notices", str(payload)], check=True, env=env)
        for name in ("SOURCE.json", "LICENSE.txt"):
            shutil.copyfile(ROOT / name, payload / name)
        manifest = {"format": "pyinstaller-onedir", "target": target, "component": "tunnel", "files": []}
        for path in sorted(payload.rglob("*")):
            if path.is_file():
                manifest["files"].append({"path": path.relative_to(payload).as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        (payload / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        output_dir.mkdir(parents=True, exist_ok=True)
        shutil.copytree(payload, destination)
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--collect-notices", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.collect_notices:
        collect_notices(args.collect_notices)
        return
    try:
        target = native_target(args.target)
        print(build(target, args.output_dir or ROOT / "dist" / target))
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Client build failed: {error}\n")


if __name__ == "__main__":
    main()
