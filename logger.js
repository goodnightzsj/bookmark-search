/**
 * 统一 logger：
 * - 支持 level（debug/info/warn/error/observe）
 * - 按 namespace 打 tag，便于 grep / 后期接入结构化日志/埋点
 * - 默认屏蔽 debug，通过 chrome.storage.local.bsDebugLog = true 打开
 */

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  observe: 25,
  warn: 30,
  error: 40
});

let runtimeDebugEnabled = false;
let subscribed = false;

function applyDebugFlag(value) {
  runtimeDebugEnabled = value === true;
}

function ensureSubscription() {
  if (subscribed) return;
  subscribed = true;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get('bsDebugLog', (result) => {
        applyDebugFlag(result && result.bsDebugLog);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes && changes.bsDebugLog) {
          applyDebugFlag(changes.bsDebugLog.newValue);
        }
      });
    }
  } catch (e) {
    // non-extension environment (test runner)
  }
}

function shouldEmit(level) {
  if (level >= LEVELS.warn) return true;
  if (level >= LEVELS.observe) return true;
  if (level >= LEVELS.info) return true;
  // debug only when runtime flag enabled
  return runtimeDebugEnabled;
}

function formatArgs(ns, label, args) {
  const prefix = label ? ('[' + ns + '][' + label + ']') : ('[' + ns + ']');
  if (args.length === 0) return [prefix];
  const [first, ...rest] = args;
  if (typeof first === 'string') {
    return [prefix + ' ' + first, ...rest];
  }
  return [prefix, ...args];
}

export function createLogger(namespace) {
  ensureSubscription();
  const ns = String(namespace || 'app');
  return {
    debug(...args) {
      if (!shouldEmit(LEVELS.debug)) return;
      try { console.debug.apply(console, formatArgs(ns, null, args)); } catch (e) {}
    },
    info(...args) {
      if (!shouldEmit(LEVELS.info)) return;
      try { console.log.apply(console, formatArgs(ns, null, args)); } catch (e) {}
    },
    observe(event, payload) {
      if (!shouldEmit(LEVELS.observe)) return;
      const args = payload === undefined ? [event] : [event, payload];
      try { console.log.apply(console, formatArgs(ns, 'Observe', args)); } catch (e) {}
    },
    warn(...args) {
      try { console.warn.apply(console, formatArgs(ns, null, args)); } catch (e) {}
    },
    error(...args) {
      try { console.error.apply(console, formatArgs(ns, null, args)); } catch (e) {}
    }
  };
}
