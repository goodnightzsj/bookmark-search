import test from 'node:test';
import assert from 'node:assert/strict';

import { handleMessage } from '../background-messages.js';
import { MESSAGE_ACTIONS, MESSAGE_ERROR_CODES } from '../constants.js';

// 全部测试都 capture sendResponse 后断言返回体形状，不触及真正的 ensureInit 异步链。
// 对于需要异步 action 的 case，我们验证「响应封包契约」而非下游 side effect。

function makeCapture() {
  const captured = { called: 0, response: null };
  return {
    sendResponse(resp) {
      captured.called += 1;
      captured.response = resp;
    },
    captured
  };
}

// ------------------------------------------------------------------------
// 入参校验（不需要 ensureInit / chrome.*）
// ------------------------------------------------------------------------

test('handleMessage: 非对象请求 → INVALID_REQUEST', () => {
  const c1 = makeCapture();
  handleMessage(null, {}, c1.sendResponse);
  assert.equal(c1.captured.called, 1);
  assert.equal(c1.captured.response.success, false);
  assert.equal(c1.captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_REQUEST);

  const c2 = makeCapture();
  handleMessage('not an object', {}, c2.sendResponse);
  assert.equal(c2.captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_REQUEST);

  const c3 = makeCapture();
  handleMessage([], {}, c3.sendResponse);
  assert.equal(c3.captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_REQUEST);
});

test('handleMessage: action 非白名单 → INVALID_ACTION', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage({ action: 'madeUpAction' }, {}, sendResponse);
  assert.equal(captured.response.success, false);
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_ACTION);
});

test('handleMessage: action 缺失 → INVALID_ACTION', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage({}, {}, sendResponse);
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_ACTION);
});

test('handleMessage: SET_SYNC_INTERVAL 非数字 → INVALID_PARAMS', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage(
    { action: MESSAGE_ACTIONS.SET_SYNC_INTERVAL, interval: 'abc' },
    {},
    sendResponse
  );
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);
});

test('handleMessage: SET_SYNC_INTERVAL 负数 → INVALID_PARAMS', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage(
    { action: MESSAGE_ACTIONS.SET_SYNC_INTERVAL, interval: -5 },
    {},
    sendResponse
  );
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);
});

test('handleMessage: SET_SYNC_INTERVAL NaN/Infinity → INVALID_PARAMS', () => {
  const c1 = makeCapture();
  handleMessage({ action: MESSAGE_ACTIONS.SET_SYNC_INTERVAL, interval: NaN }, {}, c1.sendResponse);
  assert.equal(c1.captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);

  const c2 = makeCapture();
  handleMessage({ action: MESSAGE_ACTIONS.SET_SYNC_INTERVAL, interval: Infinity }, {}, c2.sendResponse);
  assert.equal(c2.captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);
});

test('handleMessage: SEARCH_BOOKMARKS 空 query → 立即返回空结果', () => {
  const { sendResponse, captured } = makeCapture();
  const rv = handleMessage(
    { action: MESSAGE_ACTIONS.SEARCH_BOOKMARKS, query: '' },
    {},
    sendResponse
  );
  assert.equal(rv, false, '同步响应应返回 false');
  assert.equal(captured.response.success, true);
  assert.deepEqual(captured.response.results, []);
  assert.deepEqual(captured.response.favicons, {});
});

test('handleMessage: SEARCH_BOOKMARKS 纯空白 query → 空结果', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage(
    { action: MESSAGE_ACTIONS.SEARCH_BOOKMARKS, query: '   \t  ' },
    {},
    sendResponse
  );
  assert.equal(captured.response.success, true);
  assert.deepEqual(captured.response.results, []);
});

test('handleMessage: DELETE_BOOKMARK 缺少 id → INVALID_PARAMS', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage(
    { action: MESSAGE_ACTIONS.DELETE_BOOKMARK },
    {},
    sendResponse
  );
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);
});

test('handleMessage: DELETE_BOOKMARK 空字符串 id → INVALID_PARAMS', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage(
    { action: MESSAGE_ACTIONS.DELETE_BOOKMARK, id: '   ' },
    {},
    sendResponse
  );
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);
});

test('handleMessage: DELETE_BOOKMARKS_BATCH 空数组 → INVALID_PARAMS', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage(
    { action: MESSAGE_ACTIONS.DELETE_BOOKMARKS_BATCH, ids: [] },
    {},
    sendResponse
  );
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);
});

test('handleMessage: DELETE_BOOKMARKS_BATCH 非数组 → INVALID_PARAMS', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage(
    { action: MESSAGE_ACTIONS.DELETE_BOOKMARKS_BATCH, ids: 'not-an-array' },
    {},
    sendResponse
  );
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);
});

test('handleMessage: OPEN_BOOKMARK_IN_WINDOW 缺 url → INVALID_PARAMS', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage(
    { action: MESSAGE_ACTIONS.OPEN_BOOKMARK_IN_WINDOW },
    {},
    sendResponse
  );
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);
});

test('handleMessage: TOGGLE_CURRENT_BOOKMARK 非 http(s) url → INVALID_PARAMS', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage(
    { action: MESSAGE_ACTIONS.TOGGLE_CURRENT_BOOKMARK, url: 'chrome://settings' },
    {},
    sendResponse
  );
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);
});

