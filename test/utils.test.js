import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, formatFutureTime, formatRelativeTime } from '../utils.js';

test('escapeHtml: handles null/undefined and escapes', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml('<div a="1">&</div>'), '&lt;div a=&quot;1&quot;&gt;&amp;&lt;/div&gt;');
});

test('formatRelativeTime: basic buckets', () => {
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    assert.equal(formatRelativeTime(1_000_000 - 10_000), '刚刚'); // 10s
    assert.equal(formatRelativeTime(1_000_000 - 5 * 60_000), '5分钟前');
    assert.equal(formatRelativeTime(1_000_000 - 2 * 60 * 60_000), '2小时前');
    assert.equal(formatRelativeTime(1_000_000 - 3 * 24 * 60 * 60_000, { showFullDate: false }), '3天前');
  } finally {
    Date.now = realNow;
  }
});

test('formatFutureTime: basic buckets', () => {
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    assert.equal(formatFutureTime(1_000_000 - 1), '即将');
    assert.equal(formatFutureTime(1_000_000 + 10_000), '1分钟内');
    assert.equal(formatFutureTime(1_000_000 + 10 * 60_000), '10分钟后');
    assert.equal(formatFutureTime(1_000_000 + 2 * 60 * 60_000), '2小时后');
  } finally {
    Date.now = realNow;
  }
});

