import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const STATE_VERSION = 4;
export const STATE_FORMAT = 'dsh-lite-memory/state@4';
/** 3 版与 2 版照常读，下一次写入升到 4 版；旧程序看到 4 版会拒绝写，不会丢掉实验标记。 */
export const LEGACY_STATE_FORMATS = ['dsh-lite-memory/state@3', 'dsh-lite-memory/state@2'];
export const LEGACY_STATE_VERSIONS = [3, 2];

/** 一期只有一个实验开关，策略版本不认时停止实验而不是猜测兼容。 */
export const EVOLUTION_POLICY_VERSION = 1;

function emptyTasks() {
  return { revision: 0, defaults: null, sessions: {}, episodes: {} };
}

/** 学习账本只留有限次数、近期用量与回执；不是事件日志，也不无限增长。 */
export function emptyLearning() {
  return { attempts: {}, recent: [], receipts: [] };
}

/** 坏数据按空账本处理；学习账本坏了只停整理，不挡住读取已学规则。 */
export function normalizeLearning(raw) {
  const out = emptyLearning();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (raw.attempts && typeof raw.attempts === 'object' && !Array.isArray(raw.attempts)) {
    const rows = Object.entries(raw.attempts)
      .filter(([id, row]) => id && row && typeof row === 'object' && Number.isInteger(row.count) && row.count > 0)
      .sort((a, b) => Date.parse(b[1].lastAt || 0) - Date.parse(a[1].lastAt || 0))
      .slice(0, 32);
    for (const [id, row] of rows) {
      out.attempts[id] = {
        count: Math.min(2, row.count),
        lastAt: typeof row.lastAt === 'string' ? row.lastAt : '',
      };
    }
  }
  if (Array.isArray(raw.recent)) {
    out.recent = raw.recent.filter((value) => typeof value === 'string' && value).slice(-32);
  }
  if (Array.isArray(raw.receipts)) {
    out.receipts = raw.receipts
      .filter((row) => row && typeof row === 'object' && typeof row.operationId === 'string')
      .slice(-64)
      .map((row) => JSON.parse(JSON.stringify(row)));
  }
  return out;
}

function newEvolution() {
  return {
    enabled: false,
    epoch: '',
    policyVersion: EVOLUTION_POLICY_VERSION,
    feedbackGeneration: 0,
    tasks: emptyTasks(),
    learning: emptyLearning(),
  };
}

/** 任务锚点只是实验内部状态；坏数据按空表处理，不让它挡住整层记忆读取。 */
function normalizeTasks(raw) {
  const out = emptyTasks();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  out.revision = Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  if (raw.defaults && typeof raw.defaults === 'object' && !Array.isArray(raw.defaults)) {
    out.defaults = JSON.parse(JSON.stringify(raw.defaults));
  }
  for (const key of ['sessions', 'episodes']) {
    if (raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) {
      out[key] = JSON.parse(JSON.stringify(raw[key]));
    }
  }
  return out;
}

/** 缺字段即关闭；未知或不兼容版本一律按关闭处理，也不改写现场。 */
export function evolutionOf(state) {
  const raw = state && state.experimental && state.experimental.projectEvolution;
  if (raw === undefined) {
    return { enabled: false, epoch: '', policyVersion: EVOLUTION_POLICY_VERSION, feedbackGeneration: 0, tasks: emptyTasks(), compatible: true };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: false, epoch: '', policyVersion: 0, feedbackGeneration: 0, tasks: emptyTasks(), learning: emptyLearning(), compatible: false };
  }
  const policyVersion = Number.isInteger(raw.policyVersion) ? raw.policyVersion : 0;
  const compatible = policyVersion === EVOLUTION_POLICY_VERSION;
  return {
    enabled: compatible && raw.enabled === true,
    epoch: typeof raw.epoch === 'string' ? raw.epoch : '',
    policyVersion,
    feedbackGeneration: Number.isInteger(raw.feedbackGeneration) ? raw.feedbackGeneration : 0,
    tasks: normalizeTasks(raw.tasks),
    learning: normalizeLearning(raw.learning),
    compatible,
  };
}

