import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-lexical-'));
const store = await import('../store.js');
const view = await import('../view.js');

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
add('插件改名与合并', { tags: ['插件开发', '启动失败'], summary: '改包名要同步 factory ID，否则启动失败' });
add('启动服务器', { tags: ['启动'] });

/* 英文按整词：git 不能因为共享 gi/it 命中 digital。 */
assert.equal(store.search(scope, 'git', 5).some((row) => row.title.includes('digital')), false);
assert.equal(store.search(scope, 'digital', 5).some((row) => row.title.includes('digital')), true);
/* 中英混排同样按整词：英文词没出现，中文词重合再多也不能替它作证。 */
assert.equal(store.search(scope, '排查 git', 5).some((row) => row.title.includes('digital')), false);
assert.equal(store.search(scope, '排查 git', 5).some((row) => row.title.includes('git 提交前跑检查')), true);

/* 只重合「怎么」这类高频词不算命中。 */
assert.equal(store.search(scope, '这个怎么弄', 5).length, 0);

/* 实词仍然命中。 */
assert.equal(store.search(scope, '发布检查', 5).some((row) => row.title.includes('怎么做发布检查')), true);

/* 「启动」只是「启动失败」的一半，不能把改包名的记忆带进自动提示。 */
const renameRecord = store.search(scope, '插件改名与合并', 1)[0];
const serverRecord = store.search(scope, '启动服务器', 5).find((row) => row.title === '启动服务器');
assert.equal(view.matchScore(renameRecord, '启动服务器').score < view.MATCH_FLOOR, true);
assert.equal(view.matchScore(serverRecord, '启动服务器').score >= view.MATCH_FLOOR, true);
/* 两个词都落在同一个标签上才继续算命中。 */
assert.equal(store.search(scope, '启动失败怎么查', 5).some((row) => row.title === '插件改名与合并'), true);

/* 续说一句没有检索词：只有明确的「继续/然后」才沿用上一轮，别把短问题也接上去。 */
for (const text of ['继续', '继续。', '然后呢？', '接着', 'go on', 'continue']) {
  assert.equal(view.isContinuationQuery(text), true, text);
}
for (const text of ['继续优化轻量化记忆与前端展示逻辑', '然后发布', '样式', 'next steps for release']) {
  assert.equal(view.isContinuationQuery(text), false, text);
}
/* 短续句只由通用动作词组成、没点名新对象：沿用上一句，但不把带对象的长句也算进来。 */
for (const text of ['继续优化收敛', '继续打磨', '接着改', '继续看看']) {
  assert.equal(view.isEllipticalContinuation(text), true, text);
}
for (const text of ['继续优化轻量化记忆与前端展示逻辑', '继续优化数据库连接池', '接着改数据库', '然后发布']) {
  assert.equal(view.isEllipticalContinuation(text), false, text);
}

/* 明确换任务：换做/先别管，或点了一个上一句没有的英文对象。 */
assert.equal(view.isExplicitSwitch('改用 PostgreSQL 先看连接池', '把前端按钮颜色调一下'), true);
assert.equal(view.isExplicitSwitch('先别管这个了，帮我看看 nginx 502', '把前端按钮颜色调一下'), true);
assert.equal(view.isExplicitSwitch('继续优化收敛', '把前端按钮颜色调一下'), false);
assert.equal(view.isExplicitSwitch('继续优化数据库连接池', '把前端按钮颜色调一下'), false);

console.log('lexical.test.mjs: all passed');
