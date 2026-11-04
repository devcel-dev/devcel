#!/usr/bin/env python3
"""Collect npm license evidence from the two committed lockfiles (Python 3.11+).

``collect(repo)`` returns one record per non-root entry in package-lock.json and
in devcel-studio/package-lock.json, including platform-specific optional entries.
The empty lockfile entry describes Devcel itself and is not a third-party entry.
Records are deliberately not deduplicated: lockfile/package_path retain scope.

scope=runtime means a dependency may be included in a distribution according to
npm's lockfile classification; it is NOT a claim that tree shaking ships every
package. devOptional entries also remain runtime candidates. Template manifests
without lockfiles do not establish resolved package versions and are not folded
into this inventory.

Evidence comes from the matching installed package, or the lockfile's official
npm registry tarball, whose complete bytes must match the strongest supported
lockfile SRI digest before any extracted text is trusted. Tarballs are read in
place, never extracted, and cached outside the repository. No license text is
inferred from an SPDX identifier or copied from an unrelated package/version.
Bundled dependencies are read only from their enclosing, integrity-verified
registry tarball, with the enclosing and bundled package identities checked.
"""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile
import time
from typing import Any
import urllib.parse
import urllib.request
from embedded_license_notices import extract as extract_embedded_notices, is_source

LOCKFILES = ("package-lock.json", "devcel-studio/package-lock.json")
LEGAL_NAME = re.compile(
    r"(?:^|[._ -])(?:licen[cs]es?|licen[cs]ing|notices?|copying|copyright|unlicense|patents?|authors?|credits?)(?:$|[._ -])",
    re.IGNORECASE,
)
LEGAL_DIRECTORIES = {"license", "licenses", "licence", "licences", "legal", "notices"}
README_NAME = re.compile(r"^readme(?:$|[._-])", re.IGNORECASE)
README_LEGAL = re.compile(r"(?:\blicen[cs]e\b|\bcopyright\b|\ball rights reserved\b)", re.IGNORECASE)
TERMS_NAME = re.compile(r"licen[cs]e|copying|copyright|unlicense", re.IGNORECASE)
SPDX_PERMISSIVE = {
    "0BSD", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "BSD-4-Clause",
    "BSL-1.0", "CC0-1.0", "ISC", "MIT", "Unlicense", "Zlib",
}
DIGEST_STRENGTH = {"sha512": 4, "sha384": 3, "sha256": 2, "sha1": 1}
MAX_TEXT_BYTES = 16 * 1024 * 1024
MAX_TARBALL_BYTES = 1024 * 1024 * 1024


def _cache_dir(repo: Path) -> Path:
    path = Path(os.environ.get("DEVCEL_NPM_LICENSE_CACHE", str(Path(tempfile.gettempdir()) / "devcel-npm-license-cache"))).expanduser().resolve()
    if path == repo or repo in path.parents:
        raise ValueError("DEVCEL_NPM_LICENSE_CACHE must be outside the repository")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _license(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, dict):
        return _license(value.get("type"))
    if isinstance(value, list):
        entries = [_license(item) for item in value]
        return " OR ".join(f"({item})" for item in entries if item) or None
    return None


def _safe_path(path: str) -> PurePosixPath:
    result = PurePosixPath(path)
    if result.is_absolute() or ".." in result.parts or "\\" in path:
        raise ValueError(f"unsafe package-relative path: {path!r}")
    return result


def _legal_path(path: str) -> bool:
    parts = PurePosixPath(path).parts
    return bool(parts) and (
        bool(LEGAL_NAME.search(parts[-1]))
        or any(part.lower() in LEGAL_DIRECTORIES for part in parts[:-1])
    )


def _terms_path(path: str) -> bool:
    parts = PurePosixPath(path).parts
    return bool(TERMS_NAME.search(parts[-1])) or any(part.lower() in LEGAL_DIRECTORIES - {"notices"} for part in parts[:-1])


def _decode(data: bytes, path: str, errors: list[str]) -> str | None:
    if len(data) > MAX_TEXT_BYTES:
        errors.append(f"evidence-file-too-large: {path}")
        return None
    try:
        # Keep line endings and a possible BOM, rather than normalizing evidence.
        return data.decode("utf-8")
    except UnicodeDecodeError:
        errors.append(f"evidence-not-utf8: {path}; original bytes need manual review")
        return None


