#!/usr/bin/env node
/*
 * postbuild smoke check
 * - 校验 dist/background.js 仍是 ESM（存在 import / export 语法）
 *   manifest.json 声明 background.type = "module"，若被 Vite/Terser 误打成 CJS/IIFE 会在加载时静默失败，
 *   这里用最小启发式做一次兜底。
 * - 校验 content.js 注入了 MESSAGE_ACTIONS 表（避免内容脚本运行时回落到 inline 硬编码）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = resolve(__dirname, '..', 'dist');

const problems = [];

function checkFileExists(path) {
  if (!existsSync(path)) {
    problems.push(`缺少文件: ${path}`);
    return false;
  }
  return true;
}

function checkBackground() {
  const backgroundPath = resolve(distDir, 'background.js');
  if (!checkFileExists(backgroundPath)) return;
  const text = readFileSync(backgroundPath, 'utf8');
  // MV3 module worker 不兼容 CJS：禁止出现 require()/module.exports/exports.
  // （background.js 是一个打包后的 ESM 入口，可能整包 inline 后不包含顶层 import/export，
  //  这在 type=module 下完全合法，所以只做反向禁止。）
  if (/\brequire\s*\(/.test(text)) {
    problems.push('dist/background.js 包含 require()，和 MV3 module worker 不兼容');
  }
  if (/\bmodule\.exports\b/.test(text) || /\bexports\.[A-Za-z_$]/.test(text)) {
    problems.push('dist/background.js 包含 CJS 导出（module.exports / exports.xxx），和 type=module 不兼容');
  }
  if (text.length === 0) {
    problems.push('dist/background.js 是空文件');
  }
}

function checkContentInjection() {
  const contentPath = resolve(distDir, 'content.js');
  if (!checkFileExists(contentPath)) return;
  const text = readFileSync(contentPath, 'utf8');
  if (text.indexOf('__BS_INJECTED_MESSAGE_ACTIONS__') === -1) {
    problems.push('dist/content.js 缺少 __BS_INJECTED_MESSAGE_ACTIONS__ 注入，MESSAGE_ACTIONS 可能会回落到硬编码 fallback');
  }
  // 注入的值至少应该包含 SEARCH_BOOKMARKS / TOGGLE_SEARCH 字符串
  if (text.indexOf('searchBookmarks') === -1 || text.indexOf('toggleSearch') === -1) {
    problems.push('dist/content.js 未包含核心 action 字面量（searchBookmarks / toggleSearch）');
  }
}

function checkManifest() {
  const manifestPath = resolve(distDir, 'manifest.json');
  if (!checkFileExists(manifestPath)) return;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!manifest.background || manifest.background.type !== 'module') {
      problems.push('dist/manifest.json background.type 必须保持为 "module"');
    }
    if (!manifest.permissions || !manifest.permissions.includes('favicon')) {
      problems.push('dist/manifest.json 缺少 "favicon" 权限（_favicon 访问所需）');
    }
  } catch (error) {
    problems.push(`dist/manifest.json 不是合法 JSON: ${error && error.message ? error.message : String(error)}`);
  }
}

checkBackground();
checkContentInjection();
checkManifest();

if (problems.length > 0) {
  console.error('[postbuild-check] FAIL:');
  for (const p of problems) console.error('  -', p);
  process.exit(1);
}

console.log('[postbuild-check] OK');
