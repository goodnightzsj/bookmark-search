import test from 'node:test';
import assert from 'node:assert/strict';

import { compareBookmarks, flattenBookmarksTree } from '../bookmark-logic.js';
import { HISTORY_ACTIONS } from '../constants.js';

test('flattenBookmarksTree: flattens tree with paths', () => {
  const tree = [
    {
      id: '0',
      title: '',
      children: [
        {
          id: '1',
          title: 'Bookmarks bar',
          parentId: '0',
          children: [
            {
              id: '10',
              title: 'Folder',
              parentId: '1',
              children: [
                {
                  id: '100',
                  title: 'Example',
                  url: 'https://example.com',
                  dateAdded: 1
                }
              ]
            }
          ]
        },
        {
          id: '2',
          title: 'Other bookmarks',
          parentId: '0',
          children: [
            {
              id: '200',
              title: 'Other',
              url: 'https://other.com',
              dateAdded: 2
            }
          ]
        }
      ]
    }
  ];

  const flat = flattenBookmarksTree(tree);
  assert.deepEqual(flat, [
    {
      id: '100',
      title: 'Example',
      url: 'https://example.com',
      path: 'Bookmarks bar > Folder',
      dateAdded: 1
    },
    {
      id: '200',
      title: 'Other',
      url: 'https://other.com',
      path: 'Other bookmarks',
      dateAdded: 2
    }
  ]);
});

test('compareBookmarks: add/move/edit/delete', () => {
  let nowValue = 123;
  const now = () => nowValue;

  // Add
  const added = compareBookmarks([], [{ id: '1', title: 'A', url: 'u', path: 'P' }], { now });
  assert.equal(added.length, 1);
  assert.equal(added[0].action, HISTORY_ACTIONS.ADD);

  // Move
  const moved = compareBookmarks(
    [{ id: '1', title: 'A', url: 'u', path: 'P1' }],
    [{ id: '1', title: 'A', url: 'u', path: 'P2' }],
    { now }
  );
  assert.equal(moved.length, 1);
  assert.equal(moved[0].action, HISTORY_ACTIONS.MOVE);
  assert.equal(moved[0].oldPath, 'P1');
  assert.equal(moved[0].newPath, 'P2');

  // Edit
  const edited = compareBookmarks(
    [{ id: '1', title: 'A', url: 'u', path: 'P' }],
    [{ id: '1', title: 'B', url: 'u', path: 'P' }],
    { now }
  );
  assert.equal(edited.length, 1);
  assert.equal(edited[0].action, HISTORY_ACTIONS.EDIT);
  assert.equal(edited[0].oldTitle, 'A');
  assert.equal(edited[0].title, 'B');

  // Delete
  const deleted = compareBookmarks([{ id: '1', title: 'A', url: 'u', path: 'P' }], [], { now });
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].action, HISTORY_ACTIONS.DELETE);
  assert.equal(deleted[0].folder, 'P');

  // Duplicate URLs with different IDs should be independent
  nowValue = 456;
  const dup = compareBookmarks(
    [{ id: '1', title: 'A', url: 'u', path: 'P' }],
    [
      { id: '1', title: 'A', url: 'u', path: 'P' },
      { id: '2', title: 'A2', url: 'u', path: 'P' }
    ],
    { now }
  );
  assert.equal(dup.length, 1);
  assert.equal(dup[0].action, HISTORY_ACTIONS.ADD);
  assert.equal(dup[0].url, 'u');
});

