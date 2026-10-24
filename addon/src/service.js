var ReaderCService = (() => {
  "use strict";
  // Translating on hover costs a full network round trip, which users feel as
  // lag. Instead prefetch every visible candidate as soon as a page is indexed,
  // grouped per sentence so one request covers several words. Hovering then
  // hits the cache and renders with no perceptible delay.
  const MAX_PENDING = 4;
  const MAX_PREFETCH_WORDS = 60;
  class GlossService {
    constructor(core, host) {
      this.core = core;
      this.host = host;
      this.cache = new Map();
      this.pending = new Map();
      this.generation = 0;
    }
    async lookup(candidate) {
      const settings = this.core.config(this.host.getConfig());
      if (!settings.endpoint || !settings.model) return this.status("未配置", "请在词释设置中填写模型接口和模型名称。");
      const key = this.core.cacheKey(candidate, settings);
      if (this.cache.has(key)) return this.cache.get(key);
      if (this.pending.has(key)) return this.pending.get(key);
      if (this.pending.size >= MAX_PENDING) return this.status("稍后再试", "翻译请求较多，请稍后再试。");
      return this.#track(key, candidate, settings, this.generation, this.#single(candidate, settings));
    }
    /**
     * Warm the cache for a page's visible candidates. Returns a promise that
     * settles when prefetching finishes, so tests can await it.
     */
    prefetch(candidates) {
      const settings = this.core.config(this.host.getConfig());
      if (!settings.endpoint || !settings.model) return Promise.resolve(0);
      const wanted = [];
      const seen = new Set();
      for (const candidate of candidates) {
        if (wanted.length >= MAX_PREFETCH_WORDS) break;
        const key = this.core.cacheKey(candidate, settings);
        if (this.cache.has(key) || this.pending.has(key) || seen.has(key)) continue;
        seen.add(key);
        wanted.push({ candidate, key });
      }
      if (!wanted.length) return Promise.resolve(0);
      // Group by sentence: one request glosses every word of that sentence.
      const groups = new Map();
      for (const item of wanted) {
        const sentence = item.candidate.sentence || "";
        if (!groups.has(sentence)) groups.set(sentence, []);
        groups.get(sentence).push(item);
      }
      const generation = this.generation;
      const jobs = [];
      for (const items of groups.values()) {
        if (items.length === 1) {
          jobs.push(this.#track(items[0].key, items[0].candidate, settings, generation, this.#single(items[0].candidate, settings)));
        } else {
          jobs.push(this.#trackBatch(items, settings, generation));
        }
      }
      return Promise.allSettled(jobs).then(() => wanted.length);
    }
    #track(key, candidate, settings, generation, operation) {
      const tracked = operation.then(result => {
        if (result?.source === "context" && this.generation === generation) this.#store(key, result);
        if (result?.source === "context") this.host.reportStatus?.({ state: "ready", message: "上下文翻译可用。" });
        return result;
      }).finally(() => {
        if (this.pending.get(key) === tracked) this.pending.delete(key);
      });
      this.pending.set(key, tracked);
      return tracked;
    }
    #trackBatch(items, settings, generation) {
      const keys = items.map(item => item.key);
      const operation = this.#batch(items.map(item => item.candidate), settings).then(glosses => {
        if (this.generation !== generation) return;
        for (const item of items) {
          const gloss = glosses.get(item.candidate);
          if (gloss) this.#store(item.key, { gloss, source: "context" });
        }
        if (glosses.size) this.host.reportStatus?.({ state: "ready", message: "上下文翻译可用。" });
      }).finally(() => {
        for (const key of keys) if (this.pending.get(key) === operation) this.pending.delete(key);
      });
      for (const key of keys) this.pending.set(key, operation);
      return operation;
    }
    async #single(candidate, settings) {
      try {
        if (!settings.model) throw new Error("请先设置模型名称。");
        const endpoint = this.core.endpointURL(settings.endpoint);
        const response = await this.host.request(endpoint, this.core.requestBody(candidate, settings.model), settings.timeout);
        return this.core.parseGloss(response);
      } catch (error) {
        return this.status("暂不可用", error?.message || "上下文翻译暂不可用。");
      }
    }
    async #batch(candidates, settings) {
      try {
        if (!settings.model) throw new Error("请先设置模型名称。");
        const endpoint = this.core.endpointURL(settings.endpoint);
        const response = await this.host.request(endpoint, this.core.batchRequestBody(candidates, settings.model), settings.timeout);
        return this.core.parseBatchGloss(response, candidates);
      } catch (error) {
        // A failed batch must not blank the card: retry the words singly so a
        // partially-covered sentence still gets glosses.
        this.host.reportStatus?.({ state: "error", message: error?.message || "批量翻译暂不可用。" });
        const fallback = new Map();
        for (const candidate of candidates) {
          const result = await this.#single(candidate, settings);
          if (result?.source === "context") fallback.set(candidate, result.gloss);
        }
        return fallback;
      }
    }
    #store(key, result) {
      this.cache.set(key, result);
      if (this.cache.size > 600) this.cache.delete(this.cache.keys().next().value);
    }
    status(gloss, message) {
      this.host.reportStatus?.({ state: "error", message });
      return { gloss, source: "status", error: message };
    }
    clear() { this.generation++; this.cache.clear(); this.pending.clear(); }
  }
  return { GlossService };
})();
if (typeof module !== "undefined") module.exports = ReaderCService;
