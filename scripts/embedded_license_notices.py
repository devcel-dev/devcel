"""Extract original legal comment blocks without changing their bytes.

This supplements dedicated LICENSE/NOTICE files, not a license-identifier guess.
Only text source formats are inspected; generated source maps and binaries are
not interpreted as code. False-positive legal prose is retained conservatively.
"""
from __future__ import annotations
import re
from pathlib import PurePosixPath

SOURCE_SUFFIXES = {'.js','.cjs','.mjs','.jsx','.ts','.tsx','.css','.c','.h','.cc','.cpp','.rs','.java','.kt','.swift','.html'}
BLOCK = re.compile(rb'/\*[\s\S]*?\*/|<!--[\s\S]*?-->')
LINES = re.compile(rb'(?m)(?:^[ \t]*//[^\r\n]*(?:\r?\n|$))+')
LEGAL = re.compile(rb'copyright\s*(?:\(c\)|[\xc2\xa9]|\d)|@licen[sc]e\b|@preserve\b|permission is hereby granted|licensed under (?:the )?(?:apache|mit|bsd|isc|mozilla|gnu)|spdx-license-identifier',re.IGNORECASE)

def is_source(path: str) -> bool:
    return PurePosixPath(path).suffix.lower() in SOURCE_SUFFIXES

def extract(path: str, data: bytes) -> dict[str, bytes]:
    if not is_source(path):return {}
    result={};seen=set()
    for match in sorted([*BLOCK.finditer(data),*LINES.finditer(data)],key=lambda m:m.start()):
        comment=match.group()
        if not LEGAL.search(comment) or comment in seen:continue
        seen.add(comment)
        line=data.count(b'\n',0,match.start())+1
        result[f'embedded-notices/{path}.L{line}.COPYRIGHT']=comment
    return result
