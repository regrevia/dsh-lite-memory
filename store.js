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
  totalBytes: 512 * 1024,
  titleChars: 40,
  whenChars: 60,
  summaryChars: 60,
  suggestionWindowMs: 48 * 60 * 60 * 1000,
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

/** 一次写入只落在一个库里：项目库优先，全局库兜底。 */
function locate(scope, id) {
  for (const source of [scope, globalScope()]) {
    const index = loadIndex(source);
    const record = index.entries.find((item) => item.id === id);
    if (record) return { source, index, record };
  }
  return null;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
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

function entryFile(scope, id) {
  return path.join(scope.dir, 'entries', `${id}.md`);
}

export function loadIndex(scope) {
  const file = path.join(scope.dir, 'index.json');
  const data = readJson(file, null);
  if (!data || !Array.isArray(data.entries)) return { version: 1, scope: scope.key, entries: [], suggestions: [] };
  if (!Array.isArray(data.suggestions)) data.suggestions = [];
  return data;
}

export function saveIndex(scope, index) {
  index.version = 1;
  index.scope = scope.key;
  index.cwd = scope.cwd;
  index.updated = new Date().toISOString();
  index.totalBytes = index.entries.reduce((sum, item) => sum + (item.bytes || 0), 0);
  writeAtomic(path.join(scope.dir, 'index.json'), JSON.stringify(index, null, 2));
}

/** Oldest and least used first; archive keeps the file, it never deletes. */
function archiveEntry(scope, index, entry) {
  try {
    const from = entryFile(scope, entry.id);
    const to = path.join(scope.dir, 'archive', `${entry.id}.md`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(from)) fs.renameSync(from, to);
  } catch {
    /* an unreadable entry is still dropped from the index */
  }
  index.entries = index.entries.filter((item) => item.id !== entry.id);
}

export function trimIndex(scope, index) {
  const byStaleness = [...index.entries].sort((a, b) => {
    const rank = (item) => (item.lastUsed || item.updated || item.created || '');
    return rank(a).localeCompare(rank(b));
  });
  const cap = scope.key === 'global' ? LIMITS.globalEntries : LIMITS.entries;
  while (index.entries.length > cap) archiveEntry(scope, index, byStaleness.shift());
  let total = index.entries.reduce((sum, item) => sum + (item.bytes || 0), 0);
  while (total > LIMITS.totalBytes && byStaleness.length > 0) {
    const victim = byStaleness.shift();
    if (!index.entries.some((item) => item.id === victim.id)) continue;
    total -= victim.bytes || 0;
    archiveEntry(scope, index, victim);
  }
}

/** 同一主题的判定线。跨过就更新原来那条，跨不过就新建；live 库里不同主题实测最高 0.27。 */
export const MERGE = { title: 0.45, summary: 0.55, near: 0.3 };

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

/** 标题、摘要、以及这条以前用过的标题，各算一次。 */
function scoreEntry(item, title, summary) {
  const names = [item.title, ...(item.aliases || [])];
  const titleScore = Math.max(...names.map((name) => similarity(name, title)));
  return { titleScore, summaryScore: similarity(item.summary, summary) };
}

/**
 * 保存时自己判：同一层、同一前置条件下，标题或摘要够像、或撞上这条用过的旧标题，
 * 就是同一条，返回要更新的条目；否则 null，调用方新增。
 */
export function resolveTarget(entries, title, summary, when) {
  let best = null;
  for (const item of entries) {
    if ((item.when || '') !== when) continue;
    if (item.title === title) return { target: item, score: 1 };
    const { titleScore, summaryScore } = scoreEntry(item, title, summary);
    const score = Math.max(titleScore, summaryScore);
    if (titleScore < MERGE.title && summaryScore < MERGE.summary) continue;
    if (!best || score > best.score) best = { target: item, score };
  }
  return best;
}

/** 没有合并时，把最接近的那条报出来（含别的场景的同主题条目）：看得到，才有可能纠正。 */
export function nearestEntry(entries, title, summary) {
  let best = null;
  for (const item of entries) {
    const { titleScore, summaryScore } = scoreEntry(item, title, summary);
    const score = Math.max(titleScore, summaryScore);
    if (score >= MERGE.near && (!best || score > best.score)) best = { title: item.title, score };
  }
  return best;
}

/** 合并只做增添：旧要点全留下；同一个键（`- 键：值`）的新值覆盖旧值。 */
export function mergeBody(oldBody, incoming) {
  const keyOf = (line) => {
    const match = /^\s*[-*]\s*([^：:]{1,20})[：:]/.exec(line);
    return match ? match[1].trim() : null;
  };
  const flat = (line) => line.replace(/\s+/g, ' ').trim();
  const out = String(oldBody || '').split('\n').filter((line) => line.trim());
  for (const raw of String(incoming || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const key = keyOf(line);
    if (key) {
      const at = out.findIndex((item) => keyOf(item) === key);
      if (at >= 0) out[at] = line;
      else out.push(line);
      continue;
    }
    if (!out.some((item) => flat(item) === flat(line))) out.push(line);
  }
  return out.join('\n');
}

export function upsert(scope, draft) {
  const title = normalizeText(draft.title, LIMITS.titleChars);
  if (!title) throw new Error('标题为空');
  const summary = validSummary(draft.summary);
  if (!summary.ok) throw new Error(summary.reason);
  const body = String(draft.body ?? '').trim();
  if (body.length > LIMITS.entryBytes) throw new Error(`正文超过 ${LIMITS.entryBytes} 字，请精简或拆成指针`);
  const asSecret = detectSecret(`${title}\n${summary.text}\n${body}`);
  if (asSecret) throw new Error(`检出疑似凭据，未保存（${asSecret}）。凭据只记位置与调用方式`);

  const when = normalizeText(draft.when ?? '', LIMITS.whenChars);
  const index = loadIndex(scope);
  const now = new Date().toISOString();
  const target = resolveTarget(index.entries, title, summary.text, when);
  const existing = target && target.target;
  const near = existing ? null : nearestEntry(index.entries, title, summary.text);
  const id = existing ? existing.id : `mem_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const stated = existing ? fs.readFileSync(entryFile(scope, id), 'utf8') : '';
  const mergedBody = existing ? mergeBody(stated, body) : body;
  if (Buffer.byteLength(mergedBody, 'utf8') > LIMITS.entryBytes) throw new Error(`合并后超过 ${LIMITS.entryBytes} 字：只写这次新增的要点，或先归档旧条目`);
  const record = {
    id,
    title: existing ? existing.title : when ? `${title}｜${when}`.slice(0, LIMITS.titleChars) : title,
    when,
    summary: summary.text,
    kind: draft.kind || 'note',
    tags: Array.isArray(draft.tags) ? draft.tags.map((tag) => normalizeText(tag, 20)).filter(Boolean).slice(0, 5) : [],
    created: existing ? existing.created : now,
    updated: now,
    lastUsed: now,
    aliases: existing ? [...new Set([...(existing.aliases || []), ...(existing.title !== title ? [existing.title] : [])])].slice(-5) : [],
    hits: existing ? existing.hits || 0 : 0,
    merges: existing ? (existing.merges || 0) + 1 : 0,
    bytes: Buffer.byteLength(mergedBody, 'utf8'),
  };
  writeAtomic(entryFile(scope, id), mergedBody);
  if (existing) index.entries = index.entries.map((item) => (item.id === id ? record : item));
  else index.entries.push(record);
  index.suggestions = (index.suggestions || []).filter((item) => item.title !== title).slice(-19);
  trimIndex(scope, index);
  saveIndex(scope, index);
  return {
    record,
    merged: Boolean(existing),
    mergedFrom: existing && existing.title !== title ? existing.title : null,
    similar: near ? near.title : null,
  };
}

export function search(scope, query, limit = 4) {
  const terms = normalizeText(query, 200)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
  const sources = scope.key === 'global' ? [scope] : [scope, globalScope()];
  const seen = new Set();
  const hits = [];
  for (const source of sources) {
    const index = loadIndex(source);
    for (const item of index.entries) {
      if (seen.has(item.id)) continue;
      const hay = `${item.title} ${item.summary} ${item.when || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) if (hay.includes(term)) score += term.length > 2 ? 2 : 1;
      if (terms.length > 0 && score === 0) score = similarity(item.title, query) > 0.5 ? 1 : 0;
      if (score > 0) hits.push({ item, score, source, index });
    }
  }
  const top = hits.sort((a, b) => b.score - a.score).slice(0, limit);
  const now = new Date().toISOString();
  const dirty = new Map();
  for (const hit of top) {
    hit.item.hits = (hit.item.hits || 0) + 1;
    hit.item.lastUsed = now;
    dirty.set(hit.source.key, { source: hit.source, index: hit.index });
  }
  for (const entry of dirty.values()) saveIndex(entry.source, entry.index);
  return top.map((hit) => ({ ...hit.item, scope: hit.source.key === 'global' ? 'global' : 'project' }));
}

