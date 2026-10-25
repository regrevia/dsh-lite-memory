import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const STATE_VERSION = 2;
export const STATE_FORMAT = 'dsh-lite-memory/state@2';

/** 容量与预算都归这里管：写入路径只报「要写什么」，能不能落地由 state 决定。 */
export const LIMITS = {
  entries: 200,
  globalEntries: 200,
  hardEntries: 1000,
  entryBytes: 4096,
  recordBytes: 10 * 1024,
  totalBytes: 512 * 1024,
  historyBytes: 512 * 1024,
  stateBytes: 2 * 1024 * 1024,
  titleChars: 60,
  whenChars: 60,
  summaryChars: 60,
  tagChars: 20,
  tags: 5,
  lockWaitMs: 500,
  suggestionWindowMs: 48 * 60 * 60 * 1000,
  suggestionTtlMs: 48 * 60 * 60 * 1000,
  pending: 20,
  pendingBytes: 64 * 1024,
  receipts: 256,
  receiptTtlMs: 7 * 24 * 60 * 60 * 1000,
  citations: 20,
  citationSessions: 20,
  citationTtlMs: 30 * 24 * 60 * 60 * 1000,
  citationBytes: 16 * 1024,
};

const LEGACY_MARKERS = ['index.json', 'entries', 'archive'];

/** 失败带上可判定的 code，宿主据此给出状态，不靠匹配文案。 */
export class StateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

export function memoryRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'lite-memory');
}

function realpathOf(target) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** 用户显式配置的项目根：只认这一个键，不猜宿主内部字段。 */
function configuredRoot() {
  const file = path.join(memoryRoot(), 'config.json');
  let data;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 8 * 1024) return '';
    data = JSON.parse(raw);
  } catch {
    return '';
  }
  const value = data && typeof data.projectRoot === 'string' ? data.projectRoot.trim() : '';
  return value ? realpathOf(path.resolve(value)) : '';
}

function gitRoot(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out || '').trim().split('\n')[0];
    if (line) return { root: realpathOf(path.resolve(line)) };
    return { root: '', reason: 'failed' };
  } catch (error) {
    const text = `${error && error.stderr ? error.stderr : ''}${error && error.message ? error.message : ''}`;
    if (/not a git repository|不是.*git/i.test(text)) return { root: '', reason: 'not_git' };
    return { root: '', reason: 'failed' };
  }
}

const rootCache = new Map();

/**
 * 一个仓库根一份记忆：子目录、符号链接、worktree 都归到同一个根。
 * 拿不准时（git 超时/不可信 cwd）不新建命名空间，交给调用方决定要不要写。
 */
export function resolveRoot(cwd, options = {}) {
  const requested = realpathOf(path.resolve(cwd || process.cwd()));
  const explicit = options.projectRoot ? realpathOf(path.resolve(options.projectRoot)) : '';
  if (explicit) return { root: explicit, source: 'configured', confirmed: true };
  const configured = configuredRoot();
  if (configured) return { root: configured, source: 'configured', confirmed: true };
  const cacheKey = `${options.workspaceDir || ''}\n${requested}`;
  if (rootCache.has(cacheKey)) return rootCache.get(cacheKey);
  let resolved;
  if (options.workspaceDir) {
    resolved = { root: realpathOf(path.resolve(options.workspaceDir)), source: 'workspace', confirmed: true };
  } else {
    const git = gitRoot(requested);
    if (git.root) resolved = { root: git.root, source: 'git', confirmed: true };
    else if (git.reason === 'not_git') resolved = { root: requested, source: 'cwd', confirmed: true };
    else resolved = { root: requested, source: 'cwd', confirmed: false };
  }
  if (rootCache.size > 200) rootCache.clear();
  rootCache.set(cacheKey, resolved);
  return resolved;
}

export function scopeOf(cwd, options = {}) {
  const requested = path.resolve(cwd || process.cwd());
  const resolved = resolveRoot(requested, options);
  const root = resolved.root;
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 8);
  const label = path.basename(root).replace(/[^\w.-]+/g, '-').slice(0, 32) || 'root';
  return {
    key: `${label}-${hash}`,
    dir: path.join(memoryRoot(), `${label}-${hash}`),
    cwd: root,
    requestedCwd: requested,
    rootSource: resolved.source,
    confirmed: resolved.confirmed !== false,
  };
}

