# 书签更新机制说明

## 📋 概述

本文档详细说明书签搜索扩展在什么情况下会获取、更新和同步书签数据。

---

## 🔄 书签更新时机

### 1. **扩展首次加载/安装**

**触发时机**：浏览器启动或扩展安装时
**执行逻辑**：

```javascript
// background.js 加载时
chrome.storage.local.get(["bookmarks"], (result) => {
  if (result.bookmarks && result.bookmarks.length > 0) {
    // 如果有缓存数据，直接使用
    bookmarks = result.bookmarks;
  } else {
    // 没有缓存，从浏览器获取所有书签
    chrome.bookmarks.getTree((bookmarkTreeNodes) => {
      processBookmarks(bookmarkTreeNodes);
      chrome.storage.local.set({ bookmarks: bookmarks });
    });
  }
});
```

**行为**：

- ✅ 检查 `chrome.storage.local` 是否有缓存的书签数据
- ✅ 如有缓存 → 直接使用（快速启动）
- ✅ 如无缓存 → 从浏览器获取完整书签树并缓存

---

### 2. **实时监听书签变化**

**触发时机**：用户添加、删除或编辑书签时
**监听器**：

```javascript
// 监听新增书签
chrome.bookmarks.onCreated.addListener((id, bookmark) => {
  updateBookmarks("add", id, bookmark);
  addBookmarkHistory("add", bookmark); // 记录历史
});

// 监听删除书签
chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  updateBookmarks("delete", id, removeInfo);
  addBookmarkHistory("delete", deletedBookmark); // 记录历史
});

// 监听编辑书签
chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  // changeInfo 只包含变化的字段（title 或 url），不包含完整信息
  // 需要调用 chrome.bookmarks.get() 获取完整书签
  chrome.bookmarks.get(id, (results) => {
    const fullBookmark = results[0];
    updateBookmarks("edit", id, changeInfo, fullBookmark);
    addBookmarkHistory("edit", fullBookmark); // 使用完整信息记录历史
  });
});

// 监听书签移动
chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
  chrome.bookmarks.get(id, (results) => {
    const fullBookmark = results[0];
    // 获取目标文件夹名称
    chrome.bookmarks.get(moveInfo.parentId, (parentResults) => {
      const folderName = parentResults[0]?.title || "未知文件夹";
      addBookmarkHistory("move", { ...fullBookmark, folder: folderName });
    });
  });
});
```

**行为**：

- ✅ **实时同步**：书签变化时立即更新内存和存储
- ✅ **增量更新**：只更新变化的书签，不重新获取全部
- ✅ **历史记录**：每次变化都会记录到 `bookmarkHistory`
- ✅ **自动保存**：更新后自动保存到 `chrome.storage.local`

---

### 3. **手动刷新书签**

**触发时机**：用户在 Popup 或设置页面点击"刷新书签"按钮
**执行流程**：

```javascript
// 用户点击刷新按钮
chrome.runtime.sendMessage({ action: "refreshBookmarks" });

// background.js 处理刷新请求
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "refreshBookmarks") {
    // 重新获取所有书签
    chrome.bookmarks.getTree((bookmarkTreeNodes) => {
      bookmarks = []; // 清空现有数据
      processBookmarks(bookmarkTreeNodes); // 重新处理
      chrome.storage.local.set({ bookmarks: bookmarks }); // 保存
      sendResponse({ success: true, count: bookmarks.length });
    });
  }
});
```

**行为**：

- ✅ **完整刷新**：清空缓存，重新获取所有书签
- ✅ **同步响应**：向调用者返回书签数量
- ✅ **适用场景**：
  - 怀疑数据不一致时
  - 从其他设备同步书签后
  - 批量导入书签后

---

### 4. **设置页面实时更新 ⭐ 新功能**

**触发时机**：`chrome.storage.local` 数据变化时
**实现方式**：

```javascript
// settings.js 中的存储监听器
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  // 书签数据变化 → 更新统计
  if (changes.bookmarks) {
    loadBookmarkStats(); // 重新加载书签数量
  }

  // 书签历史变化 → 更新历史列表
  if (changes.bookmarkHistory) {
    loadUpdateHistory(); // 重新加载历史记录
    showUpdateNotification(); // 显示"已自动更新"提示
  }
});
```

**行为**：

- ✅ **自动更新**：检测到存储变化时自动刷新界面
- ✅ **无需手动刷新**：打开设置页面后，书签变化会实时显示
- ✅ **视觉反馈**：显示绿色通知"书签历史已自动更新"（3 秒后消失）

---

## 📊 数据流向图

```
用户操作
   ↓
浏览器书签 API (chrome.bookmarks)
   ↓
Background.js 监听器
   ↓
内存数组 (bookmarks[])
   ↓
chrome.storage.local (持久化)
   ↓
chrome.storage.onChanged 事件
   ↓
设置页面自动更新 (settings.js)
   ↓
UI 实时刷新
```

---

## 🔍 书签获取方式对比

