/* Text nodes are never replaced: selection/copy remains owned by Zotero/PDF.js. */
var ReaderCReader = (() => {
  "use strict";
  const OWNED = "data-readerc-owned";
  function owned(node) { return node?.nodeType === 1 && (node.hasAttribute(OWNED) || node.closest(`[${OWNED}]`)); }
  function indexText(layer) {
    const doc = layer.ownerDocument;
    const walker = doc.createTreeWalker(layer, 4);
    let node, text = "", previous = null;
    const segments = [];
    while ((node = walker.nextNode())) {
      if (!node.nodeValue?.trim() || node.parentElement?.closest(".endOfContent, [data-readerc-owned]")) continue;
      const rect = node.parentElement.getBoundingClientRect();
      if (previous && (node.previousSibling?.nodeName === "BR" || node.parentElement.previousSibling?.nodeName === "BR")) text += "\n";
      if (previous && previous.node.parentElement !== node.parentElement) {
        const lineBreak = Math.abs(rect.top - previous.rect.top) > Math.max(3, rect.height * 0.45);
        const space = rect.left - previous.rect.right > Math.max(1, rect.height * 0.1);
        const blockSelector = "p,h1,h2,h3,h4,h5,h6,.journal,.byline";
        const previousBlock = previous.node.parentElement.closest(blockSelector);
        const nextBlock = node.parentElement.closest(blockSelector);
        const paragraphBreak = (previousBlock && nextBlock && previousBlock !== nextBlock)
          || (lineBreak && rect.top - previous.rect.bottom > Math.max(7, previous.rect.height * 0.85));
        if (paragraphBreak) text += "\n\n";
        else if ((lineBreak || space) && !/\s$/.test(text) && !/^\s/.test(node.nodeValue)) text += lineBreak ? "\n" : " ";
      }
      segments.push({ node, start: text.length, end: text.length + node.nodeValue.length });
      text += node.nodeValue;
      previous = { node, rect };
    }
    return { text, segments };
  }
  function makeRange(doc, segments, start, end) {
    const first = segments.find(x => x.end > start && x.start <= start);
    const last = segments.find(x => x.end >= end && x.start < end);
    if (!first || !last) return null;
    const range = doc.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  }
  function node(doc, tag, text, className) {
    const result = doc.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  class DocumentController {
    constructor(doc, core, lexicon, host, service) {
      this.doc = doc;
      this.win = doc.defaultView;
      this.core = core;
      this.lexicon = lexicon;
      this.host = host;
      this.service = service;
      this.pages = new Map();
      this.cleanups = [];
      this.hover = null;
      this.translated = false;
      this.disposed = false;
      this.sequence = 0;
      this.on(doc, "pointermove", event => this.pointerMove(event), { passive: true });
      this.on(doc, "pointerdown", event => {
        // Side buttons (3 = back, 4 = forward) mark the hovered word instead of
        // closing the card. They arrive as pointerdown too, so check the button
        // before the plain dismiss below.
        if (event.button === 3 || event.button === 4) {
          this.markFromSideButton(event);
          return;
        }
        // Keep the card alive when the press lands on the card itself, so the
        // user can interact with it without it vanishing first.
        if (this.frame && event.target === this.frame) return;
        this.close();
      });
      // Side buttons navigate back/forward by default. Suppress that while a
      // gloss is showing so the press only marks the word.
      this.on(doc, "mousedown", event => {
        if ((event.button === 3 || event.button === 4) && this.hover && this.translated) {
          event.preventDefault();
          event.stopPropagation();
        }
      }, true);
      this.on(doc, "auxclick", event => {
        if (event.button === 3 || event.button === 4) { event.preventDefault(); event.stopPropagation(); }
      }, true);
      this.on(doc, "pointerleave", () => this.scheduleClose());
      // Delete acts on the visible card without requiring a click first: the
      // card is only a few pixels tall, so demanding focus made the feature
      // undiscoverable. Handled at the document level while a gloss is shown.
      // Accept both the Delete key and Backspace. Many keyboards put Backspace
      // under the typing hand while Delete sits far away, so requiring only
      // Delete made the shortcut easy to miss.
      const MARK_KEYS = new Set(["Delete", "Backspace"]);
      const onKeyDown = event => {
        if (!MARK_KEYS.has(event.key) || event.ctrlKey || event.altKey || event.metaKey) return;
        // The hovered word may have been closed by an intervening click; only
        // act while a real gloss is on screen.
        if (!this.hover || !this.translated) return;
        const origin = event.target;
        if (origin?.closest?.("input, textarea, [contenteditable], [role='textbox']")) return;
        event.preventDefault();
        event.stopPropagation();
        this.markKnown(this.hover.word);
      };
      // Listen on both the reader document and its window: focus can sit on the
      // viewer chrome rather than the document, and a missed listener made the
      // key feel broken.
      this.on(doc, "keydown", onKeyDown, true);
      if (this.win !== doc) this.on(this.win, "keydown", onKeyDown, true);
      this.on(doc, "scroll", () => { this.close(); this.schedule(); }, { capture: true, passive: true });
      this.on(this.win, "resize", () => { this.close(); this.schedule(); });
      this.observer = new this.win.MutationObserver(mutations => {
        if (mutations.some(m => !owned(m.target.nodeType === 3 ? m.target.parentElement : m.target)
          && (m.type === "characterData" || [...m.addedNodes, ...m.removedNodes].some(n => !owned(n))))) this.schedule();
      });
      this.observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
      const app = this.win.wrappedJSObject?.PDFViewerApplication || this.win.PDFViewerApplication;
      if (app?.eventBus) {
        for (const type of ["textlayerrendered", "scalechanging", "rotationchanging", "pagesinit"]) {
          const callback = () => { this.close(); this.schedule(); };
          app.eventBus.on(type, callback);
          this.cleanups.push(() => app.eventBus.off(type, callback));
        }
      }
      // A vocabulary or settings change only needs the markers redrawn. Closing
      // the card here would cancel an in-progress action: marking a word
      // updates the store, and the resulting callback used to dismiss the card
      // that the next keystroke was meant to act on.
      this.unsubscribe = host.subscribe(() => {
        const shown = this.hover;
        this.schedule();
        if (shown && !this.frame) this.hover = shown;
      });
      this.schedule();
    }
    on(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      this.cleanups.push(() => target.removeEventListener(type, handler, options));
    }
    schedule() {
      if (this.disposed) return;
      this.win.clearTimeout(this.indexTimer);
      this.indexTimer = this.win.setTimeout(() => this.reindex(), 120);
    }
    reindex() {
      if (this.disposed) return;
      for (const state of this.pages.values()) state.overlay.remove();
      this.pages.clear();
      const settings = this.host.getConfig();
      if (!settings.enabled) return;
      const visible = [];
      for (const page of this.doc.querySelectorAll(".page")) {
        const pageRect = page.getBoundingClientRect();
        if (pageRect.width === 0 || pageRect.bottom < -this.win.innerHeight || pageRect.top > this.win.innerHeight * 2) continue;
        const layer = page.querySelector(".textLayer");
        if (!layer) continue;
        const indexed = indexText(layer);
        const words = this.core.candidates(indexed.text, this.lexicon, this.host.getVocabulary(), settings);
        visible.push(...words);
        const overlay = node(this.doc, "div");
        overlay.setAttribute(OWNED, "markers");
        overlay.setAttribute("aria-hidden", "true");
        overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden;";
        const sx = (page.offsetWidth || pageRect.width) / pageRect.width;
        const sy = (page.offsetHeight || pageRect.height) / pageRect.height;
        const hits = [];
        for (const word of words) {
          const range = makeRange(this.doc, indexed.segments, word.start, word.end);
          if (!range) continue;
          const rects = [...range.getClientRects()].filter(r => r.width > 0.5 && r.height > 0.5);
          if (!rects.length) continue;
          hits.push({ word, range, rects });
          for (const rect of rects) {
            const marker = node(this.doc, "span");
            marker.style.cssText = `position:absolute;left:${(rect.left - pageRect.left) * sx - page.clientLeft}px;top:${(rect.bottom - pageRect.top) * sy - page.clientTop - 1}px;width:${rect.width * sx}px;height:0;border-bottom:1px dotted #479c91;opacity:.8;`;
            overlay.append(marker);
          }
        }
        page.append(overlay);
        this.pages.set(page, { overlay, hits, indexed });
      }
      // Warm the cache now so the first hover hits it instead of waiting on
      // a network round trip.
      this.prefetchTimer = this.win.setTimeout(() => {
        if (!this.disposed) this.service.prefetch?.(visible);
      }, 60);
    }
    pointerMove(event) {
      if (event.buttons || this.doc.getSelection()?.toString()) { this.close(); return; }
      const page = event.target.closest?.(".page");
      const state = this.pages.get(page);
      const hit = state?.hits.find(x => x.rects.some(r => event.clientX >= r.left - 1 && event.clientX <= r.right + 1 && event.clientY >= r.top - 2 && event.clientY <= r.bottom + 3));
      if (!hit) { this.scheduleClose(); return; }
      this.win.clearTimeout(this.closeTimer);
      this.closeTimer = null;
      if (this.hover === hit) return;
      this.close();
      this.hover = hit;
      this.hoverTimer = this.win.setTimeout(() => this.show(hit), this.host.getConfig().hoverDelay);
    }
    scheduleClose() {
      if (this.closeTimer) return;
      // Long enough to travel from the word up to the card, short enough that
      // the card does not linger after the pointer really leaves.
      this.closeTimer = this.win.setTimeout(() => this.close(), 600);
    }
    async show(hit, force = false) {
      if (this.disposed || (!force && this.hover !== hit)) return;
      this.close();
      this.hover = hit;
      const sequence = ++this.sequence;
      const frame = node(this.doc, "iframe");
      frame.setAttribute(OWNED, "popover");
      frame.title = "ReaderC 中文释义";
      frame.setAttribute("aria-label", "ReaderC 中文释义");
      frame.style.cssText = "position:fixed;width:330px;height:24px;border:0;border-radius:0;box-shadow:none;z-index:2147483640;background:transparent;visibility:hidden;color-scheme:light dark;";
      // Gecko navigates a new about:blank frame asynchronously. Writing before
      // its load event produces an empty popup in the real Zotero reader.
      const loaded = new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
      frame.src = "about:blank";
      this.doc.body.append(frame);
      this.frame = frame;
      await loaded;
      if (this.disposed || this.sequence !== sequence || this.frame !== frame) return;
      const cardDoc = frame.contentDocument;
      const style = node(cardDoc, "style");
      style.textContent = `*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;overflow:hidden}#card{display:inline-block;padding:4px 9px;border:0;border-radius:4px;box-shadow:none;outline:none;white-space:nowrap;background:Canvas;color:CanvasText;font:13px/20px system-ui,"Microsoft YaHei",sans-serif;cursor:pointer}.status{opacity:.6}`;
      cardDoc.head.append(style);
      const card = node(cardDoc, "div", "", "gloss");
      card.id = "card";
      card.tabIndex = 0;
      card.setAttribute("role", "tooltip");
      card.setAttribute("aria-label", `${hit.word.word} 的中文释义，按 Delete 标为熟词`);
      cardDoc.body.append(card);
      this.translated = false;
      card.addEventListener("pointerdown", () => card.focus({ preventScroll: true }));
      cardDoc.addEventListener("keydown", event => {
        if (translated && event.key === "Delete" && !event.ctrlKey && !event.altKey && !event.metaKey) {
          event.preventDefault(); event.stopImmediatePropagation(); this.markKnown(hit.word);
        } else if (event.key === "Escape") { event.preventDefault(); this.close(); }
      }, true);
      frame.addEventListener("pointerenter", () => { this.win.clearTimeout(this.closeTimer); this.closeTimer = null; });
      frame.addEventListener("pointerleave", () => this.scheduleClose());
      const position = () => {
        if (!frame.isConnected) return;
        const width = Math.min(this.win.innerWidth - 16, Math.ceil(card.getBoundingClientRect().width));
        const height = Math.ceil(card.getBoundingClientRect().height);
        frame.style.width = `${Math.max(20, width)}px`;
        frame.style.height = `${height}px`;
        const rect = hit.rects[0];
        frame.style.left = `${Math.max(8, Math.min((rect.left + rect.right - width) / 2, this.win.innerWidth - width - 8))}px`;
        const above = rect.top - height - 3;
        frame.style.top = `${above >= 8 ? above : rect.bottom + 3}px`;
        frame.style.visibility = "visible";
      };
      try {
        const result = await this.service.lookup(hit.word);
        if (this.disposed || this.sequence !== sequence || this.frame !== frame) return;
        card.textContent = result.gloss;
        this.translated = result.source === "context";
        if (!this.translated) card.classList.add("status");
        position();
      } catch {
        if (this.frame === frame) { card.textContent = "暂不可用"; card.classList.add("status"); position(); }
      }
    }
    /** Mark the hovered word when a mouse side button is pressed. */
    markFromSideButton(event) {
      if (!this.hover || !this.translated) return;
      const origin = event.target;
      if (origin?.closest?.("input, textarea, [contenteditable], [role='textbox']")) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      this.markKnown(this.hover.word);
    }
    async markKnown(word) {
      try {
        const previous = this.host.getVocabulary()[word.lemma] || null;
        await this.host.setState(word.lemma, "known");
        this.close();
        // Reflect the change immediately: the dotted underline should vanish
        // as soon as the word is marked, without waiting for a re-render.
        this.reindex();
        this.toast(`✓ 已标为熟词：${word.lemma}\n下划线已移除，今后不再标注。`, async () => {
          try { await this.host.restoreState(word.lemma, previous); this.reindex(); this.toast(`已撤销：${word.lemma}`); }
          catch { this.toast("撤销未保存，请在设置中恢复该词。"); }
        });
      } catch { this.toast("保存失败，该词仍保留原状态。"); }
    }
    toast(message, undo) {
      this.toastNode?.remove();
      this.win.clearTimeout(this.toastTimer);
      const box = node(this.doc, "div", message);
      box.setAttribute(OWNED, "toast");
      box.setAttribute("role", "status");
      box.style.cssText = "position:fixed;bottom:24px;left:24px;z-index:2147483641;padding:14px 20px;background:#203b33;color:white;border-radius:10px;font:14px/1.5 system-ui;box-shadow:0 6px 24px #0004;max-width:420px;white-space:pre-line;";
      if (undo) {
        const button = node(this.doc, "button", "撤销");
        button.style.cssText = "margin-left:15px;background:transparent;border:0;color:#a8e6c8;cursor:pointer;";
        button.addEventListener("click", () => { box.remove(); void undo(); });
        box.append(button);
      }
      this.doc.body.append(box);
      this.toastNode = box;
      this.toastTimer = this.win.setTimeout(() => box.remove(), 9000);
    }
    showSelection(text, sentence = text) {
      const normalized = this.core.normalize(text);
      if (!this.core.validKey(normalized) || normalized.split(" ").length > 4) return;
      const { entry } = this.core.entryFor(normalized, this.lexicon);
      const selected = this.doc.getSelection();
      let context = { sentence, targetStart: Math.max(0, sentence.toLowerCase().indexOf(text.toLowerCase())) };
      context.targetEnd = context.targetStart + text.length;
      if (selected?.rangeCount) {
        const range = selected.getRangeAt(0);
        const element = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
        const page = element.closest?.(".page");
        const state = this.pages.get(page);
        const first = state?.indexed.segments.find(s => s.node === range.startContainer);
        const last = state?.indexed.segments.find(s => s.node === range.endContainer);
        if (first && last) context = this.core.sentenceAt(state.indexed.text, first.start + range.startOffset, last.start + range.endOffset);
      }
      const word = { word: text, lemma: this.core.canonical(normalized, this.lexicon), entry, ...context };
      const rect = selected?.rangeCount ? selected.getRangeAt(0).getBoundingClientRect() : null;
      const anchor = rect?.width ? rect : { left: 50, top: 60, bottom: 90 };
      this.show({ word, rects: [anchor] }, true);
    }
    close() {
      this.win.clearTimeout(this.hoverTimer);
      this.win.clearTimeout(this.closeTimer);
      this.closeTimer = null;
      this.hover = null;
      this.translated = false;
      this.sequence++;
      this.frame?.remove();
      this.frame = null;
    }
    destroy() {
      if (this.disposed) return;
      this.disposed = true;
      this.close();
      this.win.clearTimeout(this.indexTimer);
      this.win.clearTimeout(this.prefetchTimer);
      this.win.clearTimeout(this.toastTimer);
      this.observer.disconnect();
      this.unsubscribe?.();
      for (const cleanup of this.cleanups) { try { cleanup(); } catch { /* Closed frame. */ } }
      for (const state of this.pages.values()) state.overlay.remove();
      this.pages.clear();
      this.toastNode?.remove();
    }
  }
  return { DocumentController, indexText, makeRange };
})();
if (typeof module !== "undefined") module.exports = ReaderCReader;
