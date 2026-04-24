# 书签搜索 · Bookmark Search

按 `Ctrl/Cmd+Space` 在当前页直接呼出搜索框。多词匹配标题、URL、文件夹路径；按数字键直达前 9 条；右键或 `Alt+Enter` 呼出操作菜单（复制链接 / 在新窗口打开 / 在书签管理器显示 / 删除）。书签与浏览器自动保持同步，离线也能用。

当前版本：`v2.1.0`

## 🧭 一句话介绍

不离开当前标签页就能打开收藏夹里某一条书签。极简白、液态玻璃、深色工作站、Linear 风经典 4 套主题任选，支持跟随系统深浅。

## ✨ 功能特性

### 搜索 & 键盘
- 🔍 **多词模糊**：title / URL / folder 路径同时匹配，空格分词 AND
- 🎯 **查询词高亮**：命中片段 `<mark>` 高亮
- 🧭 **面包屑路径**：`a › b › c` 分隔；URL 默认折叠，hover/选中才展开
- ⚡ **数字直达**：`Cmd/Ctrl+1~9` 直接打开前 9 条结果
- ⌨️ **`/` 聚焦**：失焦时用 `/` 重新抓回输入框
- 🛠️ **Action menu**：`Alt+Enter` 或右键呼出：复制链接 / 在新窗口打开 / 在书签管理器中显示 / 删除（带确认）
- 💭 **搜索历史**：记录最近 20 条成功查询，空输入时作为 chips 一键回填
- 📇 **空态最近打开**：没输入时优先展示你最近实际打开过的书签
- 🌏 **IME 友好**：中文/日文输入时不会误确认

### 视觉 & 主题
- 🎨 **4 套主题**：经典 Linear-light / Swiss Grid 极简白 / Liquid-Glass 液态玻璃 / 夜间工作站深色
- 🌓 **跟随系统**：新增 `auto` 主题，根据 `prefers-color-scheme` 切换深浅
- 🔤 **各主题专属字体栈**：SF Pro Text / Helvetica Neue / SF Pro Rounded / Mono
- 🖼️ **Monogram favicon 回退**：图标加载失败时显示"首字母 + 域名哈希色"，不是灰色默认圆
- 🎛️ **原生控件全改写**：select / checkbox / input / scrollbar 按主题重绘，无 browser chrome

### 存储 & 同步
- 📊 **IDB documents store + chrome.storage 元数据**：主书签走 IndexedDB，元数据/历史/设置走 `chrome.storage.local`
- 🔄 **增量实时同步**：监听 `chrome.bookmarks.*` 事件，防抖 500ms 合并
- ⏰ **定时轮询**：5 分钟 ~ 24 小时可选，30 分钟推荐
- 💾 **SW 挂起兜底**：事件队列持久化到 IDB + alarm 唤醒 flush，Service Worker 休眠也不丢事件
- 📝 **100 条变更历史**：新增/删除/编辑/移动，源位置 + 目标位置
- 📤 **Netscape 格式导出**：多选历史项批量导出，兼容 Chrome/Edge/Firefox

### 性能 & 可靠性
- 🚀 **Favicon 多级缓存**：内存 LRU → IDB 持久化 → `chrome-extension://_favicon` 浏览器内置服务（替代 DDG/Google/Faviconkit，无隐私泄露）
- ⚙️ **构建期常量注入**：`MESSAGE_ACTIONS` 通过 vite plugin 注入 content.js，消除两份手写常量
- 🧪 **postbuild smoke check**：自动校验 `dist/background.js` 仍是 ESM + 注入成功
- 🎯 **29 个单元测试**：`node --test` 内置 runner，覆盖 bookmark-logic、background-data、storage-service 等核心模块
- 🏗 **GitHub Actions CI**：build + test + postbuild smoke + dist artifact

### 可访问性
- ♿ **`prefers-reduced-motion`**：关闭 stagger / pulse / spring
- ♿ **`prefers-reduced-transparency`**：glass 主题自动回退到实色
- 🎯 **`:focus-visible`**：所有交互元素可见焦点环
- 🏷️ **ARIA 完整**：role=dialog / combobox / listbox / option / menu

