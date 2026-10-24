var ReaderCStore = (() => {
  "use strict";
  class Store {
    constructor(core, persistence, initial = {}) {
      this.core = core;
      this.persistence = persistence;
      this.state = { version: 1, config: core.config(initial.config), vocabulary: core.cleanVocabulary(initial.vocabulary) };
      this.listeners = new Set();
      this.queue = Promise.resolve();
    }
    getConfig() { return { ...this.state.config }; }
    getVocabulary() { return this.state.vocabulary; }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    mutate(change) {
      const job = this.queue.then(async () => {
        const next = JSON.parse(JSON.stringify(this.state));
        next.vocabulary = this.core.cleanVocabulary(next.vocabulary);
        change(next);
        await this.persistence(next);
        this.state = next;
        for (const listener of this.listeners) { try { listener(); } catch { /* Isolate readers. */ } }
      });
      this.queue = job.catch(() => {});
      return job;
    }
    setConfig(value) { return this.mutate(next => { next.config = this.core.config(value); }); }
    setState(word, state) {
      if (!this.core.validKey(word) || !["known", "unknown"].includes(state)) return Promise.reject(new Error("词条或状态无效。"));
      return this.mutate(next => { next.vocabulary[word] = { state, updatedAt: new Date().toISOString() }; });
    }
    restoreState(word, previous) {
      if (!this.core.validKey(word)) return Promise.reject(new Error("词条无效。"));
      return this.mutate(next => {
        if (previous && ["known", "unknown"].includes(previous.state)) next.vocabulary[word] = { ...previous };
        else delete next.vocabulary[word];
      });
    }
    batchState(words, state) {
      if (!Array.isArray(words) || words.length > 10000 || !["known", "unknown", "default"].includes(state) || words.some(word => !this.core.validKey(word))) return Promise.reject(new Error("词条无效：仅支持英文单词或短语，每次最多一万个。"));
      return this.mutate(next => {
        for (const word of words) {
          if (state === "default") delete next.vocabulary[word];
          else next.vocabulary[word] = { state, updatedAt: new Date().toISOString() };
        }
      });
    }
    importVocabulary(data) {
      if (data?.version !== 1 || !data.vocabulary || typeof data.vocabulary !== "object" || Array.isArray(data.vocabulary)) return Promise.reject(new Error("不是 ReaderC v1 词表文件。"));
      const incoming = this.core.cleanVocabulary(data.vocabulary);
      if (Object.keys(incoming).length !== Object.keys(data.vocabulary).length) return Promise.reject(new Error("词表包含无效条目，未导入。"));
      return this.mutate(next => { Object.assign(next.vocabulary, incoming); });
    }
    exportVocabulary() { return JSON.stringify({ version: 1, vocabulary: this.state.vocabulary }, null, 2); }
  }
  return { Store };
})();
if (typeof module !== "undefined") module.exports = ReaderCStore;
