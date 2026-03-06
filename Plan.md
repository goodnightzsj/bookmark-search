# Bookmark Search 优化计划（code-review / Plan 模式）

> 本文件用于在实现前对齐范围与验收标准。你确认无误后，我再开始改代码。

## 当前进度（已完成）
- 已修复 `content.js` 中 `faviconCache` 未定义导致的运行时崩溃，并增加内存缓存减少重复请求。
- 已优化 `content.js` 本地搜索：改为 early-break 收集前 10 条，减少 `filter/slice` 分配与重复 `toLowerCase()`。
- 已优化 `background-data.js` 写入策略：将 `bookmarks/history/lastSyncTime` 合并为一次 `chrome.storage.local.set`，并与 `idbSet` 并行，降低 `storage.onChanged` 抖动与 IO。
- 已抽取消息动作常量 `MESSAGE_ACTIONS` 并在 `background/popup/settings` 统一使用（`content.js` 受注入约束保留本地常量）。
- 已加固 `background-data.js` 的 storage 读取：对 `bookmarks/bookmarkHistory` 做 `Array.isArray` 归一化，避免异常值导致启动期 `.length` 崩溃。
- 已加固 `content.js` 的消息监听：对 `message` 为空/非对象做防御，避免异常消息导致监听器崩溃。
- 已新增 `bookmarkCount`：`popup/settings` 展示数量优先读取计数，不再依赖读取全量 `bookmarks` 数组。
- 已优化主题切换：`theme-loader.js` 通过替换 `<link href>` 无刷新切主题（带 token 防止乱序 onload）。
- 已优化 favicon：移除 `chrome://favicon2`（页面内会触发 `Not allowed to load local resource`），改为公开源（DDG/Google/Faviconkit）+ 子域名→一级域名回退。
- 已新增 favicon 持久化缓存：`background-messages.js` 增加 `GET_FAVICONS/SET_FAVICONS`，落地到 IndexedDB；`content.js` 在 overlay 关闭后后台预热书签根域 favicon（使用与展示一致的公开源，限制并发并批量写入 IDB），渲染搜索结果时优先读取持久化缓存，未命中才按需加载并回写持久化。
- 已验证：`pnpm test`、`pnpm build` 通过。

## Gate 0：任务定义

### 目标
- 修复确定性问题，提升稳定性与可维护性
- 降低不必要的 IO/写入与运行时开销（尤其是 `chrome.storage` 写入与页面端搜索）
- 明确模块边界与通信动作（减少字符串散落与耦合）
- 保持 Chrome MV3 + Vite 构建 + 混淆的兼容性

### 非目标
- 不引入框架/TypeScript、不大改 UI 结构
- 不更换构建工具链（仅在现有 Vite/rollup 配置内优化）
- 不做“推翻式重构”（以小步可验收为主）

### 约束与假设
- MV3 service worker 为 `type: "module"`（ESM 环境）
- `content.js` 需要保持可注入的“非 ESM”脚本形态（不要新增 `import`）
- 混淆器 `javascript-obfuscator@0.25.x` 对语法较敏感（避免使用可选链 `?.` 等特性）

### 验收标准（成功判据）
- `pnpm test` 通过
- `pnpm build` 通过，`chrome://extensions` Reload 后 service worker 正常启动
- 快捷键弹出/关闭 overlay 正常；搜索结果可渲染且无运行时报错
- 自动/手动同步后：`popup`/`settings` 统计与时间展示正常、历史记录可更新

## 当前架构速记

### 入口与模块职责
- `background.js`：service worker 启动初始化、监听原生书签事件并防抖触发刷新、监听快捷键并按需注入 `content.js`/`content.css`
- `background-data.js`：书签缓存基线、全量刷新、差异对比、历史记录维护、落地存储（`chrome.storage.local` + IndexedDB）
- `background-messages.js`：`chrome.runtime.onMessage` 路由（使用 `constants.js` 的 `MESSAGE_ACTIONS`）
- `content.js`：页面内 overlay UI、本地缓存过滤搜索（`chrome.storage.local.bookmarks`），缓存为空时降级走后台 `MESSAGE_ACTIONS.SEARCH_BOOKMARKS`（由于注入约束，action 常量在文件内维护一份）
- `popup.js` / `settings*.js`：界面展示 + 发送消息触发同步/设置，监听 `chrome.storage.onChanged` 做实时刷新

