const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { fileURLToPath, pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../addon');

function environment(initial) {
  const registered = [{ type: 'renderToolbar', handler: () => {}, pluginID: 'other-plugin' }];
  const writes = [], logins = [], requests = [], panes = [], timers = new Set();
  let current = initial;
  let rejectRegistration = false;
  const Zotero = {
    initializationPromise: Promise.resolve(), uiReadyPromise: Promise.resolve(),
    DataDirectory: { dir: 'Z:/test-zotero-profile' },
    File: { getContentsFromURLAsync: async () => JSON.stringify({ meta: { entries: 1 }, entries: { attenuate: { translation: '减弱', rank: 21000 } }, forms: { attenuated: 'attenuate' } }) },
    Reader: {
      _readers: [],
      registerEventListener: (type, handler, pluginID) => registered.push({ type, handler, pluginID }),
      _unregisterEventListenerByPluginID: id => { for (let i = registered.length - 1; i >= 0; i--) if (registered[i].pluginID === id) registered.splice(i, 1); }
    },
    PreferencePanes: { register: async value => { if (rejectRegistration) throw new Error('preferences failed'); panes.push(value); } },
    HTTP: { request: async (method, url, options) => {
      requests.push({ method, url, options });
      const response = await fetch(url, { method, headers: options.headers, body: options.body, signal: AbortSignal.timeout(options.timeout), redirect: 'manual' });
      if (!response.ok) { const error = new Error('provider body must not leak'); error.status = response.status; throw error; }
      return { status: response.status, response: await response.json() };
    } },
    Utilities: { Internal: { openPreferences() {} } }, debug() {}, logError() {}
  };
  const context = vm.createContext({
    URL, Zotero,
    PathUtils: { join: (...parts) => parts.join('/') },
    IOUtils: {
      exists: async () => current !== undefined,
      readJSON: async () => current,
      writeJSON: async (target, value, options) => { current = JSON.parse(JSON.stringify(value)); writes.push({ target, value: current, options }); }
    },
    Services: {
      scriptloader: { loadSubScript: (url, scope) => { if (!vm.isContext(scope)) vm.createContext(scope); vm.runInContext(fs.readFileSync(fileURLToPath(url), 'utf8'), scope, { filename: url }); } },
      logins: {
        initializationPromise: Promise.resolve(), findLogins: () => logins,
        addLoginAsync: async value => logins.push(value),
        modifyLogin: (old, value) => { logins[logins.indexOf(old)] = value; },
        removeLogin: value => logins.splice(logins.indexOf(value), 1)
      }
    },
    Components: {
      interfaces: { nsILoginInfo: {} },
      classes: { '@mozilla.org/login-manager/loginInfo;1': { createInstance: () => ({ init(origin, formAction, realm, username, password) { Object.assign(this, { origin, formAction, realm, username, password }); } }) } }
    },
    setInterval: fn => { const value = { fn }; timers.add(value); return value; },
    clearInterval: value => timers.delete(value)
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'bootstrap.js'), 'utf8'), context);
  return {
    Zotero, registered, writes, logins, requests, panes, timers,
    failPreferences: () => { rejectRegistration = true; },
    start: () => context.startup({ id: 'readerc@readerc.local', version: '0.1.0', rootURI: pathToFileURL(ROOT + path.sep).href }),
    stop: () => context.shutdown()
  };
}

test('plugin lifecycle registers preferences and leaves other plugins intact on shutdown', async () => {
  const env = environment();
  await env.start();
  assert.equal(env.panes[0].id, 'readerc-settings');
  assert.equal(env.registered.length, 3);
  assert.equal(env.timers.size, 1);
  await env.Zotero.ReaderC.host.setState('attenuated', 'known');
  assert.equal(env.writes[0].value.vocabulary.attenuate.state, 'known');
  assert.match(env.writes[0].options.tmpPath, /\.tmp$/);
  await env.stop();
  assert.equal(env.Zotero.ReaderC, undefined);
  assert.equal(env.registered.length, 1);
  assert.equal(env.registered[0].pluginID, 'other-plugin');
  assert.equal(env.timers.size, 0);
});