def _read_local(package: Path, errors: list[str]) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    for directory, subdirs, files in os.walk(package, followlinks=False):
        subdirs[:] = sorted(name for name in subdirs if name != "node_modules" and not (Path(directory) / name).is_symlink())
        for name in sorted(files):
            item = Path(directory) / name
            relative = item.relative_to(package).as_posix()
            if relative != "package.json" and not _legal_path(relative) and not README_NAME.match(name) and not is_source(relative):
                continue
            if item.is_symlink():
                errors.append(f"evidence-symlink-not-followed: {relative}")
                continue
            try:
                if item.stat().st_size > MAX_TEXT_BYTES:
                    errors.append(f"evidence-file-too-large: {relative}")
                else:
                    raw = item.read_bytes()
                    if is_source(relative) and not _legal_path(relative):
                        result.update(extract_embedded_notices(relative, raw))
                    else:
                        result[relative] = raw
            except OSError as exc:
                errors.append(f"evidence-read-failed: {relative}: {type(exc).__name__}")
    return result


def _sri(integrity: str) -> tuple[str, set[bytes]]:
    candidates: dict[str, set[bytes]] = {}
    for item in integrity.split():
        algorithm, separator, digest = item.partition("-")
        if separator and algorithm in DIGEST_STRENGTH:
            try:
                decoded = base64.b64decode(digest.split("?", 1)[0], validate=True)
            except ValueError as exc:
                raise ValueError(f"invalid lockfile integrity: {algorithm}") from exc
            if len(decoded) != hashlib.new(algorithm).digest_size:
                raise ValueError(f"invalid lockfile digest length: {algorithm}")
            candidates.setdefault(algorithm, set()).add(decoded)
    if not candidates:
        raise ValueError("missing or unsupported lockfile integrity")
    algorithm = max(candidates, key=DIGEST_STRENGTH.__getitem__)
    return algorithm, candidates[algorithm]


def _verify_tarball(path: Path, integrity: str) -> bool:
    algorithm, expected = _sri(integrity)
    digest = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest() in expected


# One download owns a cache key until its authenticated archive is published.
# Other keys still download concurrently; readers never race a second replacement.
import threading
_CACHE_LOCK_GUARD = threading.Lock()
_CACHE_LOCKS = {}


def _download(source: str, integrity: str, cache: Path) -> Path:
    key = (str(cache.resolve()), source, integrity)
    with _CACHE_LOCK_GUARD:
        lock = _CACHE_LOCKS.setdefault(key, threading.Lock())
    with lock:
        return _download_owned(source, integrity, cache)


def _download_owned(source: str, integrity: str, cache: Path) -> Path:
    url = urllib.parse.urlparse(source)
    if url.scheme != "https" or url.hostname != "registry.npmjs.org" or url.username or url.password or url.port not in (None, 443):
        raise ValueError(f"not an official HTTPS npm registry tarball: {source}")
    algorithm, expected = _sri(integrity)
    key = hashlib.sha256((source + "\n" + integrity).encode()).hexdigest()
    path = cache / f"{key}.tgz"
    if path.is_file():
        if _verify_tarball(path, integrity):
            return path
        # A bad cache entry is never trusted; replace it with verified bytes.
    if os.environ.get("DEVCEL_NPM_LICENSE_OFFLINE") == "1":
        raise ValueError("verified tarball is not cached (DEVCEL_NPM_LICENSE_OFFLINE=1)")
    last_error: Exception | None = None
    for attempt in range(3):
        temporary: Path | None = None
        try:
            request = urllib.request.Request(source, headers={"User-Agent": "Devcel-license-evidence/1.0"})
            with urllib.request.urlopen(request, timeout=90) as response:
                final_url = urllib.parse.urlparse(response.geturl())
                if final_url.scheme != "https" or final_url.hostname != "registry.npmjs.org":
                    raise ValueError("npm tarball redirected outside the official registry")
                digest = hashlib.new(algorithm)
                size = 0
                with tempfile.NamedTemporaryFile(dir=cache, suffix=".partial", delete=False) as output:
                    temporary = Path(output.name)
                    while chunk := response.read(1024 * 1024):
                        size += len(chunk)
                        if size > MAX_TARBALL_BYTES:
                            raise ValueError("npm tarball exceeds 1 GiB safety limit")
                        digest.update(chunk)
                        output.write(chunk)
                if digest.digest() not in expected:
                    raise ValueError("npm tarball does not match lockfile integrity")
                os.replace(temporary, path)
                return path
        except Exception as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(attempt + 1)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    raise ValueError(f"tarball-download-failed: {type(last_error).__name__}")


