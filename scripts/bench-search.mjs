#!/usr/bin/env node
/*
 * 大书签量压测：索引构建 + 单次搜索延迟 + pinyin 解析开销。
 *
 * 不依赖 chrome.* / IndexedDB，走 __seedRuntimeDocumentsFromBookmarksForTests 入口。
 * 运行：node scripts/bench-search.mjs [5000 10000 50000]
 */

import {
  __seedRuntimeDocumentsFromBookmarksForTests,
  __searchDocumentsForTests,
  __buildSearchBigramIndexSyncForTests,
  __resetBackgroundDataForTests
} from '../background-data.js';

const WORDS_EN = [
  'github', 'google', 'stackoverflow', 'react', 'vue', 'typescript',
  'javascript', 'nodejs', 'python', 'rust', 'docker', 'kubernetes',
  'postgres', 'redis', 'aws', 'gcp', 'azure', 'linear', 'notion',
  'figma', 'slack', 'discord', 'twitter', 'linkedin', 'medium',
  'hackernews', 'reddit', 'wikipedia', 'mdn', 'devto'
];
const WORDS_CN = [
  '知乎', '掘金', '思否', '简书', '博客园', '开源', '中国', '科技',
  '新闻', '财经', '体育', '视频', '音乐', '工具', '学习', '文档',
  '教程', '指南', '手册', '参考', '设计', '开发', '运维', '测试'
];
const TLDS = ['com', 'org', 'io', 'dev', 'cn', 'xyz', 'app'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function genBookmark(i) {
  const en = pick(WORDS_EN);
  const cn = pick(WORDS_CN);
  const tld = pick(TLDS);
  const useChinese = Math.random() < 0.35;
  const title = useChinese
    ? `${cn} · ${en} 工具 ${i}`
    : `${en} - ${pick(WORDS_EN)} ${i}`;
  const host = `${en}${Math.floor(Math.random() * 1000)}.${tld}`;
  const path = Math.random() < 0.3
    ? `/path/${pick(WORDS_EN)}/${i}`
    : '/';
  const folder = Math.random() < 0.5
    ? `书签栏 > ${pick(WORDS_CN)}`
    : `Other > ${pick(WORDS_EN)}`;
  return {
    id: String(i),
    title,
    url: `https://${host}${path}`,
    path: folder,
    dateAdded: Date.now() - Math.floor(Math.random() * 365 * 86400_000)
  };
}

function format(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function bench(label, fn, iterations = 1) {
  // warmup
  for (let i = 0; i < Math.min(3, iterations); i++) fn();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1];
  const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
  console.log(
    `  ${label.padEnd(42)} avg=${format(avg).padStart(9)}  med=${format(med).padStart(9)}  p95=${format(p95).padStart(9)}  (n=${iterations})`
  );
}

async function runSize(N) {
  __resetBackgroundDataForTests();

  console.log(`\n━━━ N=${N.toLocaleString()} bookmarks ━━━`);

  const t0 = process.hrtime.bigint();
  const bookmarks = [];
  for (let i = 0; i < N; i++) bookmarks.push(genBookmark(i));
  const tGen = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  生成假数据                                 avg=${format(tGen).padStart(9)}`);

  // 一次性 seed（含 mapBookmarkToSearchDocument + pinyin 解析 + rebuildBookmarkIndex）
  const tSeedStart = process.hrtime.bigint();
  const docCount = __seedRuntimeDocumentsFromBookmarksForTests(bookmarks);
  const tSeed = Number(process.hrtime.bigint() - tSeedStart) / 1e6;
  console.log(`  mapToDoc + pinyin + rebuildIndex            avg=${format(tSeed).padStart(9)}  (${docCount} docs)`);

  // 场景 A：索引未就绪时的首次搜索（新改动下走全扫而非阻塞同步构建）
  const tFirst0 = process.hrtime.bigint();
  __searchDocumentsForTests('github', 10);
  const tFirst = Number(process.hrtime.bigint() - tFirst0) / 1e6;
  console.log(`  首次搜索（索引未就绪，走全扫兜底）          avg=${format(tFirst).padStart(9)}`);

  // 场景 B：强制建好索引后的热路径
  const tBuildStart = process.hrtime.bigint();
  __buildSearchBigramIndexSyncForTests();
  const tBuild = Number(process.hrtime.bigint() - tBuildStart) / 1e6;
  console.log(`  bigram 索引同步构建（离线 warmup 的成本）   avg=${format(tBuild).padStart(9)}`);

  // 索引命中后的各类查询
  bench('搜索 "github"（索引命中）', () => __searchDocumentsForTests('github', 10), 100);
  bench('搜索 "react typescript"（多 token）', () => __searchDocumentsForTests('react typescript', 10), 100);
  bench('搜索 "zh"（短查询，bigram 1）', () => __searchDocumentsForTests('zh', 10), 100);
  bench('搜索 "知乎"（中文 2 字）', () => __searchDocumentsForTests('知乎', 10), 100);
  bench('搜索 "nonexistent"（无结果）', () => __searchDocumentsForTests('nonexistentxyz', 10), 100);
  bench('搜索 "a"（1 字 fallback 全扫）', () => __searchDocumentsForTests('a', 10), 20);
}

const argSizes = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const sizes = argSizes.length > 0 ? argSizes : [1000, 5000, 10000, 50000];

console.log('Bookmark Search — 搜索性能压测');
console.log('=============================');
for (const n of sizes) {
  await runSize(n);
}
console.log('\n完成。');
