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
