#!/usr/bin/env python3
"""Wrap a Devcel v1 full JSON bundle as a Roblox Luau ModuleScript."""
import argparse
import json
import os
from pathlib import Path
import tempfile


def render(text: str) -> str:
    bundle = json.loads(text)
    if not isinstance(bundle, dict) or not isinstance(bundle.get("manifest"), dict):
        raise ValueError("missing bundle manifest")
    manifest = bundle["manifest"]
    if manifest.get("schema_version") != 1 or manifest.get("mode") != "full":
        raise ValueError("expected a full Devcel bundle with schema_version 1")
    if not isinstance(bundle.get("tables"), list):
        raise ValueError("bundle tables must be an array")
    # JSON remains data, never executable Luau. Choose a delimiter absent from it.
    eq = ""
    while "]" + eq + "]" in text:
        eq += "="
    # A newline after a Luau long-bracket opener is discarded by the parser.
    return ("-- Generated from a Devcel runtime bundle. Do not edit.\n"
            "local HttpService = game:GetService(\"HttpService\")\n"
            "return HttpService:JSONDecode([" + eq + "[\n" + text + "]" + eq + "])\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("output", type=Path, help="destination .luau file")
    args = parser.parse_args()
    result = render(args.bundle.read_text(encoding="utf-8"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Write beside the target then replace; a failed conversion leaves it intact.
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=args.output.parent, delete=False) as f:
            name = f.name
            f.write(result)
        os.replace(name, args.output)
        name = None
    finally:
        if name is not None:
            os.unlink(name)


if __name__ == "__main__":
    main()