## 🚀 使用方法

### 安装
1. 打开 Chrome/Edge 浏览器
2. 进入扩展管理页面
3. 开启"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择本项目文件夹

### 使用
- **快捷键唤起**：默认 Ctrl+Space（Windows/Linux）与 Command+Space（Mac），可在浏览器扩展快捷键设置中自定义
- **点击图标**：点击扩展图标查看状态和管理
- **搜索**：输入关键词搜索书签标题、URL 和路径
- **导航**：使用方向键或鼠标选择
- **打开书签**：Enter 键在新标签页打开，Ctrl+Enter 在当前页打开
- **关闭**：按 Esc 键或点击遮罩层

## ⚠️ 使用限制

### 特殊页面限制
由于浏览器安全策略，扩展无法在系统页面中使用，包括 chrome:// 和 edge:// 开头的页面。这是浏览器的安全设计，防止恶意扩展在系统页面注入代码。

**解决方法**：请切换到普通网页使用扩展功能。

## ⌨️ 快捷键说明

### 默认快捷键
- **Windows/Linux**：`Ctrl+Space`
- **Mac**：`Command+Space`

可在浏览器的 `chrome://extensions/shortcuts` 页面自定义。如果与输入法切换冲突，参考下方替代组合。

### 推荐替代方案
- **Windows/Linux**：`Ctrl+Shift+Q`（首选），`Ctrl+Alt+B`，`Ctrl+Shift+;`
- **Mac**：`Command+Shift+Q` 或 `Command+Shift+B`

**注意**：避免使用 `Ctrl+Shift+F`，该组合在 Windows 下与部分输入法冲突。

## 🔄 书签更新机制

### 自动同步原理
扩展采用多层次的书签同步机制，确保数据实时更新：

### 更新时机
1. **扩展首次加载**：检查本地缓存，如无缓存则从浏览器获取完整书签树并缓存，记录同步时间
2. **实时监听**：自动监听书签的新增、删除、编辑和移动操作，立即同步更新
3. **定时轮询**：根据用户设置的间隔（默认30分钟）自动同步书签，可选5分钟至24小时，或禁用
4. **手动刷新**：用户可在Popup或设置页面手动同步，完整重新获取所有书签
5. **设置页面实时更新**：检测到数据变化时自动刷新界面，无需手动刷新

### 同步间隔设置
用户可以在设置页面自定义同步间隔：
- **5分钟** - 数据最新，适合频繁操作书签的用户
- **10/15/30分钟** - 平衡性能与实时性（推荐30分钟）
- **1/2/6/12/24小时** - 适合不常修改书签的用户
- **禁用** - 仅依靠实时监听和手动同步

Popup页面会显示最后同步时间和下次同步时间，让用户随时了解同步状态。

### 数据流向
用户操作 → 浏览器书签 API → 后台增量/全量同步 → 运行时文档缓存 → IndexedDB + `chrome.storage.local` → 界面自动更新

### 支持的操作
- **新增书签**：实时添加到搜索列表，记录新增位置
- **删除书签**：实时从列表移除，记录删除前位置
- **编辑书签**：获取完整书签信息，更新标题和URL，记录当前位置
- **移动书签**：跟踪文件夹变化，同时记录源位置和目的位置

### 历史记录功能
系统自动记录所有书签操作，包括操作类型、书签信息、位置信息和时间戳，最多保留100条记录。

**位置显示规则**：
- 🟢 **新增**：显示"新增到：文件夹路径"
- 🔴 **删除**：显示"删除自：文件夹路径"
- 🔵 **修改**：显示"位置：文件夹路径"
- 🔴🟢 **移动**：分两行显示"从：源路径" 和 "到：目标路径"

### 性能优化
- 使用运行时缓存与 IndexedDB 减少 API 调用
- 增量更新优先，必要时再执行全量刷新
- 设置页面实时更新，无需轮询
- 防抖搜索、后台检索与 favicon 预热机制

### 故障排查
如遇书签数量不准确或历史记录不显示，可在设置页面点击"同步书签"按钮手动刷新。设置页面支持实时更新，会自动显示"已自动更新"的视觉反馈。

## 🎯 首次使用