| 方式         | 触发时机           | 数据来源                     | 更新范围 | 性能       |
| ------------ | ------------------ | ---------------------------- | -------- | ---------- |
| **首次加载** | 扩展启动           | `chrome.bookmarks.getTree()` | 全部书签 | 慢（首次） |
| **实时监听** | 书签变化           | 监听器事件                   | 单个书签 | 快 ⚡      |
| **手动刷新** | 点击按钮           | `chrome.bookmarks.getTree()` | 全部书签 | 慢         |
| **缓存读取** | Content/Popup 加载 | `chrome.storage.local`       | 全部书签 | 超快 🚀    |

## 🎯 支持的书签操作

| 操作     | 监听器      | 历史标签 | 记录内容           |
| -------- | ----------- | -------- | ------------------ |
| **新增** | `onCreated` | 🟢 新增  | title, url         |
| **删除** | `onRemoved` | 🔴 删除  | title, url (缓存)  |
| **编辑** | `onChanged` | 🔵 编辑  | title, url (完整)  |
| **移动** | `onMoved`   | 🟡 移动  | title, url, folder |

---

## 💾 存储数据结构

### bookmarks 数组

```json
[
  {
    "id": "123",
    "title": "Google",
    "url": "https://www.google.com"
  },
  {
    "id": "456",
    "title": "GitHub",
    "url": "https://github.com"
  }
]
```

### bookmarkHistory 数组

```json
[
  {
    "action": "add",
    "title": "New Bookmark",
    "url": "https://example.com",
    "timestamp": 1710000000000
  },
  {
    "action": "delete",
    "title": "Old Bookmark",
    "url": "https://old.com",
    "timestamp": 1710000060000
  },
  {
    "action": "edit",
    "title": "Updated Title",
    "url": "https://example.com",
    "timestamp": 1710000120000
  },
  {
    "action": "move",
    "title": "Moved Bookmark",
    "url": "https://example.com",
    "folder": "工作",
    "timestamp": 1710000180000
  }
]
```

**历史记录限制**：最多保留 100 条记录（自动清理旧记录）

---

## ⚙️ 设置页面实时更新示例

### 场景 1：用户添加新书签

```
1. 用户在浏览器中添加书签
2. background.js 监听到 onCreated 事件
3. 更新内存 bookmarks 数组
4. 保存到 chrome.storage.local
5. 添加历史记录到 bookmarkHistory
6. chrome.storage.onChanged 触发
7. settings.js 监听器检测到变化
8. 自动调用 loadBookmarkStats() 更新数量
9. 自动调用 loadUpdateHistory() 更新列表
10. 显示绿色通知："书签历史已自动更新"
```

### 场景 2：用户点击刷新按钮

```
1. 用户在设置页面点击"同步书签"
2. 发送 refreshBookmarks 消息到 background.js
3. background.js 清空并重新获取所有书签
4. 保存到 chrome.storage.local
5. chrome.storage.onChanged 触发
6. settings.js 自动更新书签统计
7. 按钮显示"✓ 同步成功"
```

---

## 🎯 最佳实践

### 何时使用手动刷新？

- ✅ 从其他设备同步书签后
- ✅ 批量导入/导出书签后
- ✅ 怀疑数据不一致时
- ❌ 正常添加/删除书签时（自动同步）

### 如何确认数据已更新？

1. **Popup 页面**：查看"书签总数"是否变化
2. **设置页面**：
   - 查看"书签总数"是否变化
   - 查看"书签更新历史"是否有新记录
   - 看到绿色通知"书签历史已自动更新"

### 性能优化

- ✅ 使用缓存（`chrome.storage.local`）减少 API 调用
- ✅ 增量更新而非全量刷新
- ✅ 设置页面实时更新，无需轮询

---

## 🐛 故障排查

### 问题：设置页面不显示最新书签

**原因**：旧版本需要手动刷新页面
**解决**：更新到最新版本（已添加自动更新功能）

### 问题：书签数量不准确

**解决**：点击"同步书签"按钮手动刷新

### 问题：历史记录不显示

**检查**：

1. 打开浏览器控制台（F12）
2. 查看是否有错误日志
3. 检查 `chrome.storage.local` 是否有数据：
   ```javascript
   chrome.storage.local.get(["bookmarkHistory"], console.log);
   ```

---

## 📝 开发日志

### v1.0 - 初始版本

- ✅ 扩展加载时获取书签
- ✅ 实时监听书签变化
- ✅ 手动刷新功能
- ✅ 书签历史记录

### v1.1 - 实时更新优化

- ✅ 设置页面添加 `chrome.storage.onChanged` 监听
- ✅ 自动更新书签统计和历史列表
- ✅ 添加视觉反馈通知
- ✅ 无需手动刷新页面
- ✅ 修复编辑书签时历史记录不完整的问题
- ✅ 使用 `chrome.bookmarks.get()` 获取完整书签信息

### v1.2 - 移动操作支持

- ✅ 添加 `chrome.bookmarks.onMoved` 监听器
- ✅ 记录书签移动到不同文件夹的操作
- ✅ 历史记录显示目标文件夹名称
- ✅ 新增黄色"移动"标签样式

---

## 🔗 相关文件

- `background.js` - 书签获取和监听逻辑
- `settings.js` - 设置页面和实时更新
- `popup.js` - Popup 页面和刷新功能
- `content.js` - 内容脚本（从存储加载书签）

---

**最后更新**：2025-10-08
**版本**：v1.2
