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
  entryBytes: 4096,
  totalBytes: 512 * 1024,
  titleChars: 40,
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
  while (index.entries.length > LIMITS.entries) archiveEntry(scope, index, byStaleness.shift());
  let total = index.entries.reduce((sum, item) => sum + (item.bytes || 0), 0);
  while (total > LIMITS.totalBytes && byStaleness.length > 0) {
    const victim = byStaleness.shift();
    if (!index.entries.some((item) => item.id === victim.id)) continue;
    total -= victim.bytes || 0;
    archiveEntry(scope, index, victim);
  }
}

/** 同一主题的判定线。跨过就合并成一条，跨不过就新建。 */
export const MERGE = { title: 0.6, summary: 0.75 };

/** 相邻两字为一组：中文没有空格，按词切分永远对不上，按字片才认得出改写的同一件事。 */
function bigrams(text) {
  const plain = normalizeText(text, 400).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (!plain) return new Set();
  if (plain.length < 2) return new Set([plain]);
  const out = new Set();
  for (let i = 0; i + 1 < plain.length; i += 1) out.add(plain.slice(i, i + 2));
  return out;
}

function similarity(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** 同标题必合并；否则标题或摘要够像，也当作同一主题的又一次记录。 */
function mergeCandidate(entries, title, summary) {
  let best = null;
  let bestScore = 0;
  for (const item of entries) {
    if (item.title === title) return item;
    const titleScore = similarity(item.title, title);
    const summaryScore = similarity(item.summary, summary);
    if (titleScore < MERGE.title && summaryScore < MERGE.summary) continue;
    const score = Math.max(titleScore, summaryScore);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Save or merge one memory. A repeat of an existing topic updates it and counts
 * the merge instead of adding a row, which is what keeps a long-lived store tidy.
 */
export function upsert(scope, draft) {
  const title = normalizeText(draft.title, LIMITS.titleChars);
  if (!title) throw new Error('标题为空');
  const summary = validSummary(draft.summary);
  if (!summary.ok) throw new Error(summary.reason);
  const body = String(draft.body ?? '').trim();
  if (body.length > LIMITS.entryBytes) throw new Error(`正文超过 ${LIMITS.entryBytes} 字，请精简或拆成指针`);
  const asSecret = detectSecret(`${title}\n${summary.text}\n${body}`);
  if (asSecret) throw new Error(`检出疑似凭据，未保存（${asSecret}）。凭据只记位置与调用方式`);

  const index = loadIndex(scope);
  const now = new Date().toISOString();
  const existing = mergeCandidate(index.entries, title, summary.text);
  const id = existing ? existing.id : `mem_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const record = {
    id,
    title,
    summary: summary.text,
    kind: draft.kind || 'note',
    tags: Array.isArray(draft.tags) ? draft.tags.map((tag) => normalizeText(tag, 20)).filter(Boolean).slice(0, 5) : [],
    created: existing ? existing.created : now,
    updated: now,
    lastUsed: now,
    hits: existing ? existing.hits || 0 : 0,
    merges: existing ? (existing.merges || 0) + 1 : 0,
    bytes: Buffer.byteLength(body, 'utf8'),
  };
  writeAtomic(entryFile(scope, id), body);
  if (existing) index.entries = index.entries.map((item) => (item.id === id ? record : item));
  else index.entries.push(record);
  index.suggestions = (index.suggestions || []).filter((item) => item.title !== title).slice(-19);
  trimIndex(scope, index);
  saveIndex(scope, index);
  return { record, merged: Boolean(existing), mergedFrom: existing && existing.title !== title ? existing.title : null };
}

export function search(scope, query, limit = 4) {
  const index = loadIndex(scope);
  const terms = normalizeText(query, 200)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
  const scored = index.entries.map((item) => {
    const hay = `${item.title} ${item.summary} ${(item.tags || []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const term of terms) if (hay.includes(term)) score += term.length > 2 ? 2 : 1;
    if (terms.length > 0 && score === 0) score = similarity(item.title, query) > 0.5 ? 1 : 0;
    return { item, score };
  });
  const hits = scored.filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  if (hits.length > 0) {
    const now = new Date().toISOString();
    for (const hit of hits) {
      hit.item.hits = (hit.item.hits || 0) + 1;
      hit.item.lastUsed = now;
    }
    saveIndex(scope, index);
  }
  return hits.map((row) => row.item);
}

export function readEntry(scope, id) {
  const index = loadIndex(scope);
  const record = index.entries.find((item) => item.id === id);
  if (!record) throw new Error(`没有这条记忆：${id}`);
  const body = fs.readFileSync(entryFile(scope, record.id), 'utf8');
  record.lastUsed = new Date().toISOString();
  record.hits = (record.hits || 0) + 1;
  saveIndex(scope, index);
  return { record, body };
}

export function forget(scope, id) {
  const index = loadIndex(scope);
  const record = index.entries.find((item) => item.id === id);
  if (!record) throw new Error(`没有这条记忆：${id}`);
  archiveEntry(scope, index, record);
  saveIndex(scope, index);
  return record;
}

/** Why a suggestion is refused: one per two days per project, and never for a saved topic. */
export function suggestionGate(scope, title) {
  const index = loadIndex(scope);
  const text = normalizeText(title, LIMITS.titleChars);
  if (index.entries.some((item) => item.title === text)) return { ok: false, reason: '这条已经存过' };
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
    const line = stale ? `- ${item.id} ${item.title}` : `- ${item.id} ${item.title}｜${item.summary}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join('\n'), chars: used };
}
