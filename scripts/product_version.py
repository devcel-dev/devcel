"""Read the single product-version setting; package versions are generated."""
import json
from pathlib import Path
import re

CONFIG = 'devcel-studio/src-tauri/tauri.conf.json'
SEMVER = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?')


def validate_version(version):
    if not isinstance(version, str) or not SEMVER.fullmatch(version):
        raise ValueError('Expected product SemVer without v or build metadata')
    return version


def read_version(root):
    return validate_version(json.loads((Path(root)/CONFIG).read_bytes())['version'])
