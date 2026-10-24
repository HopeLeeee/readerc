"""Build a deterministic Zotero XPI using only the Python standard library."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "addon"
manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
zotero = manifest.get("applications", {}).get("zotero", {})
for key in ["id", "update_url", "strict_min_version", "strict_max_version"]:
    if not zotero.get(key):
        raise SystemExit(f"Zotero install manifest requires applications.zotero.{key}")
if not zotero["update_url"].startswith("https://"):
    raise SystemExit("Zotero 9 requires an HTTPS update_url to enable the plugin")
required = ["bootstrap.js", "src/core.js", "src/reader.js", "src/settings.js", "data/lexicon.json", "THIRD_PARTY_NOTICES.md", "licenses/ECDICT.txt"]
for name in required:
    if not (SOURCE / name).is_file():
        raise SystemExit(f"Missing required file: {name}")
target = ROOT / "dist" / f"readerc-{manifest['version']}-zotero9.xpi"
target.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(SOURCE.rglob("*")):
        if not path.is_file():
            continue
        info = zipfile.ZipInfo(path.relative_to(SOURCE).as_posix(), date_time=(2026, 10, 23, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, path.read_bytes(), compresslevel=9)
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
print(f"Built {target} ({target.stat().st_size:,} bytes)")
print("SHA256 " + hashlib.sha256(target.read_bytes()).hexdigest())
