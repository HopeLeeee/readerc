# ReaderC 开发说明

## 结构

| 文件 | 职责 |
| --- | --- |
| `addon/bootstrap.js` | Zotero 生命周期、读者发现、密码存储、HTTP、设置页注册 |
| `addon/src/core.js` | 词元查找、生词筛选、句子提取、请求和响应校验 |
| `addon/src/store.js` | 串行持久化、状态恢复、词表导入导出 |
| `addon/src/service.js` | 上下文释义缓存、请求合并、失败回退 |
| `addon/src/reader.js` | 文本层索引、独立下划线层、悬浮卡片、Delete 与撤销 |
| `addon/src/settings.js` | Zotero 和浏览器演示共用的设置界面 |
| `addon/data/lexicon.json` | 带来源元信息的离线词典和词形索引 |
| `tools/build.py` | 标准库生成可重复的 XPI，并检查 ZIP 完整性 |
| `demo/` | 模拟 PDF 文本层的浏览器交互演示 |
| `tests/` | Node 内置测试运行器：词汇逻辑和模拟 Zotero 宿主 |

不改写 PDF、不替换文本层节点，不把释义写成 Zotero 原生批注。标记通过 DOM Range 计算位置，并在页面添加 `pointer-events:none` 的独立图层；翻页、缩放和文本层变化后重新计算。

卡片放在单独的 `about:blank` iframe 中。Delete 只在卡片获得焦点时处理，键盘事件不传播到 PDF 阅读器所在浏览上下文。划选英文仍交给 Zotero 原有逻辑处理。

## Zotero 接入依据

实现依据：

- 官方插件文档：https://www.zotero.org/support/dev/zotero_7_for_developers
- Zotero 9.0.6 读者宿主：https://github.com/zotero/zotero/blob/9.0.6/chrome/content/zotero/xpcom/reader.js
- 9.0.6 对应 Reader 子模块提交：`9643fac7a4e86c8d7ff9548af0191e9df63aa998`
- 对应 PDF 阅读器：https://github.com/zotero/reader/blob/9643fac7a4e86c8d7ff9548af0191e9df63aa998/src/pdf/pdf-view.js

使用正式事件 `renderToolbar`、`renderTextSelectionPopup`；为已有阅读页及分屏发现文本层，使用受保护的 `_readers` / `_iframeWindow` 访问并扫描嵌套 iframe。这一部分属于版本相关适配，不能据此保证未来版本兼容。

Zotero 9.0.6 的 `unregisterEventListener` 源码会过宽地移除同类型监听器，因此关闭时采用 Zotero 自身使用的按 pluginID 清理路径，并为回调设置停止标记，避免影响其他插件。

配置页通过 `Zotero.PreferencePanes.register` 注册；`preferences.xhtml` 的 XUL 容器在 Zotero 派发 load 事件时挂载共用设置 UI。

## 词库再生成

来源：

```text
https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv
```

上游 Git blob：`c4ade63ea08cf39d9c3475e96929036d64d94c94`

源文件 SHA-256：`1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`

源文件完整大小：65,933,428 bytes。转换器先核验 Git blob，拒绝不完整下载。

```powershell
python tools/import-lexicon.py path/to/ecdict.csv
python tools/build.py
```

转换条件：只保留长度不超过 40 的小写英文单词及带连字符/撇号的单词，须有中文释义；释义最多 900 字符。保留 FRQ/BNC 排名、音标及可解析的时态/单复数等词形。词形链解析时跳过循环与缺失词元，不做粗暴的后缀截断。

请随分发包保留 ECDICT 许可及来源说明。

## 请求格式

POST 到用户配置的 `/chat/completions` 地址，JSON 为 `model`、`messages`、`temperature`、`max_tokens`。目标词、词元、所在句及该词起止位置作为用户消息中的 JSON 数据发送。模型必须返回如下消息文本：

```json
{"gloss":"减弱","explanation":"此处指炎症反应减弱。"}
```

句子按标点与段落边界提取，目标词左右最多各约 650 字符，不跨 PDF 页面。行末连字符会合并，普通复合词连字符保留。缓存包含接口、模型、词元、句子和目标位置，不按英文单词全局复用译文。

网络采用 Zotero 的特权 HTTP API，关闭正文调试输出、全局 Cookie、重定向和自动重试；失败回退本地词典。运行中最多三个并发翻译。插件关闭或设置更改时取消仍在执行的 HTTP 请求。

