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
const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'ne.jp',
  'co.kr',
  'com.br', 'com.mx', 'com.tr'
]);

export function isIpAddress(host) {
  const safe = typeof host === 'string' ? host.trim() : '';
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(safe)) return false;
  const parts = safe.split('.');
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n) || n < 0 || n > 255) return false;
  }
  return true;
}

export function getHostForPrivateCheck(value) {
  const safe = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!safe) return '';
  try {
    if (safe.indexOf('://') !== -1) return new URL(safe).hostname.toLowerCase();
  } catch (e) {}
  if (safe[0] === '[') {
    const end = safe.indexOf(']');
    return end >= 0 ? safe.slice(1, end) : safe;
  }
  const colon = safe.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(safe.slice(colon + 1)) && safe.indexOf(':') === colon) {
    return safe.slice(0, colon);
  }
  return safe;
}

export function isLikelyPrivateHost(host) {
  const safe = getHostForPrivateCheck(host);
  if (!safe) return false;
  if (safe === 'localhost') return true;
  if (isIpAddress(safe)) return true;
  if (safe.endsWith('.local')) return true;
  if (safe.endsWith('.lan')) return true;
  if (safe.endsWith('.internal')) return true;
  if (safe.endsWith('.intranet')) return true;
  if (safe.endsWith('.corp')) return true;
  if (safe.endsWith('.home')) return true;
  if (safe.endsWith('.localdomain')) return true;
  if (safe.indexOf('.') === -1) return true;
  return false;
}

export function normalizeFaviconHost(host) {
  const safe = typeof host === 'string' ? host.trim().toLowerCase() : '';
  if (!safe) return '';
  const withoutWww = safe.startsWith('www.') ? safe.slice(4) : safe;
  return getRootDomain(withoutWww) || withoutWww;
}

export function buildFaviconServiceKey(pageUrl) {
  const safe = typeof pageUrl === 'string' ? pageUrl.trim() : '';
  if (!safe) return '';
  try {
    const url = new URL(safe);
    const host = (url.host || '').trim().toLowerCase();
    const hostname = (url.hostname || '').trim().toLowerCase();
    if (host && isLikelyPrivateHost(hostname || host)) return host;
    return normalizeFaviconHost(hostname);
  } catch (e) {
    return '';
  }
}

export function getRootDomain(domain) {
  const safe = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
  if (!safe) return '';
  if (isIpAddress(safe)) return safe;
  if (safe === 'localhost') return safe;
  if (safe.indexOf('.') === -1) return safe;

  const parts = safe.split('.').filter(Boolean);
  if (parts.length <= 2) return safe;

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }

  return lastTwo;
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