/** 开关事务里的纯状态部分：旋转 epoch、推进反馈代次；关闭时把试用条目转暂停待复核。 */
export function applyEvolution(draft, enabled) {
  const now = new Date().toISOString();
  const current = evolutionOf(draft);
  if (!current.compatible) throw new StateError('invalid', '实验配置版本不认，先不要改动开关');
  const next = Boolean(enabled);
  if (current.enabled === next) return { changed: false, enabled: next };
  const config = {
    enabled: next,
    epoch: crypto.randomUUID(),
    policyVersion: EVOLUTION_POLICY_VERSION,
    feedbackGeneration: current.feedbackGeneration + 1,
    changedAt: now,
    /** 开与关都让上一轮锚点失效；已经确认的项目默认保留，它不属于临时作品状态。 */
    tasks: { ...emptyTasks(), ...(current.tasks && current.tasks.defaults ? { defaults: current.tasks.defaults } : {}) },
    /** 关开不继承在途整理与旧提案；已学规则的来源与版本仍留在条目里。 */
    learning: emptyLearning(),
  };
  draft.experimental = { ...(draft.experimental || {}), projectEvolution: config };
  if (!next) {
    for (const entry of draft.entries) {
      const learning = entry && entry.maintenance && entry.maintenance.learning;
      if (learning && learning.state === 'trial') {
        learning.state = 'paused';
        learning.blockedReason = 'needs_revalidation';
        learning.pausedAt = now;
        learning.pausedBy = 'experiment_off';
      }
    }
    /** 未提交的候选随关闭清掉，不保留一份看不见却还能被旧提案命中的正文。 */
    draft.entries = draft.entries.filter((entry) => !(entry && entry.maintenance && entry.maintenance.learning && entry.maintenance.learning.state === 'pending'));
    draft.candidates = draft.candidates.filter((row) => !row || row.origin !== 'project_evolution');
  }
  return { changed: true, enabled: next, epoch: config.epoch };
}

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
  suppressions: 64,
  suppressionTtlMs: 7 * 24 * 60 * 60 * 1000,
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
      /* stderr 要留着：git 明说「不在仓库里」是可信结果，不能和超时/失败混成未确认。 */
      stdio: ['ignore', 'pipe', 'pipe'],
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
const purgeIntentFile = (scope) => path.join(scope.dir, 'purge.intent.json');

/** 搬移的协调文件放在根目录：它跨两层，不属于任何一层的状态包。 */
export const MOVE_FORMAT = 'dsh-lite-memory/move@1';
const moveIntentFile = () => path.join(memoryRoot(), 'move.intent.json');

