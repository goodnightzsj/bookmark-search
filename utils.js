/**
 * 书签搜索扩展 - 共享工具函数
 * 提取自 popup.js 和 settings.js 中的重复代码
 */

/**
 * 格式化相对时间（过去时间）
 * @param {number} timestamp - 时间戳
 * @param {Object} options - 可选配置
 * @param {boolean} options.showFullDate - 超过阈值后是否显示完整日期时间（默认 true）
 * @returns {string} 格式化后的相对时间字符串
 */
export function formatRelativeTime(timestamp, options = {}) {
  const { showFullDate = true } = options;
  
  if (!timestamp) return '从未';
  
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  
  if (!showFullDate) return `${days}天前`;
  
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * 格式化未来时间
 * @param {number} timestamp - 时间戳
 * @returns {string} 格式化后的未来时间字符串
 */
export function formatFutureTime(timestamp) {
  if (!timestamp) return '未知';
  
  const now = Date.now();
  const diff = timestamp - now;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (diff < 0) return '即将';
  if (minutes < 1) return '1分钟内';
  if (minutes < 60) return `${minutes}分钟后`;
  if (hours < 24) return `${hours}小时后`;
  
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN');
}

/**
 * HTML 转义（增强版，处理 null/undefined）
 * @param {*} text - 需要转义的文本
 * @returns {string} 转义后的安全字符串
 */
const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;'
};
const HTML_ESCAPE_REGEX = /[&<>"']/g;

export function escapeHtml(text) {
  if (text == null) return '';
  return String(text).replace(HTML_ESCAPE_REGEX, char => HTML_ESCAPE_MAP[char]);
}

/**
 * 格式化时间（历史记录显示用，向后兼容别名）
 * @deprecated 请使用 formatRelativeTime
 */
export const formatTime = formatRelativeTime;

// 特殊页面协议列表
export const SPECIAL_PROTOCOLS = ['chrome://', 'edge://', 'about:', 'chrome-extension://', 'edge-extension://'];

/**
 * 提取根域名（用于 favicon 缓存键）
 * @param {string} domain - 域名
 * @returns {string} 根域名
 */
export function getRootDomain(domain) {
  const safe = typeof domain === 'string' ? domain.trim() : '';
  if (!safe) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(safe)) {
    const octets = safe.split('.');
    if (octets.every(o => { const n = Number(o); return n >= 0 && n <= 255; })) return safe;
  }
  if (safe === 'localhost') return safe;
  if (safe.indexOf('.') === -1) return safe;

  const parts = safe.split('.');
  if (parts.length <= 2) return safe;
  return parts.slice(-2).join('.');
}

/**
 * 从 URL 提取主机名
 * @param {string} url - URL
 * @returns {string} 主机名
 */
export function getHostnameFromUrl(url) {
  const safe = typeof url === 'string' ? url.trim() : '';
  if (!safe) return '';
  try {
    const u = new URL(safe);
    return u && u.hostname ? u.hostname : '';
  } catch (error) {
    return '';
  }
}
