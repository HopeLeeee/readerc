/* Zotero 9 bootstrapped extension entry point. */
var ReaderC;
var ReaderCStarting = false;
var ReaderCGeneration = 0;

async function startup({ id, version, rootURI }) {
  ReaderCStarting = true;
  const generation = ++ReaderCGeneration;
  await Promise.all([Zotero.initializationPromise, Zotero.uiReadyPromise]);
  if (!ReaderCStarting || generation !== ReaderCGeneration) return;
  const scope = { URL };
  for (const file of ["core", "store", "service", "reader", "settings"]) {
    Services.scriptloader.loadSubScript(rootURI + `src/${file}.js`, scope);
  }
  const core = scope.ReaderCCore;
  const path = PathUtils.join(Zotero.DataDirectory.dir, "readerc-state.json");
  let initial = {};
  if (await IOUtils.exists(path)) {
    // Never overwrite an unreadable or unsupported state file.
    initial = await IOUtils.readJSON(path);
    if (initial.version !== 1) throw new Error("ReaderC：词表版本不支持，原文件已保留。");
  }
  const store = new scope.ReaderCStore.Store(core, value => IOUtils.writeJSON(path, value, { tmpPath: path + ".tmp" }), initial);
  const lexicon = JSON.parse(await Zotero.File.getContentsFromURLAsync(rootURI + "data/lexicon.json"));
  if (!ReaderCStarting || generation !== ReaderCGeneration) return;
  const controllers = new Map();
  const buttons = new Set();
  const readers = new Set();
  const listeners = [];
  const cancellers = new Set();
  let stopped = false;
  let interval = null;
  const loginOrigin = "chrome://readerc";
  const loginRealm = "ReaderC contextual translation";
  let translationStatus = { state: "unconfigured", message: "请先配置模型接口。" };

  async function findLogins() {
    await Services.logins.initializationPromise;
    return Services.logins.findLogins(loginOrigin, null, loginRealm);
  }
  async function credential(endpoint) {
    return (await findLogins()).find(login => login.username === endpoint)?.password || "";
  }
  async function saveCredential(endpoint, secret, clear) {
    const existing = (await findLogins()).filter(login => login.username === endpoint);
    if (!secret && !clear) return;
    if (clear) {
      for (const login of existing) Services.logins.removeLogin(login);
      return;
    }
    const login = Components.classes["@mozilla.org/login-manager/loginInfo;1"].createInstance(Components.interfaces.nsILoginInfo);
    login.init(loginOrigin, null, loginRealm, endpoint, secret, "", "");
    if (existing.length) Services.logins.modifyLogin(existing[0], login);
    else await Services.logins.addLoginAsync(login);
  }
  const host = {
    getConfig: () => store.getConfig(),
    getVocabulary: () => store.getVocabulary(),
    subscribe: fn => store.subscribe(fn),
    reportStatus: value => { translationStatus = value; },
    getStatus: () => ({ ...translationStatus }),
    setState: (word, state) => store.setState(core.canonical(word, lexicon), state),
    restoreState: (word, previous) => store.restoreState(core.canonical(word, lexicon), previous),
    async saveConfig(value, secret = "", clearKey = false) {
      const settings = core.config(value);
      if (settings.endpoint || settings.model || secret) {
        settings.endpoint = core.endpointURL(settings.endpoint);
        if (!settings.model) throw new Error("请填写翻译模型名称。");
      }
      if (settings.endpoint) await saveCredential(settings.endpoint, secret, clearKey);
      await store.setConfig(settings);
      for (const cancel of cancellers) { try { cancel(); } catch { /* Already finished. */ } }
      service.clear();
    },
    exportVocabulary: () => store.exportVocabulary(),
    importVocabulary: value => store.importVocabulary(value),
    batchState: (words, state) => store.batchState(words.map(word => core.canonical(word, lexicon)), state),
    testTranslation: () => service.lookup({
      word: "attenuated", lemma: "attenuate", entry: lexicon.entries.attenuate,
      sentence: "The treatment attenuated the inflammatory response.", targetStart: 14, targetEnd: 24
    }),
    clearCache: () => service.clear(),
    lookupForTest: candidate => service.lookup(candidate),
    prefetchForTest: candidates => service.prefetch(candidates),
    lexiconInfo: lexicon.meta,
    async request(endpoint, body, timeout) {
      if (stopped) throw new Error("插件已关闭。");
      const key = await credential(endpoint);
      if (stopped) throw new Error("插件已关闭。");
      // The body carries Chinese text. Without an explicit charset, Zotero's
      // HTTP stack falls back to the platform encoding (GBK on zh-CN Windows),
      // which turns the prompt into mojibake and makes the model answer
      // unpredictably. Declare UTF-8 and send pre-encoded bytes.
      const headers = { "Content-Type": "application/json; charset=utf-8" };
      if (key) headers.Authorization = `Bearer ${key}`;
      const payload = JSON.stringify(body);
      // Prefer real UTF-8 bytes. Fall back to the string when TextEncoder is
      // unavailable (some embedding contexts); the charset header still pins
      // the interpretation in that case.
      let encoded = payload;
      try { encoded = new TextEncoder().encode(payload); } catch { /* Keep the string. */ }
      let cancel;
      try {
        const result = await Zotero.HTTP.request("POST", endpoint, {
          body: encoded, headers, timeout, responseType: "json",
          logBodyLength: 0, debug: false, followRedirects: false, anon: true,
          successCodes: false, errorDelayMax: 0,
          cancellerReceiver: value => { cancel = value; cancellers.add(value); }
        });
        if (result.status && (result.status < 200 || result.status >= 300)) {
          const error = new Error("HTTP error"); error.status = result.status; throw error;
        }
        return result.response;
      } catch (error) {
        const status = error?.status || error?.xmlhttp?.status;
        throw new Error(status ? `翻译接口返回 HTTP ${status}。` : "翻译连接失败或超时，请检查接口配置。");
      } finally { if (cancel) cancellers.delete(cancel); }
    }
  };
  const service = new scope.ReaderCService.GlossService(core, host);

  function scanDocument(doc, depth = 0, found = new Set()) {
    if (!doc || depth > 4 || !doc.defaultView || !doc.body) return found;
    if (doc.querySelector("#viewerContainer #viewer, .pdfViewer")) {
      found.add(doc);
      if (!controllers.has(doc)) {
        try { controllers.set(doc, new scope.ReaderCReader.DocumentController(doc, core, lexicon, host, service)); }
        catch (error) { Zotero.logError(error); }
      }
    }
    for (const frame of doc.querySelectorAll("iframe:not([data-readerc-owned])")) {
      try { scanDocument(frame.contentDocument, depth + 1, found); } catch { /* Inaccessible frame. */ }
    }
    return found;
  }
  function scan() {
    if (stopped) return;
    const found = new Set();
    for (const reader of Zotero.Reader._readers || []) readers.add(reader);
    for (const reader of readers) {
      try {
        if (reader.type !== "pdf" || reader._iframeWindow?.closed || !reader._iframeWindow?.document) { readers.delete(reader); continue; }
        scanDocument(reader._iframeWindow.document, 0, found);
      } catch { readers.delete(reader); }
    }
    for (const [doc, controller] of controllers) {
      if (!found.has(doc)) { controller.destroy(); controllers.delete(doc); }
    }
    for (const button of buttons) if (!button.isConnected) buttons.delete(button);
  }
  function addListener(type, handler) {
    const guarded = event => { if (!stopped) handler(event); };
    Zotero.Reader.registerEventListener(type, guarded, id);
    listeners.push([type, guarded]);
  }
  function makeButton(doc, label, command) {
    const button = doc.createElement("button");
    button.textContent = label;
    button.setAttribute("data-readerc-owned", "toolbar");
    button.style.cssText = "font:12px system-ui;padding:3px 8px;margin-inline:4px;border:1px solid #7d9c9266;border-radius:5px;background:transparent;color:inherit;cursor:pointer;";
    button.addEventListener("click", command);
    return button;
  }
  addListener("renderToolbar", ({ reader, doc, append }) => {
    if (reader.type !== "pdf") return;
    readers.add(reader);
    const button = makeButton(doc, host.getConfig().enabled ? "词释 ON" : "词释 OFF", async () => {
      try { await store.setConfig({ ...host.getConfig(), enabled: !host.getConfig().enabled }); }
      catch (error) { Zotero.logError(error); }
    });
    button.title = "开关生词下划线和悬浮释义";
    buttons.add(button);
    const settings = makeButton(doc, "词释设置", () => Zotero.Utilities.Internal.openPreferences("readerc-settings"));
    buttons.add(settings);
    append(button, settings);
    scan();
  });
  addListener("renderTextSelectionPopup", ({ reader, doc, params, append }) => {
    if (reader.type !== "pdf") return;
    const text = params.annotation?.text?.trim();
    if (!text || !core.validKey(core.normalize(text)) || text.split(/\s+/).length > 4) return;
    readers.add(reader);
    append(makeButton(doc, "词释 / 标生词", async () => {
      try {
        await host.setState(text, "unknown");
        scan();
        for (const [frameDoc, controller] of controllers) {
          let belongs = false;
          try { belongs = frameDoc.defaultView.parent === reader._iframeWindow || frameDoc.defaultView.parent.parent === reader._iframeWindow; } catch { /* Closed. */ }
          if (!belongs) continue;
          // The controller uses the exact selection offsets, not the first
          // occurrence of this spelling on an arbitrary visible page.
          controller.showSelection(text);
          break;
        }
      } catch (error) { Zotero.logError(error); }
    }));
  });
  const unsubscribe = store.subscribe(() => {
    for (const button of buttons) if (button.title === "开关生词下划线和悬浮释义") button.textContent = host.getConfig().enabled ? "词释 ON" : "词释 OFF";
  });
  const instance = {
    version, host,
    // Read-only accessors used by the isolated native harness
    // (tools/zotero-smoke-bootstrap.js) to measure the service layer directly.
    // They expose nothing that callers could not already reach via the DOM.
    __testController: doc => controllers.get(doc),
    mountSettings: root => scope.ReaderCSettings.mount(root, host),
    shutdown: async () => {
      stopped = true;
      clearInterval(interval);
      for (const cancel of cancellers) { try { cancel(); } catch { /* Already finished. */ } }
      cancellers.clear();
      unsubscribe();
      // Zotero 9.0.6's public unregisterEventListener filters shared event types
      // too broadly. Use the same per-plugin cleanup as Zotero's own lifecycle.
      // If unavailable, stopped guards remain inert until lifecycle auto-cleanup.
      Zotero.Reader._unregisterEventListenerByPluginID?.(id);
      for (const controller of controllers.values()) controller.destroy();
      controllers.clear();
      readers.clear();
      for (const button of buttons) button.remove();
      buttons.clear();
      service.clear();
      await store.queue;
    }
  };
  ReaderC = instance;
  Zotero.ReaderC = instance;
  try {
    await Zotero.PreferencePanes.register({
      pluginID: id, id: "readerc-settings", label: "ReaderC 英文词释",
      src: rootURI + "preferences.xhtml", scripts: [rootURI + "preferences.js"]
    });
  } catch (error) {
    await instance.shutdown();
    if (Zotero.ReaderC === instance) delete Zotero.ReaderC;
    if (ReaderC === instance) ReaderC = undefined;
    throw error;
  }
  if (!ReaderCStarting || generation !== ReaderCGeneration) { await instance.shutdown(); return; }
  interval = setInterval(scan, 1800);
  scan();
  Zotero.debug(`ReaderC ${version}: ${lexicon.meta.entries} dictionary entries loaded.`);
}

function install() {}
async function shutdown() {
  ReaderCStarting = false;
  ReaderCGeneration++;
  if (ReaderC) await ReaderC.shutdown();
  if (Zotero.ReaderC === ReaderC) delete Zotero.ReaderC;
  ReaderC = undefined;
}
function uninstall() { /* Keep the user's learned vocabulary and credentials. */ }