/** 恢复流程要直接比对 current/prev：只暴露这两个固定文件名。 */
export function stateFiles(scope) {
  return { current: stateFile(scope), prev: prevFile(scope) };
}

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
    experimental: { projectEvolution: newEvolution() },
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
  for (const row of data.suppressions) {
    if (!row || typeof row !== 'object' || typeof row.reason !== 'string' || !row.reason) {
      throw new StateError('invalid', '记忆抑制规则缺少 reason');
    }
    if (row.expiresAt !== null && row.expiresAt !== undefined && typeof row.expiresAt !== 'string') {
      throw new StateError('invalid', '记忆抑制规则的 expiresAt 不合法');
    }
  }
  if (data.experimental !== undefined) {
    const box = data.experimental;
    if (!box || typeof box !== 'object' || Array.isArray(box)) throw new StateError('invalid', '记忆状态 experimental 不是对象');
    const evolution = box.projectEvolution;
    if (evolution !== undefined) {
      if (!evolution || typeof evolution !== 'object' || Array.isArray(evolution)) {
        throw new StateError('invalid', '记忆状态实验配置不是对象');
      }
      if (typeof evolution.enabled !== 'boolean') throw new StateError('invalid', '记忆状态实验开关不是布尔值');
      if (typeof evolution.epoch !== 'string' || (evolution.enabled && !evolution.epoch)) {
        throw new StateError('invalid', '记忆状态实验配置缺少 epoch');
      }
      if (!Number.isInteger(evolution.policyVersion)) throw new StateError('invalid', '记忆状态实验策略版本不对');
      if (evolution.feedbackGeneration !== undefined
        && (!Number.isInteger(evolution.feedbackGeneration) || evolution.feedbackGeneration < 0)) {
        throw new StateError('invalid', '记忆状态反馈代次不对');
      }
      if (evolution.learning !== undefined) {
        const learning = evolution.learning;
        if (!learning || typeof learning !== 'object' || Array.isArray(learning)) throw new StateError('invalid', '记忆状态学习账本不是对象');
        if (learning.attempts !== undefined && (!learning.attempts || typeof learning.attempts !== 'object' || Array.isArray(learning.attempts))) {
          throw new StateError('invalid', '记忆状态学习账本 attempts 不是对象');
        }
        for (const list of ['recent', 'receipts']) {
          if (learning[list] !== undefined && !Array.isArray(learning[list])) throw new StateError('invalid', `记忆状态学习账本 ${list} 不是数组`);
        }
      }
      if (evolution.tasks !== undefined) {
        const tasks = evolution.tasks;
        if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) throw new StateError('invalid', '记忆状态任务锚点不是对象');
        if (tasks.revision !== undefined && (!Number.isInteger(tasks.revision) || tasks.revision < 0)) {
          throw new StateError('invalid', '记忆状态任务锚点版本不对');
        }
        for (const key of ['sessions', 'episodes']) {
          if (tasks[key] !== undefined && (!tasks[key] || typeof tasks[key] !== 'object' || Array.isArray(tasks[key]))) {
            throw new StateError('invalid', '记忆状态任务锚点表不是对象');
          }
        }
        if (tasks.defaults !== undefined && tasks.defaults !== null && (typeof tasks.defaults !== 'object' || Array.isArray(tasks.defaults))) {
          throw new StateError('invalid', '记忆状态栏目默认不是对象');
        }
      }
    }
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
  if (!data || (data.format !== STATE_FORMAT && !LEGACY_STATE_FORMATS.includes(data.format))
    || !data.payload || typeof data.payload !== 'object') {
    throw fail(file, '格式不认');
  }
  if (data.checksum !== checksumOf(data.payload)) throw fail(file, '校验和不一致');
  if (data.format !== STATE_FORMAT) {
    if (!LEGACY_STATE_VERSIONS.includes(data.payload.schemaVersion)) throw fail(file, '版本对不上');
    const upgraded = { ...data.payload, schemaVersion: STATE_VERSION };
    if (upgraded.experimental === undefined) {
      upgraded.experimental = { projectEvolution: { enabled: false, epoch: '', policyVersion: EVOLUTION_POLICY_VERSION, feedbackGeneration: 0, learning: emptyLearning() } };
    }
    validateState(upgraded);
    return upgraded;
  }
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

/** 固定临时名：失败重试不会在目录里堆一串随机副本；恢复路径只认这几个已知名字。 */
function tempOf(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
}

function discardTemp(file) {
  try {
    fs.rmSync(tempOf(file), { force: true });
  } catch {
    /* 临时文件不权威，删不掉也不能挡住真正的写入 */
  }
}

/** 清理上次中断留下的临时副本：只碰已知的 .state*.tmp，不碰状态文件本身。 */
export function cleanStateResidue(scope) {
  let names;
  try {
    names = fs.readdirSync(scope.dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('.state') || !name.endsWith('.tmp')) continue;
    try {
      fs.rmSync(path.join(scope.dir, name), { force: true });
    } catch {
      /* 同一目录的临时副本，删不掉下次写前还会再清一次 */
    }
  }
}

function writeDurable(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tempOf(file);
  discardTemp(file);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    discardTemp(file);
    throw new StateError('unavailable', `${path.basename(file)} 写不进去（${error.code || 'IO'}）`);
  }
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
  writeDurable(current, text);
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
  const meta = [current.title || '', current.summary || '', current.when || '',
    Array.isArray(current.keywords) ? current.keywords.join(',') : ''].join('\n');
  return Buffer.byteLength(body) + Buffer.byteLength(meta) + Buffer.byteLength(fieldsBytesOf(current));
}

/**
 * 结构化字段也要计入预算：条件、清单、关联、触发词都占模型可见额度。
 * 键顺序固定，state 与 store 两边算出来的数字必须一致。
 */
