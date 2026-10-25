import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../store.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-'));
process.env.DSH_HOME = home;

const scope = store.scopeOf('/tmp/project-a');
const other = store.scopeOf('/tmp/project-b');
const draft = { title: '插件市场条目规范', summary: '市场上传指南的位置与要点', body: '见 UPLOAD-GUIDE.md', kind: 'pointer', tags: ['marketplace'] };

const first = store.upsert(scope, draft);
assert.equal(first.merged, false);
assert.equal(store.loadIndex(scope).entries.length, 1);

const second = store.upsert(scope, { ...draft, summary: '市场上传指南的位置与要点（更新）' });
assert.equal(second.merged, true);
assert.equal(second.record.id, first.record.id);
assert.equal(store.loadIndex(scope).entries.length, 1);
assert.equal(store.loadIndex(scope).entries[0].merges, 1);

assert.deepEqual(store.search(scope, '插件市场').map((item) => item.id), [first.record.id]);
assert.deepEqual(store.search(scope, '量子力学'), []);
assert.deepEqual(store.loadIndex(other).entries, []);

assert.throws(() => store.upsert(scope, { title: 'x', summary: '你要记得用 tab 缩进' }), /名词短语/);
assert.throws(() => store.upsert(scope, { title: 'y', summary: '凭据位置', body: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }), /凭据/);

const read = store.readEntry(scope, first.record.id);
assert.match(read.body, /UPLOAD-GUIDE/);
assert.ok(store.loadIndex(scope).entries[0].hits >= 2);

assert.equal(store.suggestionGate(scope, '插件市场条目规范').ok, false);
store.noteSuggestion(scope, '提交前先跑 lint');
assert.equal(store.suggestionGate(scope, '另一条').ok, false);
store.upsert(scope, { title: '提交前先跑 lint', summary: '交付前的文案检查步骤' });
assert.equal(store.suggestionGate(scope, '新的建议').ok, true);

const old = store.upsert(scope, { title: '很久没用到的条目', summary: '三个月没命中', body: 'x' });
const index = store.loadIndex(scope);
index.entries = index.entries.map((item) =>
  item.id === old.record.id ? { ...item, lastUsed: new Date(Date.now() - 400 * 86400000).toISOString() } : item,
);
store.saveIndex(scope, index);
const stale = store.loadIndex(scope).entries.find((item) => item.id === old.record.id);
const rendered = store.renderIndex([stale]);
assert.equal(rendered.text.includes('｜'), false);
assert.ok(rendered.text.includes(old.record.title));

const forgotten = store.forget(scope, first.record.id);
assert.equal(forgotten.title, draft.title);
assert.equal(store.loadIndex(scope).entries.some((item) => item.id === first.record.id), false);
assert.ok(fs.existsSync(path.join(scope.dir, 'archive', `${first.record.id}.md`)));

for (let i = 0; i < 240; i += 1) {
  store.upsert(scope, { title: `条目 ${i}`, summary: `第 ${i} 条`, body: 'x' });
}
const trimmed = store.loadIndex(scope);
assert.ok(trimmed.entries.length <= store.LIMITS.entries);
assert.ok(trimmed.totalBytes <= store.LIMITS.totalBytes);

fs.rmSync(home, { recursive: true, force: true });
console.log('store: 16 checks passed');

// 同一主题换个说法：合并，不新增。
const mergeScope = store.scopeOf('/tmp/project-merge');
store.upsert(mergeScope, { title: '插件市场条目规范', summary: '市场上传指南的位置与要点', body: '见 UPLOAD-GUIDE.md' });
const paraphrase = store.upsert(mergeScope, { title: '插件市场条目规范（改写）', summary: '市场上传指南的位置与要点', body: '见 UPLOAD-GUIDE.md#第二节' });
assert.equal(paraphrase.merged, true);
assert.equal(paraphrase.mergedFrom, '插件市场条目规范');
assert.equal(store.loadIndex(mergeScope).entries.length, 1);

// 同一项目下的另一件事：不合并。
const sibling = store.upsert(mergeScope, { title: '插件市场踩坑清单', summary: '卡片不刷新与抓取失败的已知原因', body: 'y' });
assert.equal(sibling.merged, false);
assert.equal(store.loadIndex(mergeScope).entries.length, 2);

console.log('store: merge rules ok');

// 前置条件不同 → 两条，哪怕标题一样。
const mac = store.upsert(mergeScope, { title: '构建耗时长', summary: '本机构建要几分钟', when: 'macOS 本地', body: '- 原因：磁盘加密' });
const ci = store.upsert(mergeScope, { title: '构建耗时长', summary: '本机构建要几分钟', when: 'CI 容器', body: '- 原因：冷缓存' });
assert.equal(mac.merged, false);
assert.equal(ci.merged, false);
assert.notEqual(ci.record.id, mac.record.id);
assert.equal(store.loadIndex(mergeScope).entries.filter((item) => item.title.startsWith('构建耗时长')).length, 2);

// 同一前置条件下合并：旧要点保留，同键覆盖。
const plus = store.upsert(mergeScope, { title: '构建耗时长', summary: '本机构建要几分钟', when: 'macOS 本地', body: '- 绕过：先跑 cache\n- 原因：磁盘加密拖慢' });
assert.equal(plus.merged, true);
assert.equal(plus.record.id, mac.record.id);
const body = store.readEntry(mergeScope, mac.record.id).body;
assert.match(body, /绕过/);
assert.match(body, /磁盘加密拖慢/);
assert.equal(body.includes('磁盘加密\n'), false);

// 前置条件参与检索。
const hit = store.search(mergeScope, 'CI 容器');
assert.ok(hit.some((item) => item.id === ci.record.id));

console.log('store: precondition rules ok');

// 全局层：一处写入，别的项目查得到；两层同名不合并，全局 id 跨作用域可读可归档。
const projA = store.scopeOf('/tmp/global-a');
const projB = store.scopeOf('/tmp/global-b');
const global = store.globalScope();
store.upsert(global, { title: '回复用中文', summary: '所有项目的中文回复约定', body: '- 回复：中文' });
const seen = store.search(projB, '中文回复');
assert.equal(seen.some((item) => item.scope === 'global'), true);
const local = store.upsert(projA, { title: '回复用中文', summary: '所有项目的中文回复约定', body: '- 回复：中文' });
assert.equal(local.merged, false);
assert.equal(store.loadIndex(global).entries.length, 1);
assert.equal(store.loadIndex(projA).entries.length, 1);
assert.match(store.readEntry(projB, seen[0].id).body, /中文/);
store.forget(projB, seen[0].id);
assert.equal(store.loadIndex(global).entries.length, 0);
console.log('store: global scope ok');