Key 通过 `Services.logins` 保存，接口地址作为对应凭据的用户名键。界面不回填已有 Key。不同接口保留各自凭据，可在设置中删除当前接口的 Key。

## 验证与接下来的原生检查

```powershell
node --test tests/*.test.cjs
node tools/browser-test.cjs
python tools/build.py
```

浏览器测试使用 Playwright 和实际 Chromium，包含真实 Range 几何、悬浮、卡片焦点、Delete 隔离、撤销、重新加载持久化、缩放、设置操作和销毁清理。截图生成在 `test-results/readerc-demo.png`。宿主测试通过模拟 Zotero API 执行真正的 `bootstrap.js`，并向本机临时 HTTP 服务发送实际请求。

下一步在独立 Zotero 9 测试配置中安装 XPI，检查以下实际场景：

1. 新开与已开的 PDF 标签，以及独立阅读窗口。
2. 单栏、双栏、不同缩放、页面旋转、分屏阅读及深色模式。
3. 划选、复制、高亮、已有批注删除，确认和插件卡片的 Delete 隔离。
4. 离线词典、实际模型服务、超时与错误 Key 的回退。
5. 关闭 Zotero 后重新打开，熟词保存与词元关联。
6. 插件禁用、重新启用、升级，以及和其他阅读器插件共同运行。

当前未把浏览器或模拟宿主测试描述为 Zotero 原生验证。

## 偏好面板初始化（Zotero 9 实测结论）

`Zotero.PreferencePanes.register` 会把 `scripts` 数组加载进**面板自己的 `Cu.Sandbox`**：

```js
pane.scope = new Cu.Sandbox(window, { sandboxPrototype: window, sameZoneAs: window });
Services.scriptloader.loadSubScript(script, pane.scope);
```

这些脚本的顶层变量（如 `ReaderCPreferences`）定义在**沙箱里，不落在设置窗口的全局对象上**。
而 `preferences.xhtml` 中内联的 `onload="ReaderCPreferences.init()"` 是在**窗口全局**求值的，
因此会报 `ReferenceError: ReaderCPreferences is not defined`，面板显示为空白。

正确做法：**XHTML 不做任何内联初始化**，由脚本自己在 DOM 就绪后查找 `#readerc-settings-root`
并挂载，必要时短暂重试（Zotero 在脚本加载**之后**才把 XHTML 片段插入文档）。

`tests/bootstrap.test.cjs` 中的
`preference pane script mounts settings without relying on inline XUL onload`
会静态检查 XHTML 不含内联 `onload`，并在模拟沙箱中确认 `mountSettings` 恰好被调用一次。

## 请求编码：必须显式声明 UTF-8（Zotero 9 实测结论）

系统提示词是中文。若只发送 `Content-Type: application/json`，**Zotero 的 HTTP 栈会按平台默认编码
（简体中文 Windows 上是 GBK）编码请求体**，中文提示词变成乱码：

```
"content":"鏍规嵁鍙ュ瓙锛屽垽鏂洰鏍囪瘝..."   // “根据句子…” 被按 GBK 解读
```

模型收到乱码提示词后无法按格式作答：它会把 token 花在推理上，或返回非 JSON 文本，
插件最终报出 `翻译结果不是约定的 JSON 格式`。

修复：**声明 charset 并预编码为 UTF-8 字节**。

```js
const headers = { "Content-Type": "application/json; charset=utf-8" };
let encoded = payload;
try { encoded = new TextEncoder().encode(payload); } catch { /* 保留字符串 */ }
```

`TextEncoder` 在部分嵌入环境不可用，因此保留字符串回退；此时 charset 头仍然生效。

## max_tokens 与推理模型

`deepseek-v4.1-flash` 一类推理模型会先输出 `reasoning_content`。
`max_tokens` 过小（原先 80）会导致 `finish_reason: "length"` 且 `content` 为空，
表现为"不是约定的 JSON 格式"。现设为 **512**，并在 `parseGloss` 中区分三种失败：
截断、空内容、以及从 `reasoning_content` 中抢救出的 JSON。

## 真实接口验证结果

在隔离 Zotero 9.0.6 实例中，经真实上游 `maas.qianwenaiapi.com` 验证：

| 词 | 返回值 |
| --- | --- |
| attenuated | 减轻 |
| inflammatory | 炎症的 |
| elucidate | 阐明 |
| plausible | 看似合理的 |