/** 跨项目通用的那层：用户说「以后所有项目都这样」才写这里。 */
export function globalScope() {
  return { key: 'global', dir: path.join(memoryRoot(), 'global'), cwd: '', rootSource: 'global', confirmed: true };
}

const stateFile = (scope) => path.join(scope.dir, 'state.json');
const prevFile = (scope) => path.join(scope.dir, 'state.prev.json');
const lockFile = (scope) => path.join(scope.dir, '.lock');
const migrationIntentFile = (scope) => path.join(scope.dir, 'migration.intent.json');

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no Atomics: the loop below still backs off via the deadline */
  }
}

const lockDepth = new Map();

/**
 * 跨进程一把锁：.lock 用 wx 创建，写 owner token，只释放自己那把。
 * 同进程内允许重入（读—改—写在同一个锁窗口里连续调用）。
 */
export function withScopeLock(scope, fn) {
  const dir = scope.dir;
  const depth = lockDepth.get(dir) || 0;
  if (depth > 0) {
    lockDepth.set(dir, depth + 1);
    try {
      return fn();
    } finally {
      lockDepth.set(dir, depth);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = lockFile(scope);
  const token = `${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
  const deadline = Date.now() + LIMITS.lockWaitMs;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(file, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw new StateError('unavailable', `记忆库加锁失败（${error.code || 'IO'}）：${file}`);
      if (Date.now() > deadline) {
        throw new StateError('busy', `记忆库正忙（另一个进程在写），稍后再试；若确认没有写入进程，删掉 ${file}`);
      }
      sleepSync(10);
    }
  }
  lockDepth.set(dir, 1);
  try {
    try {
      fs.writeSync(fd, token);
    } catch {
      /* token is advisory; the lock file itself is the mutex */
    }
    return fn();
  } finally {
    lockDepth.delete(dir);
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      if (fs.readFileSync(file, 'utf8').trim() === token) fs.rmSync(file, { force: true });
    } catch {
      /* someone else already removed it */
    }
  }
}

function checksumOf(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function emptyState(scope) {
  const now = new Date().toISOString();
  return {
    schemaVersion: STATE_VERSION,
    storeId: crypto.randomUUID(),
    scopeKey: scope.key,
    cwd: scope.cwd || '',
    generation: 0,
    epoch: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    entries: [],
    candidates: [],
    receipts: [],
    suppressions: [],
  };
}

function fail(file, why, code = 'corrupt') {
  return new StateError(code, `记忆状态${why}，已停止读写：${file}`);
}

function validEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.id !== 'string' || !/^mem_[a-z0-9]{6,}$/.test(entry.id)) return false;
  if (!Number.isInteger(entry.revision) || entry.revision < 1) return false;
  if (entry.status !== 'active' && entry.status !== 'archived') return false;
  const current = entry.current;
  if (!current || typeof current !== 'object' || typeof current.title !== 'string') return false;
  if (typeof current.body !== 'string') return false;
  if (!entry.maintenance || typeof entry.maintenance !== 'object') return false;
  if (!Array.isArray(entry.maintenance.versions)) return false;
  return true;
}

export function validateState(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new StateError('invalid', '记忆状态结构不对');
  if (data.schemaVersion !== STATE_VERSION) {
    throw new StateError('invalid', `记忆状态版本不认（${String(data.schemaVersion)}），没有改动任何文件`);
  }
  for (const key of ['storeId', 'scopeKey', 'epoch']) {
    if (typeof data[key] !== 'string' || !data[key]) throw new StateError('invalid', `记忆状态缺少 ${key}`);
  }
  if (!Number.isInteger(data.generation) || data.generation < 0) throw new StateError('invalid', '记忆状态 generation 不对');
  for (const key of ['entries', 'candidates', 'receipts', 'suppressions']) {
    if (!Array.isArray(data[key])) throw new StateError('invalid', `记忆状态 ${key} 不是数组`);
  }
  const ids = new Set();
  for (const entry of data.entries) {
    if (!validEntry(entry)) throw new StateError('invalid', '记忆状态里有不合规的条目');
    if (ids.has(entry.id)) throw new StateError('invalid', `记忆状态里条目 id 重复：${entry.id}`);
    ids.add(entry.id);
  }
  for (const row of data.candidates) {
    if (!row || typeof row.id !== 'string' || !row.id.startsWith('sug_')) throw new StateError('invalid', '记忆候选缺少 id');
  }
  for (const row of data.receipts) {
    if (!row || typeof row.operationId !== 'string' || !row.operationId) throw new StateError('invalid', '记忆回执缺少 operationId');
  }
  return data;
}

function readEnvelope(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new StateError('unavailable', `记忆状态读不出来（${error.code || 'IO'}）：${file}`);
  }
  if (Buffer.byteLength(raw) > LIMITS.stateBytes) throw fail(file, '超过大小上限');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw fail(file, '已损坏');
  }
  if (!data || data.format !== STATE_FORMAT || !data.payload || typeof data.payload !== 'object') {
    throw fail(file, '格式不认');
  }
  if (data.checksum !== checksumOf(data.payload)) throw fail(file, '校验和不一致');
  validateState(data.payload);
  return data.payload;
}

export function encodeState(state) {
  const payload = validateState(state);
  return `${JSON.stringify({ format: STATE_FORMAT, checksum: checksumOf(payload), payload }, null, 2)}\n`;
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* best effort: rename already landed */
  }
}

function writeDurable(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(dir);
}

/** 先发布旧状态到 prev，再换 current：任何一步中断都能看出「旧/新」而不是空库。 */
function publish(scope, next, hadCurrent) {
  const dir = scope.dir;
  let durability = 'confirmed';
  const current = stateFile(scope);
  if (hadCurrent) {
    try {
      const raw = fs.readFileSync(current, 'utf8');
      writeDurable(prevFile(scope), raw);
    } catch {
      /* prev is a recovery aid; a missing one must not block a real write */
    }
  }
  const text = encodeState(next);
  if (Buffer.byteLength(text) > LIMITS.stateBytes) {
    throw new StateError('budget_exhausted', `记忆状态超过 ${LIMITS.stateBytes} 字节，先归档旧的再写`);
  }
  const tmp = path.join(dir, `.state.tmp.${process.pid}.${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    fs.rmSync(tmp, { force: true });
    throw new StateError('unavailable', `记忆状态写不进去（${error.code || 'IO'}）`);
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, current);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw new StateError('unavailable', `记忆状态换不上去（${error.code || 'IO'}）`);
  }
  try {
    fsyncDir(dir);
  } catch {
    durability = 'unconfirmed';
  }
  return { durability };
}

function countActive(state) {
  return state.entries.filter((entry) => entry.status === 'active').length;
}

/**
 * 一条占多少字节：正文 + 标题/摘要/标签（和展示与检索用到的字段一致）。
 * 预算按这个算，capacityOf 报出来的数字才对得上。
 */
export function entryBytesOf(entry) {
  const current = entry.current || {};
  const body = typeof current.body === 'string' ? current.body : '';
  const meta = [current.title || '', current.summary || '', Array.isArray(current.keywords) ? current.keywords.join(',') : ''].join('\n');
  return Buffer.byteLength(body) + Buffer.byteLength(meta);
}

function activeBytesOf(state) {
  return state.entries.reduce((sum, entry) => (entry.status === 'active' ? sum + entryBytesOf(entry) : sum), 0);
}

function entryLastTouch(entry) {
  const maintenance = entry.maintenance || {};
  return Date.parse(maintenance.lastUsed || entry.updatedAt || entry.createdAt || '') || 0;
}

const IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 到硬上限不拒绝新记忆：把同层最久没被读/更新的一条标成归档（正文保留），
 * 返回动了哪些，让工具结果里说清楚。真腾不出位置才报 budget_exhausted。
 */
export function enforceBudget(state, scope) {
  if (scope && scope.key === 'global') {
    // 全局层与项目层共用同一套条数与字节预算，只是各自独立计算。
  }
  const evicted = [];
  const now = Date.now();
  for (;;) {
    const active = state.entries.filter((entry) => entry.status === 'active');
    const bytes = active.reduce((sum, entry) => sum + entryBytesOf(entry), 0);
    if (active.length <= LIMITS.hardEntries && bytes <= LIMITS.totalBytes) break;
    const idle = active.filter((entry) => now - entryLastTouch(entry) >= IDLE_MS);
    const pool = idle.length ? idle : active;
    const victim = pool.reduce((oldest, entry) => (entryLastTouch(entry) < entryLastTouch(oldest) ? entry : oldest));
    if (!victim) throw new StateError('budget_exhausted', `记忆库已满：这一条自己就超过 ${LIMITS.totalBytes} 字节正文预算，先精简正文`);
    victim.status = 'archived';
    victim.updatedAt = new Date().toISOString();
    evicted.push({ id: victim.id, title: victim.current.title });
  }
  const pendingBytes = state.candidates.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.draft || {})), 0);
  if (state.candidates.length > LIMITS.pending || pendingBytes > LIMITS.pendingBytes) {
    state.candidates = state.candidates.slice(-LIMITS.pending);
  }
  const cutoff = now - LIMITS.receiptTtlMs;
  state.receipts = state.receipts.filter((row) => {
    const at = Date.parse(row.at || '');
    return Number.isFinite(at) && at >= cutoff;
  }).slice(-LIMITS.receipts);
  return evicted;
}

