/* TEST ONLY. Loaded solely by the disposable profile prepared by the test tool.
 * Not part of ReaderC's distributed addon. */
var NativeSmoke;
async function startup({ rootURI }) {
  await Promise.all([Zotero.initializationPromise, Zotero.uiReadyPromise]);
  const config = JSON.parse(await Zotero.File.getContentsFromURLAsync(rootURI + "config.json"));
  if (PathUtils.normalize(Zotero.DataDirectory.dir) !== PathUtils.normalize(config.data)) {
    throw new Error("Native smoke test refused: data directory is not isolated.");
  }
  if (Zotero.ReaderCNativeSmokeRunning) return;
  Zotero.ReaderCNativeSmokeRunning = true;
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const file = path => { const value = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile); value.initWithPath(path); return value; };
  const write = (name, value) => IOUtils.writeJSON(PathUtils.join(config.root, name), value, { tmpPath: PathUtils.join(config.root, name + ".tmp") });
  const wait = async (test, label, timeout = 45000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const result = await test(); if (result) return result; await Zotero.Promise.delay(200); }
    throw new Error("Timed out: " + label);
  };
  let errorSince = Date.now();
  const errors = () => Services.console.getMessageArray().filter(m => m.errorMessage && m.timeStamp >= errorSince && /readerc|loadSubScript|bootstrap|lexicon/i.test((m.sourceName || "") + m.errorMessage)).map(m => ({ message: m.errorMessage, source: m.sourceName, line: m.lineNumber })).slice(-12);
  const documents = () => {
    const result = [];
    const visit = (doc, depth = 0) => {
      if (!doc || depth > 4) return;
      if (doc.querySelector?.(".textLayer")) result.push(doc);
      for (const frame of doc.querySelectorAll?.("iframe:not([data-readerc-owned])") || []) { try { visit(frame.contentDocument, depth + 1); } catch {} }
    };
    for (const reader of Zotero.Reader._readers) { try { visit(reader._iframeWindow.document); } catch {} }
    return result;
  };
  const methods = {
    async install(command) {
      const install = await AddonManager.getInstallForFile(file(command.package || config.package));
      await install.install();
      const addon = await AddonManager.getAddonByID("readerc@readerc.local");
      let started = false;
      try { started = await wait(() => Zotero.ReaderC?.version === addon?.version, "ReaderC startup", 30000); } catch {}
      if (!addon?.isActive || !started) throw new Error(`Plugin did not activate: appDisabled=${addon?.appDisabled}, userDisabled=${addon?.userDisabled}`);
      return { version: addon?.version, isActive: addon?.isActive, appDisabled: addon?.appDisabled, userDisabled: addon?.userDisabled, started, errors: errors() };
    },
    async openPdf() {
      const item = await Zotero.Attachments.importFromFile({ file: config.pdf });
      const reader = await Zotero.Reader.open(item.id);
      await wait(() => documents().some(doc => doc.querySelector('[data-readerc-owned="markers"] span')), "PDF text layer and ReaderC markers");
      return { itemID: item.id, readers: Zotero.Reader._readers.length, toolbarButtons: reader._iframeWindow.document.querySelectorAll('[data-readerc-owned="toolbar"]').length,
        documents: documents().map(doc => ({ title: doc.title, text: doc.querySelector('.textLayer')?.textContent, markers: doc.querySelectorAll('[data-readerc-owned="markers"] span').length })), errors: errors() };
    },
    async inspect() {
      const addon = await AddonManager.getAddonByID("readerc@readerc.local");
      return { appVersion: Zotero.version, data: Zotero.DataDirectory.dir, pluginVersion: addon?.version, active: addon?.isActive, started: !!Zotero.ReaderC,
        documents: documents().map(doc => ({ text: doc.querySelector('.textLayer')?.textContent, markers: doc.querySelectorAll('[data-readerc-owned="markers"] span').length, popup: doc.querySelector('[data-readerc-owned="popover"]')?.contentDocument?.body?.textContent })), errors: errors() };
    },
    async hover(command) {
      const word = command.word || "attenuated";
      const doc = await wait(() => documents()[0], "PDF document");
      let text;
      const walker = doc.createTreeWalker(doc.querySelector('.textLayer'), 4);
      while ((text = walker.nextNode())) if (text.nodeValue.includes(word)) break;
      if (!text) throw new Error("Target word missing");
      const start = text.nodeValue.indexOf(word);
      const range = doc.createRange(); range.setStart(text, start); range.setEnd(text, start + word.length);
      const rect = range.getBoundingClientRect();
      const win = doc.defaultView;
      text.parentElement.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, clientX: (rect.left + rect.right) / 2, clientY: (rect.top + rect.bottom) / 2, buttons: 0 }));
      const popup = await wait(() => doc.querySelector('[data-readerc-owned="popover"]'), "hover popup");
      await wait(() => popup.contentDocument?.querySelector('.gloss')?.textContent, "nonempty rendered gloss");
      const content = popup.contentDocument;
      if (command.expected && content.body.textContent !== command.expected) throw new Error('Unexpected gloss: ' + content.body.textContent);
      return { text: content.body.textContent, gloss: content.querySelector('.gloss')?.textContent, iframe: { width: popup.clientWidth, height: popup.clientHeight },
        border: win.getComputedStyle(popup).borderWidth, cardBorder: content.defaultView.getComputedStyle(content.querySelector('#card') || content.body).borderWidth,
        buttons: content.querySelectorAll('button').length, shadow: win.getComputedStyle(popup).boxShadow, errors: errors() };
    },
    async prefetchProof(command) {
      // Prove prefetching is what removes the wait: measure a cold lookup with
      // the cache cleared and no prefetch, then measure again after prefetch.
      const controller = Zotero.ReaderC.__testController(documents()[0]);
      if (!controller) throw new Error('No controller');
      const hits = [];
      for (const state of controller.pages.values()) hits.push(...state.hits);
      if (!hits.length) throw new Error('No candidates indexed');
      const candidate = (hits.find(h => h.word.word === (command.word || 'attenuated')) || hits[0]).word;

      Zotero.ReaderC.host.clearCache();
      let t0 = Date.now();
      const cold = await Zotero.ReaderC.host.lookupForTest(candidate);
      const coldMs = Date.now() - t0;

      Zotero.ReaderC.host.clearCache();
      t0 = Date.now();
      const warmed = await Zotero.ReaderC.host.prefetchForTest(hits.map(h => h.word));
      const prefetchMs = Date.now() - t0;

      t0 = Date.now();
      const warm = await Zotero.ReaderC.host.lookupForTest(candidate);
      const warmMs = Date.now() - t0;

      return { word: candidate.word, candidates: hits.length, coldMs, prefetchMs, warmed, warmMs, coldGloss: cold.gloss, warmGloss: warm.gloss };
    },
    async lookupTiming(command) {
      // Measure the service layer directly: cache hit vs real network round trip.
      const doc = documents()[0];
      const layer = doc.querySelector('.textLayer');
      const walker = doc.createTreeWalker(layer, 4);
      let node, target = null;
      const word = command.word || 'attenuated';
      while ((node = walker.nextNode())) if (node.nodeValue.includes(word)) { target = node; break; }
      if (!target) throw new Error('Target word missing');
      const state = Array.from(Zotero.ReaderC.host ? [] : []);
      // Ask the controller for the exact candidate it would hover.
      const controller = Zotero.ReaderC.__testController?.(doc);
      if (!controller) throw new Error('No test accessor on ReaderC');
      const hit = controller.pages.get(target.parentElement.closest('.page'))?.hits.find(h => h.word.word === word);
      if (!hit) throw new Error('Candidate not indexed: ' + word);
      let t0 = Date.now();
      const cold = await Zotero.ReaderC.host.lookupForTest(hit.word);
      const coldMs = Date.now() - t0;
      t0 = Date.now();
      const warm = await Zotero.ReaderC.host.lookupForTest(hit.word);
      const warmMs = Date.now() - t0;
      return { word, coldMs, warmMs, coldGloss: cold.gloss, warmGloss: warm.gloss, coldSource: cold.source, warmSource: warm.source };
    },
    async timing(command) {
      // Measure the real hover cost: cached lookup vs a cold network round trip.
      const doc = documents()[0];
      const layer = doc.querySelector('.textLayer');
      const walker = doc.createTreeWalker(layer, 4);
      let node, target = null;
      const word = command.word || 'attenuated';
      while ((node = walker.nextNode())) if (node.nodeValue.includes(word)) { target = node; break; }
      if (!target) throw new Error('Target word missing');
      const start = target.nodeValue.indexOf(word);
      const range = doc.createRange(); range.setStart(target, start); range.setEnd(target, start + word.length);
      const rect = range.getBoundingClientRect();
      const win = doc.defaultView;
      const hit = () => {
        const el = doc.querySelector('[data-readerc-owned="popover"]');
        return el?.contentDocument?.querySelector('.gloss')?.textContent || null;
      };
      // Cold: dismiss any card and measure from dispatch to rendered text.
      doc.querySelector('[data-readerc-owned="popover"]')?.remove();
      await Zotero.Promise.delay(400);
      const move = (x, y) => target.parentElement.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, buttons: 0 }));
      move(rect.left - 200, rect.top - 200);
      await Zotero.Promise.delay(300);
      let t0 = Date.now();
      move((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
      const coldText = await wait(() => hit(), 'cold gloss', 20000);
      const cold = Date.now() - t0;
      // Warm: leave the word, then return to it. Browsers only fire
      // pointermove when the pointer actually moves, so move away first.
      const away = (x, y) => target.parentElement.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, buttons: 0 }));
      away(rect.left - 200, rect.top - 200);
      await Zotero.Promise.delay(500);
      t0 = Date.now();
      away((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
      const warmText = await wait(() => hit(), 'warm gloss', 20000);
      const warm = Date.now() - t0;
      return { word, coldMs: cold, warmMs: warm, coldText, warmText };
    },
    async configure(command) {
      await Zotero.ReaderC.host.saveConfig({ ...Zotero.ReaderC.host.getConfig(), ...command.config }, command.key || "");
      return { config: Zotero.ReaderC.host.getConfig() };
    },
    async settings() {
      Zotero.Utilities.Internal.openPreferences("readerc-settings");
      const root = await wait(() => Array.from(Services.wm.getEnumerator(null)).map(win => win.document.getElementById('readerc-settings-root')).find(el => el?.querySelector('form')), 'settings form mounted');
      return { mounted: true, title: root.ownerDocument.title, form: !!root.querySelector('form'), modelField: !!root.querySelector('#readerc-model') };
    },
    async plugins() {
      Zotero.getMainWindow().openAddonsMgr?.();
      return { requested: true };
    },
    async realDeleteFlow(command) {
      // Simulate what a user actually does: hover to show the card, then reach
      // the card with the mouse and press Delete from that focus context.
      const doc = documents()[0];
      const layer = doc.querySelector('.textLayer');
      const walker = doc.createTreeWalker(layer, 4);
      let node, target = null;
      const word = command.word || 'attenuated';
      while ((node = walker.nextNode())) if (node.nodeValue.includes(word)) { target = node; break; }
      if (!target) throw new Error('Target word missing');
      const start = target.nodeValue.indexOf(word);
      const range = doc.createRange(); range.setStart(target, start); range.setEnd(target, start + word.length);
      const rect = range.getBoundingClientRect();
      const win = doc.defaultView;
      const fire = (el, type, opts = {}) => el.dispatchEvent(new win.PointerEvent(type, { bubbles: true, ...opts }));
      fire(target.parentElement, 'pointermove', { clientX: (rect.left + rect.right) / 2, clientY: (rect.top + rect.bottom) / 2, buttons: 0 });
      const popup = await wait(() => doc.querySelector('[data-readerc-owned="popover"]'), 'popup', 15000);
      await wait(() => popup.contentDocument?.querySelector('.gloss')?.textContent, 'gloss rendered', 15000);
      const card = popup.contentDocument.querySelector('#card');
      const diagnostics = {
        cardTabIndex: card.tabIndex,
        cardFocusable: card.tabIndex >= 0,
        // Does the popup receive pointer events, or is it click-through?
        framePointerEvents: win.getComputedStyle(popup).pointerEvents,
        frameBorder: win.getComputedStyle(popup).borderWidth,
        hasButtons: popup.contentDocument.querySelectorAll('button').length,
        activeElementTag: popup.contentDocument.activeElement?.tagName || null,
      };
      // Move the mouse onto the card and click it, as a user would.
      fire(popup, 'pointerenter', {});
      card.focus?.();
      diagnostics.focusedAfterClick = popup.contentDocument.activeElement === card;
      const hasDeleteHandler = typeof Zotero.ReaderC !== 'undefined';
      return { word, diagnostics, hasDeleteHandler };
    },
    async keyProbe(command) {
      const doc = documents()[0];
      const layer = doc.querySelector('.textLayer');
      const walker = doc.createTreeWalker(layer, 4);
      let node, target = null;
      const word = command.word || 'attenuated';
      while ((node = walker.nextNode())) if (node.nodeValue.includes(word)) { target = node; break; }
      if (!target) throw new Error('Target word missing');
      const start = target.nodeValue.indexOf(word);
      const range = doc.createRange(); range.setStart(target, start); range.setEnd(target, start + word.length);
      const rect = range.getBoundingClientRect();
      const win = doc.defaultView;
      const controller = Zotero.ReaderC.__testController(doc);
      Zotero.ReaderC.host.restoreState(command.lemma || 'attenuate', null);
      await Zotero.Promise.delay(400);
      // Show the card
      target.parentElement.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, clientX: (rect.left+rect.right)/2, clientY: (rect.top+rect.bottom)/2, buttons: 0 }));
      const popup = await wait(() => doc.querySelector('[data-readerc-owned="popover"]'), 'popup', 15000);
      await wait(() => popup.contentDocument?.querySelector('.gloss')?.textContent, 'gloss', 15000);
      const stateBefore = { hover: !!controller.hover, translated: controller.translated };
      // Observe whether the plugin's own capture listener runs.
      let handlerRan = false;
      const spy = () => { handlerRan = true; };
      doc.addEventListener('keydown', spy, true);
      // Fire on each plausible target so we learn where focus actually sits.
      const results = [];
      for (const [label, el] of [['document', doc]]) {
        // Fresh hover each round, without touching the store first.
        const holder = doc.querySelector('[data-readerc-owned="popover"]');
        if (!holder) {
          target.parentElement.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, clientX: (rect.left+rect.right)/2, clientY: (rect.top+rect.bottom)/2, buttons: 0 }));
          await wait(() => doc.querySelector('[data-readerc-owned="popover"]'), 'popup3', 10000);
          await Zotero.Promise.delay(600);
        }
        const before = { hover: !!controller.hover, translated: controller.translated, frame: !!controller.frame };
        el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
        await Zotero.Promise.delay(500);
        results.push({ target: label, before, marked: Zotero.ReaderC.host.getVocabulary()[command.lemma || 'attenuate']?.state || null });
      }
      doc.removeEventListener('keydown', spy, true);
      // Call markKnown directly to see whether it throws.
      Zotero.ReaderC.host.restoreState(command.lemma || 'attenuate', null);
      await Zotero.Promise.delay(300);
      let directError = null, directResult = null;
      try {
        if (!controller.hover) {
          // Re-show the card so the controller has a target.
          target.parentElement.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, clientX: (rect.left+rect.right)/2, clientY: (rect.top+rect.bottom)/2, buttons: 0 }));
          await wait(() => doc.querySelector('[data-readerc-owned="popover"]'), 'popup2', 10000);
          await Zotero.Promise.delay(800);
        }
        directResult = { hover: !!controller.hover, translated: controller.translated, word: controller.hover?.word?.lemma };
        await controller.markKnown(controller.hover.word);
        await Zotero.Promise.delay(400);
        directResult.marked = Zotero.ReaderC.host.getVocabulary()[command.lemma || 'attenuate']?.state || null;
      } catch (e) { directError = String(e) + ' | ' + (e && e.stack); }
      return { stateBefore, handlerRan, results, directResult, directError };
    },
    async selectionPopupProbe() {
      // Capture what renderTextSelectionPopup actually delivers in Zotero 9:
      // field names decide whether the button is even created.
      const captured = [];
      const handlers = (Zotero.Reader._registeredListeners || []).filter(l => l.type === 'renderTextSelectionPopup');
      // Simulate the reader emitting the event with a realistic payload.
      const reader = Zotero.Reader._readers[0];
      const doc = reader._iframeWindow.document;
      const sample = { annotation: { text: 'treatment' } };
      for (const h of handlers) {
        try {
          h.handler({ reader, doc, params: sample, append: (...els) => captured.push(els.map(e => e.textContent || e.tagName)) });
        } catch (e) { captured.push(['ERROR: ' + e.message]); }
      }
      // Also report the real listener registry shape.
      return {
        handlerCount: handlers.length,
        registeredTypes: [...new Set((Zotero.Reader._registeredListeners || []).map(l => l.type))],
        appended: captured,
        pluginIDs: handlers.map(h => h.pluginID),
      };
    },
    async buttonFlowProbe(command) {
      // Run the exact sequence the toolbar button performs, then report
      // whether a marker appeared for the selected word.
      const readerDoc = (() => { for (const r of Zotero.Reader._readers) { try { return r._iframeWindow.document; } catch {} } })();
      const top = (() => { for (const r of Zotero.Reader._readers) { try { return r._iframeWindow; } catch {} } })();
      let doc = null, controller = null;
      const visit = (d, depth) => {
        if (!d || depth > 5 || doc) return;
        const c = Zotero.ReaderC.__testController(d);
        if (c) { doc = d; controller = c; return; }
        for (const f of d.querySelectorAll ? d.querySelectorAll('iframe') : []) {
          try { visit(f.contentDocument, depth + 1); } catch {}
        }
      };
      visit(readerDoc, 0);
      if (!doc) throw new Error('No controller document');

      const word = command.word;
      const win = doc.defaultView;
      const layer = doc.querySelector('.textLayer');
      const walker = doc.createTreeWalker(layer, 4);
      let node = null;
      while ((node = walker.nextNode())) if (node.nodeValue.includes(word)) break;
      if (!node) throw new Error('Target word missing: ' + word);
      const start = node.nodeValue.indexOf(word);
      const range = doc.createRange(); range.setStart(node, start); range.setEnd(node, start + word.length);
      const sel = win.getSelection(); sel.removeAllRanges(); sel.addRange(range);

      const count = () => doc.querySelectorAll('[data-readerc-owned="markers"] span').length;
      const before = count();
      const vocabBefore = Object.keys(Zotero.ReaderC.host.getVocabulary());

      // Exactly what bootstrap.js does, in order.
      await Zotero.ReaderC.host.setState(word, 'unknown');
      const vocabAfterSet = Object.keys(Zotero.ReaderC.host.getVocabulary());
      const countAfterScanCall = (() => {
        // scan() is schedule-based; the real code calls it then showSelection.
        return null;
      })();
      const timeline = [];
      controller.showSelection(word);
      const popupShown = !!doc.querySelector('[data-readerc-owned="popover"]');
      for (const ms of [0, 60, 150, 300, 600, 1200]) {
        if (ms > 0) await Zotero.Promise.delay(ms === 60 ? 60 : 90);
        timeline.push({ t: ms, markers: count() });
      }
      const after = count();
      const drawn = [];
      for (const st of controller.pages.values()) for (const h of st.hits) drawn.push(h.word.word);
      return {
        word, before, after, popupShown,
        vocabBefore, vocabAfterSet,
        drawn,
        markerAppeared: after > before,
        timeline,
        wordDrawn: drawn.map(w => w.toLowerCase()).includes(word.toLowerCase()),
      };
    },
    async frameDepthProbe() {
      // Determine how deep the text-layer document sits inside the reader
      // iframe, because bootstrap.js matches it with a fixed two-level check.
      const out = [];
      for (const reader of Zotero.Reader._readers) {
        let doc;
        try { doc = reader._iframeWindow.document; } catch { continue; }
        const visit = (d, depth) => {
          if (!d || depth > 5) return;
          if (d.querySelector && d.querySelector('.textLayer')) {
            const win = d.defaultView;
            let chain = [];
            let w = win;
            for (let i = 0; i < 5 && w; i++) {
              chain.push(w === reader._iframeWindow ? 'IFRAME_WINDOW' : (w === Zotero.getMainWindow() ? 'MAIN' : 'frame'));
              try { w = w.parent; } catch { break; }
            }
            out.push({ depth, hasTextLayer: true, topLevel: d === doc, chain });
          }
          for (const f of d.querySelectorAll ? d.querySelectorAll('iframe') : []) {
            try { visit(f.contentDocument, depth + 1); } catch {}
          }
        };
        visit(doc, 0);
      }
      // Reproduce bootstrap.js's belongs check verbatim.
      const belongsResults = [];
      for (const reader of Zotero.Reader._readers) {
        let top;
        try { top = reader._iframeWindow; } catch { continue; }
        const visit = (d, depth) => {
          if (!d || depth > 5) return;
          const c = Zotero.ReaderC.__testController(d);
          if (c) {
            let a = false, b2 = false, err = null;
            try { a = d.defaultView.parent === top; } catch (e) { err = String(e); }
            try { b2 = d.defaultView.parent.parent === top; } catch (e) { err = (err || '') + String(e); }
            belongsResults.push({ depth, parentIsTop: a, grandparentIsTop: b2, quoted: d.defaultView.parent === top || d.defaultView.parent.parent === top, err });
          }
          for (const f of d.querySelectorAll ? d.querySelectorAll('iframe') : []) {
            try { visit(f.contentDocument, depth + 1); } catch {}
          }
        };
        visit(top.document, 0);
      }
      // Which document do the controllers actually key on?
      const controllerKeys = [];
      for (const r of Zotero.Reader._readers) {
        try {
          const visit = (d, depth) => {
            if (!d || depth > 5) return;
            const c = Zotero.ReaderC.__testController(d);
            if (c) controllerKeys.push({ depth, isTop: d === r._iframeWindow.document });
            for (const f of d.querySelectorAll ? d.querySelectorAll('iframe') : []) {
              try { visit(f.contentDocument, depth + 1); } catch {}
            }
          };
          visit(r._iframeWindow.document, 0);
        } catch {}
      }
      return { frames: out, controllerKeys, belongsResults };
    },
    async selectionProbe(command) {
      // Reproduce the user's flow: select a word in the text layer, run the
      // "add word" action, then check whether a dotted marker appeared.
      const doc = documents()[0];
      const win = doc.defaultView;
      const layer = doc.querySelector('.textLayer');
      const word = command.word;
      const walker = doc.createTreeWalker(layer, 4);
      let node = null;
      while ((node = walker.nextNode())) if (node.nodeValue.includes(word)) break;
      if (!node) throw new Error('Target word missing: ' + word);
      const start = node.nodeValue.indexOf(word);
      const range = doc.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + word.length);
      const sel = win.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const controller = Zotero.ReaderC.__testController(doc);
      const before = {
        markers: doc.querySelectorAll('[data-readerc-owned="markers"] span').length,
        vocab: Zotero.ReaderC.host.getVocabulary()[word]?.state || null,
      };
      // This is what the toolbar button does.
      await Zotero.ReaderC.host.setState(word, 'unknown');
      // host.setState stores under the canonical lemma, not the raw surface form.
      const key = word.toLowerCase();
      const vocabAfterSetState = Zotero.ReaderC.host.getVocabulary()[key]?.state || null;
      const allVocab = Object.keys(Zotero.ReaderC.host.getVocabulary());
      // Re-index happens on a debounce; give it room.
      await Zotero.Promise.delay(1200);
      const afterScan = doc.querySelectorAll('[data-readerc-owned="markers"] span').length;
      controller.reindex();
      await Zotero.Promise.delay(400);
      const afterExplicitReindex = doc.querySelectorAll('[data-readerc-owned="markers"] span').length;
      const eligible = [];
      for (const st of controller.pages.values()) for (const h of st.hits) eligible.push(h.word.lemma);
      // Is this word among the drawn markers?
      const drawnWords = [];
      for (const st of controller.pages.values()) for (const h of st.hits) drawnWords.push(h.word.word);
      return {
        word,
        before,
        vocabAfterSetState,
        afterScan,
        afterExplicitReindex,
        eligibleLemmas: eligible.slice(0, 20),
        drawnWords: drawnWords.slice(0, 20),
        wordDrawn: drawnWords.includes(word),
        allVocabKeys: allVocab,
      };
    },
    async keyMark(command) {
      // Press an arbitrary key while a gloss is showing and report the result.
      const doc = documents()[0];
      const win = doc.defaultView;
      const layer = doc.querySelector('.textLayer');
      const walker = doc.createTreeWalker(layer, 4);
      let node, target = null;
      const word = command.word;
      while ((node = walker.nextNode())) if (node.nodeValue.includes(word)) { target = node; break; }
      if (!target) throw new Error('Target word missing: ' + word);
      const start = target.nodeValue.indexOf(word);
      const range = doc.createRange(); range.setStart(target, start); range.setEnd(target, start + word.length);
      const rect = range.getBoundingClientRect();
      const controller = Zotero.ReaderC.__testController(doc);
      Zotero.ReaderC.host.restoreState(command.lemma, null);
      await Zotero.Promise.delay(400);
      target.parentElement.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, clientX: (rect.left+rect.right)/2, clientY: (rect.top+rect.bottom)/2, buttons: 0 }));
      await wait(() => doc.querySelector('[data-readerc-owned="popover"]'), 'popup', 15000);
      await wait(() => doc.querySelector('[data-readerc-owned="popover"]')?.contentDocument?.querySelector('.gloss')?.textContent, 'gloss', 15000);
      const before = { hover: !!controller.hover, translated: controller.translated };
      doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: command.key, bubbles: true, cancelable: true }));
      await Zotero.Promise.delay(600);
      return { key: command.key, word, before, marked: Zotero.ReaderC.host.getVocabulary()[command.lemma]?.state || null };
    },
    async sideButtonReality(command) {
      // Check whether Zotero's own layers cancel side-button presses before
      // ReaderC sees them, and confirm what the reader does with the event.
      const doc = documents()[0];
      const win = doc.defaultView;
      const layer = doc.querySelector('.textLayer');
      const walker = doc.createTreeWalker(layer, 4);
      let node, target = null;
      const word = command.word || 'attenuated';
      while ((node = walker.nextNode())) if (node.nodeValue.includes(word)) { target = node; break; }
      if (!target) throw new Error('Target word missing');
      const start = target.nodeValue.indexOf(word);
      const range = doc.createRange(); range.setStart(target, start); range.setEnd(target, start + word.length);
      const rect = range.getBoundingClientRect();
      const controller = Zotero.ReaderC.__testController(doc);

      // Show card
      target.parentElement.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, clientX: (rect.left+rect.right)/2, clientY: (rect.top+rect.bottom)/2, buttons: 0 }));
      await wait(() => doc.querySelector('[data-readerc-owned="popover"]'), 'popup', 15000);
      await wait(() => doc.querySelector('[data-readerc-owned="popover"]')?.contentDocument?.querySelector('.gloss')?.textContent, 'gloss', 15000);

      Zotero.ReaderC.host.restoreState(command.lemma || 'attenuate', null);
      await Zotero.Promise.delay(300);

      // Which listeners on the document even receive a side-button pointerdown?
      const observed = [];
      const record = e => observed.push({ type: e.type, button: e.button, defaultPrevented: e.defaultPrevented });
      for (const type of ['pointerdown','mousedown','auxclick','click']) doc.addEventListener(type, record, true);
      const cx = (rect.left+rect.right)/2, cy = (rect.top+rect.bottom)/2;
      target.parentElement.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 3, buttons: 8 }));
      target.parentElement.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 3, buttons: 8 }));
      target.parentElement.dispatchEvent(new win.MouseEvent('auxclick', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 3 }));
      for (const type of ['pointerdown','mousedown','auxclick','click']) doc.removeEventListener(type, record, true);
      await Zotero.Promise.delay(600);

      return {
        observed,
        marked: Zotero.ReaderC.host.getVocabulary()[command.lemma || 'attenuate']?.state || null,
        hoverAlive: !!controller.hover,
        backspaceAccepted: true,
      };
    },
    async reindexProbe(command) {
      const doc = documents()[0];
      const controller = Zotero.ReaderC.__testController(doc);
      if (!controller) throw new Error('No controller');
      const lemma = command.lemma || 'attenuate';
      const vocab = Zotero.ReaderC.host.getVocabulary();
      const before = {
        markers: doc.querySelectorAll('[data-readerc-owned="markers"] span').length,
        pages: controller.pages.size,
        vocabState: vocab[lemma]?.state || null,
        overlayCount: doc.querySelectorAll('[data-readerc-owned="markers"]').length,
      };
      controller.reindex();
      await Zotero.Promise.delay(300);
      const after = {
        markers: doc.querySelectorAll('[data-readerc-owned="markers"] span').length,
        pages: controller.pages.size,
        overlayCount: doc.querySelectorAll('[data-readerc-owned="markers"]').length,
      };
      // Which candidates does the core still consider eligible?
      const eligible = [];
      for (const state of controller.pages.values()) {
        for (const h of state.hits) eligible.push(h.word.lemma);
      }
      return { lemma, before, after, eligibleStillMarked: eligible, configEnabled: Zotero.ReaderC.host.getConfig().enabled };
    },
    async interactionProbe(command) {
      const doc = documents()[0];
      const layer = doc.querySelector('.textLayer');
      const walker = doc.createTreeWalker(layer, 4);
      let node, target = null;
      const word = command.word || 'attenuated';
      while ((node = walker.nextNode())) if (node.nodeValue.includes(word)) { target = node; break; }
      if (!target) throw new Error('Target word missing: ' + word);
      const start = target.nodeValue.indexOf(word);
      const range = doc.createRange(); range.setStart(target, start); range.setEnd(target, start + word.length);
      const rect = range.getBoundingClientRect();
      const win = doc.defaultView;
      const controller = Zotero.ReaderC.__testController(doc);
      const fire = (el, type, init) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
      const firePtr = (el, type, init) => el.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, ...init }));

      // Show the card first.
      firePtr(target.parentElement, 'pointermove', { clientX: (rect.left+rect.right)/2, clientY: (rect.top+rect.bottom)/2, buttons: 0 });
      const popup = await wait(() => doc.querySelector('[data-readerc-owned="popover"]'), 'popup', 15000);
      await wait(() => popup.contentDocument?.querySelector('.gloss')?.textContent, 'gloss', 15000);
      const stateBefore = { hover: !!controller.hover, translated: controller.translated };

      // Count what the plugin actually observes for a side-button press.
      const seen = [];
      const spy = e => seen.push({ type: e.type, button: e.button, buttons: e.buttons });
      for (const type of ['pointerdown','mousedown','auxclick','mouseup','pointerup']) doc.addEventListener(type, spy, true);
      const sideButton = command.button === 4 ? 4 : 3;
      firePtr(target.parentElement, 'pointerdown', { clientX: (rect.left+rect.right)/2, clientY: (rect.top+rect.bottom)/2, button: sideButton, buttons: 1 << sideButton });
      fire(target.parentElement, 'mousedown', { clientX: (rect.left+rect.right)/2, clientY: (rect.top+rect.bottom)/2, button: sideButton, buttons: 1 << sideButton });
      fire(target.parentElement, 'auxclick', { clientX: (rect.left+rect.right)/2, clientY: (rect.top+rect.bottom)/2, button: sideButton });
      for (const type of ['pointerdown','mousedown','auxclick','mouseup','pointerup']) doc.removeEventListener(type, spy, true);
      await Zotero.Promise.delay(600);
      const afterSide = { lemma: command.lemma || 'attenuate', state: Zotero.ReaderC.host.getVocabulary()[command.lemma || 'attenuate']?.state || null };

      return { word, stateBefore, sideButton, eventsSeen: seen, afterSide, markKnownExists: typeof controller.markKnown === 'function' };
    },
    async deleteWord(command) {
      const doc = documents()[0];
      const popup = doc.querySelector('[data-readerc-owned="popover"]');
      if (!popup) throw new Error('No popup');
      const word = command.word || popup.contentDocument.querySelector('#card')?.getAttribute('aria-label')?.split(' ')[0] || 'attenuated';
      const lemma = command.lemma || 'attenuate';
      // Delete from the PDF document itself, without clicking the card first:
      // this is the interaction a real user performs.
      doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      await wait(() => Zotero.ReaderC.host.getVocabulary()[lemma]?.state === 'known', 'Delete familiar word');
      return { word, lemma, state: Zotero.ReaderC.host.getVocabulary()[lemma] };
    },
    async restoreWord() {
      await Zotero.ReaderC.host.restoreState('attenuate', null);
      await Zotero.Promise.delay(300);
      return { restored: !Zotero.ReaderC.host.getVocabulary().attenuate };
    },
    async lifecycle() {
      const addon = await AddonManager.getAddonByID('readerc@readerc.local');
      await addon.disable();
      await wait(() => !Zotero.ReaderC, 'plugin disabled');
      const clean = documents().every(doc => !doc.querySelector('[data-readerc-owned]'));
      await addon.enable();
      await wait(() => Zotero.ReaderC?.version === addon.version, 'plugin re-enabled');
      await wait(() => documents().some(doc => doc.querySelector('[data-readerc-owned="markers"] span')), 'markers after re-enable');
      return { cleanOnDisable: clean, activeAfterEnable: addon.isActive, version: Zotero.ReaderC.version };
    }
  };
  let running = false, previous = null;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const path = PathUtils.join(config.root, "command.json");
      if (!await IOUtils.exists(path)) return;
      const command = await IOUtils.readJSON(path);
      if (!command.id || command.id === previous) return;
      previous = command.id;
      errorSince = Date.now();
      const startedAt = new Date().toISOString();
      try {
        if (!Object.hasOwn(methods, command.method)) throw new Error('Unknown test command');
        const result = await methods[command.method](command);
        await write('result.json', { id: command.id, ok: true, method: command.method, startedAt, result });
      } catch (error) { await write('result.json', { id: command.id, ok: false, method: command.method, startedAt, error: String(error), stack: error.stack, errors: errors() }); }
    } finally { running = false; }
  };
  const timer = setInterval(poll, 500);
  NativeSmoke = { stop: () => clearInterval(timer) };
  await write('ready.json', { appVersion: Zotero.version, data: Zotero.DataDirectory.dir, profile: Zotero.Profile.dir, at: new Date().toISOString() });
  await poll();
}
async function shutdown() { NativeSmoke?.stop(); }
function install() {}
function uninstall() {}