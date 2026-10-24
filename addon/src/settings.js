var ReaderCSettings = (() => {
  "use strict";
  function mount(root, host) {
    const doc = root.ownerDocument;
    const el = (tag, text) => {
      const value = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      if (text !== undefined) value.textContent = text;
      return value;
    };
    const style = el("style");
    style.textContent = `#readerc-settings-root{font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:inherit}#readerc-settings-root h2{font-size:17px;margin:22px 0 8px}#readerc-settings-root p{margin:6px 0 12px;color:#6b7d75}#readerc-settings-root label{display:block;margin:10px 0}#readerc-settings-root input:not([type=checkbox]),#readerc-settings-root select,#readerc-settings-root textarea{display:block;width:100%;padding:8px 10px;margin-top:4px;border:1px solid #94a99d66;border-radius:6px;color:inherit;background:transparent;font:inherit;box-sizing:border-box}#readerc-settings-root input[type=checkbox]{margin-right:8px}#readerc-settings-root button{padding:7px 12px;border:1px solid #8ca99b66;border-radius:6px;background:#e9f5ee;color:#23513f;cursor:pointer;margin:4px 6px 4px 0;font:inherit}#readerc-settings-root button:disabled{opacity:.5;cursor:wait}#readerc-settings-root .rc-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}#readerc-settings-root .rc-row>label{flex:1;min-width:120px}#readerc-settings-root .rc-list{max-height:270px;overflow:auto;border:1px solid #91a99b55;border-radius:6px;padding:8px}#readerc-settings-root .rc-word{display:flex;gap:10px;align-items:center;justify-content:space-between;border-bottom:1px solid #91a99b22;padding:3px 5px}#readerc-settings-root .rc-word button{font-size:11px;padding:3px 8px}#readerc-settings-root .rc-status{min-height:24px;color:#327257;white-space:pre-line}#readerc-settings-root .rc-muted{font-size:11px;color:#71867b}#readerc-settings-root details{margin-top:16px}#readerc-settings-root summary{cursor:pointer}`;
    root.append(style);
    const title = el("h2", "英文原文，按需释义");
    const intro = el("p", "绿色虚线标记候选生词。悬浮时只显示一个由模型按原句选出的中文释义，不显示边框、原句或按钮。点击释义后按 Delete，今后隐藏该词及常见屈折词形。");
    root.append(title, intro);
    const form = el("form");
    const fields = {};
    const add = (parent, name, label, type = "text", choices) => {
      const wrapper = el("label");
      const control = el(choices ? "select" : "input");
      control.id = `readerc-${name}`;
      if (choices) {
        for (const [value, text] of choices) {
          const option = el("option", text); option.value = value; control.append(option);
        }
      } else control.type = type;
      if (type === "checkbox") wrapper.append(control, doc.createTextNode(label));
      else wrapper.append(doc.createTextNode(label), control);
      fields[name] = control;
      parent.append(wrapper);
      return control;
    };
    add(form, "enabled", "启用生词标记和悬浮释义", "checkbox");
    const row = el("div"); row.className = "rc-row";
    add(row, "threshold", "初始注释密度", "text", [["1500", "更多（常用词排名 1500 以后）"], ["3000", "适中（排名 3000 以后）"], ["6000", "较少（排名 6000 以后）"]]);
    const delay = add(row, "hoverDelay", "悬浮等待（毫秒，越低越灵敏）", "number"); delay.min = "0"; delay.max = "2000";
    const max = add(row, "maxPerPage", "每页最多标记数", "number"); max.min = "10"; max.max = "300";
    form.append(row);
    add(form, "firstOnly", "同一词元每页只标记第一次出现", "checkbox");
    form.append(el("p", "密度依据通用词频估计，不代表精确词汇量。个人熟词、生词记录优先；单独的介词不自动注释，固定短语整体处理。"));
    form.append(el("p", "译文在页面显示后即于后台预取，悬浮时直接读取缓存，通常无需等待网络。若模型不支持关闭推理，可在接口参数中另行调整。"));
    form.append(el("h2", "上下文模型"));
    const endpoint = add(form, "endpoint", "接口基础地址或完整 /chat/completions 地址");
    endpoint.placeholder = "https://你的服务地址/v1 或 http://127.0.0.1:端口/v1";
    add(form, "model", "模型名称（由接口服务商提供）");
    const secret = add(form, "apiKey", "API Key（留空保留已保存的密钥）", "password");
    secret.autocomplete = "new-password";
    add(form, "clearKey", "删除当前接口已保存的密钥", "checkbox");
    form.append(el("p", "查询时只将目标词及所在句子发送给你配置的模型；不上传整篇 PDF。悬浮只显示一个短释义，不回退展示词典列表。接口未配置或不可用时仅显示简短状态，详细原因见下方测试结果。API Key 保存到 Zotero 的密码存储，不写入词表或导出文件。本地无密钥服务可留空。"));
    const save = el("button", "保存设置"); save.type = "submit";
    const test = el("button", "测试已保存的配置"); test.type = "button";
    const status = el("div"); status.className = "rc-status"; status.setAttribute("role", "status");
    form.append(save, test, status);
    root.append(form);
    const current = host.getConfig();
    for (const [name, control] of Object.entries(fields)) {
      if (name === "apiKey" || name === "clearKey") continue;
      if (control.type === "checkbox") control.checked = current[name];
      else control.value = current[name];
    }
    form.addEventListener("submit", async event => {
      event.preventDefault(); save.disabled = true; status.textContent = "正在保存……";
      try {
        const value = { ...host.getConfig() };
        for (const [name, control] of Object.entries(fields)) {
          if (["apiKey", "clearKey"].includes(name)) continue;
          value[name] = control.type === "checkbox" ? control.checked : control.type === "number" || name === "threshold" ? Number(control.value) : control.value;
        }
        await host.saveConfig(value, secret.value, fields.clearKey.checked);
        secret.value = ""; fields.clearKey.checked = false;
        status.textContent = "设置已保存，已打开的 PDF 会自动更新。";
      } catch (error) { status.textContent = error.message || "保存失败。"; }
      finally { save.disabled = false; }
    });
    test.addEventListener("click", async () => {
      test.disabled = true; status.textContent = "正在测试……";
      try {
        const result = await host.testTranslation();
        status.textContent = result.source === "context" ? `连接成功：attenuated → ${result.gloss}` : result.error || "翻译暂不可用。";
      } catch (error) { status.textContent = error.message || "测试失败。"; }
      finally { test.disabled = false; }
    });

    root.append(el("h2", "个人词表"));
    const counts = el("p"); root.append(counts);
    const search = el("input"); search.type = "search"; search.placeholder = "搜索熟词或生词"; search.setAttribute("aria-label", "搜索个人词表"); root.append(search);
    const list = el("div"); list.className = "rc-list"; root.append(list);
    const vocabStatus = el("div"); vocabStatus.className = "rc-status"; vocabStatus.setAttribute("role", "status");
    const render = () => {
      const entries = Object.entries(host.getVocabulary()).sort(([a], [b]) => a.localeCompare(b));
      const known = entries.filter(([, x]) => x.state === "known").length;
      counts.textContent = `${known} 个熟词，${entries.length - known} 个生词。恢复默认后，该词重新按词频筛选。`;
      list.replaceChildren();
      const filtered = entries.filter(([key]) => key.includes(search.value.trim().toLowerCase()));
      for (const [key, value] of filtered.slice(0, 200)) {
        const item = el("div"); item.className = "rc-word";
        item.append(el("span", `${key} · ${value.state === "known" ? "熟词" : "生词"}`));
        const restore = el("button", "恢复默认"); restore.type = "button";
        restore.addEventListener("click", async () => {
          try { await host.restoreState(key, null); render(); }
          catch { vocabStatus.textContent = "恢复失败，请检查存储目录。"; }
        });
        item.append(restore); list.append(item);
      }
      if (!filtered.length) list.append(el("span", "暂无匹配词条。"));
      if (filtered.length > 200) list.append(el("span", `另有 ${filtered.length - 200} 个词条，请输入搜索。`));
    };
    search.addEventListener("input", render);
    const batch = el("textarea"); batch.rows = 2; batch.placeholder = "输入单词或短语，每行一个，例如 mitigate 或 account for"; batch.setAttribute("aria-label", "批量编辑词条");
    root.append(batch);
    for (const [state, label] of [["known", "标记为熟词"], ["unknown", "标记为生词"], ["default", "恢复默认"]]) {
      const button = el("button", label); button.type = "button";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const words = [...new Set(batch.value.split(/\n|,|，/).map(x => x.trim()).filter(Boolean))];
          if (!words.length) throw new Error("请先输入词条。");
          // Host validates the entire batch before writing, avoiding partial updates.
          await host.batchState(words, state);
          vocabStatus.textContent = `已处理 ${words.length} 个词条。`;
          batch.value = ""; render();
        } catch (error) { vocabStatus.textContent = error.message || "保存失败。"; }
        finally { button.disabled = false; }
      });
      root.append(button);
    }
    root.append(vocabStatus);
    const details = el("details"); details.append(el("summary", "备份与导入词表"));
    details.append(el("p", "导出内容不包含 API Key 或接口配置。导入会合并词表，同名词以导入内容为准。"));
    const transfer = el("textarea"); transfer.rows = 7; transfer.setAttribute("aria-label", "词表 JSON");
    const exportButton = el("button", "生成备份 JSON"); exportButton.type = "button";
    exportButton.addEventListener("click", () => { transfer.value = host.exportVocabulary(); transfer.focus(); transfer.select(); });
    const importButton = el("button", "合并导入 JSON"); importButton.type = "button";
    importButton.addEventListener("click", async () => {
      importButton.disabled = true;
      try {
        if (transfer.value.length > 5000000) throw new Error("词表过大，最大支持 5 MB。");
        await host.importVocabulary(JSON.parse(transfer.value)); render(); vocabStatus.textContent = "词表已合并导入。";
      } catch (error) { vocabStatus.textContent = error instanceof SyntaxError ? "JSON 格式错误，未导入。" : error.message; }
      finally { importButton.disabled = false; }
    });
    details.append(transfer, exportButton, importButton); root.append(details);
    const credits = el("p", `ReaderC 0.2.0 · ECDICT 词频与词形数据（MIT）· ${host.lexiconInfo.entries.toLocaleString()} 个词条。中文释义只来自模型。扫描 PDF 需要先做 OCR；词频和通用停用词规则可能误判，可随时补标或恢复。开发预览版暂手动更新。`);
    credits.className = "rc-muted"; root.append(credits);
    render();
    // A fresh render when reopening the pane shows updates made while reading.
    root.parentElement?.addEventListener("showing", render);
  }
  return { mount };
})();
if (typeof module !== "undefined") module.exports = ReaderCSettings;
