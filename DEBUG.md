# 调试指南

## 🐛 测试书签编辑功能

### 测试步骤

#### 1. 刷新扩展
1. 打开 `chrome://extensions/` 或 `edge://extensions/`
2. 找到"书签搜索"扩展
3. 点击刷新按钮 🔄

#### 2. 打开调试控制台
1. 点击扩展详情页的"background page"或"service worker"链接
2. 或者右键扩展图标 → "检查"
3. 打开 Console 标签页

#### 3. 打开设置页面
1. 点击扩展图标
2. 点击"设置与管理"按钮
3. 或者右键扩展图标 → "选项"

#### 4. 测试新增书签
**操作**：
1. 在浏览器中添加一个新书签（Ctrl+D）
2. 书签名称：`Test Add - [时间戳]`
3. 保存

**预期结果**：
- Background 控制台输出：
  ```
  [Background] 新增书签：123 {title: "Test Add - xxx", url: "..."}
  [Background] 书签历史记录已添加: add - Test Add - xxx
  [Background] 更新后的书签数据已存储，当前数量: 42
  ```
- 设置页面自动刷新
- 显示绿色通知："书签历史已自动更新"
- 书签总数增加 1
- 历史记录列表顶部出现新记录（绿色"新增"标签）

#### 5. 测试删除书签
**操作**：
1. 在书签管理器中删除刚才添加的书签
2. 或右键书签 → 删除

**预期结果**：
- Background 控制台输出：
  ```
  [Background] 删除书签：123 {...}
  [Background] 删除书签已从数组移除
  [Background] 书签历史记录已添加: delete - Test Add - xxx
  [Background] 更新后的书签数据已存储，当前数量: 41
  ```
- 设置页面自动刷新
- 显示绿色通知
- 书签总数减少 1
- 历史记录列表出现新记录（红色"删除"标签）

#### 6. 测试编辑书签 ⭐ 关键测试
**操作**：
1. 在书签管理器中选择一个书签
2. 右键 → 编辑
3. 修改书签名称：`Test Edit - [新名称]`
4. 保存

**预期结果**：
- Background 控制台输出：
  ```
  [Background] 修改书签：123 {title: "Test Edit - 新名称"}
  [Background] 获取完整书签信息: {id: "123", title: "Test Edit - 新名称", url: "..."}
  [Background] 编辑书签已更新: {id: "123", title: "Test Edit - 新名称", url: "..."}
  [Background] 书签历史记录已添加: edit - Test Edit - 新名称
  [Background] 更新后的书签数据已存储，当前数量: 41
  ```
- 设置页面自动刷新
- 显示绿色通知
- 历史记录列表出现新记录（蓝色"编辑"标签）
- **记录包含完整的 title 和 url**

#### 7. 测试编辑 URL
**操作**：
1. 在书签管理器中选择一个书签
2. 右键 → 编辑
3. 修改 URL：`https://example.com/new-path`
4. 保存

**预期结果**：
- 类似步骤 6，但 changeInfo 是 `{url: "https://example.com/new-path"}`
- 历史记录显示更新后的完整信息

#### 8. 测试移动书签 ⭐ 新功能
**操作**：
1. 在书签管理器中选择一个书签
2. 拖拽到其他文件夹
3. 或者右键 → 剪切，然后在目标文件夹粘贴

**预期结果**：
- Background 控制台输出：
  ```
  [Background] 移动书签：123 {parentId: "456", index: 0, ...}
  [Background] 获取移动的书签信息: {id: "123", title: "...", url: "..."}
  [Background] 移动到文件夹: "工作"
  [Background] 书签历史记录已添加: move - [标题]
  ```
- 设置页面自动刷新
- 显示绿色通知
- 历史记录列表出现新记录（黄色"移动"标签）
- **记录显示目标文件夹名称：📁 工作**

---

## 📊 日志说明

### Background.js 日志前缀
- `[Background]` - background.js 的所有日志
- 关键日志：
  - `新增书签` - onCreated 触发
  - `删除书签` - onRemoved 触发
  - `修改书签` - onChanged 触发
  - `获取完整书签信息` - chrome.bookmarks.get() 成功
  - `书签历史记录已添加` - 历史记录写入成功

### Settings.js 日志前缀
- `[Settings]` - settings.js 的所有日志
- 关键日志：
  - `存储发生变化` - chrome.storage.onChanged 触发
  - `检测到书签数据变化` - bookmarks 数组更新
  - `检测到书签历史变化` - bookmarkHistory 更新

### Content.js 日志前缀
- `[Content]` - content.js 的所有日志

---

## 🔍 常见问题排查

### 问题 1：编辑书签后设置页面没有更新
**检查步骤**：
1. 打开 background console，确认是否有 `修改书签` 日志
2. 确认是否有 `获取完整书签信息` 日志
3. 确认是否有 `书签历史记录已添加: edit` 日志
4. 打开设置页面 console，确认是否有 `检测到书签历史变化` 日志

**可能原因**：
- background.js 没有正确监听 onChanged
- chrome.bookmarks.get() 调用失败
- 设置页面的存储监听器未设置

