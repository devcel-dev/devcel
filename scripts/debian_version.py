"""Map release SemVer to Debian ordering without changing application identity."""
from pathlib import Path
import argparse
import os
import re
import subprocess
import tempfile

VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?')


def control_version(version):
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError('Expected release SemVer without metadata')
    return version.replace('-', '~', 1)


def rewrite_control(raw, version):
    expected = control_version(version).encode('ascii')
    matches = list(re.finditer(rb'^Version:[ \t]*([^\r\n]+)', raw, re.MULTILINE | re.IGNORECASE))
    if len(matches) != 1 or matches[0][1].strip() not in (version.encode('ascii'), expected):
        raise ValueError('Debian control version differs from release candidate')
    match = matches[0]
    return raw[:match.start(1)] + expected + raw[match.end(1):]


def verify(artifact, version):
    actual = subprocess.check_output(['dpkg-deb', '--field', str(artifact), 'Version'], text=True).strip()
    if actual != control_version(version):
        raise ValueError('Debian package version differs from canonical release mapping')


def prepare(artifact, version):
    artifact = Path(artifact).resolve(strict=True)
    expected = control_version(version)
    actual = subprocess.check_output(['dpkg-deb', '--field', str(artifact), 'Version'], text=True).strip()
    if actual == expected:
        return
    if actual != version:
        raise ValueError('Unexpected input Debian version')
    # Tauri's pinned DebConfig has no independent version override. Repackage
    # only the unpublished candidate using dpkg's own tools; no script executes.
    with tempfile.TemporaryDirectory(prefix='devcel-debian-', dir=artifact.parent) as directory:
        directory = Path(directory)
        stage = directory/'package'
        subprocess.run(['dpkg-deb', '--raw-extract', str(artifact), str(stage)], check=True)
        control = stage/'DEBIAN/control'
        if control.is_symlink():
            raise ValueError('Linked Debian control file')
        control.write_bytes(rewrite_control(control.read_bytes(), version))
        output = directory/'mapped.deb'
        environment = dict(os.environ)
        environment.setdefault('SOURCE_DATE_EPOCH', '0')
        subprocess.run(['dpkg-deb', '--build', '--root-owner-group', str(stage), str(output)],
                       check=True, env=environment)
        verify(output, version)
        os.replace(output, artifact)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--artifact', type=Path)
    target.add_argument('--bundle-dir', type=Path)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    artifact = args.artifact
    if args.bundle_dir:
        candidates = list(args.bundle_dir.glob('*.deb'))
        if len(candidates) != 1 or candidates[0].is_symlink():
            parser.error('Expected one newly built Debian package')
        artifact = candidates[0]
    prepare(artifact, args.version)