def _package_boundaries(package_path: str) -> list[str]:
    """Return actual npm install-package ancestors, never arbitrary directories."""
    parts = _safe_path(package_path).parts
    if not parts or PurePosixPath(*parts).as_posix() != package_path:
        raise ValueError("noncanonical npm package path")
    boundaries = []
    offset = 0
    while offset < len(parts):
        if parts[offset] != "node_modules" or offset + 1 >= len(parts):
            raise ValueError("invalid npm package boundary")
        offset += 1
        if parts[offset].startswith("@"):
            if len(parts[offset]) == 1 or offset + 1 >= len(parts):
                raise ValueError("invalid scoped npm package boundary")
            offset += 1
        if parts[offset] == "node_modules" or parts[offset].startswith("@"):
            raise ValueError("invalid npm package name")
        offset += 1
        boundaries.append("/".join(parts[:offset]))
    return boundaries


def _identity(package_path: str, locked: dict[str, Any]) -> tuple[str, str]:
    return (str(locked.get("name") or package_path.rsplit("node_modules/", 1)[-1]),
            str(locked.get("version", "UNKNOWN")))


def _bundle_source(package_path: str, packages: dict[str, Any]) -> tuple[str, dict[str, Any], dict[str, tuple[str, str]]]:
    """Find the nearest non-bundled package that owns these tarball bytes.

    Every intervening install-package must exist in this lockfile and be bundled.
    A missing source on a non-bundled ancestor cannot be bypassed by climbing on.
    """
    boundaries = _package_boundaries(package_path)
    for index in range(len(boundaries) - 2, -1, -1):
        parent_path = boundaries[index]
        parent = packages.get(parent_path)
        if not isinstance(parent, dict) or parent.get("link"):
            raise ValueError("bundled dependency has a missing or linked package ancestor")
        if parent.get("inBundle") is True:
            continue
        expected = {}
        for nested_path in boundaries[index:]:
            nested = packages.get(nested_path)
            if not isinstance(nested, dict) or nested.get("link"):
                raise ValueError("bundled dependency has a missing or linked package ancestor")
            if nested_path != parent_path and nested.get("inBundle") is not True:
                raise ValueError("bundled dependency has a non-bundled intermediate package")
            relative = nested_path[len(parent_path):].lstrip("/")
            expected[relative] = _identity(nested_path, nested)
        return parent_path, parent, expected
    raise ValueError("bundled dependency has no registry package ancestor")


