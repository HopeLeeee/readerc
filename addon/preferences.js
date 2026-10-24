/* Loaded by Zotero.PreferencePanes into the pane's own sandbox scope.
 * The XHTML's inline onload cannot see sandbox variables, so this script
 * mounts itself once the pane markup is in the document. */
var ReaderCPreferences = {
  init() {
    const root = document.getElementById("readerc-settings-root");
    if (!root) return false;
    if (root.dataset.mounted) return true;
    root.dataset.mounted = "true";
    if (Zotero.ReaderC) {
      try { Zotero.ReaderC.mountSettings(root); }
      catch (error) { root.textContent = "词释设置加载失败：" + (error?.message || error); }
    }
    else {
      root.textContent = "ReaderC 尚未启动，请检查插件是否启用。";
    }
    return true;
  }
};

// Mount as soon as the pane markup exists; retry briefly because Zotero
// appends the fragment after loading these scripts.
(() => {
  let tries = 0;
  const tick = () => {
    if (ReaderCPreferences.init()) return;
    if (++tries > 100) return;
    setTimeout(tick, 50);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tick, { once: true });
  else tick();
})();
