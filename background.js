console.log("background.js");
let bookmarks = [];

chrome.storage.local.remove(["bookmarks"], () => {
  console.log("书签数据已删除");
});

// 检查存储的书签数据
chrome.storage.local.get(["bookmarks"], (result) => {
  if (result.bookmarks && result.bookmarks.length > 0) {
    // 如果已有存储的数据，直接使用
    console.log("从存储中获取书签数据：", result.bookmarks);
  } else {
    // 没有存储的数据，获取并存储书签信息
    chrome.bookmarks.getTree((bookmarkTreeNodes) => {
      processBookmarks(bookmarkTreeNodes);
      console.log("新获取的书签数据：", bookmarks);

      // 将书签数据存储到 chrome.storage
      chrome.storage.local.set({ bookmarks: bookmarks }, () => {
        console.log("书签数据已存储");
      });
    });
  }
});

// 递归遍历书签树
function processBookmarks(nodes) {
  for (const node of nodes) {
    if (node.children) {
      // 如果有子节点，说明是文件夹，继续递归
      processBookmarks(node.children);
    } else {
      // 没有子节点，说明是书签
      bookmarks.push({
        id: node.id,
        title: node.title,
        url: node.url,
      });
    }
  }
}

// 更新书签数据的函数
function updateBookmarks(action, id, bookmark) {
  if (action === "add") {
    bookmarks.push({
      id: id,
      title: bookmark.title,
      url: bookmark.url,
    });
  } else if (action === "delete") {
    bookmarks = bookmarks.filter((mark) => mark.id !== id);
  } else if (action === "edit") {
    bookmarks = bookmarks.map((mark) => {
      if (mark.id === id) {
        return { ...mark, ...bookmark };
      }
      return mark;
    });
  }
  // 存储更新后的数据
  chrome.storage.local.set({ bookmarks: bookmarks }, () => {
    console.log("更新后的书签数据已存储");
  });
}

// 监听书签的变化
chrome.bookmarks.onCreated.addListener((id, bookmark) => {
  console.log("新增书签：", id, bookmark);
  updateBookmarks("add", id, bookmark);
});

chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  console.log("删除书签：", id, removeInfo);
  updateBookmarks("delete", id, removeInfo);
});

chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  console.log("修改书签：", id, changeInfo);
  updateBookmarks("edit", id, changeInfo);
});

// 监听书签文件夹的变化
// chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
//   console.log("移动书签：", moveInfo);
//   updateBookmarks();
// });
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-overlay") {
    console.log("监听快捷键触发");
  }
});