### 通信与数据流（简化版）
1. 原生书签变化 → `background.js` debounce alarm → `background-data.refreshBookmarks()` → 写入存储 → `popup/settings/content` 通过 `storage.onChanged` 更新
2. 用户点击同步（popup/settings）→ `runtime.sendMessage({ action: MESSAGE_ACTIONS.REFRESH_BOOKMARKS })` → 同上
3. 快捷键 → `background.js` 注入 `content.css`/`content.js` → `tabs.sendMessage({ action: MESSAGE_ACTIONS.TOGGLE_SEARCH })` → `content.js` 切换 overlay
4. `content.js` 搜索：有 `bookmarks` 缓存 → 页面端过滤；无缓存 → `sendMessage({ action: MESSAGE_ACTIONS.SEARCH_BOOKMARKS })` → `chrome.bookmarks.search()` → 返回前 10 条

## code-review 发现（分级）

### Must fix（正确性/高风险）
- 暂无新的确定性崩溃点（已修复 `faviconCache` 与已知性能热点）。若你更关注“隐私/合规”，则 favicon 第三方请求可提升为 Must fix（见 Optional-1）。

### Should improve（可维护性/性能）
- 生产日志策略：目前生产包保留大量 `console.log`；建议引入统一的 `DEBUG` 开关或构建期 `drop_console`（按环境）减少噪音与潜在性能影响。
- 代码体量与认知负担：`content.js` 仍是“多职责大文件”（UI/搜索/图标/通信混合），即使不拆文件，也可按“纯函数 + side effects”方式分区组织，降低后续改动风险。

### Optional（未来演进）
1. favicon 隐私/稳定性：当前通过第三方源按域名拉取图标，可能受页面 CSP 影响且会泄露访问域名；可研究 background 侧通过 `chrome.favicon.getFaviconUrl` / `chrome://favicon` 代理（或扩展自建 webAccessible favicon endpoint）实现“浏览器内置 favicon”路径，减少第三方依赖。
2. 数据层取舍：目前 `bookmarks` 同时存储在 IndexedDB + `chrome.storage.local`（双份）；若接受“内容脚本只走后台搜索”，可减少/取消全量写入 storage，仅保留统计/时间，从而减少 `storage.onChanged` 风暴。
3. 构建/混淆可靠性：`vite.config.js` 通过字符串扫描在 imports 后插入 `var window=globalThis;`；建议补一个最小“构建产物 smoke check”（例如检查 `dist/background.js` 仍是合法 ESM），避免未来配置变更引入隐性失败。

## Gate A：步骤拆分（小步可验收）
（已完成）1. 修复 `faviconCache` 未定义问题（并补齐最小缓存写入逻辑，避免反复请求）
（已完成）2. 优化 `content.js` 搜索性能（early-break 收集前 10 条，保持结果一致）
（已完成）3. 优化 `background-data.js` 落库策略（减少 `chrome.storage` 写入次数，`Promise.all` 并行）
（已完成）4. 抽取并使用消息 action 常量（统一替换各模块中的字符串）
（已完成）5. 加固数据读取与消息监听的容错（storage 值归一化 + `onMessage` 防御）
（已完成）6. 明确 favicon 策略（公开源 + 子域名→一级域名回退 + 持久化）
（已完成）7. 新增 `bookmarkCount` 减少 UI 读取全量（后续可评估是否移除 `bookmarks` 双份存储）
（已完成）8. 主题无刷新切换（替换 `<link href>` 代替 reload）
（已完成）9. favicon 持久化与关闭后预热（对“书签根域集合”做公开源预热，搜索结果域名仍按需加载）

## Gate B：需要你确认
- 下一迭代你更看重哪条主线？
  - A. 稳定性/健壮性（storage 归一化、消息防御、减少边界崩溃）
  - B. 隐私/合规（favicon 改为不走第三方）
  - C. 性能/容量（减少 `chrome.storage` 全量书签双份存储，更多走后台查询）
  - D. 体验（主题无刷新切换、日志降噪）
