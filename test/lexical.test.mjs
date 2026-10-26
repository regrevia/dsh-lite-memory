import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-lexical-'));
const store = await import('../store.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-lexical-scope-'));
const scope = store.scopeOf(dir);
const add = (title, extra = {}) => store.upsert(scope, {
  applicability: 'all_in_scope',
  body: `正文：${title}`,
  summary: extra.summary || `${title}的摘要`,
  tags: extra.tags || [],
  resolution: 'distinct',
  title,
});
add('digital signal 调试', { tags: ['音频'] });
add('怎么做发布检查', { tags: ['发布'] });
add('git 提交前跑检查', { tags: ['git'] });

/* 英文按整词：git 不能因为共享 gi/it 命中 digital。 */
assert.equal(store.search(scope, 'git', 5).some((row) => row.title.includes('digital')), false);
assert.equal(store.search(scope, 'digital', 5).some((row) => row.title.includes('digital')), true);

/* 只重合「怎么」这类高频词不算命中。 */
assert.equal(store.search(scope, '这个怎么弄', 5).length, 0);

/* 实词仍然命中。 */
assert.equal(store.search(scope, '发布检查', 5).some((row) => row.title.includes('怎么做发布检查')), true);

console.log('lexical.test.mjs: all passed');
