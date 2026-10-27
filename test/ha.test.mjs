import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-ha-'));
const store = await import('../store.js');
const state = await import('../state.js');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const dirs = [];
const fresh = (label) => {
  const dir = path.join(os.tmpdir(), `lite-memory-ha-${label}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return store.scopeOf(dir);
};

const lockOf = (scope) => path.join(scope.dir, '.lock');
const currentOf = (scope) => path.join(scope.dir, 'state.json');
const prevOf = (scope) => path.join(scope.dir, 'state.prev.json');

test('P1-C: a lock left by a dead pid is reclaimed instead of reported busy', () => {
  const scope = fresh('stale-lock');
  fs.mkdirSync(scope.dir, { recursive: true });
  fs.writeFileSync(lockOf(scope), '999999:deadbeef');
  const saved = store.upsert(scope, { title: '锁回收', summary: '崩溃进程留下的锁不该卡住写入', body: '正文' });
  assert.ok(saved.record.id.startsWith('mem_'));
  assert.equal(fs.existsSync(lockOf(scope)), false);
});

test('P1-C: a lock held by a live pid still reports busy and is never deleted', () => {
  const scope = fresh('live-lock');
  fs.mkdirSync(scope.dir, { recursive: true });
  const file = lockOf(scope);
  fs.writeFileSync(file, `${process.pid}:live`);
  try {
    assert.throws(
      () => store.upsert(scope, { title: '忙', summary: '另一个进程正在写', body: '正文' }),
      (error) => error.code === 'busy' && /另一个进程/.test(error.message),
    );
    assert.equal(fs.readFileSync(file, 'utf8'), `${process.pid}:live`);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('P0-B: 别的项目占着全局锁，本项目保存自己的条目照样能写', () => {
  const project = fresh('other-project-save');
  const global = store.globalScope();
  fs.mkdirSync(global.dir, { recursive: true });
  const file = lockOf(global);
  fs.writeFileSync(file, `${process.pid}:busy-global`);
  try {
    const saved = store.saveEntry(project, {
      title: '本项目照常保存',
      summary: '别的项目或全局在写，不影响本项目的记忆',
      body: '本项目照常保存正文。',
      memoryClass: 'project_fact',
    });
    assert.equal(saved.chosenScope, 'project');
    assert.ok(saved.record && saved.record.id.startsWith('mem_'));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('P0-B: a corrupt state.json falls back to state.prev.json and says so', () => {
  const scope = fresh('recover');
  store.upsert(scope, { title: '第一条', summary: '先写一条', body: '正文一' });
  store.upsert(scope, { title: '第二条', summary: '再写一条，prev 才有货', body: '正文二' });
  assert.ok(fs.existsSync(prevOf(scope)), 'second publish should have produced state.prev.json');
  fs.writeFileSync(currentOf(scope), '{"format":"broken"');
  const loaded = state.load(scope);
  assert.equal(loaded.recovered, true);
  assert.ok(loaded.state.entries.length >= 1);
  assert.match(loaded.recovery.message, /已从上一版恢复/);
});

test('P0-B: recovery does not bring a closed memory switch back on its own', () => {
  const scope = fresh('recover-auth');
  store.upsert(scope, { title: '关闭前的一条', summary: '先有数据', body: '正文' });
  store.setMemoryEnabled(scope, false, { operationId: 'op-close' });
  // 关闭这一版是 current；prev 还是开启状态。current 坏掉后恢复的是 prev。
  assert.equal(store.controlStatus(scope).enabled, false);
  fs.writeFileSync(currentOf(scope), '{"format":"broken"');
  const loaded = state.load(scope);
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.state.control.recoveryPending, true);
  assert.equal(store.controlStatus(scope).enabled, false, '恢复出来仍是关闭，不能自己恢复授权');
  const reopened = store.setMemoryEnabled(scope, true, { operationId: 'op-reopen' });
  assert.equal(reopened.ok, true);
  assert.equal(store.controlStatus(scope).enabled, true);
  assert.equal(store.controlStatus(scope).recoveryPending, false, '用户明确开启后不再待确认');
});

test('P0-B: both files unreadable gives a recovery step, not just a path', () => {
  const scope = fresh('both-bad');
  store.upsert(scope, { title: '第一条', summary: '先写一条', body: '正文一' });
  store.upsert(scope, { title: '第二条', summary: '再写一条', body: '正文二' });
  fs.writeFileSync(currentOf(scope), 'broken');
  fs.writeFileSync(prevOf(scope), 'broken too');
  try {
    state.load(scope);
    assert.fail('expected a corrupt error');
  } catch (error) {
    assert.equal(error.code, 'corrupt');
    assert.match(error.message, /恢复/);
    assert.match(error.message, /state\.prev\.json/);
  }
});

test('P0-A: writeDurable publishes atomically and leaves no temp file behind', () => {
  const dir = path.join(os.tmpdir(), `lite-memory-durable-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const file = path.join(dir, 'x.json');
  state.writeDurable(file, '{"ok":true}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}');
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
  state.writeDurable(file, 'second');
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
});

test('P0-A: a failing write surfaces as unavailable and does not clobber the good file', () => {
  const dir = path.join(os.tmpdir(), `lite-memory-durable-bad-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const file = path.join(dir, 'x.json');
  state.writeDurable(file, 'good');
  const frozen = path.join(dir, 'frozen');
  fs.mkdirSync(frozen);
  fs.chmodSync(frozen, 0o500);
  try {
    assert.throws(
      () => state.writeDurable(path.join(frozen, 'y.json'), 'nope'),
      (error) => error.code === 'unavailable' && /写不进去/.test(error.message),
    );
  } finally {
    fs.chmodSync(frozen, 0o700);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'good');
});

test('P1-D: archived body round-trips through cold storage, and corrupt cold fails loudly', () => {
  const scope = fresh('cold');
  const saved = store.upsert(scope, { title: '冷存', summary: '归档正文放冷存', body: '归档正文内容' });
  const archived = store.forget(scope, saved.record.id, { mode: 'archive' });
  assert.ok(['archive', 'archived'].includes(archived.mode));
  const cold = path.join(scope.dir, 'cold', `${saved.record.id}.json`);
  assert.ok(fs.existsSync(cold), 'cold file should exist for an archived record');
  assert.equal(JSON.parse(fs.readFileSync(cold, 'utf8')).body, '归档正文内容');
  assert.equal(store.readEntry(scope, saved.record.id).body, '归档正文内容');
  fs.writeFileSync(cold, '{broken');
  assert.throws(
    () => store.readEntry(scope, saved.record.id),
    (error) => error.code === 'cold_corrupt' && /冷存/.test(error.message),
    'a broken cold file must never read back as an empty body',
  );
});

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`test/ha.test.mjs: ${passed} passed`);
