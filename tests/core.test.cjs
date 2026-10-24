const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../addon/src/core.js');
const { Store } = require('../addon/src/store.js');
const { GlossService } = require('../addon/src/service.js');

const lexicon = {
  entries: {
    treatment: { rank: 1700, translation: '治疗' }, attenuate: { rank: 21000, translation: '减弱' },
    inflammatory: { rank: 16000, translation: '炎症的' }, response: { rank: 1300, translation: '反应' },
    mitigate: { rank: 9000, translation: '减轻' }, significant: { rank: 1200, translation: '重要的；显著的' },
    economy: { rank: 800, translation: '经济' }, econometric: { rank: 0, translation: '计量经济的' },
    account: { rank: 700, translation: '解释' }, in: { rank: 10, translation: '在' },
    sparse: { rank: 13000, translation: '稀疏的' }
  },
  forms: { attenuated: 'attenuate', attenuating: 'attenuate', mitigated: 'mitigate', mitigates: 'mitigate', accounted: 'account' }
};
const pick = (text, vocab = {}, opts = {}) => core.candidates(text, lexicon, vocab, opts).map(x => x.lemma);

test('cold start uses frequency and inflection base forms', () => {
  assert.deepEqual(pick('The treatment attenuated the inflammatory response.'), ['attenuate', 'inflammatory']);
});
test('dictionary lookups never mistake Object prototype properties for entries', () => {
  assert.equal(core.entryFor('constructor', lexicon).entry, null);
  assert.equal(core.entryFor('constructor', lexicon).lemma, 'constructor');
});
test('explicit familiarity overrides automatic predictions across inflections', () => {
  assert.deepEqual(pick('mitigated mitigates', { mitigate: { state: 'known' } }), []);
  assert.deepEqual(pick('significant', { significant: { state: 'unknown' } }), ['significant']);
  assert.deepEqual(pick('econometric', { economy: { state: 'known' } }), ['econometric']);
});
test('standalone prepositions excluded; phrases and inflected phrases survive', () => {
  assert.deepEqual(pick('in with to from', { in: { state: 'unknown' } }), []);
  assert.deepEqual(pick('in vitro accounted for the response.'), ['in vitro', 'account for']);
  assert.deepEqual(pick('in vitro', { 'in vitro': { state: 'known' } }), []);
});
test('manual unknown words and custom phrases do not require dictionary coverage', () => {
  assert.deepEqual(pick('novelmarker cell culture', { novelmarker: { state: 'unknown' }, 'cell culture': { state: 'unknown' } }), ['novelmarker', 'cell culture']);
});
test('repetition and page budget are independent settings', () => {
  assert.deepEqual(pick('mitigate mitigated mitigates'), ['mitigate']);
  assert.equal(pick('mitigate mitigated mitigates', {}, { firstOnly: false }).length, 3);
  assert.equal(core.candidates('mitigate '.repeat(100), lexicon, {}, { firstOnly: false, maxPerPage: 10 }).length, 10);
  assert.deepEqual(pick('mitigate', {}, { enabled: false }), []);
});

test('manual unknown marks survive repetition and the automatic page budget', () => {
  const text = 'mitigate '.repeat(12) + 'treatment treatment';
  assert.deepEqual(pick(text, { treatment: { state: 'unknown' } }, { maxPerPage: 10, firstOnly: false }), [...Array(10).fill('mitigate'), 'treatment', 'treatment']);
  assert.deepEqual(pick('treatment treatment', { treatment: { state: 'unknown' } }), ['treatment', 'treatment']);
});

