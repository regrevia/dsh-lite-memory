import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Hard limits. They are the whole reason this plugin stays small for years:
 * nothing is ever allowed to grow without pushing the oldest entry to archive/.
 */
export const LIMITS = {
  entries: 200,
  globalEntries: 40,
  entryBytes: 4096,
  bodyChars: 3000,
  totalBytes: 512 * 1024,
  titleChars: 60,
  whenChars: 60,
  summaryChars: 60,
  suggestionWindowMs: 48 * 60 * 60 * 1000,
  suggestionTtlMs: 48 * 60 * 60 * 1000,
  pending: 20,
};

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
  return { version: 1, scope: scope.key, entries: [], suggestions: [] };
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
  writeAtomic(indexFile(scope), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no Atomics: busy fallback below */
  }
}

/**
 * 整个作用域一把锁：两个 DSH 进程共用全局库时，读—改—写必须串行，
 * 否则两个保存都成功、索引只剩一条。
 */
function withLock(scope, fn) {
  fs.mkdirSync(scope.dir, { recursive: true });
  const file = path.join(scope.dir, '.lock');
  let fd = null;
  for (let attempt = 0; attempt < 200 && fd === null; attempt += 1) {
    try {
      fd = fs.openSync(file, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > 10_000) fs.rmSync(file, { force: true });
      } catch {
        /* the other process may have just released it */
      }
      sleepSync(5);
    }
  }
  if (fd === null) throw new Error('记忆库正被另一个进程写入，稍后再试');
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* stale lock is reclaimed by mtime */
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

export function validSummary(summary) {
  const text = normalizeText(summary, LIMITS.summaryChars);
  if (!text) return { ok: false, reason: '摘要为空' };
  if (IMPERATIVE.test(text)) return { ok: false, reason: '摘要必须写成名词短语，不能写成指令' };
  return { ok: true, text };
}

/**
 * 所有落盘入口共用的唯一草稿结构与校验：直接保存、提出建议、点 keep 都从这里过。
 * 凭据检查覆盖全部文本字段（正文、场景、标签也同样检查）。
 */
export function normalizeDraft(source, options = {}) {
  const draft = typeof source === 'string' ? { title: source } : source && typeof source === 'object' ? source : {};
  const rawTitle = String(draft.title ?? '').replace(/\s+/g, ' ').trim();
  const title = rawTitle.slice(0, LIMITS.titleChars);
  if (!title) throw new Error('标题为空');
  if (rawTitle.length > LIMITS.titleChars) {
    throw new Error(`标题超过 ${LIMITS.titleChars} 字，拆成两条或写短些`);
  }
  const rawSummary = String(draft.summary ?? '').replace(/\s+/g, ' ').trim();
  let summary = rawSummary.slice(0, LIMITS.summaryChars);
  if (!summary) {
    if (options.requireSummary === false) summary = title;
    else throw new Error('摘要为空');
  }
  if (rawSummary) {
    const check = validSummary(summary);
    if (!check.ok) throw new Error(check.reason);
    summary = check.text;
  }
  const when = normalizeText(draft.when, LIMITS.whenChars);
  const body = String(draft.body ?? '').trim().slice(0, LIMITS.bodyChars);
  const kind = typeof draft.kind === 'string' && draft.kind ? draft.kind : 'note';
  const tags = Array.isArray(draft.tags)
    ? [...new Set(draft.tags.map((tag) => normalizeText(tag, 20)).filter(Boolean))].slice(0, 5)
    : [];
  const id = typeof draft.id === 'string' && /^mem_[a-z0-9]+$/.test(draft.id) ? draft.id : '';
  const secret = detectSecret([title, summary, when, body, tags.join(' ')].join('\n'));
  if (secret) throw new Error(`疑似凭据（${secret}），只记位置，不记值`);
  return { id, title, summary, when, body, kind, tags };
}

function newId() {
  return `mem_${crypto.randomBytes(6).toString('hex')}`;
}