第一次在新标签页使用快捷键时，扩展会自动注入必要的脚本，之后使用将即时响应。

## 🛠️ 技术栈

- **Manifest V3** Chrome extension
- **Vanilla ES modules**（无框架、无运行时依赖）
- **Vite 5** + Terser 构建；内置 `bs-inject-message-actions` plugin 构建期注入常量
- **CSS3**：CSS vars + `backdrop-filter` + `@supports` + `prefers-*` 媒体查询
- **Storage**：`chrome.storage.local`（配置/元数据/历史）+ IndexedDB（主书签文档 + 事件队列）
- **Service Worker** + `chrome.alarms` + `chrome.scripting`
- **Chrome Extension i18n**（`_locales/zh_CN` + `_locales/en`）
- **GitHub Actions CI** + `node --test` 单元测试

## 📂 项目结构

**Service Worker 侧**
- `background.js` - SW 入口：事件监听 + 防抖队列 + alarm 兜底
- `lifecycle.js` - `ensureInit()` 单例初始化（破解循环依赖）
- `background-data.js` - 书签文档缓存、增量/全量 refresh、搜索评分、历史
- `background-messages.js` - 消息路由（SEARCH_BOOKMARKS / GET_RECENT_OPENED / DELETE_BOOKMARK 等）
- `background-sync.js` - 定时同步 alarm 配置
- `idb-service.js` - IndexedDB kv / documents / meta 三个 store 的读写封装
- `storage-service.js` - `chrome.storage.local` 带状态封装
- `migration-service.js` - schema v1 → v2 迁移
- `logger.js` - 统一 logger（level + namespace + 运行时 debug flag）

**Content / UI 侧**
- `content.js` - Overlay 搜索界面（2150+ 行）：IIFE + 键盘导航 + IME + favicon 渲染
- `content.css` - Overlay 样式 + 主题 CSS vars 注入
- `popup.html/js` - 扩展 popup（状态 + 快捷操作）
- `settings.html/js` - 设置页（主题 / 同步 / 历史 / 导出 / 关于）
- `settings-theme.js` / `settings-sync.js` / `settings-history.js` / `settings-shortcuts.js` - 设置页子模块
- `theme-loader.js` / `theme-service.js` - 主题加载与持久化

**主题**
- `themes/_tokens.css` - 跨主题共享：design tokens + 原生控件重写 + scrollbar + help-tip + toast
- `themes/popup-{original,minimal,glass,dark}.css` - 4 套 popup 主题
- `themes/settings-{original,minimal,glass,dark}.css` - 4 套 settings 主题

**构建 / CI**
- `vite.config.js` - 多入口打包 + MESSAGE_ACTIONS 构建期注入插件
- `scripts/postbuild-check.mjs` - 构建后冒烟校验（ESM / 注入 / manifest）
- `.github/workflows/ci.yml` - CI：build + test + postbuild smoke + artifact

## TODO List

- [ ] fuzzy 模糊匹配（FlexSearch / Fuse）代替 indexOf 字面匹配
- [ ] `folder:work X` / `is:recent` 等 scope filter 查询语法
- [ ] popup 内嵌搜索框（目前必须用快捷键呼出）
- [ ] shortcut 设置原地可编辑，不需要跳 `chrome://extensions/shortcuts`
- [ ] 首次安装的欢迎流 / shortcut 提示 overlay
- [ ] 书签导入（目前只能导出）
- [ ] TypeScript 全量迁移（目前仅 tsconfig scaffold + JSDoc）
- [ ] 使用统计面板（搜索次数 / 命中率 / 最常搜词）

## 📝 更新日志

### v2.1.0 - Dashboard 新标签页 · 智能检索增强

