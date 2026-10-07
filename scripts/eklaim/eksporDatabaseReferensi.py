#!/usr/bin/env python3
"""Export tabel referensi patch dari container MariaDB sementara ke SQLite.

Container harus hanya berisi salinan installer, bukan database E-Klaim RS.
Tidak menjalankan installer atau menulis ke MariaDB.
"""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
from zoneinfo import ZoneInfo


def query(container, sql):
    return subprocess.check_output(
        ["docker", "exec", container, "mariadb", "-uroot", "--batch", "-e", sql],
        text=True, encoding="utf-8",
    )


def decode(value):
    if value == "NULL":
        return None
    escapes = {"0": "\0", "n": "\n", "r": "\r", "t": "\t", "b": "\b", "\\": "\\"}
    result = []
    i = 0
    while i < len(value):
        if value[i] == "\\" and i + 1 < len(value):
            i += 1
            result.append(escapes.get(value[i], "\\" + value[i]))
        else:
            result.append(value[i])
        i += 1
    return "".join(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("container")
    parser.add_argument("installer", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--tambahan", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    db_path = args.output / "referensi.sqlite"
    if db_path.exists():
        raise SystemExit("Output sudah ada; pilih folder baru agar tidak menimpa arsip.")
    manifest = {
        "installer": args.installer.name,
        "sha256": hashlib.sha256(args.installer.read_bytes()).hexdigest(),
        "tanggal_ekstraksi": datetime.now(ZoneInfo("Asia/Jakarta")).date().isoformat(),
        "format": "SQLite; nilai kolom dipertahankan sebagai teks atau NULL",
        "tabel": {},
    }
    selected = {
        "inacbg5.c51cclm", "inacbg5.c51dc", "inacbg5.cclist",
        "inacbg5.special_cmg_tariff_20230124",
        "inacbg5.ina_grouper4_specialgroups_20230124",
        "casemix.alt_hierarchy2", "casemix.alt_hierarchy3", "casemix.alt_unucbg",
    }
    tambahan = {"sumber": manifest, "profil_tarif_tambahan": {"regional": "reg1", "kode_tarif": "DS"}, "tabel": {}}
    with sqlite3.connect(db_path) as db:
        for schema in ("inacbg5", "casemix"):
            tables = query(args.container, f"SHOW TABLES FROM `{schema}`").splitlines()[1:]
            for table in tables:
                # Table names come from SHOW TABLES, never arbitrary SQL input.
                safe_table = table.replace("`", "``")
                qualified = f"{schema}.{table}"
                text = query(args.container, f"SELECT * FROM `{schema}`.`{safe_table}`")
                lines = text.splitlines()
                columns = lines[0].split("\t")
                rows = [tuple(decode(v) for v in line.split("\t")) for line in lines[1:]]
                if any(len(row) != len(columns) for row in rows):
                    raise ValueError(f"Jumlah kolom tidak sesuai: {qualified}")
                expected = int(query(args.container, f"SELECT COUNT(*) FROM `{schema}`.`{safe_table}`").splitlines()[1])
                if expected != len(rows):
                    raise ValueError(f"Jumlah baris tidak sesuai: {qualified}")
                quote = lambda name: '"' + name.replace('"', '""') + '"'
                definition = ",".join(quote(c) + " TEXT" for c in columns)
                db.execute(f"CREATE TABLE {quote(qualified)} ({definition})")
                db.executemany(f"INSERT INTO {quote(qualified)} VALUES ({','.join('?' for _ in columns)})", rows)
                manifest["tabel"][qualified] = {"jumlah_baris": len(rows), "kolom": columns}
                if qualified in selected:
                    objects = [dict(zip(columns, row)) for row in rows]
                    if qualified == "inacbg5.special_cmg_tariff_20230124":
                        objects = [r for r in objects if r["REGIONAL"] == "reg1" and r["KODE_TARIFF"] == "DS"]
                    tambahan["tabel"][qualified] = objects
                print(f"{qualified}: {len(rows)}", flush=True)
        check = db.execute("PRAGMA integrity_check").fetchone()[0]
        if check != "ok":
            raise ValueError(check)
    tambahan["batasan"] = (
        "c51dc pada patch ini hanya berisi 6 kelompok COVID-19. c51cclm berisi "
        "106 baris matriks, tetapi pemetaan kolom untuk kelompok lain tidak tersedia. "
        "Tabel tambahan adalah referensi; belum mengubah algoritme severity atau "
        "mengaktifkan top-up otomatis. Bukan pengganti mesin grouper E-Klaim."
    )
    args.tambahan.parent.mkdir(parents=True, exist_ok=True)
    args.tambahan.write_text(json.dumps(tambahan, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (args.output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"SQLite integrity_check={check}; {len(manifest['tabel'])} tabel")


if __name__ == "__main__":
    main()