test('manual single words are not swallowed by automatic phrases', () => {
  assert.deepEqual(pick('accounted for', { account: { state: 'unknown' } }), ['account']);
});
test('PDF line-end hyphenation restores the word and context target offsets', () => {
  const text = 'An earlier sentence. The treatment attenu-\nated the response. Another sentence.';
  const result = core.candidates(text, lexicon, {})[0];
  assert.equal(result.lemma, 'attenuate');
  assert.equal(result.sentence, 'The treatment attenuated the response.');
  assert.equal(result.sentence.slice(result.targetStart, result.targetEnd), 'attenuated');
});
test('context stays inside its paragraph and phrases cannot bridge paragraphs', () => {
  const text = 'A title without a period\n\nThe treatment attenuated the response.\n\nAnother paragraph';
  const candidate = core.candidates(text, lexicon, {})[0];
  assert.equal(candidate.sentence, 'The treatment attenuated the response.');
  assert.deepEqual(pick('in\n\nvitro'), []);
});
test('same spelling, different context or target position gets a distinct cache key', () => {
  const a = { lemma: 'significant', sentence: 'significant then significant', targetStart: 0, targetEnd: 11 };
  const b = { ...a, targetStart: 17, targetEnd: 28 };
  assert.notEqual(core.cacheKey(a, {}), core.cacheKey(b, {}));
  assert.notEqual(core.cacheKey(a, { model: 'a' }), core.cacheKey(a, { model: 'b' }));
});
test('API address validation preserves local services and rejects unsafe credentials', () => {
  assert.equal(core.endpointURL('https://example.com/v1/'), 'https://example.com/v1/chat/completions');
  assert.equal(core.endpointURL('http://127.0.0.1:1234/v1/chat/completions'), 'http://127.0.0.1:1234/v1/chat/completions');
  for (const value of ['http://external.example/v1', 'https://user:secret@example.com', 'https://example.com?key=secret', 'javascript:alert(1)']) assert.throws(() => core.endpointURL(value));
});
test('model output is strictly parsed as data', () => {
  assert.equal(core.parseGloss({ choices: [{ message: { content: '```json\n{"gloss":"减弱","explanation":"此处指炎症反应减弱。"}\n```' } }] }).gloss, '减弱');
  assert.throws(() => core.parseGloss({ choices: [{ message: { content: '<script>bad()</script>' } }] }));
  assert.throws(() => core.parseGloss({ choices: [{ message: { content: '{"gloss":42}' } }] }));
  for (const gloss of ['减弱；稀释', '减弱，稀释', '减弱/稀释', '减弱（炎症反应）']) {
    assert.throws(() => core.parseGloss({ choices: [{ message: { content: JSON.stringify({ gloss }) } }] }));
  }
  const candidate = core.candidates('The treatment attenuated the response.', lexicon, {})[0];
  const body = core.requestBody(candidate, 'test-model');
  assert.equal(JSON.parse(body.messages[1].content).target, 'attenuated');
  assert.equal(body.messages.length, 2);
});
test('store serializes simultaneous changes and does not publish failed writes', async () => {
  let fail = false;
  const writes = [];
  const store = new Store(core, async state => {
    if (fail) throw new Error('disk full');
    await new Promise(resolve => setTimeout(resolve, 3));
    writes.push(JSON.parse(JSON.stringify(state)));
  });
  await Promise.all([store.setState('mitigate', 'known'), store.setState('sparse', 'unknown')]);
  assert.equal(Object.keys(store.getVocabulary()).length, 2);
  assert.equal(Object.keys(writes.at(-1).vocabulary).length, 2);
  fail = true;
  await assert.rejects(store.setState('mitigate', 'unknown'), /disk full/);
  assert.equal(store.getVocabulary().mitigate.state, 'known');
  fail = false;
  await store.restoreState('mitigate', null);
  assert.equal(store.getVocabulary().mitigate, undefined);
});
test('export excludes credentials, import merges and rejects malformed entries atomically', async () => {
  const store = new Store(core, async () => {}, { config: { apiKey: 'must-not-leak' } });
  await store.setState('mitigate', 'known');
  const data = JSON.parse(store.exportVocabulary());
  assert.deepEqual(Object.keys(data), ['version', 'vocabulary']);
  assert.ok(!JSON.stringify(data).includes('must-not-leak'));
  await store.importVocabulary({ version: 1, vocabulary: { sparse: { state: 'unknown' } } });
  assert.equal(Object.keys(store.getVocabulary()).length, 2);
  await assert.rejects(store.importVocabulary(JSON.parse('{"version":1,"vocabulary":{"__proto__":{"state":"known"},"fine":{"state":"known"}}}')));
  assert.equal(store.getVocabulary().fine, undefined);
  await assert.rejects(store.batchState(['good', '<bad>'], 'known'));
  assert.equal(store.getVocabulary().good, undefined);
});
test('context service deduplicates in-flight calls and caches successful results only', async () => {
  let calls = 0, fail = false;
  const host = {
    getConfig: () => ({ provider: 'context', endpoint: 'https://example.com/v1', model: 'test' }),
    request: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 3)); if (fail) throw new Error('offline'); return { choices: [{ message: { content: '{"gloss":"减弱"}' } }] }; }
  };
  const service = new GlossService(core, host);
  const candidate = core.candidates('attenuated', lexicon, {})[0];
  const result = await Promise.all([service.lookup(candidate), service.lookup(candidate)]);
  assert.equal(calls, 1);
  assert.equal(result[0].source, 'context');
  await service.lookup(candidate); assert.equal(calls, 1);
  service.clear(); fail = true;
  const fallback = await service.lookup(candidate);
  assert.equal(fallback.source, 'status'); assert.equal(fallback.gloss, '暂不可用'); assert.equal(fallback.error, 'offline');
  await service.lookup(candidate); assert.equal(calls, 3);
});
test('unconfigured context never falls back to dictionary definitions', async () => {
  const service = new GlossService(core, { getConfig: () => ({ provider: 'offline' }), request: async () => { throw new Error('must not request'); } });
  const result = await service.lookup({ lemma: 'mitigate', entry: { translation: '减轻；缓和；温和' } });
  assert.equal(result.gloss, '未配置');
  assert.equal(result.source, 'status');
});

