"""Consistent local backup and read-only pre-existing-row comparison.

Prints counts and hashes, never learning payloads. A new destination is required.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3


def connect_readonly(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


def fingerprint(row):
    normalized = [value.hex() if isinstance(value, bytes) else value for value in row]
    return hashlib.sha256(json.dumps(normalized, ensure_ascii=False).encode()).hexdigest()


def audit(before, current):
    result = []
    with connect_readonly(before) as old, connect_readonly(current) as new:
        for (table,) in old.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
            quoted = '"' + table.replace('"', '""') + '"'
            columns = [row[1] for row in old.execute(f"PRAGMA table_info({quoted})")]
            selected = ','.join('"' + name.replace('"', '""') + '"' for name in columns)
            old_rows = {fingerprint(row) for row in old.execute(f"SELECT {selected} FROM {quoted}")}
            new_rows = {fingerprint(row) for row in new.execute(f"SELECT {selected} FROM {quoted}")}
            result.append({"table": table, "before": len(old_rows), "after": len(new_rows),
                           "missing_or_changed": len(old_rows - new_rows)})
        return {"integrity": new.execute("PRAGMA integrity_check").fetchone()[0], "tables": result,
                "preexisting_rows_unchanged": all(row["missing_or_changed"] == 0 for row in result)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("backup", "compare"))
    parser.add_argument("database")
    parser.add_argument("backup")
    args = parser.parse_args()
    destination = Path(args.backup)
    if args.command == "backup":
        if destination.exists():
            raise SystemExit("Backup already exists; refusing overwrite")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with connect_readonly(args.database) as source, sqlite3.connect(destination) as target:
            source.backup(target)
            integrity = target.execute("PRAGMA integrity_check").fetchone()[0]
        print(json.dumps({"backup": str(destination.resolve()), "integrity": integrity}))
    else:
        print(json.dumps(audit(args.backup, args.database), ensure_ascii=False))


if __name__ == "__main__":
    main()
