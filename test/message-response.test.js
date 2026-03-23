import test from 'node:test';
import assert from 'node:assert/strict';

import { assertSuccessfulMessageResponse } from '../message-response.js';

test('assertSuccessfulMessageResponse: accepts skipped responses when allowed', () => {
  const response = assertSuccessfulMessageResponse(
    { success: false, skipped: true },
    '刷新失败',
    { allowSkipped: true }
  );

  assert.deepEqual(response, { success: false, skipped: true });
});

test('assertSuccessfulMessageResponse: throws fallback on missing response', () => {
  assert.throws(
    () => assertSuccessfulMessageResponse(undefined, '同步失败'),
    /同步失败/
  );
});

test('assertSuccessfulMessageResponse: extracts nested background error message', () => {
  assert.throws(
    () => assertSuccessfulMessageResponse(
      { success: false, error: { message: 'alarm unavailable' } },
      '设置失败'
    ),
    /alarm unavailable/
  );
});
