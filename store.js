import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Hard limits. Nothing grows without either an explicit error or a bounded,
 * oldest-first archive move — no silent truncation of what the user asked to keep.
 */
export const LIMITS = {
  entries: 200,
  globalEntries: 200,
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

/** Record types the model may pick. Anything else is a schema error, not a guess. */
export const KINDS = ['preference', 'convention', 'procedure', 'pointer', 'pitfall', 'credential_hint', 'note'];

/** Strings that mean "this is a credential", never a memory. */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*\S{6,}/i,
  /[A-Za-z0-9+/]{60,}={0,2}/,
];

/** A summary is a noun phrase. An imperative turns a note into an instruction. */
const IMPERATIVE = /^(?:你要|你得|你必须|请|务必|必须|记得|记住|别忘了|do not|don't|please|you (?:must|should|need))/i;

export function memoryRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'lite-memory');
}

/** One store per project directory, so projects never see each other. */
export function scopeOf(cwd) {
  const abs = path.resolve(cwd || process.cwd());
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 8);
  const label = path.basename(abs).replace(/[^\w.-]+/g, '-').slice(0, 32) || 'root';
  return { key: `${label}-${hash}`, dir: path.join(memoryRoot(), `${label}-${hash}`), cwd: abs };
}

/** 跨项目通用的那层：用户说「以后所有项目都这样」才写这里。 */
export function globalScope() {
  return { key: 'global', dir: path.join(memoryRoot(), 'global'), cwd: '' };
}

function indexFile(scope) {
  return path.join(scope.dir, 'index.json');
}

function entryFile(scope, id) {
  return path.join(scope.dir, 'entries', `${id}.md`);
}

function emptyIndex(scope) {
  return { version: 1, scope: scope.key, entries: [], suggestions: [], receipts: [] };
}

/**
 * 只有 ENOENT 才算「还没用过」。JSON 损坏、没有读权限必须报错，
 * 否则下一次写入会拿空库覆盖掉整个索引。
 */