export function fieldsBytesOf(current) {
  return JSON.stringify({
    topicKey: current.topicKey || '',
    triggers: Array.isArray(current.triggers) ? current.triggers : [],
    applicability: current.applicability || 'all_in_scope',
    conditions: Array.isArray(current.conditions) ? current.conditions : [],
    selection: current.selection || null,
    links: Array.isArray(current.links) ? current.links : [],
  });
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
      triggers: Array.isArray(legacy.triggers) ? legacy.triggers : [],
      /** 旧库只有一句 when 的条目不猜条件：先标 unresolved，第一次读取时让人确认。 */
      applicability: legacy.applicability || (legacy.when ? 'unresolved' : 'all_in_scope'),
      conditions: Array.isArray(legacy.conditions) ? legacy.conditions : [],
      selection: legacy.selection || null,
      links: Array.isArray(legacy.links) ? legacy.links : [],
      aliases: Array.isArray(legacy.aliases) ? legacy.aliases : [],
    },
    maintenance: {
      reviewState: 'legacy_unreviewed',
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

/** 被吸收的旧库：当前根目录的旧索引 + 同一仓库下更早按子目录建的那些。 */
function legacySources(scope) {
  const sources = [];
  const own = legacyEntries(scope);
  if (own) sources.push({ scope, legacy: own });
  let adoptable = [];
  if (scope.cwd) adoptable = adoptableLegacy(scope);
  for (const item of adoptable) {
    const child = { ...scope, key: item.key, dir: item.dir, cwd: item.cwd };
    const legacy = legacyEntries(child);
    if (legacy) sources.push({ scope: child, legacy });
  }
  return { sources, adoptable };
}

/** 归档文件单独放：预检阶段只读，不写盘。 */
function legacyArchiveRows(scope) {
  const dir = path.join(scope.dir, 'archive');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    try {
      const row = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (row && typeof row.id === 'string') rows.push(row);
    } catch {
      /* 坏归档文件不参与迁移，也不阻断当前条目 */
    }
  }
  return rows;
}

/**
 * 旧库只读预检：缺正文、同 id 冲突、同 id 不同正文、索引与正文不一致都在这里显形，
 * 一次扫完所有会被吸收的旧库；有任何未解决项就一条都不发布。
 */
export function migrationReport(scope) {
  const { sources, adoptable } = legacySources(scope);
  const report = {
    required: sources.some((source) => source.scope.dir === scope.dir),
    entries: 0,
    archived: 0,
    missingBodies: [],
    conflicts: [],
    adoptable,
    sources: sources.length,
  };
  const bodies = new Map();
  for (const source of sources) {
    const local = new Set();
    const storeKey = source.scope.key || 'root';
    const noteBody = (id, body, where) => {
      const seen = bodies.get(id);
      if (!seen) {
        bodies.set(id, { body, store: storeKey });
        return;
      }
      if (seen.body !== body) report.conflicts.push({ id, store: storeKey, reason: `同 id 不同正文：${seen.store} 与 ${storeKey}` });
      if (where === 'archive' && !body && seen.body) report.conflicts.push({ id, store: storeKey, reason: '归档缺少正文' });
    };
    for (const row of source.legacy.entries) {
      if (!row || typeof row.id !== 'string' || !/^mem_[a-z0-9]{6,}$/.test(row.id)) {
        report.conflicts.push({ id: String(row && row.id), store: storeKey, reason: 'id 不合法' });
        continue;
      }
      if (local.has(row.id)) report.conflicts.push({ id: row.id, store: storeKey, reason: 'id 重复' });
      local.add(row.id);
      report.entries += 1;
      const fileBody = legacyBody(source.scope, row.id);
      if (fileBody === null) report.missingBodies.push(row.id);
      /** 旧索引若自带正文，和正文文件必须一致，否则不知道该信哪份。 */
      if (typeof row.body === 'string' && fileBody !== null && row.body !== fileBody) {
        report.conflicts.push({ id: row.id, store: storeKey, reason: '索引与正文不一致' });
      }
      noteBody(row.id, fileBody === null ? '' : fileBody, 'active');
    }
    const archiveRows = legacyArchiveRows(source.scope);
    report.archived += archiveRows.length;
    for (const row of archiveRows) {
      if (local.has(row.id)) {
        report.conflicts.push({ id: row.id, store: storeKey, reason: '归档与索引 id 重复' });
        continue;
      }
      local.add(row.id);
      const fileBody = legacyBody(source.scope, row.id);
      const text = typeof row.body === 'string' ? row.body : (fileBody === null ? '' : fileBody);
      if (fileBody !== null && typeof row.body === 'string' && row.body !== fileBody) {
        report.conflicts.push({ id: row.id, store: storeKey, reason: '归档索引与正文不一致' });
      }
      noteBody(row.id, text, 'archive');
    }
  }
  return report;
}

