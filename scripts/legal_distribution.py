"""Select distribution notices only after auditing the complete original evidence."""
from pathlib import Path
import hashlib
import json


def distribution_files(legal):
    legal = Path(legal)
    aggregate = legal / 'THIRD-PARTY-NOTICES.txt'
    document = aggregate.read_bytes()
    inventory = json.loads((legal / 'inventory.json').read_text(encoding='utf-8'))
    checked = {}
    for package in inventory['packages']:
        if package.get('errors'): raise ValueError('Unresolved license evidence: ' + package['name'])
        version = f" {package['version']}" if 'version' in package else ''
        heading = f"{package['ecosystem']}: {package['name']}{version}\n".encode()
        if heading not in document: raise ValueError('Missing package notice mapping: ' + package['name'])
        for evidence in package['texts']:
            source = legal / evidence['file']
            if source.is_symlink() or not source.resolve().is_relative_to(legal.resolve()):
                raise ValueError('Unsafe original license path')
            if source not in checked:
                raw = source.read_bytes()
                if raw not in document: raise ValueError('Original license/NOTICE text missing from aggregate')
                checked[source] = hashlib.sha256(raw).hexdigest()
            if checked[source] != evidence['sha256']: raise ValueError('Original license evidence hash differs')
    return {'THIRD-PARTY-NOTICES.txt': aggregate}