test('handleMessage: TOGGLE_CURRENT_BOOKMARK file:// → INVALID_PARAMS', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage(
    { action: MESSAGE_ACTIONS.TOGGLE_CURRENT_BOOKMARK, url: 'file:///etc/passwd' },
    {},
    sendResponse
  );
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);
});

test('handleMessage: PROBE_URL_REACHABILITY 无 url → INVALID_PARAMS', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage(
    { action: MESSAGE_ACTIONS.PROBE_URL_REACHABILITY },
    {},
    sendResponse
  );
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);
});

test('handleMessage: PROBE_URL_REACHABILITY 非 http(s) → INVALID_PARAMS', () => {
  const { sendResponse, captured } = makeCapture();
  handleMessage(
    { action: MESSAGE_ACTIONS.PROBE_URL_REACHABILITY, url: 'javascript:alert(1)' },
    {},
    sendResponse
  );
  assert.equal(captured.response.error.code, MESSAGE_ERROR_CODES.INVALID_PARAMS);
});

// ------------------------------------------------------------------------
// PROBE_URL_REACHABILITY 真跑通：stub fetch，验证 HEAD→GET 回退、
// 404 直判 dead、其它状态回到 suspect
// ------------------------------------------------------------------------

async function waitFor(pred, timeoutMs = 1000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('PROBE_URL_REACHABILITY: HEAD 200 直接 ok', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, body: null };
  };

  try {
    const { sendResponse, captured } = makeCapture();
    const rv = handleMessage(
      { action: MESSAGE_ACTIONS.PROBE_URL_REACHABILITY, url: 'https://example.com', timeoutMs: 1000 },
      {},
      sendResponse
    );
    assert.equal(rv, true, '异步响应应返回 true');
    await waitFor(() => captured.called > 0);
    assert.equal(fetchCalls, 1, 'HEAD 一次就够，不需要 GET 回退');
    assert.equal(captured.response.success, true);
    assert.equal(captured.response.ok, true);
    assert.equal(captured.response.status, 200);
    assert.equal(captured.response.phase, 'head');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('PROBE_URL_REACHABILITY: HEAD 404 直接 dead，不走 GET 回退', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: false, status: 404, body: null };
  };

  try {
    const { sendResponse, captured } = makeCapture();
    handleMessage(
      { action: MESSAGE_ACTIONS.PROBE_URL_REACHABILITY, url: 'https://example.com/missing' },
      {},
      sendResponse
    );
    await waitFor(() => captured.called > 0);
    assert.equal(fetchCalls, 1);
    assert.equal(captured.response.ok, false);
    assert.equal(captured.response.status, 404);
    assert.equal(captured.response.phase, 'head');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('PROBE_URL_REACHABILITY: HEAD 405 触发 GET 回退', async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (url, init) => {
    methods.push(init.method);
    if (init.method === 'HEAD') return { ok: false, status: 405, body: null };
    if (init.method === 'GET') return { ok: true, status: 200, body: null };
    throw new Error('unexpected');
  };

  try {
    const { sendResponse, captured } = makeCapture();
    handleMessage(
      { action: MESSAGE_ACTIONS.PROBE_URL_REACHABILITY, url: 'https://example.com' },
      {},
      sendResponse
    );
    await waitFor(() => captured.called > 0);
    assert.deepEqual(methods, ['HEAD', 'GET'], '应当 HEAD 失败后 GET');
    assert.equal(captured.response.ok, true);
    assert.equal(captured.response.status, 200);
    assert.equal(captured.response.phase, 'get');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('PROBE_URL_REACHABILITY: 5xx 会触发 1s 重试一次', async () => {
  const originalFetch = globalThis.fetch;
  let headCalls = 0;
  let getCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (init.method === 'HEAD') { headCalls += 1; return { ok: false, status: 500, body: null }; }
    if (init.method === 'GET') { getCalls += 1; return { ok: false, status: 500, body: null }; }
    throw new Error('unexpected');
  };

  try {
    const { sendResponse, captured } = makeCapture();
    handleMessage(
      { action: MESSAGE_ACTIONS.PROBE_URL_REACHABILITY, url: 'https://example.com' },
      {},
      sendResponse
    );
    await waitFor(() => captured.called > 0, 3000);
    assert.equal(headCalls, 1);
    assert.equal(getCalls, 2, 'GET 应该重试一次，共 2 次');
    // 5xx 在前端 classify 成 suspect（非 dead），这里只验证 SW 如实回传
    assert.equal(captured.response.ok, false);
    assert.equal(captured.response.status, 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('PROBE_URL_REACHABILITY: fetch 抛错 → 返回 status=0 + error（suspect 而非 dead）', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };

  try {
    const { sendResponse, captured } = makeCapture();
    handleMessage(
      { action: MESSAGE_ACTIONS.PROBE_URL_REACHABILITY, url: 'https://example.com' },
      {},
      sendResponse
    );
    await waitFor(() => captured.called > 0);
    assert.equal(captured.response.ok, false);
    assert.equal(captured.response.status, 0);
    assert.ok(captured.response.error);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