**产品功能**
- 🏠 **新标签页 Dashboard**：`chrome_url_overrides` 接管新标签页。时间感知问候 + 大细体时钟 + 搜索框 + 基于访问统计的 Speed Dial 12 格 + 4 套渐变壁纸（dawn/day/sunset/night）按时间自动切换
- 🔥 **访问加权搜索**：每次打开书签记录 `{count, lastAt}`，搜索排序叠加 `count × exp(-Δt/14d)` 奖励（半衰期 10 天，上限 200 分），常用书签自然浮到前面
- 📊 **访问热度视图**：设置 → 维护，查看「TOP 20 最常访问」与「30 天未访问」，帮助梳理长期闲置
- 🔎 **搜索引擎回退**（默认关闭）：书签零命中时回车可跳转 Google / Bing / DuckDuckGo / 百度 / Kagi / Startpage / 自定义 `{q}` 模板
- ✂️ **片段上下文高亮**：长 URL / 长 title 自动缩为命中位置 ±20 字符窗口（`…关键词 命中 上下文…`），窗口之间用省略号拼接
- 🧹 **重复书签清理 + 失效链接检测**：独立 modal 展示，zigzag host 并发探测，结果缓存；HEAD→GET+Range 两阶段，只有 404/410 判死链，其它归"可疑"降低误杀
- 🧠 **拼音 + 首字母搜索**：索引已经内置 `pinyin / pinyinInitials`，输入 "zhihu" 或 "zh" 都能命中「知乎」
- 📖 **独立 select / dialog / modal 组件**：原生下拉改写为 portal 定位 combobox，删除弹窗 bsConfirm / bsAlert 替代 `window.confirm`；跨 4 主题统一
- 🔑 **快捷键风格 shortcuts**：`/` 聚焦、`Cmd/Ctrl+K` 聚焦（Dashboard）、`↑↓` 选择、`Enter` 打开、`Escape` 清空

**性能**
- ⚡ **异步分块 bigram 索引**：原同步 build 会在 50k 书签下阻塞 SW **2.5 秒**。改为每 2000 doc `setTimeout(0)` 让出；搜索时索引未就绪直接走全扫兜底（50k 下 77ms）。**首次搜索延迟 2.5s → 77ms（33×）**
- 🪫 **失效检测并发可配置**：默认 16 并发，设置页支持 4 / 8 / 16 / 24 / 32 / 48；zigzag host 调度保证单站同时最多 1 个请求

**体验修复**
- 🔕 **Extension context invalidated 静默**：扩展升级后老 content script 的报错不再刷屏，context 检测失效立即短路所有消息
- 🚫 **Mixed Content 过滤**：HTTPS 页面下跳过 `http://` 私网 favicon 请求（含 `192.168.x.x` 这类），不触发浏览器 Mixed Content warning
- 🎨 **主题变量补全**：4 个 settings 主题补上共享 token（`--card-bg` / `--surface-hover` / `--text-*`），暗色主题下 modal 不再"白底白卡片"
- 🎯 **焦点加固**：Shadow DOM 深度 activeElement / iframe 主动 blur / 全屏 exitFullscreen / 三阶段 focusEnforcer / `scheduleFocusOnWindowRegain` 窗口回焦监听
- 🧭 **自定义 select 层级提升**：menu portal 到 body + z-index 9999，不再被卡片遮挡
- 💬 **toggleSearch 150ms 节流**：避免地址栏/DevTools 聚焦时 Ctrl+Space 触发 overlay "闪一下就关"
- 🧪 **测试覆盖**：从 29 条扩到 50 条，覆盖 `handleMessage` 路由与 `PROBE_URL_REACHABILITY` 两阶段探测语义

### v2.0.0 - Overlay 重写 + 主题系统全量重设计

**产品功能**
- 🎯 `Cmd/Ctrl+1~9` 直达前 9 条结果；`/` 键重新聚焦输入框
- 🛠 `Alt+Enter` / 右键呼出 action menu：复制链接 / 在新窗口打开 / 在书签管理器中显示 / 删除（带确认）
- 🎨 查询词在 title / path / URL 中 `<mark>` 高亮
- 🧭 面包屑 path（`›` 分隔），URL 只在 hover / 选中时展开
- 💭 最近 20 条成功查询记忆，空态以 chips 形式展示并一键回填
- 📇 空态"最近打开"列表；无历史时展示快捷键 onboarding 卡片
- 📊 搜索防抖期间顶部 2 px 进度条
- 🖼️ Favicon 失败时回退到"首字母 + 域名哈希 HSL 色"Monogram，替代灰色默认圆
- 🧪 结果进场 stagger + favicon skeleton shimmer（主题感知：minimal 保持 Swiss 纪律不做动画）