function readBody(scope, id) {
  try {
    return fs.readFileSync(entryFile(scope, id), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error(`记忆正文读不出来（${error.code || 'IO'}）：${id}`);
  }
}

function writeBody(scope, id, body) {
  writeAtomic(entryFile(scope, id), body);
}

function entrySize(record, body) {
  return Buffer.byteLength([record.title, record.when, record.summary, (record.tags || []).join(','), body].join('\n'));
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

/** Trim never drops a record it could not archive: a failed move keeps the entry. */
export function trimIndex(scope, index) {
  const rank = (item) => item.lastUsed || item.updated || item.created || '';
  const cap = scope.key === 'global' ? LIMITS.globalEntries : LIMITS.entries;
  while (index.entries.length > cap) {
    const victim = [...index.entries].sort((a, b) => rank(a).localeCompare(rank(b)))[0];
    if (!victim) break;
    archiveEntry(scope, index, victim);
  }
  let total = index.entries.reduce((sum, item) => sum + (item.bytes || 0), 0);
  while (total > LIMITS.totalBytes) {
    const victim = [...index.entries].sort((a, b) => rank(a).localeCompare(rank(b)))[0];
    if (!victim) break;
    const size = victim.bytes || 0;
    archiveEntry(scope, index, victim);
    total -= size;
  }
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
 * 模糊相似只用来提示候选（similar），不会把两条不同事实并成一条。
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

/** 没有合并时，把最接近的那条报出来：看得到，才有可能纠正。 */
export function nearestEntry(entries, title, summary) {
  let best = null;
  for (const item of entries) {
    const names = [item.title, ...(item.aliases || [])];
    const titleScore = Math.max(0, ...names.map((name) => similarity(name, title)));
    const summaryScore = similarity(item.summary, summary);
    const score = Math.max(titleScore, summaryScore);
    if (score >= MERGE.near && (!best || score > best.score)) {
      best = { id: item.id, title: item.title, score };
    }
  }
  return best;
}

/** 相近线只用于「提示」，与合并无关。 */
export const MERGE = { near: 0.3 };

function keyOf(line) {
  const match = /^\s*[-*]\s*([^：:]{1,20})[：:]/.exec(line);
  return match ? match[1].trim() : null;
}

function splitSections(body) {
  const blocks = [];
  let current = { heading: '', lines: [] };
  for (const line of String(body || '').split('\n')) {
    if (/^#{1,6}\s+/.test(line)) {
      if (current.heading || current.lines.length > 0) blocks.push(current);
      current = { heading: line.trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.heading || current.lines.length > 0) blocks.push(current);
  return blocks;
}

/**
 * 合并只做增添，且同名键只在同一个 Markdown 章节内覆盖：
 * `## 前端` 的端口和 `## 后端` 的端口不是同一件事。
 */
export function mergeBody(oldBody, incoming) {
  const oldSections = splitSections(oldBody);
  const newSections = splitSections(incoming);
  const seen = new Set();
  for (const section of newSections) {
    const target = oldSections.find((item) => item.heading === section.heading);
    const bucket = target ? target.lines : [];
    for (const line of section.lines) {
      const plain = line.replace(/\s+/g, ' ').trim();
      if (!plain) continue;
      const key = keyOf(plain);
      if (key) {
        const at = bucket.findIndex((item) => keyOf(item.replace(/\s+/g, ' ').trim()) === key);
        if (at >= 0) bucket[at] = plain;
        else bucket.push(plain);
      } else if (!bucket.some((item) => item.replace(/\s+/g, ' ').trim() === plain)) {
        bucket.push(plain);
      }
    }
    if (!target) oldSections.push({ heading: section.heading, lines: [...bucket] });
    seen.add(section.heading);
  }
  const lines = [];
  for (const section of oldSections) {
    if (section.heading) lines.push(section.heading);
    for (const line of section.lines) if (String(line).trim()) lines.push(line);
  }
  return lines.join('\n').slice(0, LIMITS.bodyChars);
}

function snapshot(record, body) {
  if (!body) return record.versions || [];
  const versions = [...(record.versions || []), { at: record.updated || record.created || new Date().toISOString(), body: body.slice(0, 1500) }];
  return versions.slice(-2);
}

/**
 * 保存。带 id 就是明确更新那条；不带 id 时只认标题 / 旧标题 + 同一前置条件。
 * 相近但不同名不合并，改在 similar 里报候选 id，让调用方决定用 id 更新。
 */
export function upsert(scope, source) {
  return withLock(scope, () => {
    const draft = normalizeDraft(source);
    const index = loadIndex(scope);
    const now = new Date().toISOString();
    let record = draft.id ? index.entries.find((item) => item.id === draft.id) : null;
    if (draft.id && !record) throw new Error('没有这条记忆，改用新增');
    let mergedFrom = null;
    if (!record) {
      const hit = resolveTarget(index.entries, draft);
      if (hit) {
        record = hit.target;
        mergedFrom = hit.target.title === draft.title ? null : hit.target.title;
      }
    }
    const similar = record ? null : nearestEntry(index.entries, draft.title, draft.summary);
    if (record) {
      const oldBody = readBody(scope, record.id);
      const body = draft.body ? mergeBody(oldBody, draft.body) : oldBody;
      record.versions = snapshot(record, oldBody);
      if (draft.title !== record.title) {
        record.aliases = [...new Set([...(record.aliases || []), record.title])].slice(-5);
        record.title = draft.title;
      }
      record.summary = draft.summary;
      record.when = draft.when;
      record.kind = draft.kind || record.kind;
      record.tags = draft.tags.length > 0 ? draft.tags : record.tags || [];
      record.updated = now;
      record.lastUsed = now;
      record.merges = (record.merges || 0) + 1;
      record.hits = record.hits || 0;
      writeBody(scope, record.id, body);
      record.bytes = entrySize(record, body);
      saveIndex(scope, index);
      return { record, merged: true, mergedFrom, similar };
    }
    const created = {
      id: newId(),
      title: draft.title,
      when: draft.when,
      summary: draft.summary,
      kind: draft.kind,
      tags: draft.tags,
      aliases: [],
      created: now,
      updated: now,
      lastUsed: now,
      hits: 0,
      merges: 0,
      versions: [],
      bytes: 0,
    };
    writeBody(scope, created.id, draft.body);
    created.bytes = entrySize(created, draft.body);
    index.entries.push(created);
    trimIndex(scope, index);
    saveIndex(scope, index);
    return { record: created, merged: false, mergedFrom: null, similar };
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
      return { id: record.id, title: record.title };
    }
    return null;
  });
}

function pruneSuggestions(index) {
  const now = Date.now();
  index.suggestions = (index.suggestions || []).filter((item) => {
    const expires = Date.parse(item.expiresAt || '');
    return Number.isFinite(expires) && expires > now;
  });
}

/** 建议门限：已有同一条或相近的一条就不要再建议；48 小时内只建议一条。 */
export function suggestionGate(scope, source) {
  return withLock(scope, () => {
    const index = loadIndex(scope);
    pruneSuggestions(index);
    const title = normalizeText(source?.title, LIMITS.titleChars);
    if (!title) return { ok: false, reason: '没有标题' };
    const summary = normalizeText(source?.summary, LIMITS.summaryChars);
    const when = normalizeText(source?.when, LIMITS.whenChars);
    const hit = resolveTarget(index.entries, { title, summary, when });
    if (hit) return { ok: false, reason: `已有「${hit.target.title}」，用 memory_save 更新它` };
    const near = nearestEntry(index.entries, title, summary);
    if (near) return { ok: false, reason: `已有相近条目「${near.title}」，改用 memory_save 更新它` };
    const last = Date.parse(index.lastSuggestedAt || '');
    if (Number.isFinite(last) && Date.now() - last < LIMITS.suggestionWindowMs) {
      return { ok: false, reason: '48 小时内已经建议过一条' };
    }
    return { ok: true };
  });
}

/** 待确认草稿与正式条目走同一个校验器：凭据、大小、必填都在这里拦住，才允许落盘。 */
export function noteSuggestion(scope, source, decision = 'asked') {
  return withLock(scope, () => {
    const draft = normalizeDraft(source, { requireSummary: false });
    const index = loadIndex(scope);
    pruneSuggestions(index);
    const at = new Date();
    index.suggestions = [
      ...(index.suggestions || []),
      {
        id: `sug_${crypto.randomBytes(4).toString('hex')}`,
        title: draft.title,
        at: at.toISOString(),
        expiresAt: new Date(at.getTime() + LIMITS.suggestionTtlMs).toISOString(),
        decision,
        draft: { title: draft.title, summary: draft.summary, when: draft.when, body: draft.body, kind: draft.kind, tags: draft.tags },
      },
    ].slice(-LIMITS.pending);
    index.lastSuggestedAt = at.toISOString();
    saveIndex(scope, index);
    return { id: index.suggestions[index.suggestions.length - 1].id, title: draft.title, expiresAt: index.suggestions[index.suggestions.length - 1].expiresAt };
  });
}

/** 待保留的那条建议：按 id 或标题取，过期/已存下的不再返回。 */
export function findSuggestion(scope, key) {
  return withLock(scope, () => {
    const index = loadIndex(scope);
    pruneSuggestions(index);
    const text = normalizeText(key, LIMITS.titleChars);
    const item = (index.suggestions || []).find((entry) => (entry.id === key || entry.title === text) && entry.decision === 'asked');
    if (!item) return null;
    return { ...item.draft, suggestionId: item.id };
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
    const head = `${item.scope === 'global' ? '[全局] ' : ''}${item.id} ${item.title}${item.when ? `（${item.when}）` : ''}`;
    const line = stale ? `- ${head}` : `- ${head}｜${item.summary}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join('\n'), chars: used };
}
