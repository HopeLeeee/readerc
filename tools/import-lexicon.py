"""Build a compact, attributed ECDICT subset from a pinned upstream CSV.

Usage: python tools/import-lexicon.py [path/to/ecdict.csv]
No network request is made by this script. See docs/DEVELOPMENT.md for provenance.
"""
from __future__ import annotations
import csv
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
PIN = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
source = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".research/ecdict.csv"
source_bytes = source.read_bytes()
source_blob = hashlib.sha1(f"blob {len(source_bytes)}\0".encode() + source_bytes).hexdigest()
if source_blob != "c4ade63ea08cf39d9c3475e96929036d64d94c94":
    raise SystemExit("Source CSV does not match the pinned upstream Git blob; download is incomplete or changed.")
entries: dict = {}
forms: dict = {}
word_pattern = re.compile(r"[a-z]+(?:[-'][a-z]+)*\Z")

with source.open(encoding="utf-8-sig", newline="") as handle:
    for row in csv.DictReader(handle):
        word = row["word"].strip()
        translation = row["translation"].strip().replace("\\n", "\n")
        if not word_pattern.fullmatch(word) or len(word) > 40 or not re.search(r"[\u3400-\u9fff]", translation):
            continue
        # BNC and FRQ are separate rank lists, not vocabulary levels. Prefer FRQ.
        rank = int(row.get("frq") or 0) or int(row.get("bnc") or 0)
        # The model is the only source of visible glosses. Ship vocabulary ranks,
        # not dictionary definitions or pronunciations.
        entries[word] = {"rank": rank}
        exchange = dict(part.split(":", 1) for part in (row.get("exchange") or "").split("/") if ":" in part)
        lemma = exchange.get("0")
        if lemma and word_pattern.fullmatch(lemma) and lemma != word:
            forms.setdefault(word, lemma)
        for key in ["p", "d", "i", "3", "s", "r", "t"]:
            for inflection in exchange.get(key, "").split(","):
                if inflection and word_pattern.fullmatch(inflection) and inflection != word:
                    forms.setdefault(inflection, word)

# Avoid dangling forms and recursively resolve inflection-to-inflection chains.
resolved = {}
for word, lemma in forms.items():
    seen = {word}
    while lemma in forms and lemma not in seen:
        seen.add(lemma)
        lemma = forms[lemma]
    if lemma in entries and lemma not in seen:
        resolved[word] = lemma

data = {
    "meta": {
        "source": "ECDICT", "url": "https://github.com/skywind3000/ECDICT",
        "license": "MIT", "commit": PIN,
        "sourceSHA256": hashlib.sha256(source_bytes).hexdigest(),
        "entries": len(entries), "forms": len(resolved),
        "rank": "FRQ rank, falling back to BNC rank; 0 means unranked",
        "selection": "Lowercase English vocabulary ranks and inflections, max 40 characters; no definitions bundled"
    },
    "entries": dict(sorted(entries.items())),
    "forms": dict(sorted(resolved.items()))
}
target = ROOT / "addon/data/lexicon.json"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(json.dumps(data["meta"], ensure_ascii=False, indent=2))
print(f"Wrote {target} ({target.stat().st_size:,} bytes)")