**主题系统重设计**
- 🔵 **经典（Linear-light）**：干掉 `#667eea → #764ba2` AI 紫蓝渐变；page-header 改为 indigo 渐变卡片 + dot pattern signature；stat-card-primary 为 indigo hero tile；body 叠加 20 px pitch 的 indigo dot-grid
- ⚫ **极简白（Swiss Grid）**：Helvetica 字体栈 + 1.5 px 规则线 + uppercase tracking + 无圆角 + 反色选中块 + 8 px baseline rhythm
- 🌫️ **毛玻璃（Liquid-Glass）**：顶缘镜面高光 + 多层阴影 + spring 缓动 + blob 背景 + 选中 specular 光斑；换掉马卡龙 AI 配色为青绿 ↔ 珊瑚
- 🌑 **深色（夜间工作站）**：去掉 glowing + pulse + hero metric + 蓝色 radial；warm-black `#121418` + 柔和 `#82aaff`；SVG 噪点 + stats-grid 融合为一张仪表面板
- 🌓 **Auto 主题**：跟随 `prefers-color-scheme` 自动切换深浅
- 🔤 四主题专属字体栈（SF Pro Text / Helvetica Neue / SF Pro Rounded / system + mono）

**原生控件改写**
- 🎛 `<select>` 去掉 browser chrome，自绘 SVG chevron，每主题 accent 色
- ☑️ `<input type=checkbox>` 自定义方块 + 勾号 SVG（minimal 直角黑 / 其他圆角 accent）
- 📝 `<input type=text>` readonly shortcut 改用 mono 字体 + tabular 字距
- 📜 `::-webkit-scrollbar` 全主题 token 化（`--scrollbar-thumb`）

**架构 & 工程**
- 🏗 抽离 `lifecycle.js`，破解 background ↔ background-messages 的 `setEnsureInit` 循环依赖
- 💾 SW 书签事件防抖队列持久化到 IDB，alarm 1 分钟兜底唤醒，refresh 失败事件不丢重入队
- 🔌 Vite plugin 构建期注入 `MESSAGE_ACTIONS` 到 content.js，消除两份手写常量
- 🖼️ Favicon 从 DDG/Google/Faviconkit 切到 `chrome-extension://_favicon` 内置服务（无隐私泄露、断网可用）
- 📖 新增 `logger.js`：level (debug/info/observe/warn/error) + namespace + 运行时 debug 开关
- 🧪 新增 `scripts/postbuild-check.mjs`：校验 dist/background.js 仍是 ESM + MESSAGE_ACTIONS 注入成功
- 🏗 新增 `.github/workflows/ci.yml`：build + test + postbuild smoke + dist artifact
- 📋 新增 `tsconfig.json` scaffold（`checkJs: true` + `noEmit`）；用户本地 `npm i -D typescript @types/chrome` 后即可 `npm run type-check`

**UX & 可访问性**
- 📋 设置页 Inline tooltip（ⓘ）for syncInterval / bookmarkCacheTtl
- 🔔 Toast 反馈系统（主题切换 / 同步间隔变更 / 清除缓存反馈）
- ⚠️ 清除 favicon 缓存改为二次确认
- ↩️ Overlay 搜索失败支持 Enter 重试
- ♿ 完整 `prefers-reduced-motion` / `prefers-reduced-transparency` 降级
- 🐛 修复 overlay 上下键选中时首行 `.selected` class 不清除的问题（`prevSelectedIndex` 与 `selectedIndex` 同步）

**破坏性变更**
- ⚠️ manifest 新增 `web_accessible_resources = _favicon/*` 权限项（MV3 需要）
- ⚠️ 主题 `original` 和 `dark` 的调色板完全变更，之前截图/视频可能需要更新