均为单词、短释义、符合上下文，说明提示词与校验逻辑在真实模型上有效。

## 消除悬停等待（无感翻译）

### 瓶颈定位

逐词按需翻译让每次悬停都要等一整个网络往返。在真实上游实测：

| 配置 | 平均耗时 | 成功率 |
| --- | --- | --- |
| 默认（开启推理） | 1768 ms | 3/4 |
| **关闭推理 + 小 token 预算** | **1007 ms** | **4/4** |
| 批量 4 词一句 | 1309 ms（≈327 ms/词） | — |

推理模型会把几百个 token 花在隐藏推理上，既慢又偶发失败。关闭推理后**快约 2 倍且更稳定**。

### 实现：预取 + 批量 + 缓存

1. **关闭推理**：`reasoning_effort: "none"` 与 `enable_thinking: false` 同时下发，
   以兼容不同服务商；`temperature` 设为 0，`max_tokens` 降到 64。
2. **批量翻译**：同一句的多个生词合并为一次请求（`batchRequestBody`／`parseBatchGloss`），
   无后缀词形仍按词元匹配。批量失败时自动回退为逐词请求。
3. **预取**：页面完成索引后 60 ms，后台把当页可见生词按句分组翻译并写入缓存。
4. **悬停延迟默认 380 ms → 120 ms**：命中缓存后不需要再等。

### 实测效果（真实上游，隔离 Zotero 9.0.6）

```
candidates: 5
coldMs:     911     ← 无预取时每次悬停的等待
prefetchMs: 5172    ← 后台一次完成，用户无感
warmMs:     0       ← 预取后悬停：立即显示
```

回归测试见 `tests/core.test.cjs` 的 `prefetch batches words per sentence…` 等 4 项。

## Delete 标记熟词：可用性修复

原先 Delete 只在**卡片自身**获得焦点后才生效，而卡片只有约 34×22 px，
用户必须先精确点中它再按键。配合 340 ms 的关闭延迟，鼠标从词移到卡片的过程中
卡片往往已经消失，导致该功能实际上难以使用。

修改：

1. **Delete 改为在 PDF 文档层监听**（捕获阶段）。只要卡片正在显示且释义已加载，
   直接按下 Delete 即可标记，无需先点击卡片。
2. **关闭延迟 340 ms → 600 ms**，给鼠标从词移动到卡片留出时间。
3. **卡片加内边距**（`padding: 4px 9px`、`border-radius: 4px`、`cursor: pointer`），
   命中区域更大，并暗示可交互。
4. **标记后立即重绘**（`markKnown` 内调用 `reindex()`），虚线当场消失，
   不必等待下一次渲染；撤销时同样刷新。

守卫条件：仅在 `translated` 为真时响应（"暂不可用"等状态不触发）；
在输入框、文本框或 `contenteditable` 内按 Delete 不拦截；
按住 Ctrl/Alt/Meta 时不响应。以上均有 `tests/reader.test.cjs` 覆盖。

## 标记熟词：两个触发通道

### 真实失效原因（原生实测定位）

此前标记功能在真实使用中无效，**原因不是事件没到达**。
原生探针显示监听器确实执行了（`handlerRan: true`），但词表**没有变化**。
真正的链路是：

```
标记一个词  ->  store 更新  ->  host.subscribe 回调  ->  controller.close()
```

订阅回调原本是 `() => { this.close(); this.schedule(); }`。任何词表或设置变化都会
**关闭正在显示的卡片**，把 `this.hover` 置为 null。于是紧接着的按键或侧键
命中了 `if (!this.hover || !this.translated) return;` 而静默失效。

修复：订阅回调只重绘标记，不再关闭卡片。

```js
this.unsubscribe = host.subscribe(() => {
  const shown = this.hover;
  this.schedule();
  if (shown && !this.frame) this.hover = shown;
});
```

### 通道一：鼠标侧键（推荐）

侧键在 `MouseEvent.button` 中是 **3（后退）** 与 **4（前进）**。它们会依次触发
`pointerdown` / `mousedown` / `auxclick`。实现要点：

- `pointerdown` 中先判断 `button === 3 || button === 4`，命中则标记而**不关闭卡片**；
  其余按键仍按原逻辑关闭。
- 在捕获阶段对 `mousedown` 与 `auxclick` 调用 `preventDefault()`，
  阻止侧键触发阅读器的**后退/前进导航**。