### 问题 2：历史记录中的编辑条目缺少信息
**检查步骤**：
1. 查看 background console 的 `获取完整书签信息` 日志
2. 检查日志中的 fullBookmark 对象是否包含 title 和 url

**解决方法**：
- 确保已更新到最新版本的 background.js
- 使用 `chrome.bookmarks.get()` 获取完整信息

### 问题 3：绿色通知不显示
**检查步骤**：
1. 确认设置页面已打开
2. 查看设置页面 console 是否有 `showUpdateNotification` 相关错误
3. 检查 CSS 是否正确加载

**解决方法**：
- 刷新设置页面
- 清除浏览器缓存

---

## 🧪 手动测试 Chrome Storage

### 查看当前存储的书签
```javascript
chrome.storage.local.get(['bookmarks'], (result) => {
  console.log('书签数量:', result.bookmarks?.length);
  console.log('前3个书签:', result.bookmarks?.slice(0, 3));
});
```

### 查看书签历史
```javascript
chrome.storage.local.get(['bookmarkHistory'], (result) => {
  console.log('历史记录数量:', result.bookmarkHistory?.length);
  console.log('最近5条:', result.bookmarkHistory?.slice(-5));
});
```

### 清空历史记录
```javascript
chrome.storage.local.set({ bookmarkHistory: [] }, () => {
  console.log('历史记录已清空');
});
```

### 监听存储变化
```javascript
chrome.storage.onChanged.addListener((changes, areaName) => {
  console.log('存储变化:', areaName, Object.keys(changes));
  if (changes.bookmarkHistory) {
    console.log('新值长度:', changes.bookmarkHistory.newValue?.length);
    console.log('旧值长度:', changes.bookmarkHistory.oldValue?.length);
  }
});
```

---

## 📝 验证清单

完成以下所有测试，确保功能正常：

- [ ] 扩展已刷新
- [ ] Background console 已打开
- [ ] 设置页面已打开
- [ ] 设置页面 console 已打开
- [ ] 新增书签 → 设置页面自动更新 ✅
- [ ] 删除书签 → 设置页面自动更新 ✅
- [ ] 编辑书签标题 → 设置页面自动更新 ✅
- [ ] 编辑书签 URL → 设置页面自动更新 ✅
- [ ] 移动书签到其他文件夹 → 设置页面自动更新 ✅
- [ ] 历史记录显示完整的 title 和 url ✅
- [ ] 移动记录显示目标文件夹名称 ✅
- [ ] 绿色通知正常显示并消失 ✅
- [ ] Background 日志正常输出 ✅
- [ ] Settings 日志正常输出 ✅

---

## 🎯 完整测试流程示例

### 场景：修改书签标题

1. **准备**：
   ```
   ✓ 刷新扩展
   ✓ 打开 background console
   ✓ 打开设置页面（保持打开状态）
   ✓ 打开设置页面 console (F12)
   ```

2. **执行操作**：
   ```
   在书签管理器中：
   → 找到书签 "GitHub"
   → 右键 → 编辑
   → 修改为 "GitHub - The World's Leading Dev Platform"
   → 点击保存
   ```

3. **预期 Background Console 输出**：
   ```javascript
   [Background] 修改书签：123 {title: "GitHub - The World's Leading Dev Platform"}
   [Background] 获取完整书签信息: {
     id: "123",
     title: "GitHub - The World's Leading Dev Platform",
     url: "https://github.com",
     dateAdded: 1234567890000,
     ...
   }
   [Background] 编辑书签已更新: {
     id: "123",
     title: "GitHub - The World's Leading Dev Platform",
     url: "https://github.com"
   }
   [Background] 书签历史记录已添加: edit - GitHub - The World's Leading Dev Platform
   [Background] 更新后的书签数据已存储，当前数量: 42
   ```

4. **预期 Settings Console 输出**：
   ```javascript
   [Settings] 存储发生变化: ["bookmarks", "bookmarkHistory"]
   [Settings] 检测到书签数据变化，重新加载统计
   [Settings] 检测到书签历史变化，重新加载历史
   ```

5. **预期 UI 变化**：
   ```
   ✓ 设置页面不需要刷新
   ✓ 历史记录列表顶部出现新条目
   ✓ 新条目显示蓝色"编辑"标签
   ✓ 新条目显示完整的 title 和 url
   ✓ 显示绿色通知："书签历史已自动更新"
   ✓ 3秒后通知自动消失
   ```

---

## 🚀 快速验证命令

在 background console 中执行：

```javascript
// 触发一次测试编辑（模拟）
const testId = "1"; // 替换为实际书签ID
chrome.bookmarks.get(testId, (results) => {
  if (results && results.length > 0) {
    const bookmark = results[0];
    console.log("测试书签:", bookmark);
    
    // 触发 onChanged 事件（通过真实编辑）
    chrome.bookmarks.update(testId, {
      title: bookmark.title + " (Test Edit)"
    }, () => {
      console.log("测试编辑完成");
    });
  }
});
```

---

**最后更新**：2024-01-01
**版本**：v1.1
