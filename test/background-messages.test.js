import test from 'node:test';
import assert from 'node:assert/strict';

import { handleMessage } from '../background-messages.js';
import { MESSAGE_ACTIONS } from '../constants.js';

function requestBrowserFavicon(pageUrl) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('GET_BROWSER_FAVICON timeout')), 200);
    const returned = handleMessage(
      { action: MESSAGE_ACTIONS.GET_BROWSER_FAVICON, pageUrl },
      {},
      (response) => {
        clearTimeout(timer);
        resolve({ response, returned });
      }
    );

    if (returned === false) {
      // Synchronous path resolves through sendResponse above.
      return;
    }
  });
}

test('GET_BROWSER_FAVICON: does not cache empty fetch results', async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const pageUrl = `https://retry-${Date.now()}.example.com/page`;
  let fetchCount = 0;

  globalThis.chrome = {
    favicon: {
      getFaviconUrl(url) {
        return `chrome-extension://favicon/${encodeURIComponent(url)}`;
      }
    }
  };

  globalThis.fetch = async () => {
    fetchCount++;
    return {
      ok: false,
      status: 503,
      headers: {
        get() {
          return '';
        }
      }
    };
  };

  try {
    const first = await requestBrowserFavicon(pageUrl);
    const second = await requestBrowserFavicon(pageUrl);

    assert.equal(first.response.success, true);
    assert.equal(first.response.src, '');
    assert.equal(second.response.success, true);
    assert.equal(second.response.src, '');
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});