def _read_tarball(path: Path, errors: list[str], package_subpath: str = "",
                  expected_packages: dict[str, tuple[str, str]] | None = None) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    with tarfile.open(path, "r:gz") as archive:
        members: dict[tuple[str, ...], tarfile.TarInfo] = {}
        for member in archive.getmembers():
            parts = _safe_path(member.name).parts
            previous = members.get(parts)
            if previous is not None and not (previous.isdir() and member.isdir()):
                raise ValueError("npm tarball has duplicate member paths")
            members[parts] = member

        def linked(parts: tuple[str, ...]) -> bool:
            return any((entry := members.get(parts[:end])) is not None
                       and (entry.issym() or entry.islnk())
                       for end in range(1, len(parts) + 1))

        # npm's older @types tarballs use a package-name root instead of "package".
        # Identify exactly one top-level regular manifest; never guess between roots.
        roots = {parts[0] for parts, member in members.items()
                 if len(parts) == 2 and parts[1] == "package.json" and member.isfile()}
        if len(roots) != 1:
            raise ValueError("npm tarball must contain exactly one root package manifest")
        package_root = next(iter(roots))
        if package_subpath:
            boundaries = _package_boundaries(package_subpath)
            if set(expected_packages or {}) != {"", *boundaries}:
                raise ValueError("bundled tarball requires every enclosing package identity")
        selected_root = (package_root,) + _safe_path(package_subpath).parts
        if linked(selected_root):
            raise ValueError("npm tarball package root has a linked ancestor")
        for subpath, expected in (expected_packages or {}).items():
            if subpath:
                _package_boundaries(subpath)
            manifest_path = (package_root,) + _safe_path(subpath).parts + ("package.json",)
            member = members.get(manifest_path)
            if member is None or not member.isfile() or linked(manifest_path) or member.size > MAX_TEXT_BYTES:
                raise ValueError("npm tarball package manifest is missing or unsafe")
            stream = archive.extractfile(member)
            manifest = json.loads(stream.read()) if stream is not None else {}
            if not isinstance(manifest, dict) or (manifest.get("name"), manifest.get("version")) != expected:
                raise ValueError("npm tarball package identity does not match lockfile")
        for parts, member in members.items():
            if parts[:len(selected_root)] != selected_root:
                continue
            relative_parts = parts[len(selected_root):]
            relative = PurePosixPath(*relative_parts).as_posix()
            if "node_modules" in relative_parts:
                # Nested installed dependencies have their own lockfile entries.
                continue
            if relative != "package.json" and not _legal_path(relative) and not README_NAME.match(PurePosixPath(relative).name) and not is_source(relative):
                continue
            if linked(parts):
                errors.append(f"evidence-symlink-not-followed: {relative}")
                continue
            if not member.isfile():
                continue
            if member.size > MAX_TEXT_BYTES:
                errors.append(f"evidence-file-too-large: {relative}")
                continue
            stream = archive.extractfile(member)
            if stream is not None:
                raw = stream.read()
                if is_source(relative) and not _legal_path(relative):
                    result.update(extract_embedded_notices(relative, raw))
                else:
                    result[relative] = raw
        manifest = json.loads(result.get("package.json", b"{}"))
        license_id = _license(manifest.get("license")) or ""
        if match := re.match(r"SEE LICEN[CS]E IN (.+)", license_id, re.IGNORECASE):
            relative = _safe_path(match.group(1)).as_posix()
            if "node_modules" in PurePosixPath(relative).parts:
                raise ValueError("declared license crosses an npm package boundary")
            if relative not in result:
                member_path = selected_root + PurePosixPath(relative).parts
                member = members.get(member_path)
                if member is None:
                    errors.append(f"declared-license-file-missing: {relative}")
                else:
                    if member.isfile() and not linked(member_path) and member.size <= MAX_TEXT_BYTES:
                        stream = archive.extractfile(member)
                        if stream is not None:
                            result[relative] = stream.read()
                    else:
                        errors.append(f"declared-license-file-not-readable: {relative}")
    return result


def _review(license_id: str) -> list[str]:
    if license_id == "UNKNOWN":
        return ["unknown-license"]
    result: list[str] = []
    if re.search(r"(?:^|[^A-Za-z])(?:AGPL|GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL)[-\d]", license_id, re.IGNORECASE):
        result.append("copyleft-or-reciprocal-license: review distribution obligations and any OR alternatives")
    tokens = re.findall(r"[A-Za-z0-9][A-Za-z0-9.+:-]*", license_id)
    special = sorted({token for token in tokens if token not in SPDX_PERMISSIVE and token not in {"AND", "OR", "WITH"}})
    if special:
        result.append("license-review-required: " + ", ".join(special))
    return result


def _supplement(repo: Path, record: dict[str, Any], upstream: dict, declarations: dict) -> None:
    """Apply checked-in, version-specific evidence; never fetch moving branches."""
    key = record["name"] + "@" + record["version"]
    supplied = []
    for item in upstream.get(key, []):
        try:
            relative = _safe_path(item["path"])
            path = repo / relative
            if path.is_symlink() or repo not in path.resolve().parents:
                raise ValueError("supplement must be a regular file within the repository")
            from license_evidence import authenticated_text_bytes
            raw = authenticated_text_bytes(path.read_bytes(), item.get("sha256"), str(relative))
            text = _decode(raw, str(relative), record["errors"])
            if text is not None:
                record["texts"].append({"path": str(relative), "text": text, "url": item["url"], "note": item.get("note"), "provenance_kind": item.get("provenance_kind")})
                supplied.append({k: v for k, v in item.items() if k != "text"})
                record["review"].extend(item.get("review", []))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            record["errors"].append(f"upstream-supplement-failed: {type(exc).__name__}")
    if supplied:
        record["upstream_sources"] = supplied
    if any(item.get("complete_license", _terms_path(item["path"])) for item in supplied):
        for missing in ("missing-dedicated-license-file", "missing-license-text"):
            if missing in record["errors"]:
                record["errors"].remove(missing)
                record["warnings"].append(missing + "-in-npm-package: supplemented by pinned upstream evidence")
    if item := declarations.get(key):
        # These are human-reviewed declarations tied to exact original text,
        # not license inference from a package name, neighboring version, or URL.
        matching = [t for t in record["texts"] if t["path"] == item["path"] and hashlib.sha256(t["text"].encode()).hexdigest() == item["sha256"]]
        if matching:
            if record["license"] == "UNKNOWN":
                record["license"] = item["license"]
                record["warnings"].append("missing-package-license-declaration: identified from reviewed, hash-pinned original license document")
            record["license_evidence"] = item
            if "missing-license-declaration" in record["errors"]:
                record["errors"].remove("missing-license-declaration")
            if item.get("complete_license"):
                for missing in ("missing-dedicated-license-file", "missing-license-text"):
                    if missing in record["errors"]:
                        record["errors"].remove(missing)
                        record["warnings"].append(missing + ": complete terms preserved in reviewed original document")
        else:
            record["errors"].append("reviewed-license-declaration-evidence-mismatch")