test('context request travels over HTTP with target offsets; secret stays out of state and export', async () => {
  let received, fail = false;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    received = { url: req.url, authorization: req.headers.authorization, contentType: req.headers['content-type'], body: JSON.parse(text) };
    res.writeHead(fail ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"gloss":"减弱","explanation":"此处指炎症反应减弱。"}' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = environment();
  try {
    await env.start();
    const host = env.Zotero.ReaderC.host;
    await host.saveConfig({ ...host.getConfig(), provider: 'context', endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-test' }, 'test-private-key');
    const result = await host.testTranslation();
    assert.equal(result.source, 'context');
    assert.equal(result.gloss, '减弱');
    assert.equal(received.url, '/v1/chat/completions');
    assert.equal(received.authorization, 'Bearer test-private-key');
    const payload = JSON.parse(received.body.messages[1].content);
    assert.equal(payload.sentence.slice(payload.targetStart, payload.targetEnd), 'attenuated');
    assert.equal(env.logins[0].password, 'test-private-key');
    assert.ok(!JSON.stringify(env.writes).includes('test-private-key'));
    assert.ok(!host.exportVocabulary().includes('test-private-key'));
    // Chinese prompts must be sent as UTF-8. Without an explicit charset,
    // the platform encoding (GBK on zh-CN Windows) corrupts the prompt.
    assert.match(received.contentType, /charset=utf-8/i);
    // Body may be UTF-8 bytes (real Zotero) or a string (contexts without
    // TextEncoder); either way the Chinese prompt must survive intact.
    const sentBody = typeof env.requests[0].options.body === 'string'
      ? env.requests[0].options.body
      : Buffer.from(env.requests[0].options.body).toString('utf8');
    assert.ok(sentBody.includes('根据句子'), 'prompt must reach the wire as valid UTF-8');
    assert.equal(env.requests[0].options.logBodyLength, 0);
    assert.equal(env.requests[0].options.followRedirects, false);
    assert.equal(env.requests[0].options.errorDelayMax, 0);
    assert.equal(env.requests[0].options.anon, true);
    host.clearCache(); fail = true;
    const fallback = await host.testTranslation();
    assert.equal(fallback.source, 'status');
    assert.match(fallback.error, /HTTP 401/);
    assert.ok(!fallback.error.includes('provider body'));
    await host.saveConfig(host.getConfig(), '', true);
    assert.equal(env.logins.length, 0);
  } finally { await env.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('unsupported vocabulary versions are preserved without startup side effects', async () => {
  const env = environment({ version: 42, vocabulary: { retained: { state: 'known' } } });
  await assert.rejects(env.start(), /版本/);
  assert.equal(env.writes.length, 0);
  assert.equal(env.registered.length, 1);
  await env.stop();
});

test('registration failure cleans up partially started hooks and host API', async () => {
  const env = environment(); env.failPreferences();
  await assert.rejects(env.start(), /preferences failed/);
  assert.equal(env.registered.length, 1);
  assert.equal(env.timers.size, 0);
  assert.equal(env.Zotero.ReaderC, undefined);
});

test('preference pane script mounts settings without relying on inline XUL onload', async () => {
  const env = environment();
  await env.start();
  const pane = env.panes[0];
  assert.equal(pane.src, pathToFileURL(path.join(ROOT, 'preferences.xhtml')).href);
  assert.equal(pane.scripts.length, 1);
  assert.equal(pane.scripts[0], pathToFileURL(path.join(ROOT, 'preferences.js')).href);

  // Zotero loads pane scripts into their own sandbox and appends the XHTML
  // afterwards. An inline onload in the XHTML cannot see sandbox variables,
  // so the script itself must find and mount the settings root.
  const xhtml = fs.readFileSync(path.join(ROOT, 'preferences.xhtml'), 'utf8');
  assert.ok(!/onload/i.test(xhtml), 'preferences.xhtml must not call sandbox variables from an inline onload');

  const root = { dataset: {}, textContent: '', id: 'readerc-settings-root' };
  let mounted = 0;
  env.Zotero.ReaderC.mountSettings = () => { mounted++; };
  const document = { getElementById: id => (id === 'readerc-settings-root' ? root : null), readyState: 'complete' };
  const scope = vm.createContext({ document, Zotero: env.Zotero, setTimeout, console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'preferences.js'), 'utf8'), scope, { filename: 'preferences.js' });

  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(mounted, 1, 'settings must mount exactly once');
  assert.equal(root.dataset.mounted, 'true');
  await env.stop();
});