export function loadIndex(scope) {
  const file = indexFile(scope);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyIndex(scope);
    throw new Error(`记忆索引读不出来（${error.code || 'IO'}）：${file}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`记忆索引已损坏，已停止读写：${file}`);
  }
  if (!data || !Array.isArray(data.entries)) throw new Error(`记忆索引结构不对，已停止读写：${file}`);
  if (!Array.isArray(data.suggestions)) data.suggestions = [];
  if (!Array.isArray(data.receipts)) data.receipts = [];
  return data;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function saveIndex(scope, index) {
  index.version = 1;
  index.scope = scope.key;
  index.cwd = scope.cwd;
  index.updated = new Date().toISOString();
  index.totalBytes = index.entries.reduce((sum, item) => sum + (item.bytes || 0), 0)
    + index.suggestions.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.draft || {})), 0);
  const text = `${JSON.stringify(index, null, 2)}\n`;
  const bytes = Buffer.byteLength(text);
  if (bytes > LIMITS.stateBytes) {
    throw new Error(`记忆索引超过 ${LIMITS.stateBytes} 字节，先归档旧的再写`);
  }
  writeAtomic(indexFile(scope), text);
  return index;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no Atomics: plain wait below */
  }
}

/**
 * 整个作用域一把锁：两个 DSH 进程共用全局库时，读—改—写必须串行。
 * 锁里写 ownerToken，只释放自己那把；不按 mtime 抢活进程的锁，
 * 崩溃留下的锁要人工确认后再删，宁可 busy 也不写坏。
 */
function withLock(scope, fn) {
  fs.mkdirSync(scope.dir, { recursive: true });
  const file = path.join(scope.dir, '.lock');
  const token = `${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
  const deadline = Date.now() + LIMITS.lockWaitMs;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(file, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error(`记忆库加锁失败（${error.code || 'IO'}）：${file}`);
      if (Date.now() > deadline) {
        throw new Error(`记忆库正忙（另一个进程在写），稍后再试；若确认没有写入进程，删掉 ${file}`);
      }
      sleepSync(10);
    }
  }
  try {
    try {
      fs.writeSync(fd, token);
    } catch {
      /* token is advisory; the lock file itself is the mutex */
    }
    return fn();
  } finally {
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

/** Locks several scopes in a stable order, so search across layers cannot deadlock. */
function withLocks(scopes, fn) {
  const unique = [];
  for (const scope of scopes) if (!unique.some((item) => item.dir === scope.dir)) unique.push(scope);
  unique.sort((a, b) => a.dir.localeCompare(b.dir));
  const run = (index) => (index === unique.length ? fn() : withLock(unique[index], () => run(index + 1)));
  return run(0);
}

export function detectSecret(text) {
  const hit = SECRET_PATTERNS.find((re) => re.test(String(text || '')));
  return hit ? hit.source : null;
}

export function normalizeText(value, max) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 超限就报错，不 slice：写的人要自己决定删哪句，存进来的东西要完整。 */
function textField(value, max, label) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new Error(`${label}超过 ${max} 字，先写短些`);
  return text;
}

/**
 * 标题就是身份，只做无损空白规范化：不切分隔符、不剥条件、不去标点。
 * 超长在 textField 里直接报错，不截断；标题写坏了是调用方的输入问题，不能靠改名字掩盖。
 */
function cleanTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function validSummary(summary) {
  const text = String(summary ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: '摘要为空' };
  if (text.length > LIMITS.summaryChars) return { ok: false, reason: `摘要超过 ${LIMITS.summaryChars} 字，先写短些` };
  if (IMPERATIVE.test(text)) return { ok: false, reason: '摘要必须写成名词短语，不能写成指令' };
  return { ok: true, text };
}

/**
 * 所有落盘入口共用的唯一草稿结构与校验：直接保存、提出建议、点 keep 都从这里过。
 * 凭据检查覆盖全部文本字段；正文按 UTF-8 字节检查，不做语义截断。
 * `has` 记录调用方到底提供了哪些字段，更新时没提供的保持原值。
 */
export function normalizeDraft(source, options = {}) {
  const draft = typeof source === 'string' ? { title: source } : source && typeof source === 'object' ? source : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(draft, key) && draft[key] !== undefined;
  const id = typeof draft.id === 'string' && /^mem_[a-z0-9]+$/.test(draft.id) ? draft.id : '';
  if (has('id') && !id) throw new Error('id 格式不对');
  const when = has('when') ? textField(draft.when, LIMITS.whenChars, '前置条件') : '';
  const title = textField(cleanTitle(draft.title), LIMITS.titleChars, '标题');
  if (!title) throw new Error('标题为空');
  let summary = '';
  const rawSummary = String(draft.summary ?? '').replace(/\s+/g, ' ').trim();
  if (rawSummary) {
    const check = validSummary(rawSummary);
    if (!check.ok) throw new Error(check.reason);
    summary = check.text;
  } else if (has('summary')) {
    throw new Error('摘要为空');
  }
  /** 更新（带 id）与候选草稿允许省略摘要；省略表示保持原值，不拿标题补。 */
  const mayOmitSummary = options.requireSummary === false || Boolean(id);
  if (!summary && !mayOmitSummary) throw new Error('摘要为空');
  const body = String(draft.body ?? '').trim();
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes > LIMITS.entryBytes) {
    throw new Error(`正文 ${bodyBytes} 字节，超过单条 ${LIMITS.entryBytes} 字节；先精简，别让尾部条件被截掉`);
  }
  const kind = has('kind') ? textField(draft.kind, 20, '类型') : 'note';
  if (kind && !KINDS.includes(kind)) throw new Error(`类型只能是 ${KINDS.join(' / ')}`);
  const rawTags = has('tags') ? draft.tags : [];
  if (!Array.isArray(rawTags)) throw new Error('标签必须是数组');
  if (rawTags.length > LIMITS.tags) throw new Error(`标签最多 ${LIMITS.tags} 个`);
  const tags = [...new Set(rawTags.map((tag) => textField(tag, LIMITS.tagChars, '标签')).filter(Boolean))];
  const secret = detectSecret([title, summary, when, body, tags.join(' ')].join('\n'));
  if (secret) throw new Error(`疑似凭据（${secret}），只记位置，不记值`);
  return {
    id,
    title,
    summary,
    when,
    body,
    kind: kind || 'note',
    tags,
    has: {
      title: has('title'),
      summary: has('summary'),
      when: has('when'),
      body: has('body'),
      kind: has('kind'),
      tags: has('tags'),
    },
  };
}

function newId() {
  return `mem_${crypto.randomBytes(6).toString('hex')}`;
}

function readBody(scope, id) {
  try {
    return fs.readFileSync(entryFile(scope, id), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`记忆正文缺失：${id} 在索引里，但正文文件不在了`);
    throw new Error(`记忆正文读不出来（${error.code || 'IO'}）：${id}`);
  }
}

function writeBody(scope, id, body) {
  writeAtomic(entryFile(scope, id), body);
}

function removeBody(scope, id) {
  try {
    fs.rmSync(entryFile(scope, id), { force: true });
  } catch {
    /* leftover body is harmless; the index no longer references it */
  }
}

function entrySize(record, body) {
  return Buffer.byteLength([record.title, record.when, record.summary, (record.tags || []).join(','), body].join('\n'));
}

function recordSize(record) {
  return Buffer.byteLength(JSON.stringify({ ...record, versions: [] }));
}

function activeBytes(index, skipId) {
  return index.entries.reduce((sum, item) => (item.id === skipId ? sum : sum + (item.bytes || 0)), 0);
}

function archiveEntry(scope, index, entry) {
  const dir = path.join(scope.dir, 'archive');
  const from = entryFile(scope, entry.id);
  fs.mkdirSync(dir, { recursive: true });
  const body = readBody(scope, entry.id);
  if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, `${entry.id}.md`));
  writeAtomic(path.join(dir, `${entry.id}.json`), `${JSON.stringify({ ...entry, body }, null, 2)}\n`);
  index.entries = index.entries.filter((item) => item.id !== entry.id);
}