/**
 * 迁移是显式事务：先写 migration.intent.json，再发布 state，最后收走旧文件。
 * 缺正文/同 id 冲突默认不动盘，把报告抛给调用方决定。
 */
export function migrateLegacy(scope, options = {}) {
  return withScopeLock(scope, () => {
    if (purgeIntent(scope)) throw new StateError('purge_pending', '这个记忆库正在彻底删除，迁移暂停；先调用 resumePurge 收尾');
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
    const sources = legacySources(scope).sources;
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
export function load(scope, options = {}) {
  moveBarrier(scope, options);
  if (options.cleanup) cleanStateResidue(scope);
  const intent = purgeIntent(scope);
  if (intent && !options.allowPurge) {
    throw new StateError('purge_pending', `这个记忆库正在彻底删除（${intent.operationId}），先调用 resumePurge 收尾；期间不提供内容读取`);
  }
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
    const loaded = load(scope, {
      allowMove: Boolean(options && options.allowMove),
      allowPurge: Boolean(options && options.allowPurge),
      cleanup: true,
    });
    const { operationId = '', payloadDigest = '', expected = null, expectCreate = false, nextEpoch = '' } = options || {};
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
    if (nextEpoch) draft.epoch = nextEpoch;
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



/** 根目录的协调锁：移动要同时持有两层，先拿这一把，固定顺序就不会互相等死。 */
export function withRootLock(fn) {
  return withScopeLock({ dir: memoryRoot(), key: 'root' }, fn);
}

/** 损坏的 intent 不当成不存在：宁可报错，也不让两层的半截状态被继续使用。 */
export function readMoveIntent() {
  const file = moveIntentFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new StateError('unavailable', `移动协调文件读不出来（${error.code || 'IO'}）：${file}`);
  }
  let intent;
  try {
    intent = JSON.parse(raw);
  } catch {
    throw new StateError('conflict', `移动中断，协调文件已损坏：${file}；先人工确认两层状态再删除它`);
  }
  const stringField = (value) => value === undefined || typeof value === 'string';
  const ok = intent && intent.format === MOVE_FORMAT
    && typeof intent.operationId === 'string' && intent.operationId
    && intent.source && typeof intent.source.scopeKey === 'string' && typeof intent.source.id === 'string'
    && stringField(intent.source.cwd) && stringField(intent.source.storeId)
    && stringField(intent.source.epoch) && stringField(intent.source.toEpoch)
    && intent.target && typeof intent.target.scopeKey === 'string' && typeof intent.target.newId === 'string'
    && stringField(intent.target.cwd) && stringField(intent.target.storeId)
    && stringField(intent.target.epoch) && stringField(intent.target.toEpoch);
  if (!ok) throw new StateError('conflict', `移动中断，协调文件内容不认：${file}`);
  return intent;
}

export function writeMoveIntent(intent) {
  const payload = {
    format: MOVE_FORMAT,
    operationId: intent.operationId,
    at: intent.at || new Date().toISOString(),
    source: { ...intent.source },
    target: { ...intent.target },
    topicKey: typeof intent.topicKey === 'string' ? intent.topicKey : '',
  };
  writeDurable(moveIntentFile(), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function clearMoveIntent() {
  fs.rmSync(moveIntentFile(), { force: true });
}

/**
 * 双重屏障：purge 和 move 都先落 intent 再改状态。涉及的两个 scope 读写在
 * intent 期间一律拒绝，直到恢复流程（resume）走完；allowMove 只给恢复路径自己用。
 */
export function moveBarrier(scope, options = {}) {
  const intent = readMoveIntent();
  if (!intent || options.allowMove) return intent;
  if (intent.source.scopeKey === scope.key || intent.target.scopeKey === scope.key) {
    throw new StateError('move_pending', `这条记忆正在跨层搬移（${intent.operationId}），先调用 resumeMove 收尾；期间不提供这两层的内容读取`);
  }
  return intent;
}

/** 把 prev 归一成刚发布的状态：搬移协议要求 prev 不保留搬动前的对立状态。 */
export function sealPrev(scope) {
  const current = stateFile(scope);
  if (!fs.existsSync(current)) throw new StateError('unavailable', '状态还没发布，不能封存 prev');
  writeDurable(prevFile(scope), fs.readFileSync(current, 'utf8'));
}

export function removePrev(scope) {
  fs.rmSync(prevFile(scope), { force: true });
}

/** 屏障只在 intent 存在期间生效：它不含标题与正文，只记身份与两个固定 epoch。 */
export function purgeIntent(scope) {
  const file = purgeIntentFile(scope);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new StateError('unavailable', `彻底删除的意图文件读不出来（${error.code || 'IO'}）：${file}`);
  }
  let row;
  try {
    row = JSON.parse(raw);
  } catch {
    throw new StateError('corrupt', `彻底删除的意图文件坏了，已停止读写：${file}`);
  }
  const ok = row && typeof row.operationId === 'string' && row.operationId
    && typeof row.toEpoch === 'string' && row.toEpoch
    && Array.isArray(row.ids) && row.ids.length > 0;
  if (!ok) throw new StateError('corrupt', `彻底删除的意图文件缺字段，已停止读写：${file}`);
  return row;
}

/** 精确指纹：标题 + 前置条件，不存原文，只用来挡住换个说法的重学。 */
export function fingerprintOf(current) {
  const text = [current && current.title, current && current.when]
    .map((part) => String(part || '').replace(/\s+/g, ' ').trim().toLowerCase())
    .join('\n');
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** 有限期抑制可以过期清掉；forgotten_source 永不过期，也不静默淘汰。 */
function pruneSuppressions(rows) {
  const now = Date.now();
  const alive = [];
  const shortLived = [];
  for (const row of rows || []) {
    if (!row || typeof row.reason !== 'string') continue;
    if (row.reason === 'forgotten_source') {
      alive.push(row);
      continue;
    }
    const expires = Date.parse(row.expiresAt || '');
    if (Number.isFinite(expires) && expires > now) shortLived.push(row);
  }
  const room = Math.max(0, LIMITS.suppressions - alive.length);
  return [...alive, ...shortLived.slice(-room)];
}

function sentinelsOf(entry) {
  const current = entry.current || {};
  const out = new Set();
  const push = (value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length >= 4) out.add(text);
  };
  push(current.title);
  push(current.summary);
  push(current.body);
  push(current.when);
  for (const name of current.aliases || []) push(name);
  for (const version of (entry.maintenance && entry.maintenance.versions) || []) {
    push(version.title);
    push(version.summary);
    push(version.body);
    push(version.when);
  }
  return [...out];
}

const PURGE_KEEP = new Set(['state.json', 'state.prev.json', '.lock', 'purge.intent.json']);

/** 受管副本一次性清掉：旧版目录、md 正文、旧归档、失败提交残留、缓存文件。 */
function cleanupManaged(scope) {
  for (const name of ['entries', 'archive', 'legacy']) {
    fs.rmSync(path.join(scope.dir, name), { recursive: true, force: true });
  }
  for (const name of ['index.json', 'migration.intent.json']) {
    fs.rmSync(path.join(scope.dir, name), { force: true });
  }
  let names = [];
  try {
    names = fs.readdirSync(scope.dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (PURGE_KEEP.has(name)) continue;
    if (name.includes('.tmp')) fs.rmSync(path.join(scope.dir, name), { force: true });
  }
}

function fileContains(file, sentinels) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const sentinel of sentinels) {
    if (raw.includes(sentinel)) return true;
    const escaped = JSON.stringify(sentinel).slice(1, -1);
    if (escaped !== sentinel && raw.includes(escaped)) return true;
    const lines = sentinel.split('\n').map((line) => line.trim()).filter((line) => line.length >= 4);
    for (const line of lines) {
      if (raw.includes(line) || raw.includes(JSON.stringify(line).slice(1, -1))) return true;
    }
  }
  return false;
}

/** 清理后自检：还有受管副本就留在 purge_pending，不提前报成功。 */
function leftoversIn(scope, sentinels) {
  if (!sentinels.length) return [];
  const hits = [];
  const walk = (dir) => {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of names) {
      const file = path.join(dir, dirent.name);
      if (dirent.isDirectory()) walk(file);
      else if (dirent.name !== '.lock' && fileContains(file, sentinels)) hits.push(dirent.name);
    }
  };
  walk(scope.dir);
  return hits;
}

/**
 * 彻底删除：锁内先落 intent 当屏障，再整份发布删除后的状态并旋转 epoch，
 * 然后把 prev 覆盖成删除后的状态、清掉受管旧副本，自检通过才移除 intent。
 * 任何一步中断都停在 purge_pending，重启后由 resumePurge 续做。
 */
export function purge(scope, options = {}) {
  return withScopeLock(scope, () => {
    const existing = purgeIntent(scope);
    if (existing && options.resume !== true) {
      throw new StateError('purge_pending', `上一次彻底删除没做完（${existing.operationId}），先调用 resumePurge 收尾`);
    }
    let loaded = load(scope, { allowPurge: true });
    let intent = existing;
    if (!intent) {
      const ids = [...new Set((Array.isArray(options.ids) ? options.ids : [])
        .filter((id) => typeof id === 'string' && /^mem_[a-z0-9]{6,}$/.test(id)))];
      if (!ids.length) throw new StateError('invalid', '没有要彻底删除的条目');
      intent = {
        operationId: typeof options.operationId === 'string' && options.operationId
          ? options.operationId
          : `purge_${crypto.randomBytes(6).toString('hex')}`,
        scopeKey: scope.key,
        storeId: loaded.state.storeId,
        fromEpoch: loaded.state.epoch,
        toEpoch: crypto.randomUUID(),
        ids,
        phase: 'planned',
        at: new Date().toISOString(),
      };
      writeDurable(purgeIntentFile(scope), `${JSON.stringify(intent, null, 2)}\n`);
      loaded = load(scope, { allowPurge: true });
    }
    const ids = new Set(intent.ids);
    const removed = loaded.state.entries.filter((entry) => ids.has(entry.id));
    const alreadyPublished = loaded.state.epoch === intent.toEpoch;
    if (alreadyPublished) {
      writeDurable(prevFile(scope), encodeState(loaded.state));
      cleanupManaged(scope);
      fs.rmSync(purgeIntentFile(scope), { force: true });
      return { ok: true, replay: true, ids: [...ids], operationId: intent.operationId, epoch: loaded.state.epoch, generation: loaded.state.generation, scopeKey: scope.key };
    }
    if (!removed.length) {
      fs.rmSync(purgeIntentFile(scope), { force: true });
      return { ok: true, missing: true, ids: [...ids], operationId: intent.operationId, epoch: loaded.state.epoch, generation: loaded.state.generation, scopeKey: scope.key };
    }
    const draft = JSON.parse(JSON.stringify(loaded.state));
    const sentinels = [];
    for (const entry of removed) sentinels.push(...sentinelsOf(entry));
    draft.entries = draft.entries.filter((entry) => !ids.has(entry.id));
    draft.candidates = (draft.candidates || []).filter((row) => !ids.has(row.targetId)
      && !ids.has(row.draft && row.draft.targetId));
    const now = new Date().toISOString();
    for (const entry of removed) {
      draft.suppressions.push({
        fingerprint: fingerprintOf(entry.current),
        sourceIds: Array.isArray(entry.maintenance && entry.maintenance.sourceRefs) ? [...entry.maintenance.sourceRefs] : [],
        reason: 'forgotten_source',
        at: now,
        expiresAt: null,
      });
    }
    draft.suppressions = pruneSuppressions(draft.suppressions);
    draft.receipts = [{
      operationId: intent.operationId,
      changed: true,
      revisionAfter: loaded.state.generation + 1,
      kind: 'purge',
      at: now,
    }];
    draft.epoch = intent.toEpoch;
    draft.generation = loaded.state.generation + 1;
    draft.updatedAt = now;
    validateState(draft);
    publish(scope, draft, loaded.exists);
    writeDurable(prevFile(scope), encodeState(draft));
    cleanupManaged(scope);
    const leftovers = leftoversIn(scope, sentinels);
    if (leftovers.length) {
      throw new StateError('purge_pending', `还有受管副本没清掉（${leftovers.join('、')}），重试继续清理`);
    }
    fs.rmSync(purgeIntentFile(scope), { force: true });
    return {
      ok: true,
      ids: [...ids],
      operationId: intent.operationId,
      epoch: draft.epoch,
      generation: draft.generation,
      scopeKey: scope.key,
    };
  });
}

export function resumePurge(scope) {
  return purge(scope, { resume: true });
}
