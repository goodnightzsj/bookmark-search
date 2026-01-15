import { HISTORY_ACTIONS } from './constants.js';

const PATH_SEPARATOR = ' > ';

export function flattenBookmarksTree(nodes, parentPath = '', resultList = []) {
  if (!Array.isArray(nodes)) return resultList;

  for (const node of nodes) {
    if (!node) continue;

    if (node.children) {
      // Folder
      let nextPath = parentPath;
      if (node.title) {
        if (node.parentId === '0') {
          nextPath = node.title; // Bookmarks bar / Other bookmarks
        } else if (parentPath) {
          nextPath = parentPath + PATH_SEPARATOR + node.title;
        } else {
          nextPath = node.title;
        }
      }

      flattenBookmarksTree(node.children, nextPath, resultList);
      continue;
    }

    if (node.url) {
      // Bookmark
      resultList.push({
        id: node.id,
        title: node.title,
        url: node.url,
        path: parentPath,
        dateAdded: node.dateAdded
      });
    }
  }

  return resultList;
}

/**
 * Compare bookmark lists and generate change records.
 * Uses bookmark ID as the unique key to properly handle duplicate URLs.
 */
export function compareBookmarks(oldList, newList, { now = Date.now } = {}) {
  const changes = [];
  const oldMap = new Map((oldList || []).map(b => [b.id, b]));
  const newMap = new Map((newList || []).map(b => [b.id, b]));

  // Add / Move / Edit
  (newList || []).forEach((newItem) => {
    const oldItem = oldMap.get(newItem.id);
    if (!oldItem) {
      changes.push({
        action: HISTORY_ACTIONS.ADD,
        title: newItem.title,
        url: newItem.url,
        path: newItem.path,
        timestamp: now()
      });
      return;
    }

    if (oldItem.path !== newItem.path) {
      changes.push({
        action: HISTORY_ACTIONS.MOVE,
        title: newItem.title,
        url: newItem.url,
        oldPath: oldItem.path,
        newPath: newItem.path,
        timestamp: now()
      });
      return;
    }

    if (oldItem.title !== newItem.title || oldItem.url !== newItem.url) {
      changes.push({
        action: HISTORY_ACTIONS.EDIT,
        oldTitle: oldItem.title,
        title: newItem.title,
        oldUrl: oldItem.url,
        url: newItem.url,
        path: newItem.path,
        timestamp: now()
      });
    }
  });

  // Delete
  (oldList || []).forEach((oldItem) => {
    if (!newMap.has(oldItem.id)) {
      changes.push({
        action: HISTORY_ACTIONS.DELETE,
        title: oldItem.title,
        url: oldItem.url,
        folder: oldItem.path,
        timestamp: now()
      });
    }
  });

  return changes;
}

