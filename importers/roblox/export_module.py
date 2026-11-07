#!/usr/bin/env python3
"""Wrap a Devcel v1 full JSON bundle as a Roblox Luau ModuleScript."""
import argparse
import json
import math
import uuid
import os
import struct
from pathlib import Path
import tempfile


def finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("expected finite number")
    return value


def float32(value):
    try:
        result = struct.unpack("<f", struct.pack("<f", finite(value)))[0]
    except (OverflowError, struct.error) as error:
        raise ValueError("float32 out of range") from error
    return finite(result)


def curve(text, config):
    raw = json.loads(text) if text else {"points": [{"x": 0, "y": 0, "mode": "auto"}, {"x": 1, "y": 1, "mode": "auto"}]}
    points = raw.get("points") if isinstance(raw, dict) else None
    if not isinstance(points, list) or len(points) < 2: raise ValueError("curve requires at least two points")
    points = [dict(p) for p in points]
    last = len(points) - 1
    previous = -1
    for p in points:
        x, y = finite(p["x"]), finite(p["y"])
        if x < 0 or x > 1 or x <= previous: raise ValueError("invalid curve positions")
        previous = x
        if p.get("mode") not in ("constant", "linear", "auto", "autoLength", "free"): raise ValueError("invalid curve tangent")
        for field in ("inLen", "outLen"):
            n = finite(p.get(field, 1))
            if n < 0 or n > 3: raise ValueError("invalid curve tangent length")
        for field in ("inSlope", "outSlope"):
            if field in p: finite(p[field])
    if points[0]["x"] != 0 or points[-1]["x"] != 1: raise ValueError("invalid curve endpoints")
    if config is not None:
        points[0]["y"] = finite(config["start_value"]); points[-1]["y"] = finite(config["end_value"])
    def auto(i):
        left, right = points[max(i-1, 0)], points[min(i+1, last)]
        return (right["y"]-left["y"]) / max(right["x"]-left["x"], 1e-9)
    def handle(i, outgoing):
        p = points[i]; mode = p["mode"]
        if mode == "constant": return 0, 1
        if mode == "linear":
            other = points[i+1 if outgoing else i-1]
            return (other["y"]-p["y"]) / max(abs(other["x"]-p["x"]), 1e-9) * (1 if outgoing else -1), 1
        slope = p.get("outSlope" if outgoing else "inSlope", auto(i)) if mode == "free" else auto(i)
        return slope, p.get("outLen" if outgoing else "inLen", 1)
    segments = []
    for i in range(last):
        a,b=points[i],points[i+1]; os,ol=handle(i,True); ins,il=handle(i+1,False)
        ol=(b["x"]-a["x"])/3*ol; il=(b["x"]-a["x"])/3*il; constant=a["mode"]=="constant"
        ys=[a["y"], a["y"] if constant else a["y"]+os*ol, b["y"] if constant else b["y"]-ins*il, b["y"]]
        for v in ys: finite(v)
        segments.append({"x": [a["x"],a["x"]+ol,b["x"]-il,b["x"]], "y":ys, "constant":constant})
    return {"__devcel_kind":"curve", "segments":segments, "endValue":points[-1]["y"]}