def _collect_one(repo: Path, lockfile: str, package_path: str, locked: dict[str, Any], cache: Path, upstream: dict | None = None, declarations: dict | None = None, packages: dict[str, Any] | None = None) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    path = _safe_path(package_path)
    # Alias entries can have a manifest name different from their install key.
    inferred_name = package_path.rsplit("node_modules/", 1)[-1]
    name = str(locked.get("name") or inferred_name)
    version = str(locked.get("version", "UNKNOWN"))
    source = str(locked.get("resolved") or "")
    integrity = str(locked.get("integrity") or "")
    lock_license = _license(locked.get("license"))
    record: dict[str, Any] = {
        "name": name,
        "version": version,
        "license": lock_license or "UNKNOWN",
        "source": source,
        "integrity": integrity,
        "scope": "dev-only" if locked.get("dev") and not locked.get("devOptional") else "runtime",
        "lockfile": lockfile,
        "package_path": package_path,
        "optional": bool(locked.get("optional") or locked.get("devOptional")),
        "texts": [],
        "errors": errors,
        "warnings": warnings,
        "review": [],
        "evidence_origin": "unavailable",
        "integrity_verified": False,
    }
    bundled = locked.get("inBundle") is True
    if not source and not bundled:
        errors.append("missing-registry-source")
    if not integrity and not bundled:
        errors.append("missing-lockfile-integrity")
    package = repo / Path(lockfile).parent / path
    manifest: dict[str, Any] = {}
    payload: dict[str, bytes] = {}
    try:
        if bundled:
            parent_path, parent, expected_packages = _bundle_source(package_path, packages or {})
            subpath = package_path[len(parent_path) + 1:]
            record["bundled_from"] = {
                "package_path": parent_path,
                "name": expected_packages[""][0],
                "version": expected_packages[""][1],
                "source": str(parent.get("resolved") or ""),
                "integrity": str(parent.get("integrity") or ""),
                "package_subpath": subpath,
            }
            tarball = _download(record["bundled_from"]["source"], record["bundled_from"]["integrity"], cache)
            payload = _read_tarball(tarball, errors, subpath, expected_packages)
            record["evidence_origin"] = "bundled-registry-tarball"
            record["integrity_verified"] = True
            manifest = json.loads(payload.get("package.json", b"{}"))
        elif package.is_dir() and not package.is_symlink():
            try:
                manifest = json.loads((package / "package.json").read_bytes())
            except (OSError, ValueError) as exc:
                warnings.append(f"installed-manifest-unreadable; using verified tarball: {type(exc).__name__}")
            expected_name = locked.get("name") or inferred_name
            if manifest.get("version") != version or manifest.get("name") != expected_name:
                warnings.append("installed-package-identity-mismatch; using verified tarball")
                manifest = {}
            if manifest:
                payload = _read_local(package, errors)
                record["evidence_origin"] = "installed:" + package.relative_to(repo).as_posix()
        if not payload:
            tarball = _download(source, integrity, cache)
            payload = _read_tarball(tarball, errors)
            record["evidence_origin"] = "registry-tarball"
            record["integrity_verified"] = True
            manifest = json.loads(payload.get("package.json", b"{}"))
            if manifest.get("version") != version or manifest.get("name") != name:
                errors.append("tarball-package-identity-mismatch")
                payload = {}
        manifest_license = _license(manifest.get("license") or manifest.get("licenses"))
        record["manifest_license"] = manifest_license
        record["lock_license"] = lock_license
        record["license"] = manifest_license or lock_license or "UNKNOWN"
        if manifest_license and lock_license and manifest_license != lock_license:
            warnings.append(f"license-declaration-differs: lock={lock_license}; manifest={manifest_license}")
        referenced_license = None
        if manifest_license and (match := re.match(r"SEE LICEN[CS]E IN (.+)", manifest_license, re.IGNORECASE)):
            referenced_license = _safe_path(match.group(1)).as_posix()
            # Official manifests normally name LICENSE-like files. If a local
            # manifest names another regular file, preserve that exact document.
            if referenced_license not in payload and record["evidence_origin"].startswith("installed:"):
                referenced = package / referenced_license
                if referenced.is_file() and not referenced.is_symlink() and referenced.stat().st_size <= MAX_TEXT_BYTES:
                    payload[referenced_license] = referenced.read_bytes()
        for relative, data in sorted(payload.items()):
            if relative == referenced_license or _legal_path(relative) or (README_NAME.match(PurePosixPath(relative).name) and b'copyright' in data.lower()):
                text = _decode(data, relative, errors)
                if text is not None:
                    record["texts"].append({"path": relative, "text": text})
        if not any(not t["path"].startswith("embedded-notices/") and (_terms_path(t["path"]) or t["path"] == referenced_license) for t in record["texts"]):
            errors.append("missing-dedicated-license-file")
            for relative, data in sorted(payload.items()):
                if README_NAME.match(PurePosixPath(relative).name):
                    text = _decode(data, relative, errors)
                    if text is not None and README_LEGAL.search(text) and not any(t["path"] == relative for t in record["texts"]):
                        record["texts"].append({"path": relative, "text": text})
            if any(README_NAME.match(PurePosixPath(t["path"]).name) for t in record["texts"]):
                warnings.append("readme-license-evidence-only: complete original README retained; verify it contains the required full terms")
            else:
                errors.append("missing-license-text")
        if record["license"] == "UNKNOWN":
            errors.append("missing-license-declaration")
    except Exception as exc:
        errors.append(f"collection-failed: {type(exc).__name__}" + (f": {exc}" if bundled else ""))
    _supplement(repo, record, upstream or {}, declarations or {})
    record["review"] = sorted(set(_review(record["license"]) + record["review"]))
    if errors:
        record["review"].append("incomplete-evidence: inspect errors")
    return record


