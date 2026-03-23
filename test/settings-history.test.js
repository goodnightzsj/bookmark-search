import test from 'node:test';
import assert from 'node:assert/strict';

import { assignHistorySelectionKeys, getExportableHistoryItems } from '../settings-history.js';

test('assignHistorySelectionKeys: keeps duplicate history entries distinguishable', () => {
  const keyed = assignHistorySelectionKeys([
    {
      action: 'add',
      title: 'Example',
      url: 'https://example.com',
      path: 'Folder',
      timestamp: 10
    },
    {
      action: 'add',
      title: 'Example',
      url: 'https://example.com',
      path: 'Folder',
      timestamp: 10
    }
  ]);

  assert.equal(keyed.length, 2);
  assert.notEqual(keyed[0].selectionKey, keyed[1].selectionKey);
});

test('getExportableHistoryItems: preserves duplicate URLs from different history entries', () => {
  const items = [
    {
      title: 'Example A',
      url: 'https://example.com',
      path: 'Folder A',
      timestamp: 10
    },
    {
      title: 'Example B',
      url: 'https://example.com',
      path: 'Folder B',
      timestamp: 20
    },
    {
      title: 'No URL',
      url: '',
      path: 'Folder C',
      timestamp: 30
    }
  ];

  const exportable = getExportableHistoryItems(items);

  assert.equal(exportable.length, 2);
  assert.deepEqual(exportable.map((item) => item.path), ['Folder A', 'Folder B']);
});