/**
 * 满额不驱逐：条数上限只做明确拒绝，让用户自己归档或彻底遗忘。
 * 自动按最久未用移走会把用户的规则悄悄挪进归档，读的时候看不见也不报错。
 */
export function capacityOf(scope, index) {
  const cap = scope.key === 'global' ? LIMITS.globalEntries : LIMITS.entries;
  return { cap, used: index.entries.length, remaining: Math.max(0, cap - index.entries.length) };
}

/** 相邻两字为一组：中文没有空格，按词切分永远对不上，按字片才认得出改写的同一件事。 */
function bigrams(text) {
  const plain = normalizeText(text, 400).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (!plain) return new Set();
  if (plain.length < 2) return new Set([plain]);
  const out = new Set();
  for (let i = 0; i + 1 < plain.length; i += 1) out.add(plain.slice(i, i + 2));
  return out;
}

export function similarity(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * 身份只由「标题 / 用过的旧标题 + 前置条件」决定，相似度不授权覆盖。
 * 精确同名同条件才算同一条；相近只作为候选返回，让调用方决定。
 */
export function resolveTarget(entries, draft, whenArg) {
  const title = typeof draft === 'string' ? normalizeText(draft, LIMITS.titleChars) : draft.title;
  const when = typeof draft === 'string' ? normalizeText(whenArg, LIMITS.whenChars) : draft.when || '';
  const plain = normalizeText(title, LIMITS.titleChars).toLowerCase();
  for (const item of entries) {
    if ((item.when || '') !== when) continue;
    const names = [item.title, ...(item.aliases || [])].map((name) => String(name || '').toLowerCase());
    if (names.includes(plain)) return { target: item, score: 1 };
  }
  return null;
}

/** 相近线只用于「提示 / 候选」，与合并无关。 */
export const MERGE = { near: 0.3 };

/** 最多两条最接近的条目：看得到具体 id 和标题，才有可能选对。 */
export function similarEntries(entries, title, summary, limit = 2) {
  const rows = [];
  for (const item of entries) {
    const names = [item.title, ...(item.aliases || [])];
    const titleScore = Math.max(0, ...names.map((name) => similarity(name, title)));
    const summaryScore = similarity(item.summary, summary);
    const score = Math.max(titleScore, summaryScore);
    if (score >= MERGE.near) rows.push({ id: item.id, title: item.title, summary: item.summary, when: item.when || '', score });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit);
}

/** 没有合并时，把最接近的那条报出来：看得到，才有可能纠正。 */
export function nearestEntry(entries, title, summary) {
  return similarEntries(entries, title, summary, 1)[0] || null;
}

/** 旧版本整段保留，字段齐全，恢复时可以连标题与条件一起还原。 */
function snapshot(record, body) {
  if (!body) return record.versions || [];
  const version = {
    at: record.updated || record.created || new Date().toISOString(),
    title: record.title,
    summary: record.summary,
    when: record.when || '',
    kind: record.kind || 'note',
    tags: [...(record.tags || [])],
    body,
  };
  let kept = [...(record.versions || []), version].slice(-2);
  while (kept.length > 1 && kept.reduce((sum, item) => sum + Buffer.byteLength(item.body), 0) > LIMITS.historyBytes) {
    kept = kept.slice(1);
  }
  return kept;
}

/**
 * 一次写入的纯业务部分：校验、身份、字节预算、版本。不改盘（正文写入由调用方在同一把锁里做）。
 */
function applyDraft(scope, index, source, now) {
  const draft = normalizeDraft(source);
  const distinct = source && source.resolution === 'distinct';
  let record = draft.id ? index.entries.find((item) => item.id === draft.id) : null;
  if (draft.id && !record) throw new Error('没有这条记忆，改用新增');
  let mergedFrom = null;
  let similarList = [];
  if (!record) {
    /** distinct 是用户明确说的「这是另一条」：同名也另起一条，不被规范化后的精确同名吞掉。 */
    const hit = distinct ? null : resolveTarget(index.entries, draft);
    if (hit) {
      record = hit.target;
      mergedFrom = hit.target.title === draft.title ? null : hit.target.title;
    } else {
      similarList = similarEntries(index.entries, draft.title, draft.summary, 2);
      /** 同名不同前置条件是用户明确表达的另一条，不走确认；只有换个说法的相近标题才拦。 */
      const sameName = index.entries.some((item) => [item.title, ...(item.aliases || [])]
        .some((name) => String(name || '').toLowerCase() === draft.title.toLowerCase()));
      if (similarList.length > 0 && !distinct && !sameName) {
        return { needsResolution: true, similarList, similar: similarList[0], draft, record: null, merged: false, previousBody: null };
      }
    }
  }
  if (record) {
    const oldBody = readBody(scope, record.id);
    const next = {
      title: draft.title,
      summary: draft.has.summary ? draft.summary : record.summary || '',
      when: draft.has.when ? draft.when : record.when || '',
      kind: draft.has.kind ? draft.kind || 'note' : record.kind || 'note',
      tags: draft.has.tags ? draft.tags : record.tags || [],
      body: draft.has.body ? draft.body : oldBody,
    };
    const sameTags = JSON.stringify(next.tags) === JSON.stringify(record.tags || []);
    const noop = next.title === record.title && next.summary === record.summary
      && next.when === (record.when || '') && next.kind === (record.kind || 'note')
      && sameTags && next.body === oldBody;
    if (noop) {
      return { record, merged: true, mergedFrom: null, similar: null, similarList, draft, noop: true, previousBody: oldBody };
    }
    const versions = snapshot(record, oldBody);
    const titles = [...new Set([...(record.aliases || []), record.title].map((name) => cleanTitle(name)).filter(Boolean))].slice(-5);
    const nextRecord = {
      ...record,
      ...next,
      aliases: titles,
      versions,
      revision: (record.revision || 1) + 1,
      updated: now,
      lastUsed: now,
      merges: (record.merges || 0) + 1,
      status: 'active',
      source: record.source || (source && source.source) || 'user_explicit',
    };
    nextRecord.bytes = entrySize(nextRecord, next.body);
    assertFits(index, nextRecord);
    writeBody(scope, record.id, next.body);
    Object.assign(record, nextRecord);
    return { record, merged: true, mergedFrom, similar: null, similarList, draft, noop: false, previousBody: oldBody };
  }
  const created = {
    id: newId(),
    title: draft.title,
    summary: draft.summary,
    when: draft.when,
    kind: draft.kind,
    tags: draft.tags,
    body: draft.body,
    aliases: [],
    created: now,
    updated: now,
    lastUsed: now,
    revision: 1,
    status: 'active',
    source: source && source.source === 'observed' ? 'observed' : 'user_explicit',
    hits: 0,
    merges: 0,
    versions: [],
    bytes: 0,
  };
  created.bytes = entrySize(created, created.body);
  assertFits(index, created);
  writeBody(scope, created.id, created.body);
  index.entries.push(created);
  return { record: created, merged: false, mergedFrom: null, similar: similarList[0] || null, similarList, draft, noop: false, previousBody: null };
}

/** 单条、记录序列化、整库三档预算：新增与更新走同一套。 */
function assertFits(index, record) {
  const isNew = !index.entries.some((item) => item.id === record.id);
  if (isNew) {
    const cap = index.scope === 'global' ? LIMITS.globalEntries : LIMITS.entries;
    if (index.entries.length + 1 > cap) {
      throw new Error(`记忆已满：${index.scope === 'global' ? '全局' : '这个项目'}最多 ${cap} 条，先归档或彻底遗忘一条`);
    }
  }
  if (record.bytes > LIMITS.entryBytes) {
    throw new Error(`这一条 ${record.bytes} 字节，超过单条 ${LIMITS.entryBytes} 字节；先精简正文`);
  }
  const size = recordSize(record);
  if (size > LIMITS.recordBytes) {
    throw new Error(`这一条序列化后 ${size} 字节，超过 ${LIMITS.recordBytes} 字节；减少字段或换更短的标签`);
  }
  const total = activeBytes(index, record.id) + record.bytes;
  if (total > LIMITS.totalBytes) {
    throw new Error(`记忆库已满：这一条会让总正文到 ${total} 字节，超过 ${LIMITS.totalBytes} 字节；先归档旧的`);
  }
}

/**
 * 保存。带 id 就是明确更新那条（没给的字段保持原值）；不带 id 时只认标题 / 旧标题 + 同一前置条件。
 * 文本相近不授权覆盖，也不先写一条再更新：返回 needsResolution，调用方决定 distinct 还是按 id 更新。
 */
export function upsert(scope, source) {
  return withLock(scope, () => {
    const index = loadIndex(scope);
    const now = new Date().toISOString();
    const result = applyDraft(scope, index, source, now);
    if (!('needsResolution' in result)) result.needsResolution = false;
    if (result.needsResolution) return result;
    try {
      saveIndex(scope, index);
    } catch (error) {
      if (result.record && result.previousBody !== null) {
        try {
          writeBody(scope, result.record.id, result.previousBody);
        } catch {
          /* keep the original error */
        }
      } else if (result.record) {
        removeBody(scope, result.record.id);
      }
      throw error;
    }
    return result;
  });
}

const MATCH_WEIGHT = { title: 3, alias: 2, summary: 2, tags: 1.5 };

function scoreQuery(item, grams, raw) {
  const fields = [
    [item.title, MATCH_WEIGHT.title],
    [(item.aliases || []).join(' '), MATCH_WEIGHT.alias],
    [item.summary, MATCH_WEIGHT.summary],
    [item.when, MATCH_WEIGHT.alias],
    [(item.tags || []).join(' '), MATCH_WEIGHT.tags],
  ];
  let score = 0;
  for (const [text, weight] of fields) {
    if (!text) continue;
    const pool = bigrams(text);
    let shared = 0;
    for (const gram of grams) if (pool.has(gram)) shared += 1;
    score += shared * weight;
  }
  const plain = normalizeText(raw, 200).toLowerCase().replace(/\s+/g, '');
  if (plain && normalizeText(item.title, 200).toLowerCase().replace(/\s+/g, '').includes(plain)) score += 5;
  return score;
}

/**
 * 按需检索：项目层 + 全局层，最多 limit 条。
 * 返回的记录带着「本次检索之前」的 lastUsed，给 renderIndex 判断陈旧用；
 * 命中计数在返回前写入，所以同一次调用既改盘又不污染展示。
 */
export function search(scope, query, limit = 4) {
  return withLocks([scope, globalScope()], () => {
    const grams = bigrams(query);
    if (grams.size === 0) return [];
    const rows = [];
    for (const source of [scope, globalScope()]) {
      const index = loadIndex(source);
      for (const item of index.entries) {
        const score = scoreQuery(item, grams, query);
        if (score > 0) rows.push({ source, index, item, score });
      }
    }
    rows.sort((a, b) => b.score - a.score || String(b.item.lastUsed).localeCompare(String(a.item.lastUsed)));
    const chosen = rows.slice(0, limit);
    const now = new Date().toISOString();
    for (const row of chosen) {
      row.snapshot = { ...row.item, scope: row.source.key === 'global' ? 'global' : 'project' };
      row.item.hits = (row.item.hits || 0) + 1;
      row.item.lastUsed = now;
    }
    const touched = new Set();
    for (const row of chosen) {
      if (touched.has(row.source.dir)) continue;
      touched.add(row.source.dir);
      saveIndex(row.source, row.index);
    }
    return chosen.map((row) => row.snapshot);
  });
}

/**
 * 只读命中：给自动提示用。不改 hits / lastUsed，不落盘。
 * 标题（含旧标题）必须真跟查询有交集，否则长句里零星重合也会冒出提示。
 */
export function peek(scope, query, limit = 3) {
  const grams = bigrams(query);
  if (grams.size === 0) return [];
  const rows = [];
  for (const source of [scope, globalScope()]) {
    let index;
    try {
      index = loadIndex(source);
    } catch {
      continue;
    }
    for (const item of index.entries) {
      if (!item || !item.title) continue;
      const pool = bigrams(`${item.title} ${(item.aliases || []).join(' ')}`);
      let shared = 0;
      for (const gram of grams) if (pool.has(gram)) shared += 1;
      if (shared === 0) continue;
      const score = scoreQuery(item, grams, query);
      if (score < 6) continue;
      rows.push({ item, source, score });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit).map(({ item, source }) => ({
    id: item.id,
    title: item.title,
    summary: item.summary || '',
    scope: source.key === 'global' ? 'global' : 'project',
  }));
}

export function readEntry(scope, id) {
  return withLocks([scope, globalScope()], () => {
    for (const source of [scope, globalScope()]) {
      const index = loadIndex(source);
      const record = index.entries.find((item) => item.id === id);
      if (!record) continue;
      const body = readBody(source, id);
      record.hits = (record.hits || 0) + 1;
      record.lastUsed = new Date().toISOString();
      saveIndex(source, index);
      return { ...record, scope: source.key === 'global' ? 'global' : 'project', body };
    }
    return null;
  });
}

/** 归档，不是删除：正文和完整记录一起进 archive/，文件移动成功后才改索引。 */
export function forget(scope, id) {
  return withLocks([scope, globalScope()], () => {
    for (const source of [scope, globalScope()]) {
      const index = loadIndex(source);
      const record = index.entries.find((item) => item.id === id);
      if (!record) continue;
      archiveEntry(source, index, record);
      saveIndex(source, index);
      return { id: record.id, title: record.title, mode: 'archive' };
    }
    return null;
  });
}

/** 撤销一次修改：有旧版本就整条还原成新 revision；没有旧版本（新建的）就归档。 */
export function undoChange(scope, id) {
  return withLocks([scope, globalScope()], () => {
    for (const source of [scope, globalScope()]) {
      const index = loadIndex(source);
      const record = index.entries.find((item) => item.id === id);
      if (!record) continue;
      const versions = record.versions || [];
      const last = versions[versions.length - 1];
      if (!last) {
        archiveEntry(source, index, record);
        saveIndex(source, index);
        return { id: record.id, title: record.title, mode: 'archived' };
      }
      const currentBody = readBody(source, record.id);
      const restored = {
        ...record,
        title: last.title || record.title,
        summary: last.summary || record.summary,
        when: last.when || '',
        kind: last.kind || record.kind,
        tags: Array.isArray(last.tags) ? last.tags : record.tags,
        versions: versions.slice(0, -1),
        revision: (record.revision || 1) + 1,
        updated: new Date().toISOString(),
      };
      writeBody(source, record.id, last.body);
      Object.assign(record, restored);
      record.bytes = entrySize(record, last.body);
      try {
        saveIndex(source, index);
      } catch (error) {
        writeBody(source, record.id, currentBody);
        throw error;
      }
      return { id: record.id, title: record.title, mode: 'restored' };
    }
    return null;
  });
}

/** 按 id 在项目层与全局层里找位置，不靠文案猜作用域。 */
export function locate(scope, id) {
  for (const source of [scope, globalScope()]) {
    const record = loadIndex(source).entries.find((item) => item.id === id);
    if (record) return { scope: source, record };
  }
  return null;
}

function pruneSuggestions(index) {
  const now = Date.now();
  index.suggestions = (index.suggestions || []).filter((item) => {
    const expires = Date.parse(item.expiresAt || '');
    return Number.isFinite(expires) && expires > now;
  });
}

function pruneReceipts(index) {
  const now = Date.now();
  index.receipts = (index.receipts || []).filter((item) => {
    const at = Date.parse(item.at || '');
    return Number.isFinite(at) && now - at < LIMITS.receiptTtlMs;
  }).slice(-LIMITS.receipts);
  return index.receipts;
}

/**
 * 建议门限：已有同一条就不再建议；相近的另一条可以建议，但必须带着 targetId
 * 走候选确认，不能直接改正式条目。
 */
export function suggestionGate(scope, source) {
  return withLock(scope, () => {
    const index = loadIndex(scope);
    pruneSuggestions(index);
    const title = normalizeText(source?.title, LIMITS.titleChars);
    if (!title) return { ok: false, reason: '没有标题' };
    const summary = normalizeText(source?.summary, LIMITS.summaryChars);
    const when = normalizeText(source?.when, LIMITS.whenChars);
    const hit = resolveTarget(index.entries, { title, summary, when });
    if (hit) return { ok: false, reason: `已有「${hit.target.title}」，这次不重复建议` };
    const near = similarEntries(index.entries, title, summary, 1)[0];
    if (near) return { ok: true, target: { id: near.id, title: near.title, revision: near.revision || 1 } };
    const last = Date.parse(index.lastSuggestedAt || '');
    if (Number.isFinite(last) && Date.now() - last < LIMITS.suggestionWindowMs) {
      return { ok: false, reason: '48 小时内已经建议过一条' };
    }
    return { ok: true };
  });
}

/**
 * 待确认草稿与正式条目走同一个校验器：凭据、大小、必填都在这里拦住。
 * 草稿在确认前就落盘（本地待确认区），所以撤回/过期都要能查到。
 */
export function noteSuggestion(scope, source, decision = 'asked') {
  return withLock(scope, () => {
    const draft = normalizeDraft(source, { requireSummary: false });
    const index = loadIndex(scope);
    pruneSuggestions(index);
    const at = new Date();
    const targetId = typeof source?.targetId === 'string' ? source.targetId : '';
    const target = targetId ? index.entries.find((item) => item.id === targetId) : null;
    if (targetId && !target) throw new Error('候选指向的条目不存在');
    const record = {
      id: `sug_${crypto.randomBytes(4).toString('hex')}`,
      title: draft.title,
      at: at.toISOString(),
      expiresAt: new Date(at.getTime() + LIMITS.suggestionTtlMs).toISOString(),
      decision,
      draft: {
        title: draft.title,
        summary: draft.summary,
        when: draft.when,
        body: draft.body,
        kind: draft.kind,
        tags: draft.tags,
        /** 字段「有」和「空」不是一回事：确认时只写真正给过的字段。 */
        has: { ...draft.has },
        targetId: target ? target.id : '',
        targetRevision: target ? target.revision || 1 : 0,
      },
    };
    const next = [...(index.suggestions || []), record];
    const bytes = next.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.draft || {})), 0);
    if (bytes > LIMITS.pendingBytes || next.length > LIMITS.pending) {
      throw new Error('待确认的候选已满，先处理旧的');
    }
    index.suggestions = next;
    index.lastSuggestedAt = at.toISOString();
    saveIndex(scope, index);
    return {
      id: record.id,
      title: draft.title,
      expiresAt: record.expiresAt,
      targetId: record.draft.targetId,
      targetTitle: target ? target.title : '',
    };
  });
}

