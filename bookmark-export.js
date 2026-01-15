import { escapeHtml } from './utils.js';

const PATH_SEPARATOR = ' > ';

function buildFolderTree(bookmarks) {
  const root = { children: new Map(), bookmarks: [] };

  for (const bookmark of bookmarks) {
    const path = bookmark.path || bookmark.newPath || bookmark.folder || '';
    const parts = String(path)
      .split(PATH_SEPARATOR)
      .map(p => p.trim())
      .filter(Boolean);

    let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, { children: new Map(), bookmarks: [] });
      }
      node = node.children.get(part);
    }
    node.bookmarks.push(bookmark);
  }

  return root;
}

function renderTree(node, indent, timestampSec) {
  let out = '';

  // Folders first
  const folderNames = Array.from(node.children.keys()).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  for (const folderName of folderNames) {
    const child = node.children.get(folderName);
    out += `${indent}<DT><H3 ADD_DATE="${timestampSec}" LAST_MODIFIED="${timestampSec}">${escapeHtml(folderName)}</H3>\n`;
    out += `${indent}<DL><p>\n`;
    out += renderTree(child, indent + '    ', timestampSec);
    out += `${indent}</DL><p>\n`;
  }

  // Then bookmarks
  for (const bookmark of node.bookmarks) {
    const addDate = Math.floor(((bookmark.timestamp || Date.now())) / 1000);
    out += `${indent}<DT><A HREF="${escapeHtml(bookmark.url)}" ADD_DATE="${addDate}">${escapeHtml(bookmark.title || '无标题')}</A>\n`;
  }

  return out;
}

// Generate Netscape bookmark file format.
export function generateNetscapeBookmarkFile(bookmarks, { now = Date.now } = {}) {
  const timestampSec = Math.floor(now() / 1000);
  const tree = buildFolderTree(bookmarks);

  let content = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="${timestampSec}" LAST_MODIFIED="${timestampSec}">书签搜索 - 极速收藏夹管理与查找工具 导出</H3>
    <DL><p>
`;

  content += renderTree(tree, '        ', timestampSec);

  content += `    </DL><p>
</DL><p>
`;

  return content;
}

