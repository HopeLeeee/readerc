(async () => {
  const status = document.getElementById('demo-status');
  try {
    const response = await fetch('/addon/data/lexicon.json');
    if (!response.ok) throw new Error('离线词典加载失败');
    const lexicon = await response.json();
    let initial = {};
    try { initial = JSON.parse(localStorage.getItem('readerc-demo-state') || '{}'); } catch { /* Fresh demo. */ }
    const store = new ReaderCStore.Store(ReaderCCore, async state => localStorage.setItem('readerc-demo-state', JSON.stringify(state)), initial);
    const host = {
      getConfig: () => ({ ...store.getConfig(), endpoint: location.origin + '/demo/model', model: 'demo-fixture' }), getVocabulary: () => store.getVocabulary(),
      subscribe: fn => store.subscribe(fn),
      setState: (word, value) => store.setState(ReaderCCore.canonical(word, lexicon), value),
      restoreState: (word, value) => store.restoreState(ReaderCCore.canonical(word, lexicon), value),
      batchState: (words, value) => store.batchState(words.map(word => ReaderCCore.canonical(word, lexicon)), value),
      saveConfig: async value => {
        await store.setConfig({ ...value, endpoint: location.origin + '/demo/model', model: 'demo-fixture' });
      },
      request: async (endpoint, body) => {
        const result = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!result.ok) throw new Error('演示服务不可用');
        return result.json();
      },
      lexiconInfo: lexicon.meta,
      exportVocabulary: () => store.exportVocabulary(), importVocabulary: value => store.importVocabulary(value)
    };
    const service = new ReaderCService.GlossService(ReaderCCore, host);
    host.testTranslation = () => service.lookup({ word: 'attenuated', lemma: 'attenuate', entry: lexicon.entries.attenuate });
    const controller = new ReaderCReader.DocumentController(document, ReaderCCore, lexicon, host, service);
    window.readercDemo = { store, host, controller, service, lexicon };
    const refresh = () => {
      const count = Object.values(store.getVocabulary()).filter(x => x.state === 'known').length;
      document.getElementById('toggle').textContent = store.getConfig().enabled ? '词释 ON' : '词释 OFF';
      status.textContent = `${lexicon.meta.entries.toLocaleString()} 个词频条目 · 已记住 ${count} 个熟词`;
    };
    store.subscribe(refresh); refresh();
    document.getElementById('toggle').addEventListener('click', () => store.setConfig({ ...store.getConfig(), enabled: !store.getConfig().enabled }));
    let mounted = false;
    const dialog = document.getElementById('settings-dialog');
    document.getElementById('settings').addEventListener('click', () => {
      controller.close();
      if (!mounted) { ReaderCSettings.mount(document.getElementById('readerc-settings-root'), host); mounted = true; }
      dialog.showModal();
    });
    document.getElementById('close-settings').addEventListener('click', () => dialog.close());
  } catch (error) { status.textContent = error.message; console.error(error); }
})();