export function readEntry(scope, id) {
  const found = locate(scope, id);
  if (!found) throw new Error(`没有这条记忆：${id}`);
  const { source, index, record } = found;
  const body = fs.readFileSync(entryFile(source, record.id), 'utf8');
  record.lastUsed = new Date().toISOString();
  record.hits = (record.hits || 0) + 1;
  saveIndex(source, index);
  return { record, body };
}

export function forget(scope, id) {
  const found = locate(scope, id);
  if (!found) throw new Error(`没有这条记忆：${id}`);
  const { source, index, record } = found;
  archiveEntry(source, index, record);
  saveIndex(source, index);
  return record;
}

/** Why a suggestion is refused: one per two days per project, and never for a saved topic. */
export function suggestionGate(scope, draft) {
  const index = loadIndex(scope);
  const title = normalizeText(draft.title, LIMITS.titleChars);
  const summary = normalizeText(draft.summary ?? '', LIMITS.summaryChars);
  const when = normalizeText(draft.when ?? '', LIMITS.whenChars);
  const hit = resolveTarget(index.entries, title, summary, when);
  if (hit) return { ok: false, reason: `已有相近条目「${hit.target.title}」，点保留会更新它` };
  const now = Date.now();
  const recent = index.suggestions.find((item) => now - Date.parse(item.at) < LIMITS.suggestionWindowMs);
  if (recent) return { ok: false, reason: `48 小时内已建议过「${recent.title}」` };
  return { ok: true };
}

