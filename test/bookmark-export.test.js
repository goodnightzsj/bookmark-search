import test from 'node:test';
import assert from 'node:assert/strict';

import { generateNetscapeBookmarkFile } from '../bookmark-export.js';

test('generateNetscapeBookmarkFile: renders nested folders and escapes', () => {
  const bookmarks = [
    {
      title: 'A & B',
      url: 'https://example.com/?q=<tag>',
      path: 'Root > Folder',
      timestamp: 1_700_000_000_000
    },
    {
      title: 'Top',
      url: 'https://top.example/',
      path: '',
      timestamp: 1_700_000_000_100
    }
  ];

  const html = generateNetscapeBookmarkFile(bookmarks, { now: () => 1_700_000_000_000 });

  // Folder structure
  assert.ok(html.includes('>Root<'));
  assert.ok(html.includes('>Folder<'));

  // Bookmark escaping
  assert.ok(html.includes('A &amp; B'));
  assert.ok(html.includes('https://example.com/?q=&lt;tag&gt;'));

  // Root-level bookmark
  assert.ok(html.includes('https://top.example/'));
});

