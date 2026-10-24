"""Prepare an isolated real Zotero 9 profile and a test-only controller addon."""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / ".research/zotero9-smoke"
PROFILE = BASE / "profile"
DATA = BASE / "data"
HARNESS = BASE / "harness"
for folder in [PROFILE / "extensions", DATA, HARNESS]:
    folder.mkdir(parents=True, exist_ok=True)
built = sorted((ROOT / "dist").glob("readerc-*-zotero9.xpi"), key=lambda p: p.stat().st_mtime)
if not built:
    raise SystemExit("Build the XPI first: python tools/build.py")
package = built[-1]
config = {"root": str(BASE), "data": str(DATA), "package": str(package), "pdf": str(BASE / "fixture.pdf")}
(HARNESS / "config.json").write_text(json.dumps(config), encoding="utf-8")
(HARNESS / "manifest.json").write_text(json.dumps({
    "manifest_version": 2, "name": "ReaderC isolated native test controller", "version": "1.0",
    "applications": {"zotero": {"id": "readerc-native-test@readerc.local", "update_url": "https://readerc.invalid/native-test-updates.json", "strict_min_version": "9.0", "strict_max_version": "9.0.*"}}
}), encoding="utf-8")
(HARNESS / "bootstrap.js").write_bytes((ROOT / "tools/zotero-smoke-bootstrap.js").read_bytes())
(PROFILE / "extensions/readerc-native-test@readerc.local").write_text(str(HARNESS), encoding="utf-8")
prefs = {
    "extensions.zotero.useDataDir": True, "extensions.zotero.dataDir": str(DATA),
    "extensions.zotero.firstRun2": False, "extensions.zotero.firstRunGuidance": False,
    "extensions.autoDisableScopes": 0, "extensions.enabledScopes": 15,
    "app.update.auto": False, "browser.shell.checkDefaultBrowser": False,
    "extensions.zoteroWinWordIntegration.skipInstallation": True,
    "extensions.zoteroOpenOfficeIntegration.skipInstallation": True,
    "intl.locale.requested": "en-US", "extensions.zotero.reportTranslationFailure": False
}
(PROFILE / "user.js").write_text("\n".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in prefs.items()) + "\n", encoding="utf-8")

# Minimal text PDF, generated locally. No real library attachments are accessed.
content = b"BT /F1 16 Tf 60 740 Td (ReaderC native installation test) Tj 0 -50 Td /F1 13 Tf (The treatment attenuated the inflammatory response.) Tj 0 -28 Td (These findings elucidate a plausible mechanism.) Tj ET"
objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream"]
pdf = bytearray(b"%PDF-1.4\n")
offsets = [0]
for i, obj in enumerate(objects, 1):
    offsets.append(len(pdf)); pdf.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
xref = len(pdf)
pdf.extend(f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode())
for offset in offsets[1:]: pdf.extend(f"{offset:010d} 00000 n \n".encode())
pdf.extend(f"trailer << /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
(BASE / "fixture.pdf").write_bytes(pdf)
print(json.dumps({"profile": str(PROFILE), "data": str(DATA), "harness": str(HARNESS)}, indent=2))