test('prefetch batches words per sentence so hover hits the cache', async () => {
  const calls = [];
  const service = new GlossService(core, {
    getConfig: () => ({ provider: 'context', endpoint: 'https://example.test/v1', model: 'm' }),
    request: async (url, body) => {
      const user = JSON.parse(body.messages[1].content);
      calls.push({ words: user.words, reasoning: body.reasoning_effort, maxTokens: body.max_tokens });
      return { choices: [{ message: { content: JSON.stringify(
        user.words.map(w => ({ word: w, gloss: w === 'attenuated' ? '减弱' : '炎症的' }))) } }] };
    }
  });
  const sentence = 'The treatment attenuated the inflammatory response.';
  const candidates = [
    { word: 'attenuated', lemma: 'attenuate', sentence, targetStart: 14, targetEnd: 24 },
    { word: 'inflammatory', lemma: 'inflammatory', sentence, targetStart: 29, targetEnd: 41 },
  ];
  const warmed = await service.prefetch(candidates);
  assert.equal(warmed, 2);
  // One request covering both words, with reasoning disabled.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].words, ['attenuated', 'inflammatory']);
  assert.equal(calls[0].reasoning, 'none');

  // Hovering afterwards must not issue another request.
  const first = await service.lookup(candidates[0]);
  assert.equal(first.gloss, '减弱');
  assert.equal(first.source, 'context');
  assert.equal(calls.length, 1, 'hover must read the prefetched cache');
});

test('separate sentences are prefetched in parallel, not one by one', async () => {
  const sentences = ['Sentence one has sparse coverage.', 'Another sentence stands alone.'];
  const calls = [];
  const service = new GlossService(core, {
    getConfig: () => ({ provider: 'context', endpoint: 'https://example.test/v1', model: 'm' }),
    request: async (url, body) => {
      const user = JSON.parse(body.messages[1].content);
      calls.push(user.words);
      return { choices: [{ message: { content: JSON.stringify(user.words.map(w => ({ word: w, gloss: '释义' }))) } }] };
    }
  });
  const candidates = sentences.map((sentence, i) => ({ word: 'word' + i, lemma: 'word' + i, sentence, targetStart: 0, targetEnd: 4 }));
  await service.prefetch(candidates);
  assert.equal(calls.length, 2, 'one request per distinct sentence');
});

test('a failed batch falls back to single-word lookups', async () => {
  let batch = true;
  const service = new GlossService(core, {
    getConfig: () => ({ provider: 'context', endpoint: 'https://example.test/v1', model: 'm' }),
    request: async (url, body) => {
      const user = JSON.parse(body.messages[1].content);
      if (Array.isArray(user.words)) { batch = false; throw new Error('batch unsupported'); }
      return { choices: [{ message: { content: JSON.stringify({ gloss: '回退释义' }) } }] };
    }
  });
  const sentence = 'One sentence here.';
  const candidates = [
    { word: 'alpha', lemma: 'alpha', sentence, targetStart: 0, targetEnd: 5 },
    { word: 'beta', lemma: 'beta', sentence, targetStart: 6, targetEnd: 10 },
  ];
  await service.prefetch(candidates);
  assert.equal(batch, false, 'should retry singly after the batch fails');
  const result = await service.lookup(candidates[0]);
  assert.equal(result.gloss, '回退释义');
  assert.equal(result.source, 'context');
});

test('reasoning is disabled and the token budget stays small', () => {
  const body = core.requestBody({ word: 'attenuated', lemma: 'attenuate', sentence: 'x', targetStart: 0, targetEnd: 0 }, 'm');
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.enable_thinking, false);
  assert.ok(body.max_tokens <= 128, 'latency depends on a small completion budget');
});
