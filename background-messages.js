import { refreshBookmarks } from './background-data.js';
import { setupAutoSync } from './background-sync.js';

/**
 * 处理扩展消息
 */
export function handleMessage(request, sender, sendResponse) {
  console.log("[Background] 收到消息:", request.action);
  
  switch (request.action) {
    case 'refreshBookmarks':
      refreshBookmarks()
        .then(sendResponse)
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          sendResponse({ success: false, error: message });
        });
      return true; // 保持通道开启以进行异步响应
      
    case 'updateSyncInterval': {
      const interval = request.interval;
      setupAutoSync(interval)
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          sendResponse({ success: false, error: message });
        });
      return true;
    }
      
    case 'getStats':
      // 可以在这里返回统计信息
      sendResponse({ success: true });
      return false;

    case 'searchBookmarks': {
      const query = String(request.query || '').trim();
      if (!query) {
        sendResponse({ success: true, results: [] });
        return false;
      }

      chrome.bookmarks.search(query)
        .then((nodes) => {
          const results = (nodes || [])
            .filter(node => node && node.url)
            .slice(0, 10)
            .map(node => ({
              title: node.title || '',
              url: node.url || ''
            }));
          sendResponse({ success: true, results });
        })
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          sendResponse({ success: false, error: message });
        });
      return true;
    }
      
    default:
      console.warn("[Background] 未知的消息动作:", request.action);
      sendResponse({ success: false, error: 'Unknown action' });
      return false;
  }
}
