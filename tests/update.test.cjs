const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

test('update generator emits the hexadecimal SHA-512 required by Zotero', () => {
  const root = path.resolve(__dirname, '..');
  const result = execFileSync('python', ['-c',
    "import importlib.util; from pathlib import Path; s=importlib.util.spec_from_file_location('updater','tools/make-update-manifest.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.sha512_hash(Path('addon/manifest.json')))"
  ], { cwd: root, encoding: 'utf8' }).trim();
  assert.match(result, /^sha512:[0-9a-f]{128}$/);
  assert.equal(result, 'sha512:' + createHash('sha512').update(fs.readFileSync(path.join(root, 'addon/manifest.json'))).digest('hex'));
});
