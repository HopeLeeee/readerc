const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../addon');

// Minimal DOM stand-ins: enough to drive DocumentController's key handling
// without a browser. The geometry-dependent code is covered by the native
// Zotero harness instead.
function element(tag = 'div') {
  const listeners = new Map();
  const el = {
    tagName: tag.toUpperCase(), nodeType: 1, dataset: {}, style: { cssText: '' },
    children: [], attributes: {}, isConnected: true, textContent: '',
    classList: { add() {}, remove() {} },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    hasAttribute(k) { return k in this.attributes; },
    removeAttribute(k) { delete this.attributes[k]; },
    append(...nodes) { this.children.push(...nodes); },
    prepend(...nodes) { this.children.unshift(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    remove() { this.isConnected = false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener(type, fn) { const l = listeners.get(type) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
    dispatch(type, event = {}) { for (const fn of (listeners.get(type) || []).slice()) fn({ type, preventDefault() {}, stopPropagation() {}, ...event }); },
    getBoundingClientRect() { return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }; },
  };
  return el;
}

function makeController() {
  const doc = element('document');
  doc.body = element('body');
  doc.ownerDocument = doc;
  const winListeners = new Map();
  doc.defaultView = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener(type, fn) { if (!winListeners.has(type)) winListeners.set(type, []); winListeners.get(type).push(fn); },
    removeEventListener() {},
    clearTimeout() {},
    document: doc,
    setTimeout: () => 1, clearTimeout() {},
    MutationObserver: class { observe() {} disconnect() {} },
    PointerEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } },
    KeyboardEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } },
    HTMLElement: class {},
    wrappedJSObject: null,
  };
  doc.createElement = tag => element(tag);
  const known = [];
  let notify = () => {};
  const host = {
    getConfig: () => ({ enabled: true, hoverDelay: 0, maxPerPage: 100, firstOnly: true }),
    getVocabulary: () => ({}),
    subscribe: fn => { notify = fn; return () => {}; },
    setState: async (word, state) => { known.push([word, state]); },
    restoreState: async () => {},
  };
  const core = { config: v => v, candidates: () => [], canonical: w => w };
  const service = { lookup: async () => ({ gloss: '减弱', source: 'context' }) };
  const scope = vm.createContext({ module: { exports: {} }, console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reader.js'), 'utf8'), scope);
  const controller = new scope.module.exports.DocumentController(doc, core, {}, host, service);
  return { controller, doc, known, fire: () => notify() };
}

test('Delete marks the hovered word known without clicking the card first', async () => {
  const { controller, doc, known } = makeController();
  // Simulate a rendered, translated card.
  controller.hover = { word: { word: 'attenuated', lemma: 'attenuate' }, rects: [{ left: 0, top: 0, right: 10, bottom: 10 }] };
  controller.translated = true;
  doc.dispatch('keydown', { key: 'Delete', target: element('span') });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(known, [['attenuate', 'known']]);
});

test('Delete does nothing when no gloss is shown or it is only a status message', async () => {
  const { controller, doc, known } = makeController();
  controller.hover = null;
  controller.translated = false;
  doc.dispatch('keydown', { key: 'Delete', target: element('span') });
  controller.hover = { word: { word: 'x', lemma: 'x' }, rects: [] };
  controller.translated = false; // e.g. "暂不可用"
  doc.dispatch('keydown', { key: 'Delete', target: element('span') });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(known, [], 'must not mark a word whose gloss never loaded');
});

test('Delete is ignored while typing in an editable field', async () => {
  const { controller, doc, known } = makeController();
  controller.hover = { word: { word: 'attenuated', lemma: 'attenuate' }, rects: [] };
  controller.translated = true;
  const input = element('input');
  input.closest = sel => (sel.includes('input') ? input : null);
  doc.dispatch('keydown', { key: 'Delete', target: input });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(known, []);
});

test('Delete requires an unmodified key press', async () => {
  const { controller, doc, known } = makeController();
  controller.hover = { word: { word: 'attenuated', lemma: 'attenuate' }, rects: [] };
  controller.translated = true;
  doc.dispatch('keydown', { key: 'Delete', ctrlKey: true, target: element('span') });
  doc.dispatch('keydown', { key: 'Delete', metaKey: true, target: element('span') });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(known, []);
});
test('a vocabulary change redraws markers without dismissing the open card', async () => {
  const { controller, doc, known, fire } = makeController();
  controller.hover = { word: { word: 'attenuated', lemma: 'attenuate' }, rects: [] };
  controller.translated = true;
  fire(); // e.g. marking another word updated the store
  // The card must survive, otherwise the very next Delete would do nothing.
  assert.ok(controller.hover, 'hover target must be preserved across a redraw');
  doc.dispatch('keydown', { key: 'Delete', target: element('span') });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(known, [['attenuate', 'known']]);
});

test('mouse side buttons mark the hovered word', async () => {
  const { controller, doc, known } = makeController();
  controller.hover = { word: { word: 'plausible', lemma: 'plausible' }, rects: [] };
  controller.translated = true;
  let defaultPrevented = false;
  controller.markFromSideButton({ button: 3, target: element('span'), preventDefault() { defaultPrevented = true; }, stopPropagation() {} });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(known, [['plausible', 'known']]);
  assert.ok(defaultPrevented, 'side-button default (history navigation) must be suppressed');
});

test('side buttons do nothing without a loaded gloss', async () => {
  const { controller, known } = makeController();
  controller.hover = { word: { word: 'x', lemma: 'x' }, rects: [] };
  controller.translated = false;
  controller.markFromSideButton({ button: 3, target: element('span'), preventDefault() {}, stopPropagation() {} });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(known, []);
});
test('Backspace marks the hovered word just like Delete', async () => {
  const { controller, doc, known } = makeController();
  controller.hover = { word: { word: 'attenuated', lemma: 'attenuate' }, rects: [] };
  controller.translated = true;
  doc.dispatch('keydown', { key: 'Backspace', target: element('span') });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(known, [['attenuate', 'known']]);
});

test('Backspace in an editable field is left to the application', async () => {
  const { controller, doc, known } = makeController();
  controller.hover = { word: { word: 'attenuated', lemma: 'attenuate' }, rects: [] };
  controller.translated = true;
  const input = element('input');
  input.closest = sel => (sel.includes('input') ? input : null);
  doc.dispatch('keydown', { key: 'Backspace', target: input });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(known, []);
});