def collect(repo: Path) -> list[dict]:
    """Collect dependency notices without changing the repository or lockfiles.

    Set DEVCEL_NPM_LICENSE_CACHE to an outside-repo directory to reuse verified
    tarballs; set DEVCEL_NPM_LICENSE_WORKERS to control concurrency (default 6).
    DEVCEL_NPM_LICENSE_OFFLINE=1 disables downloads; uncached entries still appear
    with explicit errors. Pinned upstream supplements are read from checked-in
    third-party/npm-upstream.json and verified against their stored SHA-256.
    Failure to read a lockfile is fatal; individual evidence failures are retained
    in each entry's errors list, rather than silently omitting that dependency.
    """
    repo = Path(repo).resolve()
    cache = _cache_dir(repo)
    upstream_path = repo / "third-party/npm-upstream.json"
    declarations_path = repo / "third-party/npm-license-declarations.json"
    upstream = json.loads(upstream_path.read_bytes()) if upstream_path.is_file() else {}
    declarations = json.loads(declarations_path.read_bytes()) if declarations_path.is_file() else {}
    work: list[tuple[str, str, dict[str, Any], dict[str, Any]]] = []
    for relative in LOCKFILES:
        lock = json.loads((repo / relative).read_bytes())
        if lock.get("lockfileVersion") not in (2, 3) or not isinstance(lock.get("packages"), dict):
            raise ValueError(f"unsupported npm lockfile format: {relative}")
        work.extend((relative, path, metadata, lock["packages"]) for path, metadata in sorted(lock["packages"].items()) if path)
    workers = max(1, min(16, int(os.environ.get("DEVCEL_NPM_LICENSE_WORKERS", "6"))))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(lambda entry: _collect_one(repo, *entry[:3], cache, upstream, declarations, packages=entry[3]), work))


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", nargs="?", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, help="Write raw inventory JSON (contains complete license texts).")
    arguments = parser.parse_args()
    inventory = collect(arguments.repo)
    rendered = json.dumps(inventory, ensure_ascii=False, indent=2) + "\n"
    if arguments.output:
        arguments.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