### v1.9.0 - 存储与搜索体验强化
- 🗃️ **数据层升级**：主书签数据以 IndexedDB 文档存储为主，`chrome.storage.local` 继续承担元数据与设置存储
- 🖼️ **favicon 缓存增强**：加入持久化缓存、后台预热与手动清理能力，减少结果列表图标闪烁
- 🌏 **输入体验优化**：改进 IME 输入法组合输入场景，避免输入确认时误打开书签
- 📤 **导出行为调整**：历史记录导出按选中的历史项生成结果，不再以 URL 去重
- ⚙️ **同步设置增强**：新增主缓存过期时间配置，配合后台过期刷新策略提升数据新鲜度

### v1.8.0 - 品牌升级与快捷键调整
- 🆕 **扩展名称升级**：更名为“书签搜索 - 极速收藏夹管理与查找工具”，英文名同步更新
- ⌨️ **Mac 默认快捷键**：改为 `Command+Space`，与 Windows/Linux 的 `Ctrl+Space` 一起作为默认组合
- 🧭 **文档与界面**：同步更新显示标题、占位提示与版本信息

### v1.7.0 - 同步机制重构与稳定性升级
- 🐛 **修复竞态条件**：解决浏览器启动时，因后台脚本初始化延迟导致的误判“全量新增”书签的问题
- 🐛 **修复路径计算**：修复移动书签时路径计算错误（重复包含自身标题）的问题
- ⚡ **机制优化**：引入初始化锁机制，确保所有同步操作必须等待本地缓存加载完毕后执行

### v1.6.1 - 代码混淆与构建优化
- 🎨 **主题重构**：
  - **极简白**：升级为 "Modern Clean" 风格，采用 Vercel 式的空气感设计
  - **毛玻璃**：升级为 "Premium Frost" 风格，引入动态网格渐变和高级磨砂质感
  - **深色**：升级为 "Midnight Pro" 风格，参考 Linear 的深邃色调与霓虹点缀
- ⚡ **性能与安全**：
  - 移除内联脚本，完全符合 CSP V3 安全规范
  - 优化主题切换机制，彻底解决样式残留
  - **代码保护**：引入构建混淆流程，发布版本更安全
- 🖱️ **交互优化**：
  - 全套主题适配的滚动条美化，按钮增加微交互动画
  - **首次安装引导**：安装扩展后自动打开设置页面，方便用户快速配置
- 🐛 **问题修复**：修复深色模式下字体颜色更新延迟问题

### v1.4 - 智能对比同步与书签导出
- ✅ 智能对比同步：每次同步时对比新旧书签数据，检测并记录所有差异
- ✅ 完整路径追踪：修复路径记录问题，现在显示包含当前文件夹的完整路径
- ✅ 文件夹级联删除：删除文件夹时自动识别并记录所有子书签的删除历史
- ✅ 书签导出功能：
  - 支持进入选择模式多选历史记录
  - 默认全选，支持全选/取消全选
  - 同一URL自动去重，保留最新记录
  - 导出为Netscape Bookmark格式，兼容Chrome/Edge/Firefox
- ✅ 远程同步支持：扩展未运行时的远程书签变更，下次同步时能完整记录

### v1.3 - 定时同步与位置追踪
- ✅ 定时轮询功能：支持5分钟～24小时自定义同步间隔
- ✅ 书签位置追踪：记录每个书签的完整文件夹路径
- ✅ 详细历史记录显示：
  - 新增操作显示目的位置
  - 删除操作显示源位置
  - 修改操作显示当前位置
  - 移动操作同时显示源位置和目的位置
- ✅ 同步时间显示：Popup页面显示最后同步和下次同步时间
- ✅ 同步间隔可配置：在设置页面实时调整并生效
- ✅ 添加alarms权限支持定时任务

### v1.2 - 移动操作支持
- ✅ 支持书签移动操作监听
- ✅ 历史记录显示目标文件夹
- ✅ 新增移动操作标签样式

### v1.1 - 实时更新优化
- ✅ 设置页面自动更新功能
- ✅ 视觉反馈通知机制
- ✅ 修复编辑书签历史记录问题
- ✅ 使用完整书签信息

### v1.0 - 初始版本
- ✅ 基础书签搜索功能
- ✅ 完整键盘导航支持
- ✅ 现代化UI设计
- ✅ 响应式布局
- ✅ 动态脚本注入
- ✅ 特殊页面提示
- ✅ 实时书签监听
- ✅ 书签历史记录