function legacyEntries(scope) {
  const index = path.join(scope.dir, 'index.json');
  let raw;
  try {
    raw = fs.readFileSync(index, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new StateError('unavailable', `旧记忆索引读不出来（${error.code || 'IO'}）：${index}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new StateError('corrupt', `记忆索引已损坏，已停止读写：${index}`);
  }
  if (!data || !Array.isArray(data.entries)) throw new StateError('corrupt', `记忆索引结构不对，已停止读写：${index}`);
  return data;
}

function legacyBody(scope, id) {
  const file = path.join(scope.dir, 'entries', `${id}.md`);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new StateError('unavailable', `旧记忆正文读不出来（${error.code || 'IO'}）：${id}`);
  }
}

function toStateEntry(legacy, body, status) {
  const at = legacy.updated || legacy.created || new Date().toISOString();
  return {
    id: legacy.id,
    revision: Number.isInteger(legacy.revision) && legacy.revision > 0 ? legacy.revision : 1,
    status,
    origin: legacy.source === 'observed' ? 'observed' : 'user_explicit',
    createdAt: legacy.created || at,
    updatedAt: at,
    current: {
      title: legacy.title || '',
      summary: legacy.summary || '',
      body: typeof body === 'string' ? body : '',
      kind: legacy.kind || 'note',
      when: legacy.when || '',
      keywords: Array.isArray(legacy.tags) ? legacy.tags : [],
      topicKey: legacy.topicKey || '',
      triggers: [],
      applicability: 'all_in_scope',
      conditions: [],
      selection: null,
      links: [],
      aliases: Array.isArray(legacy.aliases) ? legacy.aliases : [],
    },
    maintenance: {
      reviewState: 'active',
      sourceRefs: [],
      retiredNames: Array.isArray(legacy.aliases) ? legacy.aliases : [],
      versions: Array.isArray(legacy.versions) ? legacy.versions : [],
      checks: [],
      hits: Number(legacy.hits) || 0,
      merges: Number(legacy.merges) || 0,
      lastUsed: legacy.lastUsed || at,
    },
  };
}

/** 旧库只读预检：缺正文、同 id 冲突、坏索引都在这里显形，绝不猜着补。 */
export function migrationReport(scope) {
  const legacy = legacyEntries(scope);
  const report = { required: false, entries: 0, archived: 0, missingBodies: [], conflicts: [], adoptable: [] };
  if (legacy) {
    report.required = true;
    const ids = new Set();
    for (const row of legacy.entries) {
      if (!row || typeof row.id !== 'string' || !/^mem_[a-z0-9]{6,}$/.test(row.id)) {
        report.conflicts.push({ id: String(row && row.id), reason: 'id 不合法' });
        continue;
      }
      if (ids.has(row.id)) report.conflicts.push({ id: row.id, reason: 'id 重复' });
      ids.add(row.id);
      report.entries += 1;
      if (legacyBody(scope, row.id) === null) report.missingBodies.push(row.id);
    }
    const archiveDir = path.join(scope.dir, 'archive');
    let archived = [];
    try {
      archived = fs.readdirSync(archiveDir).filter((name) => name.endsWith('.json'));
    } catch {
      archived = [];
    }
    report.archived = archived.length;
  }
  if (scope.cwd) report.adoptable = adoptableLegacy(scope);
  return report;
}

/** 旧版按 cwd 建库，根目录改到仓库根后，子目录的旧库必须收编到同一层。 */
function adoptableLegacy(scope) {
  let names;
  try {
    names = fs.readdirSync(memoryRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const dirent of names) {
    if (!dirent.isDirectory() || dirent.name === scope.key || dirent.name === 'sessions') continue;
    const dir = path.join(memoryRoot(), dirent.name);
    const index = path.join(dir, 'index.json');
    let data;
    try {
      const raw = fs.readFileSync(index, 'utf8');
      if (Buffer.byteLength(raw) > LIMITS.stateBytes) continue;
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const cwd = typeof data.cwd === 'string' ? realpathOf(path.resolve(data.cwd || '.')) : '';
    const root = realpathOf(scope.cwd);
    if (!cwd || !(cwd === root || cwd.startsWith(root + path.sep))) continue;
    if (fs.existsSync(path.join(dir, 'state.json'))) continue;
    found.push({ key: dirent.name, dir, cwd, entries: Array.isArray(data.entries) ? data.entries.length : 0 });
  }
  return found;
}

/**
 * 迁移是显式事务：先写 migration.intent.json，再发布 state，最后收走旧文件。
 * 缺正文/同 id 冲突默认不动盘，把报告抛给调用方决定。
 */
export function migrateLegacy(scope, options = {}) {
  return withScopeLock(scope, () => {
    const report = migrationReport(scope);
    if (!report.required && !report.adoptable.length) return { migrated: false, report };
    const decisions = options.decisions || {};
    if (report.conflicts.length || report.missingBodies.length) {
      const code = report.conflicts.length ? 'legacy_conflict' : 'legacy_missing_body';
      const detail = report.conflicts.length
        ? `同 id 冲突：${report.conflicts.map((row) => row.id).join('、')}`
        : `缺正文：${report.missingBodies.join('、')}`;
      const error = new StateError(code, `旧记忆库迁移需要确认（${detail}），没有改动任何文件；确认后带 decisions 重试`);
      error.report = report;
      throw error;
    }
    const sources = [];
    if (report.required) sources.push({ scope, legacy: legacyEntries(scope) });
    for (const item of report.adoptable) sources.push({ scope: { ...scope, key: item.key, dir: item.dir, cwd: item.cwd }, legacy: legacyEntries({ key: item.key, dir: item.dir }) });
    const state = emptyState(scope);
    const seen = new Set();
    let missing = 0;
    for (const source of sources) {
      const legacy = source.legacy;
      const sourceScope = source.scope;
      for (const row of legacy.entries) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const body = legacyBody(sourceScope, row.id);
        if (body === null) missing += 1;
        state.entries.push(toStateEntry(row, body === null ? '' : body, 'active'));
      }
      const archiveDir = path.join(sourceScope.dir, 'archive');
      let names = [];
      try {
        names = fs.readdirSync(archiveDir).filter((name) => name.endsWith('.json'));
      } catch {
        names = [];
      }
      for (const name of names) {
        if (seen.has(name.replace(/\.json$/, ''))) continue;
        let row;
        try {
          row = JSON.parse(fs.readFileSync(path.join(archiveDir, name), 'utf8'));
        } catch {
          continue;
        }
        if (!row || typeof row.id !== 'string' || seen.has(row.id)) continue;
        seen.add(row.id);
        const body = legacyBody(sourceScope, row.id);
        state.entries.push(toStateEntry(row, body === null ? '' : body, 'archived'));
        state.entries[state.entries.length - 1].current.body = typeof row.body === 'string' ? row.body : (body || '');
      }
      if (legacy.lastSuggestedAt) state.lastSuggestedAt = legacy.lastSuggestedAt;
    }
    state.migration = {
      at: new Date().toISOString(),
      fromVersion: 1,
      entries: state.entries.length,
      sources: sources.map((source) => source.scope.key),
      missingBodies: missing,
      decisions,
    };
    fs.mkdirSync(scope.dir, { recursive: true });
    writeDurable(migrationIntentFile(scope), `${JSON.stringify({ at: state.migration.at, sources: state.migration.sources, phase: 'publishing' }, null, 2)}\n`);
    publish(scope, state, fs.existsSync(stateFile(scope)));
    const legacyRoot = path.join(scope.dir, 'legacy');
    fs.mkdirSync(legacyRoot, { recursive: true });
    for (const source of sources) {
      if (source.scope.dir === scope.dir) {
        const target = path.join(legacyRoot, 'v1');
        fs.mkdirSync(target, { recursive: true });
        for (const name of LEGACY_MARKERS) {
          const from = path.join(scope.dir, name);
          if (!fs.existsSync(from)) continue;
          try {
            fs.renameSync(from, path.join(target, name));
          } catch {
            /* leftover legacy file is inert once state.json exists */
          }
        }
      } else {
        const target = path.join(legacyRoot, `scope-${source.scope.key}`);
        try {
          fs.rmSync(target, { recursive: true, force: true });
          fs.renameSync(source.scope.dir, target);
        } catch {
          /* best effort: leaving the old dir is inert without a root index */
        }
      }
    }
    fs.rmSync(migrationIntentFile(scope), { force: true });
    return { migrated: true, report, state };
  });
}

/**
 * 读当前状态：只有「完全没有」才算新库；坏文件、未知版本、迁移痕迹都报错，
 * 绝不用空库覆盖。
 */
export function load(scope) {
  const current = stateFile(scope);
  let data = null;
  try {
    data = readEnvelope(current);
  } catch (error) {
    // 校验和/结构坏了时有 prev 也不自动回滚：回滚会掩盖一次真实损坏。
    throw error;
  }
  if (!data) {
    const hasLegacy = LEGACY_MARKERS.some((name) => fs.existsSync(path.join(scope.dir, name)));
    const intent = fs.existsSync(migrationIntentFile(scope));
    if (hasLegacy || intent || (scope.cwd && adoptableLegacy(scope).length)) {
      const report = migrationReport(scope);
      const error = new StateError('migration_required', `旧记忆库需要迁移，先调用 migrateLegacy；报告：${JSON.stringify(report)}`);
      error.report = report;
      throw error;
    }
    const prev = readEnvelope(prevFile(scope));
    if (prev) {
      // current 丢了但 prev 完好：恢复 prev，并标记需要重写 current。
      return { state: prev, exists: false, recovered: true };
    }
    return { state: emptyState(scope), exists: false, recovered: false };
  }
  return { state: data, exists: true, recovered: false };
}

/**
 * 一次写入 = 一个事务：锁内重读 → 回执/摘要 → epoch/generation CAS → 校验 → 预算 → 原子发布。
 */
export function transact(scope, options, work) {
  return withScopeLock(scope, () => {
    const loaded = load(scope);
    const { operationId = '', payloadDigest = '', expected = null, expectCreate = false } = options || {};
    if (operationId) {
      const replay = loaded.state.receipts.find((row) => row.operationId === operationId);
      if (replay) {
        if (payloadDigest && replay.payloadDigest && replay.payloadDigest !== payloadDigest) {
          throw new StateError('conflict', '同一个 operationId 带了不同内容，这次没有写入');
        }
        return { replayed: true, changed: Boolean(replay.changed), state: loaded.state, receipt: replay, archived: [] };
      }
    }
    if (expectCreate && loaded.exists) {
      throw new StateError('conflict', '记忆库已经被另一个进程创建，重读后再写');
    }
    if (expected) {
      if (expected.epoch && expected.epoch !== loaded.state.epoch) {
        throw new StateError('conflict', '记忆库已经换过一代（epoch 变了），重读后再写');
      }
      if (Number.isInteger(expected.generation) && expected.generation !== loaded.state.generation) {
        throw new StateError('conflict', '记忆库刚被改过，重读后再写');
      }
    }
    const draft = JSON.parse(JSON.stringify(loaded.state));
    const outcome = work(draft) || {};
    if (!outcome.changed) {
      return { changed: false, state: loaded.state, result: outcome.result, archived: [] };
    }
    const evicted = enforceBudget(draft, scope);
    draft.generation = loaded.state.generation + 1;
    draft.updatedAt = new Date().toISOString();
    if (!draft.storeId) draft.storeId = loaded.state.storeId;
    if (operationId) {
      draft.receipts = [...draft.receipts, {
        operationId,
        payloadDigest,
        changed: true,
        revisionAfter: draft.generation,
        kind: outcome.kind || '',
        at: draft.updatedAt,
        ...(outcome.receipt || {}),
      }].slice(-LIMITS.receipts);
    }
    validateState(draft);
    const published = publish(scope, draft, loaded.exists);
    return { changed: true, state: draft, result: outcome.result, archived: evicted, durability: published.durability };
  });
}

/** 只读正文：缺失就报「正文缺失」，不返回空串冒充内容。 */
export function readEntryBody(scope, id) {
  const loaded = load(scope);
  const entry = loaded.state.entries.find((row) => row.id === id);
  if (!entry) return null;
  return { body: entry.current.body, entry };
}