export function noteSuggestion(scope, draft, decision = 'asked') {
  const source = typeof draft === 'string' ? { title: draft } : draft;
  const title = normalizeText(source.title, LIMITS.titleChars);
  const payload = {
    title,
    summary: normalizeText(source.summary, LIMITS.summaryChars),
    body: String(source.body ?? ''),
    kind: source.kind || 'note',
    tags: Array.isArray(source.tags) ? source.tags.map((tag) => normalizeText(tag, 20)).filter(Boolean).slice(0, 5) : [],
  };
  const index = loadIndex(scope);
  index.suggestions = [
    ...(index.suggestions || []),
    { title, at: new Date().toISOString(), decision, draft: payload },
  ].slice(-20);
  saveIndex(scope, index);
}

/** 待保留的那条建议；没有就返回 null（已过期、已存下或从未建议过）。 */
export function findSuggestion(scope, title) {
  const index = loadIndex(scope);
  const text = normalizeText(title, LIMITS.titleChars);
  const item = (index.suggestions || []).find((entry) => entry.title === text && entry.decision === 'asked');
  if (!item) return null;
  return item.draft ?? { title: text };
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
    const head = `${item.scope === 'global' ? '[全局] ' : ''}${item.title}${item.when ? `（${item.when}）` : ''}`;
    const line = stale ? `- ${item.id} ${head}` : `- ${item.id} ${head}｜${item.summary}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join('\n'), chars: used };
}
