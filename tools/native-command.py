"""Send a bounded command to the disposable Zotero native-test profile."""
from pathlib import Path
import argparse
import json
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / ".research/zotero9-smoke"
parser = argparse.ArgumentParser()
parser.add_argument("method")
parser.add_argument("--package")
parser.add_argument("--config")
parser.add_argument("--config-file")
parser.add_argument("--word")
parser.add_argument("--lemma")
parser.add_argument("--button", type=int)
parser.add_argument("--expected")
parser.add_argument("--key")
parser.add_argument("--timeout", type=int, default=60)
args = parser.parse_args()
command = {"id": str(uuid.uuid4()), "method": args.method}
if args.package: command["package"] = str(Path(args.package).resolve())
if args.config: command["config"] = json.loads(args.config)
if args.config_file: command["config"] = json.loads(Path(args.config_file).read_text(encoding="utf-8"))
if args.word: command["word"] = args.word
if args.lemma: command["lemma"] = args.lemma
if args.button is not None: command["button"] = args.button
if args.expected: command["expected"] = args.expected
if args.key: command["key"] = args.key
temp = BASE / "command.tmp.json"
temp.write_text(json.dumps(command), encoding="utf-8")
temp.replace(BASE / "command.json")
print(f"Native Zotero command: {args.method}", flush=True)
deadline = time.monotonic() + min(args.timeout, 60)
while time.monotonic() < deadline:
    try:
        result = json.loads((BASE / "result.json").read_text(encoding="utf-8"))
        if result.get("id") == command["id"]:
            output = ROOT / "test-results/native"
            output.mkdir(parents=True, exist_ok=True)
            (output / f"{args.method}-{int(time.time())}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)
            raise SystemExit(0 if result.get("ok") else 1)
    except (FileNotFoundError, json.JSONDecodeError): pass
    time.sleep(0.5)
raise SystemExit("No matching native result within 60 seconds; inspect .research/zotero9-smoke.")