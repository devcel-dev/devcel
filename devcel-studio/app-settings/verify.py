#!/usr/bin/env python3
"""Exercise localization domain tables through the real CLI (Python 3.11+)."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import tomllib
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path)
    args = parser.parse_args()
    cli = args.cli.resolve()
    with tempfile.TemporaryDirectory(prefix="devcel-localization-") as temp:
        root = Path(temp)
        project = root / "studio"
        out = root / "generated"
        passes = []

        def run(*arguments, good=True, use_project=True):
            command = [str(cli)]
            if use_project:
                command += ["--project", str(project), "--mode", "local"]
            result = subprocess.run(command + list(arguments), capture_output=True, text=True)
            try:
                value = json.loads(result.stdout)
            except json.JSONDecodeError as error:
                raise AssertionError(f"Expected JSON output: {result.stdout}\n{result.stderr}") from error
            assert (result.returncode == 0 and value["ok"]) == good, (command, arguments, value, result.stderr)
            return value

        def snapshot():
            return {p.name: p.read_bytes() for p in out.iterdir() if p.is_file()}

        def export(good=True):
            return run("localization", "export", "--out", str(out), good=good)

        def import_rows(rows):
            fragment = root / "fragment.json"
            fragment.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
            return run("localization", "import", str(fragment))

        def table(name):
            return project / "Tables" / ("Localization" if name in {"Locales", "Messages"} else "") / f"{name}.table.toml"

        def table_paths(name=None):
            if name == "Translations":
                return sorted((project / "Tables" / "Translations").glob("*.table.toml"))
            if name is not None:
                return [table(name)]
            return sorted((project / "Tables").rglob("*.table.toml"))

        def database_snapshot():
            return {path: path.read_bytes() for path in table_paths()}

        def records(name):
            return [record for path in table_paths(name)
                    for record in tomllib.loads(path.read_text(encoding="utf-8"))["records"]]

        def record_path(name, record_id):
            owners = [path for path in table_paths(name)
                      if any(record["uuid"] == record_id for record in
                             tomllib.loads(path.read_text(encoding="utf-8"))["records"])]
            assert len(owners) == 1, (name, record_id, owners)
            return owners[0]

        def cell(name, record_id, column, value):
            """Invalid fixtures intentionally corrupt saved tables outside normal CLI validation."""
            path = record_path(name, record_id)
            raw = path.read_text(encoding="utf-8")
            blocks = re.split(r"(?=^\[\[records\]\]$)", raw, flags=re.M)
            matches = 0
            for index, block in enumerate(blocks):
                if f'uuid = "{record_id}"' not in block:
                    continue
                new = f"{column} = {json.dumps(value, ensure_ascii=False)}"
                blocks[index], count = re.subn(rf"^{re.escape(column)} = .*$", lambda _: new, block, count=1, flags=re.M)
                assert count == 1, (name, column)
                matches += 1
            assert matches == 1, (name, record_id)
            path.write_text("".join(blocks), encoding="utf-8")

        def invalid_fixture(label, mutate):
            original = database_snapshot()
            before = snapshot()
            try:
                mutate()
                export(good=False)
                assert snapshot() == before, f"{label}: failure changed generated output"
                passes.append(label)
            finally:
                for path in set(table_paths()) - set(original):
                    path.unlink()
                for path, content in original.items():
                    path.write_bytes(content)

        run("localization", "init", "--dir", str(root), "--name", "studio", use_project=False)
        rows = [
            {"key": "fixture.plural", "ja": "{n, plural, =0 {なし} other {{kind, select, a {A # 件} other {その他 # 件}}}}",
             "en": "{n, plural, =0 {None} one {{kind, select, a {A # item} other {Other # item}}} other {{kind, select, a {A # items} other {Other # items}}}}"},
            {"key": "fixture.formats", "ja": "{name} {n, number, ::percent} {when, date, short} {when, time, short}",
             "en": "{name}: {n, number, ::percent}, {when, date, short}, {when, time, short}"},
            {"key": "fixture.literal", "ja": "'{'文字'}' '' <b>安全</b>", "en": "'{'text'}' '' <b>safe</b>"},
        ]
        import_rows(rows)
        assert {path.name for path in table_paths("Translations")} == {
            "common.table.toml", "fixture.table.toml"}
        assert not table("Translations").exists()
        domain_rows = tomllib.loads((project / "Tables/Translations/fixture.table.toml").read_text())["records"]
        assert len(domain_rows) == 2 * len(rows)
        passes.append("Domain creation keeps both fixture locales together")
        db_before = database_snapshot()
        bad_import = root / "invalid.json"
        bad_import.write_text(json.dumps([{"key": "fixture.plural", "ja": "{broken", "en": "Broken"}]))
        run("localization", "import", str(bad_import), good=False)
        assert database_snapshot() == db_before, "Invalid import changed the database"
        passes.append("Invalid import leaves sources unchanged")
        bad_import.write_text(json.dumps([{"key": "newdomain.invalid", "ja": "{broken", "en": "Broken"}]))
        run("localization", "import", str(bad_import), good=False)
        assert database_snapshot() == db_before, "Invalid new-domain import changed the database"
        assert not (project / "Tables/Translations/newdomain.table.toml").exists()
        passes.append("Invalid new-domain import leaves no table behind")
        collision_path = project / "Tables/Translations/collision.table.toml"
        source_path = project / "Tables/Translations/common.table.toml"
        source_table = tomllib.loads(source_path.read_text())
        header = re.split(r"(?=^\[\[records\]\]$)", source_path.read_text(), flags=re.M)[0]
        header = header.replace(source_table["uuid"], str(uuid.uuid4()), 1)
        header = header.replace('data_name = "Translations_common"', 'data_name = "Unrelated"', 1)
        collision_path.write_text("records = []\n" + header)
        collision_before = database_snapshot()
        bad_import.write_text(json.dumps([{"key": "collision.save", "ja": "Save", "en": "Save"}]))
        run("localization", "import", str(bad_import), good=False)
        assert database_snapshot() == collision_before, "Domain import overwrote an existing destination"
        collision_path.unlink()
        passes.append("Existing domain destination is never overwritten")
        run("localization", "validate")
        export()
        baseline = snapshot()
        export()
        assert snapshot() == baseline, "Regeneration is nondeterministic"
        run("localization", "export", "--out", str(out), "--check")
        catalog = json.loads((out / "catalog.json").read_text())
        assert set(catalog["messages"]) == {"ja", "en", "en-XA"}
        assert catalog["messages"]["ja"]["common.save"] == "保存"
        assert catalog["messages"]["en-XA"]["fixture.plural"] != catalog["messages"]["en"]["fixture.plural"]
        assert re.search(r'\{n,\s*plural,', catalog["messages"]["en-XA"]["fixture.plural"])
        keys = (out / "keys.ts").read_text()
        assert '"n": number' in keys and '"when": Date | number' in keys
        for path in table_paths():
            blocks = re.split(r"(?=^\[\[records\]\]$)", path.read_text(), flags=re.M)
            path.write_text(blocks[0] + "".join(reversed(blocks[1:])))
        export()
        assert snapshot() == baseline, "Record order changed generated output"
        passes += ["init/import/validate/export", "Deterministic generation, check, and record-order independence", "Nested ICU, formatting, quoting, and pseudo-locale"]

        messages = records("Messages")
        locales = records("Locales")
        translations = records("Translations")
        msg = next(r for r in messages if r["values"]["key"] == "common.save")
        other = next(r for r in messages if r["values"]["key"] == "common.cancel")
        ja = next(r for r in locales if r["values"]["code"] == "ja")
        en = next(r for r in locales if r["values"]["code"] == "en")
        tr = next(r for r in translations if r["values"]["message_ref"] == msg["uuid"] and r["values"]["locale_ref"] == en["uuid"])
        invalid_fixture("Duplicate key", lambda: cell("Messages", other["uuid"], "key", "common.save"))
        invalid_fixture("Unsafe key", lambda: cell("Messages", msg["uuid"], "key", "common.__proto__"))
        invalid_fixture("Duplicate locale", lambda: cell("Locales", en["uuid"], "code", "ja"))
        invalid_fixture("Invalid locale", lambda: cell("Locales", en["uuid"], "code", "bad_locale!"))
        invalid_fixture("Disabled required locale", lambda: cell("Locales", en["uuid"], "enabled", "false"))
        invalid_fixture("Fallback cycle", lambda: cell("Locales", en["uuid"], "fallback_locale", en["uuid"]))
        invalid_fixture("Missing fallback", lambda: cell("Locales", en["uuid"], "fallback_locale", str(uuid.uuid4())))
        invalid_fixture("Missing message", lambda: cell("Translations", tr["uuid"], "message_ref", str(uuid.uuid4())))
        invalid_fixture("Missing locale", lambda: cell("Translations", tr["uuid"], "locale_ref", str(uuid.uuid4())))
        invalid_fixture("Unreviewed translation", lambda: cell("Translations", tr["uuid"], "status", "draft"))
        invalid_fixture("Invalid Select value", lambda: cell("Translations", tr["uuid"], "status", "approved"))
        invalid_fixture("Stale source revision", lambda: cell("Translations", tr["uuid"], "reviewed_source_revision", "old"))
        invalid_fixture("Source hash mismatch", lambda: cell("Messages", msg["uuid"], "source_message", "変更した原文"))
        invalid_fixture("ICU syntax", lambda: cell("Translations", tr["uuid"], "message", "{broken"))
        invalid_fixture("ICU argument mismatch", lambda: cell("Translations", tr["uuid"], "message", "Save {count, number}"))

        def duplicate_translation():
            path = record_path("Translations", tr["uuid"])
            raw = path.read_text()
            blocks = re.split(r"(?=^\[\[records\]\]$)", raw, flags=re.M)
            block = next(b for b in blocks if f'uuid = "{tr["uuid"]}"' in b)
            path.write_text(raw + "\n" + block.replace(tr["uuid"], str(uuid.uuid4()), 1))
        invalid_fixture("Duplicate message/locale pair", duplicate_translation)

        def wrong_domain():
            origin = record_path("Translations", tr["uuid"])
            target = project / "Tables/Translations/fixture.table.toml"
            blocks = re.split(r"(?=^\[\[records\]\]$)", origin.read_text(), flags=re.M)
            block = next(b for b in blocks if f'uuid = "{tr["uuid"]}"' in b)
            origin.write_text("".join(b for b in blocks if b != block))
            target.write_text(target.read_text() + "\n" + block)
        invalid_fixture("Reject translations placed in the wrong semantic domain", wrong_domain)

        def invalid_translation_name():
            source = project / "Tables/Translations/common.table.toml"
            table("Translations").write_text(source.read_text().replace(
                'data_name = "Translations_common"', 'data_name = "Translations"', 1))
        invalid_fixture("Reject an invalid translation table name", invalid_translation_name)

        def missing_translation():
            path = record_path("Translations", tr["uuid"])
            blocks = re.split(r"(?=^\[\[records\]\]$)", path.read_text(), flags=re.M)
            path.write_text("".join(b for b in blocks if f'uuid = "{tr["uuid"]}"' not in b))
        invalid_fixture("Required English coverage", missing_translation)

        def wrong_column_type():
            path = table("Messages")
            raw = path.read_text()
            blocks = re.split(r"(?=^\[\[schema.columns\]\]$)", raw, flags=re.M)
            index = next(i for i, b in enumerate(blocks) if 'data_name = "key"' in b)
            blocks[index] = blocks[index].replace('data_type = "String"', 'data_type = "I32"', 1)
            path.write_text("".join(blocks))
        invalid_fixture("Required column type", wrong_column_type)

        def missing_column():
            path = table("Messages")
            blocks = re.split(r"(?=^\[\[schema.columns\]\]$|^\[\[records\]\]$)", path.read_text(), flags=re.M)
            path.write_text("".join(b for b in blocks if 'data_name = "key"' not in b))
        invalid_fixture("Missing required column", missing_column)

        def blank_source_with_default():
            path = table("Messages")
            blocks = re.split(r"(?=^\[\[schema.columns\]\]$)", path.read_text(), flags=re.M)
            index = next(i for i, b in enumerate(blocks) if 'data_name = "source_message"' in b)
            blocks[index] = blocks[index].replace('default_value = ""', 'default_value = "保存"', 1)
            path.write_text("".join(blocks))
            cell("Messages", msg["uuid"], "source_message", "")
        before_db = database_snapshot()
        before_generated = snapshot()
        blank_source_with_default()
        blank_stored = database_snapshot()
        run("localization", "validate")
        export()
        assert snapshot() == before_generated, "Cleared source did not resolve its column default"
        assert database_snapshot() == blank_stored, "Default projection rewrote stored inputs"
        for path, content in before_db.items():
            path.write_bytes(content)
        passes.append("Blank source resolves its column default without rewriting stored inputs")
        invalid_fixture("Missing effective required source without a default",
                        lambda: cell("Messages", msg["uuid"], "source_message", ""))

        # --check detects changed or missing output without writing files.
        (out / "keys.ts").write_text("stale")
        before = snapshot()
        run("localization", "export", "--out", str(out), "--check", good=False)
        assert snapshot() == before
        export()
        passes.append("Check detects changes without writing")

        # Source argument changes keep omitted translations and mark them for review.
        original_uuid = msg["uuid"]
        import_rows([{"key": "common.save", "ja": "{name}を保存"}])
        changed = next(r for r in records("Messages") if r["uuid"] == original_uuid)
        assert changed["values"]["source_revision"] == hashlib.sha256("{name}を保存".encode()).hexdigest()
        changed_tr = next(r for r in records("Translations") if r["uuid"] == tr["uuid"])
        assert changed_tr["values"]["status"] == "needs_review" and changed_tr["values"]["message"] == "Save"
        before = snapshot()
        export(good=False)
        assert snapshot() == before
        import_rows([{"key": "common.save", "ja": "{name}を保存", "en": "Save {name}"}])
        export()
        passes.append("Import source changes, UUID preservation, and translation re-review")

        cell("Messages", original_uuid, "source_message", "保存対象: {name}")
        export(good=False)
        run("localization", "reconcile")
        export(good=False)
        changed = next(r for r in records("Messages") if r["uuid"] == original_uuid)
        cell("Translations", tr["uuid"], "status", "reviewed")
        cell("Translations", tr["uuid"], "reviewed_source_revision", changed["values"]["source_revision"])
        export()
        run("localization", "validate")
        passes.append("Ordinary source-cell editing, reconciliation, and re-review")

        # Empty authoring input clears raw storage and resolves the column default.
        invalid_fixture("Invalid boolean cannot be hidden by a default",
                        lambda: cell("Messages", original_uuid, "deprecated", "not-a-boolean"))
        run("cell", "set", "Messages", original_uuid, "deprecated", "")
        assert "deprecated" not in next(r for r in records("Messages") if r["uuid"] == original_uuid)["values"]
        run("localization", "validate")
        export()
        # Cleared source_revision resolves to pending; reconciliation writes its content hash.
        run("cell", "set", "Messages", original_uuid, "source_revision", "")
        run("localization", "reconcile")
        changed = next(r for r in records("Messages") if r["uuid"] == original_uuid)
        cell("Translations", tr["uuid"], "status", "reviewed")
        cell("Translations", tr["uuid"], "reviewed_source_revision", changed["values"]["source_revision"])
        export()
        passes.append("Empty-input clearing, default resolution, and invalid boolean rejection")

        # Optional locales use the same source and atomic import path; omitted translations remain intact.
        locale_path = table("Locales")
        raw = locale_path.read_text()
        en_block = next(b for b in re.split(r"(?=^\[\[records\]\]$)", raw, flags=re.M)
                        if f'uuid = "{en["uuid"]}"' in b)
        fr_id = str(uuid.uuid4())
        fr_block = en_block.replace(en["uuid"], fr_id, 1).replace('code = "en"', 'code = "fr"')
        fr_block = fr_block.replace('required = "true"', 'required = "false"')
        locale_path.write_text(raw + "\n" + fr_block)
        source_text = changed["values"]["source_message"]
        english_before = next(r for r in records("Translations") if r["uuid"] == tr["uuid"])
        import_rows([{"key": "common.save", "ja": source_text, "translations": {"fr": "Enregistrer {name}"}}])
        french = next(r for r in records("Translations") if r["values"]["locale_ref"] == fr_id)
        assert french["values"]["reviewed_source_revision"] == changed["values"]["source_revision"]
        assert next(r for r in records("Translations") if r["uuid"] == tr["uuid"]) == english_before
        export()
        assert json.loads((out / "catalog.json").read_text())["messages"]["fr"]["common.save"] == "Enregistrer {name}"
        import_rows([{"key": "common.save", "ja": source_text, "translations": {"fr": "Sauvegarder {name}"}}])
        assert next(r for r in records("Translations") if r["uuid"] == french["uuid"])["values"]["message"] == "Sauvegarder {name}"
        for payload in [
            {"translations": {"xx": "Unknown {name}"}},
            {"translations": {"ja": source_text}},
            {"en": "Save {name}", "translations": {"en": "Duplicate {name}"}},
            {"translations": {"fr": "Missing argument"}},
            {"translations": {"fr": "Broken {"}},
        ]:
            before_db = database_snapshot()
            fragment = root / "bad-multilingual.json"
            fragment.write_text(json.dumps([{"key": "common.save", "ja": source_text, **payload}]))
            run("localization", "import", str(fragment), good=False)
            assert database_snapshot() == before_db
        passes.append("Optional-locale import, preserved UUIDs and omitted translations, atomic rejection of invalid locale/duplicate/ICU input")

        # A normal Messages-table edit can introduce a domain before its table exists.
        message_path = table("Messages")
        raw = message_path.read_text()
        block = next(b for b in re.split(r"(?=^\[\[records\]\]$)", raw, flags=re.M)
                     if f'uuid = "{original_uuid}"' in b)
        edited_id = str(uuid.uuid4())
        block = block.replace(original_uuid, edited_id, 1)
        block = block.replace('key = "common.save"', 'key = "uiedited.save"', 1)
        block = block.replace('namespace = "common"', 'namespace = "uiedited"', 1)
        message_path.write_text(raw + "\n" + block)
        run("localization", "reconcile")
        edited_rows = tomllib.loads((project / "Tables/Translations/uiedited.table.toml").read_text())["records"]
        assert len(edited_rows) == 1
        assert edited_rows[0]["values"]["message_ref"] == edited_id
        assert edited_rows[0]["values"]["locale_ref"] == ja["uuid"]
        export(good=False)
        import_rows([{"key": "uiedited.save", "ja": source_text, "en": "Save {name}"}])
        export()
        run("localization", "validate")
        passes.append("Ordinary message editing creates its domain during reconciliation")

        print(json.dumps({"ok": True, "fixture": "CLI-created ja/en fixture with an optional fr import", "verified": passes, "count": len(passes)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
