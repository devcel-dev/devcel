#!/usr/bin/env python3
"""Fail-closed review of native files in an extracted release payload.

The input must be a complete extracted payload, not the outer installer. This
scanner never runs binaries. Extraction/bootstrapper review is explicit metadata.
"""
from __future__ import annotations
import argparse, hashlib, json, pathlib, stat, sys

MAGIC = (b'\x7fELF', b'MZ', b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf')

def sha256(path):
    with path.open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()

def inventory(root):
    root = root.resolve()
    found=[]
    for path in root.rglob('*'):
        is_link = path.is_symlink() or bool(getattr(path.lstat(), 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))
        if is_link and not path.resolve().is_relative_to(root):
            raise RuntimeError(f'Payload link escapes extracted root: {path.relative_to(root)}')
        if not path.is_file():continue
        with path.open('rb') as source:prefix=source.read(4)
        if any(prefix.startswith(magic) for magic in MAGIC):
            found.append({'path':path.relative_to(root).as_posix(),'sha256':sha256(path)})
    return sorted(found, key=lambda item: item['path'])

# Tauri 2.12.2 patches the first UNK token for each bundle, then restores
# the original executable. Compare the ENTIRE resulting file, not only code
# sections, a filename, a build ID, or a normalized payload hash.
BUNDLE_TOKEN = b'__TAURI_BUNDLE_TYPE_VAR_UNK'
BUNDLE_TYPES = {'.msi': b'MSI', '.exe': b'NSS', '.deb': b'DEB',
                '.rpm': b'RPM', '.appimage': b'APP'}

def first_party_identity(path, artifact_suffix=None):
    data=path.read_bytes();original=hashlib.sha256(data).hexdigest()
    kind=BUNDLE_TYPES.get(artifact_suffix)
    offset=data.find(BUNDLE_TOKEN) if kind else -1
    if offset >= 0:
        replacement=BUNDLE_TOKEN[:-3]+kind
        data=data[:offset]+replacement+data[offset+len(BUNDLE_TOKEN):]
    return {'source_file':path.name,'source_sha256':original,'sha256':hashlib.sha256(data).hexdigest(),
            'transformation':'tauri-bundle-type' if offset >= 0 else 'exact',
            'bundle_type':kind.decode() if offset >= 0 else None,
            'patch_offset':offset if offset >= 0 else None}

def verify(root, manifest, first_party, artifact_suffix=None):
    errors=[];files=inventory(root)
    identities=[first_party_identity(p,artifact_suffix) for p in first_party]
    own={item['sha256'] for item in identities}
    for file in files:
        identity=next((item for item in identities if item['sha256']==file['sha256']),None)
        if identity is not None:file['first_party_identity']=identity
    if manifest.get('review_status')!='verified':errors.append('Platform packaging/runtime review is not verified')
    for field in ('platform','format','extraction_evidence','bootstrapper_and_system_runtime_review'):
        if not manifest.get(field):errors.append(f'Missing packaging evidence: {field}')
    reviewed_formats=manifest.get('reviewed_artifact_formats')
    if reviewed_formats is not None and artifact_suffix not in reviewed_formats:
        errors.append(f'Artifact format has not been reviewed: {artifact_suffix}')
    present={file['sha256'] for file in files}
    for missing in sorted(own-present):
        errors.append(f'Expected first-party binary missing from extracted payload: {missing}')
    known={row['sha256']:row for row in manifest.get('native_components',[])}
    for file in files:
        if file['sha256'] in own:continue
        reviewed=known.get(file['sha256'])
        if not reviewed:
            errors.append(f'Unreviewed native file: {file["path"]} ({file["sha256"]})');continue
        for field in ('name','version','license','upstream_source','source_availability','linking_or_relinking'):
            if not reviewed.get(field):errors.append(f'{file["path"]}: missing {field}')
        if not reviewed.get('notices'):errors.append(f'{file["path"]}: missing original notice files')
        for notice in reviewed.get('notices',[]):
            path=(root/notice['payload_path']).resolve()
            if not path.is_relative_to(root) or not path.is_file() or sha256(path)!=notice.get('sha256'):
                errors.append(f'{file["path"]}: original notice missing/changed in payload: {notice["payload_path"]}')
    if not files:errors.append('No native payload files found; installer extraction has not been demonstrated')
    return files,errors

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=pathlib.Path,required=True)
    parser.add_argument('--manifest',type=pathlib.Path,required=True)
    parser.add_argument('--first-party',type=pathlib.Path,action='append',default=[])
    parser.add_argument('--report',type=pathlib.Path,required=True)
    parser.add_argument('--artifact-format',choices=sorted({*BUNDLE_TYPES, '.zip'}))
    args=parser.parse_args();root=args.root.resolve()
    if not root.is_dir():raise RuntimeError('Extracted payload directory does not exist')
    manifest=json.loads(args.manifest.read_text());files,errors=verify(root,manifest,args.first_party,args.artifact_format)
    report={'schema_version':1,'platform':manifest.get('platform'),'native_files':files,'errors':errors,'verified':not errors}
    args.report.parent.mkdir(parents=True,exist_ok=True);args.report.write_text(json.dumps(report,indent=2)+'\n')
    if errors:
        print('\n'.join(errors),file=sys.stderr);sys.exit(1)
    print(f'Native notice gate passed: {len(files)} payload files')

if __name__=='__main__':main()
