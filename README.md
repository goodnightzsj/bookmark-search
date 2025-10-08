# 书签搜索 (Bookmark Search)

一个现代化的浏览器书签搜索扩展，支持快捷键快速搜索和打开书签。

## ✨ 功能特性

- 🔍 **快速搜索**：实时搜索书签标题和URL
- ⌨️ **键盘导航**：完整的键盘操作支持
- 🎨 **现代UI**：精美的渐变设计和流畅动画
- 📱 **响应式设计**：自适应各种屏幕尺寸
- ⚡ **性能优化**：防抖搜索，智能缓存

## 🚀 使用方法

### 安装
1. 打开 Chrome/Edge 浏览器
2. 进入扩展管理页面：
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
3. 开启"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择本项目文件夹

### 使用
- **快捷键唤起**：
  - 理想快捷键：`Ctrl+Space` (Windows/Linux) 或 `Command+Space` (Mac)
  - 由于浏览器限制，推荐使用：**`Ctrl+Shift+F`** (Windows/Linux) 或 **`Command+Shift+F`** (Mac)
  - 可在 `chrome://extensions/shortcuts` 自定义快捷键
- **点击图标**：点击扩展图标查看状态和管理
- **搜索**：输入关键词搜索书签
- **选择**：使用 `↑` `↓` 方向键或鼠标选择
- **打开书签**：
  - `Enter` 或点击 → 在新标签页打开
  - `Ctrl+Enter` 或 `Ctrl+点击` → 在当前页打开
- **关闭**：按 `Esc` 或点击遮罩层

## ⚠️ 使用限制

### 特殊页面限制
由于浏览器安全策略，扩展**无法**在以下页面中使用：
- Chrome 系统页面：`chrome://` 开头的页面（如 `chrome://extensions/`）
- Edge 系统页面：`edge://` 开头的页面（如 `edge://settings/`）
- 其他特殊页面：`about:`、`chrome-extension://` 等

**解决方法**：在这些页面使用快捷键时会弹出提示，请切换到普通网页（如 Google、GitHub 等）使用。

### 为什么有这个限制？
这是 Chrome/Edge 浏览器的安全设计，防止恶意扩展在系统页面中注入代码。所有扩展都受此限制。

## ⌨️ 快捷键说明

### 理想快捷键
我们希望使用最方便的快捷键：
- **Windows/Linux**: `Ctrl+Space`（与输入法切换键相同，易记）
- **Mac**: `Command+Space`（类似 Spotlight，直觉）

### 为什么实际不能使用 Ctrl+Space？
由于浏览器和系统限制：
1. **浏览器限制**：Chrome/Edge 不允许扩展使用 `Space`、`Enter`、`Tab` 等功能键作为快捷键
2. **系统占用**：`Ctrl+Space` 通常是系统输入法切换快捷键
3. **安全设计**：浏览器保留了部分快捷键组合给内置功能

### 推荐替代方案 ⭐
您需要在 `chrome://extensions/shortcuts` 设置页面手动配置：

| 快捷键 | 平台 | 说明 |
|--------|------|------|
| **`Ctrl+Shift+F`** | Windows/Linux | **强烈推荐**（F = Find） |
| **`Command+Shift+F`** | Mac | **强烈推荐**（F = Find） |
| `Ctrl+Shift+B` | Windows/Linux | B = Bookmark |
| `Command+Shift+B` | Mac | B = Bookmark |
| `Alt+S` | Windows/Linux | 更简洁（S = Search） |
| `Alt+B` | Windows/Linux | 更简洁（B = Bookmark） |

## 🎯 首次使用

第一次在新标签页使用快捷键时，扩展会自动注入必要的脚本（约需150ms），之后使用将即时响应。

## 🛠️ 技术栈

- Manifest V3
- Vanilla JavaScript
- CSS3 (Animations, Gradients, Clamp)
- Chrome Extension APIs

## 📝 更新日志

### v1.0
- ✅ 基础书签搜索功能
- ✅ 完整键盘导航支持
- ✅ 现代化UI设计
- ✅ 响应式布局
- ✅ 动态脚本注入
- ✅ 特殊页面提示