- 仅在 `hover && translated` 时响应，输入框内不拦截。

### 通道二：Delete 键

监听同时挂在 reader 文档与其 window 上（捕获阶段），因为焦点可能位于查看器
外壳而非文档，只挂一处会让按键"看起来坏了"。

两条通道共用 `markKnown()`：写入词表、立即 `reindex()` 使虚线消失、弹出可撤销提示。

### 验证（隔离 Zotero 9.0.6，真实上游）

| 通道 | 结果 |
| --- | --- |
| 侧键 button=3 | `state: known`，虚线 3 → 2 |
| 侧键 button=4 | `state: known` |
| Delete 键 | `marked: known` |

单元测试见 `tests/reader.test.cjs`：词表变更不得关闭卡片、侧键标记与默认行为抑制、
无释义时不响应，以及 Delete 的四项守卫。

## 标记键位的可用性打磨

用户反馈"按了没反应"，实际有两层原因，都已处理。

### 1. Backspace 与 Delete 是两个不同的键

原先只接受 `event.key === "Delete"`。但打字区那个大键是 **Backspace**，
真正的 **Delete** 位于方向键上方、离手远。用户按 Backspace 时插件无响应。

现在两者都接受：

```js
const MARK_KEYS = new Set(["Delete", "Backspace"]);
if (!MARK_KEYS.has(event.key) || event.ctrlKey || event.altKey || event.metaKey) return;
```

输入框、文本框或 `contenteditable` 内的 Backspace 仍然交还给应用处理，
不会误拦截正常的文本编辑。

### 2. 反馈不够明显

标记其实一直生效（词表能看到 `state: "known"`），但提示太小太短，
用户不容易注意到。现在提示更大（14px、内边距加大、9 秒）、
文案明确说明结果（"下划线已移除，今后不再标注"），并支持换行显示。

### 键盘与侧键的分工

| 触发方式 | 说明 |
| --- | --- |
| `Delete` | 方向键区，离手较远 |
| `Backspace` | 打字区，最容易按到 |
| 鼠标侧键（button 3/4） | 悬停时按，无需移动右手 |

原生实测三种方式均返回 `state: "known"`，且侧键的 `defaultPrevented` 为 `true`，
确认历史导航被正确阻止。

## 自动更新

### 机制

Zotero 读取 XPI 内 `applications.zotero.update_url` 指向的 JSON，与已安装版本比较后决定是否升级。
格式（与 Firefox 一致）：

```json
{
  "addons": {
    "readerc@readerc.local": {
      "updates": [{
        "version": "0.2.0",
        "update_link": "https://github.com/.../readerc-0.2.0-zotero9.xpi",
        "update_hash": "sha512:<base64>",
        "applications": { "zotero": { "strict_min_version": "9.0", "strict_max_version": "9.0.*" } }
      }]
    }
  }
}
```

`update_hash` 必须与 `update_link` 下载到的字节完全一致，否则 Zotero 拒绝安装。
因此版本号、链接、哈希三者必须同时更新。

### 生成方式

`tools/make-update-manifest.py` 从已构建的 XPI 反推全部字段，避免手工填写走样：

```powershell
python tools/build.py                 # 构建 XPI
python tools/make-update-manifest.py  # 生成 update.json（含 sha512）
python tools/make-update-manifest.py --release   # 同时创建 GitHub release 并上传
```

发布顺序必须是 **构建 → 生成清单 → 上传 XPI → 上传 update.json**。
先传清单后传 XPI 会让用户拿到哈希不匹配的更新。

### 为什么用 Release 而不是仓库 raw 地址

仓库 `raw` 地址（`raw.githubusercontent.com` 与 `github.com/.../raw/...`）都经过 CDN 缓存。
实测发版后立即拉取，仍会返回上一版文件（相差数分钟到更久），
导致 Zotero 下载到的 XPI 与 `update_hash` 不匹配而拒绝更新。

Release 资产没有这个问题，实测上传后立即可取且哈希一致。
`update_url` 本身托管在固定的 `release` 标签下，指向始终最新。

### 已安装记录会缓存 update_url

`extensions.json` 中保存着安装当时的 `updateURL`。
仅替换 profile 里的 XPI **不会**刷新它，Zotero 仍会去请求旧地址。
更改更新地址后必须重新安装插件（工具 → 插件 → 齿轮 → Install Add-on From File…）。
