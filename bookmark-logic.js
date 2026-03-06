import { HISTORY_ACTIONS, PATH_SEPARATOR } from './constants.js';

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

  // 直接构造 Map，避免 .map() 创建中间数组
  const oldMap = new Map();
  const oldItems = oldList || [];
  for (let i = 0; i < oldItems.length; i++) {
    const b = oldItems[i];
    if (b && b.id) oldMap.set(b.id, b);
  }

  const newMap = new Map();
  const newItems = newList || [];
  for (let i = 0; i < newItems.length; i++) {
    const b = newItems[i];
    if (b && b.id) newMap.set(b.id, b);
  }

  // Add / Move / Edit
  for (let i = 0; i < newItems.length; i++) {
    const newItem = newItems[i];
    if (!newItem) continue;

    const oldItem = oldMap.get(newItem.id);
    if (!oldItem) {
      changes.push({
        action: HISTORY_ACTIONS.ADD,
        title: newItem.title,
        url: newItem.url,
        path: newItem.path,
        timestamp: now()
      });
      continue;
    }

    const moved = oldItem.path !== newItem.path;
    const edited = oldItem.title !== newItem.title || oldItem.url !== newItem.url;

    if (moved) {
      changes.push({
        action: HISTORY_ACTIONS.MOVE,
        title: newItem.title,
        url: newItem.url,
        oldPath: oldItem.path,
        newPath: newItem.path,
        timestamp: now()
      });
    }

    if (edited) {
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
  }

  // Delete
  for (let i = 0; i < oldItems.length; i++) {
    const oldItem = oldItems[i];
    if (!oldItem) continue;

    if (!newMap.has(oldItem.id)) {
      changes.push({
        action: HISTORY_ACTIONS.DELETE,
        title: oldItem.title,
        url: oldItem.url,
        folder: oldItem.path,
        timestamp: now()
      });
    }
  }

  return changes;
}

