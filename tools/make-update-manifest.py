"""Generate update.json for Zotero's built-in add-on updater.

Zotero reads this file from applications.zotero.update_url and compares the
listed version with the installed one. Keep the entry in sync with the XPI that
tools/build.py produces: this script derives version, download link and hash
straight from the built artifact, so they cannot drift apart.

Usage:
    python tools/make-update-manifest.py                # just write update.json
    python tools/make-update-manifest.py --release      # also create a GitHub release
"""
import argparse
import base64
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "addon"
DIST = ROOT / "dist"
TARGET = ROOT / "update.json"

REPO = "HopeLeeee/readerc"
ASSET_NAME = "readerc-{version}-zotero9.xpi"


def sha512_b64(path):
    """Zotero expects 'sha512:<base64>', matching Firefox's update_hash."""
    digest = hashlib.sha512(path.read_bytes()).digest()
    return "sha512:" + base64.b64encode(digest).decode("ascii")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", action="store_true",
                        help="create a GitHub release with the XPI attached")
    args = parser.parse_args()

    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    zotero = manifest["applications"]["zotero"]
    version = manifest["version"]
    asset = DIST / ASSET_NAME.format(version=version)
    if not asset.is_file():
        raise SystemExit(f"Build the XPI first: python tools/build.py ({asset.name} missing)")

    # Point at the release asset. Repository "raw" URLs are served through a
    # CDN that caches aggressively: right after a release the updater can fetch
    # the previous build and fail its hash check. Release assets have no such
    # staleness and are what Zotero's other plugins publish.
    tag = f"v{version}"
    update_link = f"https://github.com/{REPO}/releases/download/{tag}/{asset.name}"

    document = {
        "addons": {
            zotero["id"]: {
                "updates": [
                    {
                        "version": version,
                        "update_link": update_link,
                        "update_hash": sha512_b64(asset),
                        "applications": {
                            "zotero": {
                                "strict_min_version": zotero["strict_min_version"],
                                "strict_max_version": zotero["strict_max_version"],
                            }
                        },
                    }
                ]
            }
        }
    }
    TARGET.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {TARGET.relative_to(ROOT)} for {zotero['id']} {version}")
    print(f"  update_link {update_link}")
    print(f"  asset       {asset.name} ({asset.stat().st_size:,} bytes)")

    if args.release:
        # update_hash covers the exact uploaded asset, so upload before publishing.
        existing = subprocess.run(
            ["gh", "release", "view", tag, "--repo", REPO],
            capture_output=True, text=True,
        )
        if existing.returncode == 0:
            print(f"Release {tag} already exists; uploading asset only")
            subprocess.run(["gh", "release", "upload", tag, str(asset), "--clobber", "--repo", REPO], check=True)
        else:
            subprocess.run([
                "gh", "release", "create", tag, str(asset),
                "--repo", REPO,
                "--title", f"ReaderC {version}",
                "--notes", f"ReaderC {version}。安装包见下方 Assets。",
            ], check=True)
        print(f"Release {tag} ready")


if __name__ == "__main__":
    main()