/** 待保留的那条建议：按 id 取，过期/已存下的不再返回。 */
export function findSuggestion(scope, key) {
  const index = loadIndex(scope);
  pruneSuggestions(index);
  const item = (index.suggestions || []).find((entry) => entry.id === key && entry.decision === 'asked');
  if (!item) return null;
  return { ...item.draft, suggestionId: item.id };
}

/**
 * 点「保留」：在同一个锁窗口里按 candidateId 确认、消费候选、写回执。
 * 已消费的候选不再写第二条；旧的 keep 重放返回原回执。
 */
export function acceptCandidate(scope, key, operationId = '') {
  return withLock(scope, () => {
    const index = loadIndex(scope);
    pruneSuggestions(index);
    pruneReceipts(index);
    const replay = (index.receipts || []).find((item) => (operationId && item.operationId === operationId)
      || (!operationId && item.candidateId === key && item.status === 'accepted'));
    if (replay) return { ok: true, replay: true, id: replay.entryId || '', title: replay.title || '', reason: '这条候选已经处理过' };
    const item = (index.suggestions || []).find((entry) => entry.id === key && entry.decision === 'asked');
    if (!item) return { ok: false, reason: '候选不存在或已过期' };
    const draft = item.draft || {};
    const target = draft.targetId ? index.entries.find((entry) => entry.id === draft.targetId) : null;
    if (draft.targetId && !target) return { ok: false, reason: '候选要更新的那条记忆已不在了' };
    if (target && draft.targetRevision && (target.revision || 1) !== draft.targetRevision) {
      return { ok: false, reason: '那条记忆在你确认前改过了，重新建议一次' };
    }
    /** 只把建议里真有的字段交给写入：省略表示保持，显式空正文清空；旧候选没有 has 时按有没有值回退。 */
    const source = { title: draft.title };
    const has = draft.has && typeof draft.has === 'object' ? draft.has : null;
    if (has) {
      if (has.summary) source.summary = draft.summary;
      if (has.when) source.when = draft.when;
      if (has.kind) source.kind = draft.kind;
      if (has.tags) source.tags = Array.isArray(draft.tags) ? draft.tags : [];
      if (has.body) source.body = draft.body;
    } else {
      if (draft.summary) source.summary = draft.summary;
      if (draft.when) source.when = draft.when;
      if (draft.kind) source.kind = draft.kind;
      if (Array.isArray(draft.tags)) source.tags = draft.tags;
      if (draft.body) source.body = draft.body;
    }
    if (target) source.id = target.id;
    const now = new Date().toISOString();
    try {
      const result = applyDraft(scope, index, source, now);
      if (result.needsResolution) return { ok: false, reason: '候选与已有条目相近，需要确认', similar: result.similarList };
      index.suggestions = (index.suggestions || []).filter((entry) => entry.id !== item.id);
      index.receipts = [...(index.receipts || []), {
        operationId: operationId || `op_${crypto.randomBytes(6).toString('hex')}`,
        candidateId: item.id,
        entryId: result.record.id,
        title: result.record.title,
        status: 'accepted',
        at: now,
      }].slice(-LIMITS.receipts);
      saveIndex(scope, index);
      return { ok: true, replay: false, id: result.record.id, title: result.record.title, mode: result.merged ? 'updated' : 'created' };
    } catch (error) {
      throw error;
    }
  });
}

