"""Fetch official Zotero 9 ZIP with checked range downloads; extract locally."""
from pathlib import Path
import concurrent.futures
import urllib.request
import time
import zipfile

ROOT = Path(__file__).resolve().parent.parent / ".research"
URL = "https://download.zotero.org/client/release/9.0.6/Zotero-9.0.6_win-x64.zip"
TOTAL = 123395439
CHUNK = 4 * 1024 * 1024
parts = ROOT / "zotero9-download-parts"
parts.mkdir(exist_ok=True)

def download(i):
    start, end = i * CHUNK, min((i + 1) * CHUNK, TOTAL) - 1
    path = parts / f"{i:03d}.part"
    if path.exists() and path.stat().st_size == end - start + 1:
        return i
    for attempt in range(4):
        try:
            req = urllib.request.Request(URL, headers={"Range": f"bytes={start}-{end}", "User-Agent": "ReaderC-native-test"})
            with urllib.request.urlopen(req, timeout=30) as response:
                if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{TOTAL}":
                    raise RuntimeError("Unexpected range response")
                data = response.read()
            if len(data) != end - start + 1:
                raise RuntimeError("Incomplete range")
            path.write_bytes(data)
            return i
        except Exception as exc:
            if attempt == 3: raise
            print(f"retry part {i}: {type(exc).__name__}", flush=True)
    raise RuntimeError("Unreachable")

count = (TOTAL + CHUNK - 1) // CHUNK
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    futures = [pool.submit(download, i) for i in range(count)]
    for j, future in enumerate(concurrent.futures.as_completed(futures), 1):
        print(f"part {future.result()} complete ({j}/{count})", flush=True)
target = ROOT / "Zotero-9.0.6-native-verified.zip"
with target.open("wb") as out:
    for i in range(count): out.write((parts / f"{i:03d}.part").read_bytes())
assert target.stat().st_size == TOTAL
destination = (ROOT / "zotero9-portable").resolve()
with zipfile.ZipFile(target) as archive:
    if archive.testzip(): raise RuntimeError("ZIP CRC validation failed")
    for name in archive.namelist():
        if not (destination / name).resolve().is_relative_to(destination): raise RuntimeError("Unsafe ZIP path")
    archive.extractall(destination)
print("Verified runtime:", list(destination.rglob("zotero.exe")), flush=True)
