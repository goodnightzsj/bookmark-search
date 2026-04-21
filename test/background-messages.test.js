import test from 'node:test';

// GET_BROWSER_FAVICON / GET_BROWSER_FAVICONS_BATCH 已在 v2.x 废弃：
// content script 直接用 chrome-extension://_favicon/?pageUrl= 构造 URL，
// 不再经 background fetch + base64。此前的"does not cache empty fetch results"
// 用例已不适用，整体移除。未来相关逻辑（pageUrl 持久化/读取）由
// background-data / content 的 favicon 流程覆盖，尚无独立单测。

test.skip('background-messages: GET_BROWSER_FAVICON 已废弃（v2.x）', () => {});