def convert(bundle):
    by_uuid = {table.get("uuid"): table for table in bundle["tables"] if isinstance(table, dict) and table.get("uuid")}
    if len(by_uuid) != sum(1 for table in bundle["tables"] if isinstance(table, dict) and table.get("uuid")):
        raise ValueError("duplicate table UUID")
    for table in bundle["tables"]:
        if not isinstance(table, dict): raise ValueError("invalid table")
        columns = table.get("columns", [])
        if not isinstance(columns, list): raise ValueError("invalid columns")
        names = [column["name"] for column in columns]
        if len(names) != len(set(names)): raise ValueError("duplicate column name")
        records = table.get("records", [])
        if not isinstance(records, list): raise ValueError("invalid records")
        record_ids = set()
        for record in records:
            record_id = record["id"]
            if record_id in record_ids: raise ValueError("duplicate record id")
            record_ids.add(record_id)
            values = record.get("values", {})
            if not isinstance(values, dict): raise ValueError("invalid values")
            record["values"] = values
            for col in columns:
                name, kind = col["name"], col["data_type"]
                text = values.get(name, col.get("default_value"))
                if text is None: text = ""
                if not isinstance(text, str): raise ValueError("cell value must be a string")
                if kind in ("Reference", "TableRef"):
                    if text: uuid.UUID(text)
                    config = col.get("reference_config") or {}
                    target = config.get("target_table_uuid")
                    if kind == "Reference" and target and target not in by_uuid:
                        raise ValueError("reference target not in bundle")
                    if kind == "TableRef" and text:
                        target_table = by_uuid.get(text)
                        interface = (col.get("table_ref_config") or {}).get("interface_uuid")
                        if target_table is None or (interface and interface not in target_table.get("interfaces", [])):
                            raise ValueError("table reference missing or incompatible")
                    values[name] = {"__devcel_kind": "reference" if kind == "Reference" else "table_ref", "id": text, "targetTableId": target}
                elif kind in ("Color32", "ColorFloat"):
                    components = json.loads(text) if text else ([255,255,255,255] if kind == "Color32" else [1,1,1,1])
                    if not isinstance(components,list) or len(components)!=4: raise ValueError("color requires four components")
                    for n in components: finite(n)
                    if kind == "Color32" and any(type(n) is not int or n<0 or n>255 for n in components): raise ValueError("invalid Color32")
                    if kind == "ColorFloat":
                        if not 0 <= components[3] <= 1: raise ValueError("invalid color alpha")
                        components = [float32(n) for n in components]
                    values[name] = dict(zip(("r","g","b","a"),components), __devcel_kind=kind)
                elif kind == "Curve": values[name] = curve(text, col.get("curve_config"))
                elif kind == "Boolean":
                    text = text.strip()
                    if text not in ("", "true", "false"): raise ValueError("invalid boolean")
                    values[name] = text == "true"
                elif kind in ("U8","I8","U16","I16","U32","I32"):
                    v=int(text) if text else 0; bits=int(kind[1:]); lower=0 if kind[0]=="U" else -(1<<(bits-1)); upper=(1<<bits)-1 if kind[0]=="U" else (1<<(bits-1))-1
                    if not lower<=v<=upper: raise ValueError("integer out of range")
                    values[name] = v
                elif kind in ("F32","F64"):
                    v=float(text) if text else 0.0; values[name]=float32(v) if kind == "F32" else finite(v)
                elif kind in ("U64", "I64"):
                    n=int(text) if text else 0
                    lower=0 if kind=="U64" else -(1<<63); upper=(1<<64)-1 if kind=="U64" else (1<<63)-1
                    if not lower<=n<=upper: raise ValueError("integer out of range")
                    values[name] = str(n)
                elif kind in ("String", "Select", "DateTime", "None"): values[name] = text
                else: raise ValueError("unsupported column type: " + str(kind))
    return bundle


def render(text: str) -> str:
    def reject_constant(value: str):
        raise ValueError(f"invalid JSON number: {value}")

    bundle = json.loads(text, parse_constant=reject_constant)
    if not isinstance(bundle, dict) or not isinstance(bundle.get("manifest"), dict):
        raise ValueError("missing bundle manifest")
    manifest = bundle["manifest"]
    version = manifest.get("schema_version")
    if type(version) is not int or version != 1 or manifest.get("mode") != "full":
        raise ValueError("expected a full Devcel bundle with schema_version 1")
    if not isinstance(bundle.get("tables"), list):
        raise ValueError("bundle tables must be an array")
    # Serialize validated typed data as JSON, not executable Luau.
    text = json.dumps(convert(bundle), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    eq = ""
    while "]" + eq + "]" in text:
        eq += "="
    runtime = Path(__file__).with_name("runtime.luau.txt").read_text(encoding="utf-8")
    license_text = Path(__file__).with_name("LICENSE").read_text(encoding="utf-8").strip()
    notice = "\n".join("-- " + line for line in license_text.splitlines())
    return (notice + "\n-- Generated from a Devcel runtime bundle. Do not edit.\n"
            "local HttpService = game:GetService(\"HttpService\")\n"
            "local data = HttpService:JSONDecode([" + eq + "[\n" + text + "]" + eq + "])\n" + runtime + "\nreturn data\n")


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