/** 拒绝一个候选：只消费这条草稿，不产生抑制规则。 */
export function rejectCandidate(scope, key) {
  return withLock(scope, () => {
    const index = loadIndex(scope);
    const before = (index.suggestions || []).length;
    index.suggestions = (index.suggestions || []).filter((entry) => entry.id !== key);
    if (index.suggestions.length === before) return { ok: false, reason: '候选不存在或已过期' };
    saveIndex(scope, index);
    return { ok: true };
  });
}

/** The compact index handed to the model: one noun-phrase line per entry, hard capped. */
export function renderIndex(entries, budget = 400) {
  const staleMs = 90 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const lines = [];
  let used = 0;
  for (const item of entries) {
    const last = Date.parse(item.lastUsed || item.updated || item.created || '') || now;
    const stale = now - last > staleMs;
    const head = `${item.scope === 'global' ? '[全局] ' : ''}${item.id} ${item.title}${item.when ? `（${item.when}）` : ''} · 第 ${item.revision || 1} 版`;
    const line = stale ? `- ${head}` : `- ${head}｜${item.summary}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join('\n'), chars: used };
}

/**
 * 会话引用：界面「N 条记忆引用」用的派生缓存，不是记忆本体。
 * 每个会话一个小文件，坏了就整份丢掉重来；记忆本身不受影响。
 */
const SESSION_ID = /^[A-Za-z0-9._-]{1,80}$/;

function sessionsDir() {
  return path.join(memoryRoot(), 'sessions');
}

function citationFile(sessionId) {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

function readSessionFile(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(citationFile(sessionId), 'utf8'));
    return data && Array.isArray(data.items) ? data : null;
  } catch {
    return null;
  }
}

/** 只留最近用过的若干个会话文件，旧的按上限与时间清掉。 */
function pruneSessions(keep) {
  const dir = sessionsDir();
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  const rows = names.map((name) => {
    const file = path.join(dir, name);
    let time = 0;
    try {
      time = fs.statSync(file).mtimeMs;
    } catch {
      /* gone already */
    }
    return { file, name, time };
  }).sort((a, b) => b.time - a.time);
  const now = Date.now();
  rows.forEach((row, index) => {
    if (row.name === `${keep}.json`) return;
    if (index < LIMITS.citationSessions && now - row.time <= LIMITS.citationTtlMs) return;
    try {
      fs.rmSync(row.file, { force: true });
    } catch {
      /* best effort */
    }
  });
}

/**
 * 记下「这些条目这次真的被读进了上下文」。同一 id 只留一条，最近的排前面。
 * 参数里的 scope 是读取时用的项目作用域；正文路径按条目自己的层算。
 */
export function recordCitations(scope, sessionId, items) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return [];
  const incoming = (Array.isArray(items) ? items : []).filter((item) => item && /^mem_[a-z0-9]{6,}$/.test(String(item.id || '')));
  const previous = readSessionFile(sessionId);
  const rows = new Map();
  const now = new Date().toISOString();
  for (const item of incoming) {
    const key = item.scope === 'global' ? 'global' : (typeof item.scopeKey === 'string' && item.scopeKey ? item.scopeKey : scope.key);
    rows.set(item.id, {
      id: item.id,
      scope: key === 'global' ? 'global' : 'project',
      key,
      at: now,
    });
  }
  for (const item of (previous && previous.items) || []) {
    if (!item || typeof item.id !== 'string' || rows.has(item.id)) continue;
    rows.set(item.id, item);
  }
  let next = [...rows.values()];
  while (next.length > 1 && Buffer.byteLength(JSON.stringify(next)) > LIMITS.citationBytes) next = next.slice(0, -1);
  next = next.slice(0, LIMITS.citations);
  const text = `${JSON.stringify({ sessionId, cwd: scope.cwd, updatedAt: now, items: next })}\n`;
  try {
    writeAtomic(citationFile(sessionId), text);
  } catch {
    return next;
  }
  pruneSessions(sessionId);
  return next;
}

const SCOPE_KEY = /^[A-Za-z0-9._-]{1,80}$/;

/** 引用的身份是「哪个 scope 的哪个 id」；旧文件里只有 path 时从目录名推回来。 */
function citationKey(row) {
  if (!row || typeof row !== 'object') return '';
  if (typeof row.key === 'string' && SCOPE_KEY.test(row.key)) return row.key;
  if (typeof row.path !== 'string') return '';
  const scopeDir = path.dirname(path.dirname(path.resolve(row.path)));
  if (path.dirname(scopeDir) !== memoryRoot()) return '';
  const key = path.basename(scopeDir);
  return SCOPE_KEY.test(key) ? key : '';
}

function scopeForKey(key) {
  if (key === 'global') return globalScope();
  if (!SCOPE_KEY.test(key)) return null;
  const dir = path.join(memoryRoot(), key);
  if (!path.resolve(dir).startsWith(memoryRoot() + path.sep)) return null;
  return { key, dir, cwd: '' };
}

/**
 * 引用只存身份，不存标题和正文：解析时一律读当前索引。
 * 目标不在了就整行失效，不回退旧缓存，也不按旧名字重建。
 */
function resolveCitation(row) {
  const key = citationKey(row);
  if (!key) return null;
  const scope = scopeForKey(key);
  if (!scope) return null;
  let entry = null;
  try {
    entry = (loadIndex(scope).entries || []).find((item) => item && item.id === row.id) || null;
  } catch {
    return null;
  }
  if (!entry) return null;
  return {
    key,
    scope,
    entry,
    row: {
      id: row.id,
      title: entry.title || '',
      scope: key === 'global' ? 'global' : 'project',
      revision: Number(entry.revision) || 1,
      when: entry.when || '',
      at: row.at,
    },
  };
}

/** 界面要的那几列：不返回正文，也不返回磁盘路径。 */
export function listCitations(sessionId) {
  const data = readSessionFile(sessionId);
  const items = ((data && data.items) || []).map(resolveCitation).filter(Boolean).map((item) => item.row);
  return { items, updatedAt: (data && data.updatedAt) || '' };
}

/** 点开一条时读当前正文；目标已删/已移出记忆根目录就返回空。 */
export function readCitationBody(sessionId, id) {
  const data = readSessionFile(sessionId);
  const row = ((data && data.items) || []).find((item) => item && item.id === id);
  if (!row) return null;
  const found = resolveCitation(row);
  if (!found) return null;
  const abs = path.resolve(entryFile(found.scope, id));
  if (!abs.startsWith(memoryRoot() + path.sep)) return null;
  let body;
  try {
    body = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  return { ...found.row, body: body.slice(0, LIMITS.entryBytes) };
}
