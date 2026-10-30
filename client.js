window.__ModuleLoader__.load({
  id: 'dsh-lite-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** One muted line per memory call: a summary, never the payload. */
    const RUNNING = {
      memory_save: 'memory · saving',
      memory_suggest: 'memory · checking',
      memory_search: 'memory · searching',
      memory_read: 'memory · reading',
      memory_forget: 'memory · dropping',
    };

    const KEEP = { idle: '保留', saving: '保存中', saved: '已保留', failed: '重试' };
    const EMPTY = [];
    const ROW = { display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 0', fontSize: '12px', lineHeight: '1.6', opacity: 0.7 };
    const DOT = { flex: '0 0 auto', opacity: 0.8 };
    const LABEL = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const KEEP_STYLE = { flex: '0 0 auto', border: '1px solid currentColor', background: 'transparent', color: 'inherit', borderRadius: '999px', padding: '0 8px', fontSize: '12px', lineHeight: '18px' };
    const KEEP_ON = { ...KEEP_STYLE, opacity: 0.9, cursor: 'pointer' };
    const KEEP_OFF = { ...KEEP_STYLE, opacity: 0.45, cursor: 'default' };
    const DROP = { flex: '0 0 auto', border: 'none', background: 'transparent', color: 'inherit', padding: '0 2px', fontSize: '12px', lineHeight: '18px', opacity: 0.55, cursor: 'pointer' };
    const DOCK = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, fontSize: '12px', lineHeight: '1.6' };
    const TAIL = { ...DOCK, margin: '4px 0 2px' };
    const CHIP = { alignSelf: 'flex-start', border: 'none', background: 'transparent', color: 'inherit', padding: 0, fontSize: '12px', lineHeight: '1.6', opacity: 0.6, cursor: 'pointer', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const ITEM = { alignSelf: 'flex-start', border: 'none', background: 'transparent', color: 'inherit', padding: 0, fontSize: '12px', lineHeight: '1.6', opacity: 0.75, cursor: 'pointer', textAlign: 'left', width: '100%', minWidth: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const BODY = { margin: '2px 0 4px', padding: '4px 0 4px 8px', borderLeft: '1px solid currentColor', opacity: 0.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '180px', overflowY: 'auto' };

    const settledText = (block) => {
      if (block === undefined || block === null || !('kind' in block)) return null;
      const content = Array.isArray(block.content) ? block.content : [];
      for (const item of content) {
        if (item !== null && item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) return item.text;
      }
      if (block.error !== undefined) return 'memory · stopped';
      if (block.isError === true) return 'memory · failed';
      return null;
    };

    const firstLine = (value) => (typeof value === 'string' ? value.split('\n')[0] : null);

    const newOperationId = () => `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    /** 会话 id 可能落在不同字段上。 */
    const sessionKeyOf = (props) =>
      (typeof props.sessionId === 'string' && props.sessionId) ||
      (props.session && typeof props.session.id === 'string' && props.session.id) ||
      '';

    const post = (path, payload) => {
      if (typeof fetch !== 'function') return Promise.resolve({ ok: false, status: 0, body: null });
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(async (response) => {
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          return { ok: response.ok, status: response.status, body };
        })
        .catch(() => ({ ok: false, status: 0, body: null }));
    };

    /** 失败不装作成功：把服务端那一句原样放回行里。 */
    const failure = (result, fallback) => (result && result.body && typeof result.body.reason === 'string' && result.body.reason ? result.body.reason : fallback);

    /** 真成功要 HTTP 与响应体同时确认；2xx 但 ok:false 仍按失败显示。 */
    const succeeded = (result) => Boolean(result && result.ok && result.body && result.body.ok === true);

    /** 已落定、带元数据的调用块；旧行只读。 */
    const metaOf = (block) => {
      if (block === undefined || block === null || !('kind' in block) || block.isError === true) return null;
      const meta = block.meta;
      if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null;
      return meta;
    };

    const isCandidateId = (value) => typeof value === 'string' && /^sug_[a-z0-9]{6,}$/.test(value);

    /** 一条引用的规范形态：只有标题、范围与版次；id 不进界面。 */
    const citationOf = (meta, kind) => {
      if (!meta || typeof meta.title !== 'string' || !meta.title.trim()) return null;
      if (kind === 'memory-save' && meta.changed !== true) return null;
      return {
        title: meta.title,
        key: `${meta.scope === 'global' ? 'global' : 'project'}\u0000${meta.title}`, // ui-copy-ignore
        scope: meta.scope === 'global' ? 'global' : 'project',
        revision: Number.isInteger(meta.revision) ? meta.revision : 1,
        status: typeof meta.status === 'string' ? meta.status : 'ok',
        origin: meta.origin === 'project_evolution' || meta.origin === 'model_drafted' ? meta.origin : 'user_explicit',
        kind,
        exposure: kind === 'memory-save' || kind === 'memory-forget' ? 'update' : 'reference',
        /** 条目类型：读正文看 recordKind，检索看 ref 自己的 kind；工具名不是类型。 */
        entryKind: typeof meta.kind === 'string' && Object.prototype.hasOwnProperty.call(KIND_LABEL, meta.kind)
          ? meta.kind
          : (typeof meta.recordKind === 'string' ? meta.recordKind : ''),
        updated: typeof meta.updated === 'string' ? meta.updated : '',
        reason: typeof meta.reason === 'string' ? meta.reason : '',
        reasonCode: typeof meta.reasonCode === 'string' ? meta.reasonCode : '',
        noTriggerReason: typeof meta.noTriggerReason === 'string' ? meta.noTriggerReason : '',
        sourceExcerpt: meta.sourceExcerpt,
        sourceRefs: meta.sourceRefs,
        evidence: meta.evidence,
        processingStatus: processingStatusOf(meta),
      };
    };

    const citationsOfMeta = (meta) => {
      if (!meta || typeof meta !== 'object') return EMPTY;
      if (meta.kind === 'memory-search') {
        if (!Array.isArray(meta.refs)) return EMPTY;
        return meta.refs.map((ref) => citationOf(ref, 'memory-search')).filter(Boolean);
      }
      if (meta.kind === 'memory-read') {
        const one = citationOf(meta, 'memory-read');
        return one ? [one] : EMPTY;
      }
      if (meta.kind === 'memory-save' || meta.kind === 'memory-forget') {
        const one = citationOf(meta, meta.kind);
        return one ? [one] : EMPTY;
      }
      return EMPTY;
    };

    /** 一轮的工具节点：结果块本身，以及 PTC 子调用的结果。 */
    const citationsOfTurn = (nodes) => {
      if (!Array.isArray(nodes)) return EMPTY;
      const out = [];
      let noTriggerReason = '';
      for (const node of nodes) {
        const root = node && node.root;
        if (root === null || typeof root !== 'object') continue;
        for (const block of [root, ...(Array.isArray(root.subCalls) ? root.subCalls : [])]) {
          const meta = metaOf(block);
          if (!meta) continue;
          const citations = citationsOfMeta(meta);
          out.push(...citations);
          if (citations.length === 0 && meta.kind === 'memory-search') {
            const reason = [meta.noTriggerReason, meta.reason].find((value) => typeof value === 'string' && value);
            if (reason) noTriggerReason = reason;
          }
        }
      }
      if (noTriggerReason) Object.defineProperty(out, 'noTriggerReason', { value: noTriggerReason, enumerable: false, configurable: true });
      return out;
    };

    /** 同轮同 id 同用途去重：位置取首次，内容取最后。 */
    const dedupe = (items) => {
      const seen = new Map();
      const out = [];
      for (const item of items) {
        const key = `${item.scope}:${item.key}:${item.exposure}`;
        const at = seen.get(key);
        if (at === undefined) {
          seen.set(key, out.length);
          out.push(item);
        } else {
          out[at] = item;
        }
      }
      if (items && typeof items.noTriggerReason === 'string' && items.noTriggerReason) {
        Object.defineProperty(out, 'noTriggerReason', { value: items.noTriggerReason, enumerable: false, configurable: true });
      }
      return out;
    };

    const sameList = (left, right) => {
      if (left === right) return true;
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) return false;
      }
      return true;
    };

    /**
     * 一轮的引用源：会话节点里冻结的工具结果。
     * 关闭、切轮时不复用旧结果——结果只认自己那次请求。
     */
    const turnSource = (getChat, turnKey) => {
      let underlying = null;
      let off = null;
      let lastNodes = null;
      let snapshot = EMPTY;
      const listeners = new Set();
      const read = () => {
        if (!underlying) {
          const chat = (() => { try { return getChat(); } catch { return null; } })();
          let nodes = null;
          try {
            const state = chat && chat.getSnapshot();
            nodes = state && state.nodes;
          } catch {
            nodes = null;
          }
          if (!nodes || typeof nodes.turnDataSource !== 'function') return EMPTY;
          try {
            underlying = nodes.turnDataSource(Number(turnKey), 'tool-call');
          } catch {
            return EMPTY;
          }
        }
        let value;
        try {
          value = underlying.getSnapshot();
        } catch {
          return snapshot;
        }
        if (value !== lastNodes) {
          lastNodes = value;
          const next = dedupe(citationsOfTurn(value));
          const nextReason = next.noTriggerReason || '';
          const lastReason = snapshot.noTriggerReason || '';
          if (!sameList(next, snapshot) || nextReason !== lastReason) snapshot = next;
        }
        return snapshot;
      };
      const notify = () => {
        const before = snapshot;
        read();
        if (snapshot !== before) {
          for (const listener of [...listeners]) listener();
        }
      };
      return {
        getSnapshot: read,
        subscribe(listener) {
          listeners.add(listener);
          if (!underlying) read();
          if (underlying && typeof underlying.subscribe === 'function' && off === null) {
            try {
              off = underlying.subscribe(notify);
            } catch {
              off = null;
            }
          }
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0 && off !== null) {
              try {
                off();
              } catch {
                /* the source may already be gone */
              }
              off = null;
            }
          };
        },
      };
    };

    /** 一行展示的身份：曝光类型 + 文案 + 正文；拦截结果没有 id，只能按内容认。 */
    const rowKeyOf = (toolName, block) => {
      const text = settledText(block);
      return text ? `${toolName}|${text}` : '';
    };

    /** 同一组行每次出现的去留：同键只留第一次。 */
    const rowKeepFlags = (keys) => {
      const seen = new Set();
      return keys.map((key) => {
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const Row = (props) => {
      const line = props.phase === 'preparing' ? null : firstLine(settledText(props.block));
      const key = props.phase === 'preparing' ? '' : rowKeyOf(props.toolName, props.block);
      const nodeRef = React.useRef(null);
      const [dup, setDup] = React.useState(false);
      const useLayout = React.useLayoutEffect || React.useEffect;
      useLayout(() => {
        const node = nodeRef.current;
        if (!key || !node || typeof node.closest !== 'function') return;
        const turnBox = node.closest('[data-chat-turn]');
        const turn = turnBox ? turnBox.getAttribute('data-chat-turn') : null;
        const rootScope = node.ownerDocument || node.parentElement;
        if (!rootScope || typeof rootScope.querySelectorAll !== 'function') return;
        const peers = Array.prototype.filter.call(rootScope.querySelectorAll('[data-memory-row]'), (peer) => {
          if (!turn) return peer.parentElement === node.parentElement;
          const box = peer.closest('[data-chat-turn]');
          return box !== null && box.getAttribute('data-chat-turn') === turn;
        });
        const at = peers.indexOf(node);
        if (at < 0) return;
        setDup(!rowKeepFlags(peers.map((peer) => peer.getAttribute('data-memory-row') || ''))[at]);
      }, [key]);
      return h('div', {
        ref: nodeRef,
        'data-tool': props.toolName,
        'data-memory-row': key || undefined,
        style: dup ? { ...ROW, display: 'none' } : ROW,
      }, h('span', { style: DOT }, '·'), h('span', { style: LABEL }, line ?? RUNNING[props.toolName] ?? 'memory'));
    };

    /** 建议行：候选 id 来自持久元数据，不读文案。 */
    const SuggestRow = (props) => {
      const meta = metaOf(props.block);
      const [state, setState] = React.useState('idle');
      const [note, setNote] = React.useState('');
      const operationId = React.useRef('');
      const text = props.phase === 'preparing' ? null : settledText(props.block);
      const line = firstLine(text) ?? RUNNING.memory_suggest;
      const candidateId = meta && meta.kind === 'memory-suggest' && meta.asked === true && isCandidateId(meta.id) ? meta.id : '';
      const cwd = typeof props.cwd === 'string' ? props.cwd : '';
      const canKeep = Boolean(candidateId) && Boolean(cwd) && (state === 'idle' || state === 'failed');
      const keep = () => {
        if (!canKeep) return;
        if (!operationId.current) operationId.current = newOperationId();
        setState('saving');
        post('/lite-memory/keep', { op: 'keep', candidateId, operationId: operationId.current, cwd, sessionId: sessionKeyOf(props) }).then((result) => {
          if (succeeded(result)) {
            setState('saved');
            return;
          }
          setNote(failure(result, '没有保存'));
          setState('failed');
        });
      };
      const button = candidateId && state !== 'saved'
        ? h('button', { type: 'button', onClick: keep, disabled: !canKeep, 'aria-label': '保留这条记忆', style: canKeep ? KEEP_ON : KEEP_OFF }, KEEP[state] ?? KEEP.idle)
        : null;
      const label = state === 'saved' ? 'memory · kept' : note || line;
      return h('div', { 'data-tool': props.toolName, style: ROW }, h('span', { style: DOT }, '·'), h('span', { style: LABEL }, label), button);
    };

    /** 撤销只认真正写入且版本一致的那次保存。 */
    const undoRefOf = (meta, cwd) => (meta
      && meta.kind === 'memory-save'
      && meta.changed === true
      && typeof meta.title === 'string' && meta.title.trim().length > 0
      && Number.isInteger(meta.revision)
      && typeof cwd === 'string'
      && cwd.length > 0
      ? meta
      : null);

    /** 写入行：只有真的改了东西才给撤销，且带着当时的版本。 */
    const SavedRow = (props) => {
      const meta = metaOf(props.block);
      const [state, setState] = React.useState('idle');
      const [note, setNote] = React.useState('');
      const text = props.phase === 'preparing' ? null : settledText(props.block);
      const cwd = typeof props.cwd === 'string' ? props.cwd : '';
      const changed = undoRefOf(meta, cwd);
      const canDrop = Boolean(changed) && (state === 'idle' || state === 'failed');
      const drop = () => {
        if (!canDrop) return;
        setState('saving');
        post('/lite-memory/undo', { op: 'undo', title: changed.title, revision: changed.revision, cwd }).then((result) => {
          if (succeeded(result)) {
            setState('dropped');
            setNote(result.body && result.body.mode === 'restored' ? 'memory · restored' : 'memory · archived');
            return;
          }
          if (result.status === 409) {
            setNote(failure(result, '这条记忆已经改过'));
            setState('conflict');
            return;
          }
          setNote(failure(result, '没有撤销'));
          setState('failed');
        });
      };
      const processing = processingStatusOf(meta);
      const baseLabel = firstLine(text) ?? RUNNING.memory_save;
      const label = note || `${baseLabel}${processing ? ` · ${PROCESSING_LABEL[processing]}` : ''}`;
      const button = changed && state !== 'dropped'
        ? h('button', { type: 'button', onClick: drop, disabled: !canDrop, 'aria-label': '撤销此次修改', style: state === 'idle' || state === 'failed' ? DROP : { ...DROP, opacity: 0.25, cursor: 'default' } }, '✕')
        : null;
      return h('div', { 'data-tool': props.toolName, style: ROW }, h('span', { style: DOT }, '·'), h('span', { style: LABEL }, label), button);
    };

    const scopeTag = (scope) => (scope === 'global' ? '[全局]' : '[项目]');

    /** 处理状态只认服务端枚举，绝不从中文 reason 反推。 */
    const PROCESSING = ['applied', 'unchanged', 'superseded', 'failed'];
    const PROCESSING_LABEL = {
      applied: '已应用', unchanged: '无变化', superseded: '已被新版本取代', failed: '处理失败',
    };
    const processingStatusOf = (source) => {
      if (!source || typeof source !== 'object') return '';
      for (const field of ['processingStatus', 'processing', 'outcome', 'status']) {
        const value = source[field];
        if (typeof value === 'string' && PROCESSING.includes(value)) return value;
        if (value && typeof value === 'object' && typeof value.status === 'string' && PROCESSING.includes(value.status)) return value.status;
      }
      return '';
    };

    const recordOfPayload = (payload) =>
      (payload && payload.record && typeof payload.record === 'object' && !Array.isArray(payload.record) ? payload.record : null);

    const bodyTextOf = (value) => {
      if (typeof value === 'string') return value;
      if (!value || typeof value !== 'object') return '';
      for (const field of ['body', 'text', 'value']) {
        if (typeof value[field] === 'string') return value[field];
      }
      return '';
    };

    /** 当前正文与历史版本分开，历史不拼进正文。 */
    const currentBodyOf = (payload) => {
      if (!payload || typeof payload !== 'object') return '';
      if (typeof payload.currentBody === 'string') return payload.currentBody;
      const record = recordOfPayload(payload);
      if (record) {
        const recordBody = bodyTextOf(record.current);
        if (recordBody) return recordBody;
        if (typeof record.body === 'string') return record.body;
      }
      if (payload.current !== undefined && typeof payload.current !== 'boolean') {
        const current = bodyTextOf(payload.current);
        if (current) return current;
      }
      return typeof payload.body === 'string' ? payload.body : '';
    };

    const historyOfPayload = (payload) => {
      const record = recordOfPayload(payload);
      const current = payload && payload.current && typeof payload.current === 'object' ? payload.current : null;
      const lists = [
        payload && payload.versions,
        payload && payload.history,
        record && record.versions,
        record && record.history,
        current && current.versions,
      ];
      for (const list of lists) {
        if (Array.isArray(list)) return list.filter((row) => row !== null && row !== undefined);
      }
      return EMPTY;
    };

    /** 历史行统一成 old → new，缺前后值用相邻版本补。 */
    const historyDiffsOf = (payload) => {
      const rows = historyOfPayload(payload);
      if (rows.length === 0) return EMPTY;
      const currentBody = currentBodyOf(payload);
      const normalized = rows.map((row, index) => {
        const value = row && typeof row === 'object' && !Array.isArray(row) ? row : { body: row };
        const explicitOld = [value.old, value.from, value.before, value.previousBody]
          .find((item) => typeof item === 'string');
        const explicitNew = [value.next, value.to, value.after, value.newBody]
          .find((item) => typeof item === 'string');
        return {
          key: `${Number.isInteger(value.revision) ? value.revision : 'v'}-${index}`,
          at: typeof value.at === 'string' ? value.at : (typeof value.when === 'string' ? value.when : ''),
          revision: Number.isInteger(value.revision) ? value.revision : null,
          status: typeof value.status === 'string' ? value.status : '',
          body: bodyTextOf(value), // ui-copy-ignore
          old: explicitOld || '', // ui-copy-ignore
          next: explicitNew || '', // ui-copy-ignore
        };
      });
      const byRevision = normalized.every((row) => row.revision !== null);
      if (byRevision) normalized.sort((a, b) => a.revision - b.revision);
      else if (normalized.every((row) => Boolean(row.at))) normalized.sort((a, b) => a.at.localeCompare(b.at));
      return normalized.map((row, index) => ({
        ...row,
        old: row.old || row.body || '',
        next: row.next || (index + 1 < normalized.length ? normalized[index + 1].body : currentBody),
      }));
    };

    const payloadFieldOf = (payload, field) => {
      const record = recordOfPayload(payload);
      const current = payload && payload.current && typeof payload.current === 'object' ? payload.current : null;
      for (const owner of [payload, record, current]) {
        if (owner && owner[field] !== undefined) return owner[field];
      }
      return undefined;
    };

    const sourceExcerptOf = (payload) => bodyTextOf(payloadFieldOf(payload, 'sourceExcerpt'));
    const refsOfPayload = (payload) => {
      const value = payloadFieldOf(payload, 'sourceRefs');
      if (typeof value === 'string' && value) return [value];
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') return [value];
      return EMPTY;
    };
    const evidenceOfPayload = (payload) => {
      const value = payloadFieldOf(payload, 'evidence');
      if (typeof value === 'string' && value) return [value];
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') return [value];
      return EMPTY;
    };

    const refLabelOf = (ref, index) => {
      if (typeof ref === 'string') return ref;
      if (!ref || typeof ref !== 'object') return '';
      if (typeof ref.label === 'string' && ref.label) return ref.label;
      if (typeof ref.title === 'string' && ref.title) return ref.title;
      if (typeof ref.text === 'string' && ref.text) return ref.text;
      if (ref.message !== undefined) return `消息 ${ref.message}`;
      if (ref.messageId !== undefined) return `消息 ${ref.messageId}`;
      if (ref.turn !== undefined) return `第 ${ref.turn} 轮`;
      if (ref.turnIndex !== undefined) return `第 ${ref.turnIndex} 轮`;
      return `引用 ${index + 1}`;
    };
    const refHrefOf = (ref) => (ref && typeof ref === 'object'
      ? [ref.href, ref.url, ref.link].find((value) => typeof value === 'string' && value)
      : '');

    const linkStyle = { color: 'inherit', textDecoration: 'underline', textUnderlineOffset: '2px', wordBreak: 'break-all' };

    const HistoryVersions = (props) => {
      const rows = Array.isArray(props.rows) ? props.rows : EMPTY;
      const [open, setOpen] = React.useState(false);
      if (rows.length === 0) return null;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
        h('button', {
          type: 'button',
          onClick: () => setOpen((value) => !value),
          'aria-expanded': open,
          'aria-label': `${open ? '收起' : '展开'}历史版本`,
          style: CHIP,
        }, `历史 ${rows.length}${open ? ' · 收起' : ''}`),
        open ? h('div', { style: BODY }, rows.map((row) => h('div', {
          key: row.key, style: { margin: '0 0 4px', minWidth: 0 },
        },
        h('div', { style: { opacity: 0.65, fontSize: '11px' } },
          [row.at, row.revision === null ? '' : `v${row.revision}`, row.status].filter(Boolean).join(' · ')),
        h('div', null,
          h('span', { style: { opacity: 0.6 } }, SHORT(row.old, 120) || '—'),
          ' → ',
          h('span', null, SHORT(row.next, 120) || '—'))))) : null,
      );
    };

    const DetailExtras = (props) => {
      const payload = props.payload;
      const excerpt = sourceExcerptOf(payload);
      const refs = refsOfPayload(payload);
      const evidence = evidenceOfPayload(payload);
      const history = historyDiffsOf(payload);
      if (!excerpt && refs.length === 0 && evidence.length === 0 && history.length === 0) return null;
      const links = (items, label) => (items.length === 0 ? null : h('div', { style: { display: 'flex', gap: '6px', minWidth: 0 } },
        h('span', { style: { opacity: 0.6, flex: '0 0 auto' } }, label),
        h('span', { style: { minWidth: 0, wordBreak: 'break-word' } }, items.map((item, index) => {
          const href = refHrefOf(item);
          const text = refLabelOf(item, index);
          const key = `${index}-${text}`;
          if (!href) return h('span', { key }, index > 0 ? ' · ' : '', text);
          return h('span', { key }, index > 0 ? ' · ' : '', h('a', {
            href, target: '_blank', rel: 'noreferrer', style: linkStyle,
          }, text));
        }))));
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        excerpt ? h('div', { style: BODY }, h('span', { style: { opacity: 0.65 } }, '来源'), ' ', excerpt) : null,
        links(refs, '消息'),
        links(evidence, '依据'),
        h(HistoryVersions, { rows: history }));
    };

    const versionLine = (shown) => {
      /** 项目名只当分层后缀：光写目录名会被当成记忆标题。 */
      const scope = shown.scope === 'global' ? '全局'
        : shown.scopeLabel ? `项目 · ${shown.scopeLabel}` : '项目';
      const archived = shown.status === 'archived' ? ' · 已归档' : '';
      const processing = processingStatusOf(shown.processingStatus ? { processingStatus: shown.processingStatus } : shown);
      return `${scope}${archived}${processing ? ` · ${PROCESSING_LABEL[processing]}` : ''}`;
    };

    /** 展开的正文紧跟被点的那条；顺序由列表决定，不挂在一段末尾。 */
    const refSectionRowsOf = (items, shown, renderRow, renderDetail) => {
      const rows = [];
      for (const item of items) {
        rows.push(renderRow(item));
        if (shown && shown.ref && shown.key === item.key && shown.ref.revision === item.revision) rows.push(renderDetail(item));
      }
      return rows;
    };

    /** 正文抬头永远是记忆标题；项目/全局只做下面的来源行。 */
    const refDetailTitleOf = (shown) => {
      const title = shown && shown.ref && typeof shown.ref.title === 'string' ? shown.ref.title.trim() : '';
      if (title) return title;
      const fallback = shown && typeof shown.title === 'string' ? shown.title.trim() : '';
      return fallback || '记忆';
    };

    /**
     * 引用三层的色调：中性 / 强调 / 成功。
     * 三档色阶：中性 / 强调 / 成功；正文用主文本色。
     */
    const REF_TONE = {
      found: 'var(--dsw-alias-label-secondary)',
      provided: 'var(--dsw-alias-brand-primary)',
      update: 'var(--dsw-alias-state-success-primary)',
    };
    const REF_META = { display: 'flex', alignItems: 'center', gap: '6px', margin: '0 0 2px 2px', fontSize: '11px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' };
    const REF_BODY = { margin: '2px 0 3px', padding: '3px 0 3px 9px', display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '12px', lineHeight: '1.65', maxHeight: '180px', overflowY: 'auto' };

    /** 出处一句话：类型、项目/全局、来源、状态。 */
    /** 只管最近一个月：更早或没时间就不占位。 */
    const agoLabel = (value) => {
      const at = Date.parse(value);
      if (!Number.isFinite(at)) return '';
      const days = Math.floor((Date.now() - at) / 86_400_000);
      if (days <= 0) return '今天更新';
      if (days === 1) return '昨天更新';
      if (days < 30) return `${days} 天前更新`;
      return '';
    };
    const refMetaOf = (item) => {
      /** 会话里只标层与来源：类型留给面板和工具，不占引用行的宽度。 */
      /** 来源只标注信任差别：自进化规则与模型整理稿都不会因此升级层级。 */
      const layer = `${item.scope === 'global' ? '[全局]' : '[项目]'}${item.origin === 'project_evolution' ? '[自进化]' : item.origin === 'model_drafted' ? '[模型]' : ''}`;
      const parts = [];
      const ago = agoLabel(item.updated);
      if (ago) parts.push(ago);
      if (item.status === 'archived') parts.push('已归档');
      const processing = PROCESSING_LABEL[item.processingStatus] || '';
      if (processing) parts.push(processing);
      return [layer, ...parts].join(' · ');
    };

    const RefChevron = (props) => h('svg', {
      width: 8, height: 8, viewBox: '0 0 8 8', 'aria-hidden': 'true', focusable: 'false',
      style: { flex: '0 0 auto', opacity: 0.65, transform: props.open ? 'rotate(90deg)' : 'none' },
    }, h('path', { d: 'M2.5 1 L5.5 4 L2.5 7', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));

    /** 一条引用：标题一行、原因与来源一行，窄栏也不抢宽度。 */
    const RefRow = (props) => {
      const [hover, setHover] = React.useState(false);
      const item = props.item;
      const reason = item.noTriggerReason || item.reason || '';
      return h('button', {
        type: 'button', // ui-copy-ignore
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: props.onShow, // ui-copy-ignore
        'aria-expanded': Boolean(props.active),
        'aria-label': `${props.active ? '收起' : '查看'}记忆 ${item.title || '记忆'}${reason ? `，${reason}` : ''}`,
        title: props.active ? `收起 ${item.title || '记忆'}` : (reason ? `${item.title || '记忆'}，${reason}` : (item.title || '记忆')),
        style: { // ui-copy-ignore
          display: 'flex', alignItems: 'flex-start', gap: '7px', width: '100%', minWidth: 0, textAlign: 'left',
          border: 'none', borderRadius: '8px', padding: '3px 7px', cursor: 'pointer', color: 'inherit',
          background: props.active || hover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          fontSize: '12px', lineHeight: '18px',
        },
      },
      h('span', { 'aria-hidden': 'true', style: { flex: '0 0 auto', alignSelf: 'stretch', width: '2px', minHeight: '10px', borderRadius: '999px', background: props.tone, opacity: 0.85 } }),
      h('span', { style: { display: 'flex', flexDirection: 'column', gap: '1px', flex: '1 1 auto', minWidth: 0 } },
        h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || '记忆'),
        h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' } },
          reason ? h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, reason) : null,
          h('span', { style: { marginLeft: 'auto', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, refMetaOf(item)),
        ),
      ));
    };

    /** 一段引用：点开是名字，再点是当前正文。 */
    const RefSection = (props) => {
      const items = Array.isArray(props.items) ? props.items : EMPTY;
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const tone = REF_TONE[props.tone] || REF_TONE.found;
      const [open, setOpen] = React.useState(false);
      const [shown, setShown] = React.useState(null);
      const [note, setNote] = React.useState('');
      const generation = React.useRef(0);
      const alive = React.useRef(true);
      React.useEffect(() => () => {
        alive.current = false;
        generation.current += 1;
      }, []);
      React.useEffect(() => {
        generation.current += 1;
        setOpen(false);
        setShown(null);
        setNote('');
      }, [sessionId, props.turnKey]);
      if (items.length === 0) {
        const reason = typeof props.noTriggerReason === 'string' ? props.noTriggerReason : '';
        return reason ? h('div', { style: { ...REF_META, margin: 0 } }, reason) : null;
      }
      const close = () => {
        generation.current += 1;
        setShown(null);
        setNote('');
        setOpen(false);
      };
      const show = (item) => {
        /** 再点同一条只收起正文，列表留着，方便接着看别的。 */
        if (shown && shown.key === item.key && shown.ref && shown.ref.revision === item.revision) {
          generation.current += 1;
          setShown(null);
          setNote('');
          return;
        }
        const request = generation.current + 1;
        generation.current = request;
        setOpen(true);
        setShown({ key: item.key, ref: item, loading: true });
        setNote('');
        post('/lite-memory/body', { title: item.title, scope: item.scope, revision: item.revision, sessionId }).then((result) => {
          if (!alive.current || generation.current !== request) return;
          const payload = result.ok && result.body ? result.body : null;
          if (!payload || payload.ok !== true) {
            setShown({ key: item.key, ref: item, invalid: true });
            return;
          }
          if (payload.status === 'gone') {
            setShown({ key: item.key, ref: item, gone: true });
            return;
          }
          setShown({
            key: item.key,
            ref: item,
            title: typeof payload.title === 'string' ? payload.title : '',
            when: typeof payload.when === 'string' ? payload.when : '',
            scope: payload.scope === 'global' ? 'global' : 'project',
            scopeLabel: typeof payload.scopeLabel === 'string' ? payload.scopeLabel : '',
            revision: Number.isInteger(payload.revision) ? payload.revision : item.revision,
            status: typeof payload.status === 'string' ? payload.status : 'ok',
            body: currentBodyOf(payload),
            processingStatus: processingStatusOf(payload) || item.processingStatus || '',
            payload,
            current: payload.revision === item.revision,
          });
        });
      };
      const detail = shown && shown.ref
        ? h('div', { style: { ...REF_BODY, margin: '2px 0 4px 7px', padding: '2px 2px 4px 10px', borderLeft: `2px solid ${tone}` } },
          shown.loading ? h('span', { style: REF_META }, '读取中…') : null,
          shown.gone ? h('span', { style: REF_META }, '这条记忆已经不在这里了') : null,
          shown.invalid ? h('span', { style: REF_META }, '读不到正文，点名字重试') : null,
          !shown.loading && !shown.gone && !shown.invalid ? h(React.Fragment, null,
            h('div', { style: { fontSize: '13px', lineHeight: '1.5', fontWeight: 600, wordBreak: 'break-word' } }, refDetailTitleOf(shown)),
            h('div', { style: REF_META }, versionLine(shown)),
            shown.when ? h('div', { style: REF_META }, shown.when) : null,
            shown.body
              ? h('div', { style: { color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, shown.body)
              : null,
            h(DetailExtras, { payload: { ...shown.ref, ...shown.payload } }),
          ) : null,
          note ? h('span', { style: REF_META }, note) : null,
        )
        : null;
      const rows = open
        ? refSectionRowsOf(items, shown, (item) => h(RefRow, {
          key: `${item.key}|${item.revision}`, // ui-copy-ignore
          item, tone, active: Boolean(shown && shown.ref && shown.key === item.key && shown.ref.revision === item.revision),
          onShow: () => show(item),
        }), () => detail)
        : [];
      return h('div', { style: DOCK, 'data-memory-section': props.label },
        h('button', {
          type: 'button', // ui-copy-ignore
          onClick: () => { if (open) close(); else setOpen(true); },
          'aria-expanded': open,
          'aria-label': `${open ? '收起' : '展开'}${props.label}，${items.length} 条`,
          style: {
            alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: '6px',
            border: 'none', background: 'transparent', padding: '1px 0', cursor: 'pointer',
            color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '18px',
          },
        },
        h('span', { 'aria-hidden': 'true', style: { width: '2px', height: '10px', borderRadius: '999px', background: tone, opacity: 0.9 } }),
        h('span', null, props.label),
        h('span', { style: { fontVariantNumeric: 'tabular-nums', opacity: 0.8 } }, String(items.length)),
        h(RefChevron, { open }),
        ),
        ...rows,
      );
    };

    const EVO_BUTTON = { flex: '0 0 auto', width: '28px', height: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', color: 'inherit', borderRadius: '999px', padding: 0, cursor: 'pointer' };

    /** 大脑：两瓣轮廓加一条中线，状态只靠透明度和面板文字。 */
    const BrainIcon = () => h('svg', {
      width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true', focusable: 'false',
    },
    h('path', { d: 'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z' }),
    h('path', { d: 'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z' }),
    h('path', { d: 'M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4' }));

    const CloseIcon = () => h('svg', {
      width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round',
      'aria-hidden': 'true', focusable: 'false',
    }, h('path', { d: 'M6 6l12 12M18 6L6 18' }));

    const EVO_STATE = { pending: '候选', trial: '试用', active: '生效', paused: '暂停' };
    const KIND_LABEL = {
      preference: '偏好', convention: '约定', procedure: '流程', pointer: '位置',
      pitfall: '坑', credential_hint: '凭据位置', note: '笔记',
    };
    const CONDITION_LABEL = {
      seriesId: '系列', taskKind: '任务', targetOs: '系统', shell: '终端', runtime: '运行时',
      machine: '设备', projectRoot: '项目路径', pathPrefix: '路径前缀', artifactKey: '产物', phase: '阶段',
    };
    const EVO_DATE = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '');
    const SHORT = (value, size) => {
      const text = typeof value === 'string' ? value : '';
      return text.length > size ? `${text.slice(0, size)}…` : text;
    };

    /** 待裁决先露两条；「查看全部 N 条」后按队列原样全列，不截断。 */
    const conflictVisibleRows = (queued, all) => (all ? queued : queued.slice(0, 2));

    /** 面板展开区一次给全：层级、适用条件、范围清单、触发词、相近条目、完整正文。 */
    const conflictFactsOf = (row) => {
      const draft = row && row.draft && typeof row.draft === 'object' ? row.draft : {};
      const conditions = (Array.isArray(draft.conditions) ? draft.conditions : []).map((item) => {
        if (!item || typeof item !== 'object') return '';
        const key = String(item.key || item.name || '').trim();
        const value = String(item.value || '').trim();
        return key && value ? `${key}=${value}` : key || value;
      }).filter(Boolean).join(' · ');
      const selection = draft.selection && typeof draft.selection === 'object' ? draft.selection : null;
      let selectionText = '';
      if (selection && selection.mode === 'complete') selectionText = `清单完整${selection.artifactKey ? ` · ${selection.artifactKey}` : ''}`;
      else if (selection && selection.mode === 'examples') {
        const items = Array.isArray(selection.items) ? selection.items.filter(Boolean) : [];
        selectionText = items.length > 0 ? `举例：${items.join('、')}` : '举例';
      }
      const triggers = Array.isArray(draft.triggers) ? draft.triggers.filter(Boolean).join('、') : '';
      const near = Array.isArray(row && row.candidates) ? row.candidates.map((item) => item && item.title).filter(Boolean) : [];
      const body = String(draft.body || draft.summary || '');
      return {
        scope: row && row.scope === 'global' ? '总记忆' : '本项目',
        when: typeof draft.when === 'string' ? draft.when : '',
        conditions,
        selection: selectionText,
        triggers,
        near: near.join('、'),
        /** 旧队列的草稿正文没落下：只能丢掉。 */
        draftMissing: body.trim() === '',
        body,
      };
    };

    /** 显示设置只决定画不画，不改学习状态；按项目 key 存在本机。 */
    const DISPLAY_DEFAULTS = Object.freeze({ graph: false, palace: false });
    const displayKeyOf = (projectKey) => `lite-memory:display:${projectKey || 'default'}`;
    const displayStoreOf = () => {
      try {
        const store = globalThis.localStorage;
        return store && typeof store.getItem === 'function' ? store : null;
      } catch {
        return null;
      }
    };
    const readDisplaySettings = (projectKey) => {
      const store = displayStoreOf();
      const next = { ...DISPLAY_DEFAULTS };
      if (!store) return next;
      try {
        const raw = store.getItem(displayKeyOf(projectKey));
        if (!raw) return next;
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
          next.graph = saved.graph === true;
          next.palace = saved.palace === true;
        }
      } catch {
        return next;
      }
      return next;
    };
    const writeDisplaySettings = (projectKey, next) => {
      const store = displayStoreOf();
      if (!store) return false;
      try {
        store.setItem(displayKeyOf(projectKey), JSON.stringify({
          graph: next && next.graph === true,
          palace: next && next.palace === true,
        }));
        return true;
      } catch {
        return false;
      }
    };
    /**
     * 解释模式只在本机、按会话记；默认关，零命中原因不打扰。
     * 面板开关与对话末尾共用同一条广播。
     */
    const explainBus = (() => {
      const key = '__liteMemoryExplainBus'; // ui-copy-ignore
      if (!(globalThis[key] instanceof Set)) globalThis[key] = new Set();
      return globalThis[key];
    })();
    const explainKeyOf = (sessionId) => `lite-memory:explain:${sessionId || 'default'}`;
    const explainModeOf = (sessionId) => {
      const store = displayStoreOf();
      if (!store) return false;
      try {
        return store.getItem(explainKeyOf(sessionId)) === '1';
      } catch {
        return false;
      }
    };
    const setExplainMode = (sessionId, on) => {
      const store = displayStoreOf();
      if (!store) return false;
      try {
        store.setItem(explainKeyOf(sessionId), on === true ? '1' : '0');
      } catch {
        return false;
      }
      for (const listener of [...explainBus]) {
        try {
          listener();
        } catch {
          // 单个订阅坏掉不影响其它面板。
        }
      }
      return true;
    };
    const watchExplain = (listener) => {
      explainBus.add(listener);
      return () => explainBus.delete(listener);
    };
    /** 召回回执只说“多久以前”，不跟列表的“更新”混用。 */
    const shortAgo = (value) => {
      const at = Date.parse(value);
      if (!Number.isFinite(at)) return '';
      const minutes = Math.floor((Date.now() - at) / 60_000);
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时前`;
      const days = Math.floor(hours / 24);
      return days < 30 ? `${days} 天前` : '';
    };
    /**
     * 面板只说判断结果，不说内部原因码；条数来自上一次自动召回的回执。
     */
    const recallTextOf = (receipt) => {
      if (!receipt || typeof receipt !== 'object') return '';
      const cards = Number.isInteger(receipt.cards) ? receipt.cards : 0;
      const matched = Number.isInteger(receipt.matched) ? receipt.matched : 0;
      const related = matched > 0 ? `${matched} 条相关记忆，` : '';
      switch (receipt.reason) {
        case 'hit': return cards > 0 ? `上次自动提醒 ${cards} 条` : '';
        case 'budget': return `上次没提醒，${related}本轮自动提醒已用满`;
        case 'needs_context': return `上次没提醒，${related}适用条件未确认`;
        case 'conflict': return `上次没提醒，${related}存在冲突的结论`;
        case 'no_overlap': return '上次没提醒，没有匹配的记忆';
        case 'expired': return '上次没提醒，相关内容已经过期';
        case 'memory_off': return '上次没提醒，记忆已关闭';
        case 'tools_only': return '上次没提醒，只在你问时检索';
        default: return '';
      }
    };
    /** 回执可能是上一轮甚至更早的：带上时间，别让旧提醒看起来像刚发生。 */
    /** 三个按钮压成两个开关：亮着的即当前状态。 */
    const modeSwitchesOf = (mode) => [
      { key: 'remind', label: '自动提醒', hint: mode === 'adaptive' ? '相关时自动放进这一轮' : '关掉后只在你搜索时出现', on: mode === 'adaptive' },
      { key: 'enabled', label: '启用记忆', hint: mode === 'off' ? '已关闭' : '关掉后不参与回答', on: mode !== 'off' },
    ];

    const recallLineOf = (receipt) => {
      const text = recallTextOf(receipt);
      const when = receipt && typeof receipt === 'object' ? shortAgo(receipt.at) : '';
      return text && when ? `${text} · ${when}` : text;
    };
    /** 功能关闭时视图统一回列表，不保留一个画不出来的页签。 */
    const graphViewOf = (enabled, view) => (enabled === true && view === 'graph' ? 'graph' : 'list');
    const viewModeOf = (display, view) => {
      if (view === 'graph' && display && display.graph === true) return 'graph';
      if (view === 'palace' && display && display.palace === true) return 'palace';
      return 'list';
    };
    const reduceMotionOf = () => {
      try {
        const query = globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)');
        return Boolean(query && query.matches === true);
      } catch {
        return false;
      }
    };
    /** 跟随系统偏好切换，打开面板期间改设置也能立即生效。 */
    const useReducedMotion = () => {
      const [reduced, setReduced] = React.useState(reduceMotionOf);
      React.useEffect(() => {
        let query = null;
        try {
          query = globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)');
        } catch {
          query = null;
        }
        if (!query || typeof query.addEventListener !== 'function') return undefined;
        const update = () => setReduced(query.matches === true);
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
      }, []);
      return reduced;
    };

    /** 同标题（去空白后）出现几次；体检与重复标题筛选共用。 */
    const titleCountsOf = (records) => {
      const counts = new Map();
      (Array.isArray(records) ? records : EMPTY).forEach((record) => {
        const title = typeof record.title === 'string' ? record.title.trim() : '';
        if (title) counts.set(title, (counts.get(title) || 0) + 1);
      });
      return counts;
    };
    /** 真被用过才算读过：`lastUsed` 有创建时间回退值。 */
    const usedOf = (record) => (record && record.used !== undefined ? record.used === true : Boolean(record && record.lastUsed));
    /** 标签/话题按精确值筛选；只有自由搜索才用包含匹配。 */
    const filterRecords = (records, query, hub) => {
      const rows = Array.isArray(records) ? records : EMPTY;
      const kind = hub && typeof hub.kind === 'string' ? hub.kind : '';
      const value = hub && typeof hub.value === 'string' ? hub.value : '';
      if (kind === 'tag' && value) {
        return rows.filter((record) => Array.isArray(record.tags) && record.tags.includes(value));
      }
      if (kind === 'topic' && value) {
        return rows.filter((record) => record.topicKey === value);
      }
      if (kind === 'duplicate' || kind === 'unread' || kind === 'noWhen') {
        const counts = titleCountsOf(rows);
        return rows.filter((record) => {
          if (kind === 'unread') return !usedOf(record);
          if (kind === 'noWhen') return !record.when;
          const title = typeof record.title === 'string' ? record.title.trim() : '';
          return Boolean(title) && counts.get(title) > 1;
        });
      }
      const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
      if (!needle) return rows;
      return rows.filter((record) => {
        const tags = Array.isArray(record.tags) ? record.tags.join(' ') : '';
        return `${record.title || ''} ${record.summary || ''} ${tags} ${record.topicKey || ''} ${KIND_LABEL[record.kind] || ''}`.toLowerCase().includes(needle);
      });
    };

    /** 结构体检：只看现行记录，缺的数据给 null，不猜。 */
    const checkupOf = (records, scopes, globalSelected) => {
      const rows = Array.isArray(records) ? records : EMPTY;
      const counts = titleCountsOf(rows);
      let duplicate = 0;
      counts.forEach((count) => { if (count > 1) duplicate += 1; });
      const globalRow = (Array.isArray(scopes) ? scopes : EMPTY).find((scope) => scope && scope.kind === 'global');
      return {
        duplicate,
        unread: rows.filter((record) => !usedOf(record)).length,
        globalEntries: globalRow && Number.isInteger(globalRow.entries) ? globalRow.entries : null,
        globalMissingWhen: globalSelected ? rows.filter((record) => !record.when).length : null,
      };
    };

    /** 记忆宫殿：房间固定，槽位固定，换项目只换陈列内容。 */
    const PALACE_PAGE_SIZE = 24;
    const PALACE_PREVIEW = 4;
    const PALACE_ROOMS = Object.freeze([
      Object.freeze({ id: 'habits', name: '习惯与规范', kinds: Object.freeze(['preference', 'convention']) }),
      Object.freeze({ id: 'methods', name: '方法与经验', kinds: Object.freeze(['procedure', 'pitfall']) }),
      Object.freeze({ id: 'entries', name: '资料与入口', kinds: Object.freeze(['pointer', 'credential_hint']) }),
      Object.freeze({ id: 'notes', name: '其他记录', kinds: Object.freeze(['note']) }),
    ]);
    const PALACE_ROOM_OF_KIND = Object.freeze({
      preference: 'habits', convention: 'habits',
      procedure: 'methods', pitfall: 'methods',
      pointer: 'entries', credential_hint: 'entries',
      note: 'notes',
    });
    const palaceRoomIdOf = (kind) => PALACE_ROOM_OF_KIND[kind] || 'notes';
    const palaceRoomsOf = (records) => {
      const rows = Array.isArray(records) ? records : EMPTY;
      return PALACE_ROOMS.map((room) => {
        const items = rows.filter((record) => palaceRoomIdOf(record && record.kind) === room.id);
        return { id: room.id, name: room.name, items, total: items.length, pages: Math.max(1, Math.ceil(items.length / PALACE_PAGE_SIZE)) };
      });
    };
    /** 房间预览按内容铺：1 条就 1 个槽，不拿虚位占地方。 */
    const palaceSlotCountOf = (total) => Math.min(PALACE_PREVIEW, Math.max(1, Number.isFinite(total) ? Math.floor(total) : 0));
    const palaceRoomPageOf = (records, roomId, page) => {
      const room = palaceRoomsOf(records).find((row) => row.id === roomId);
      if (!room) return { items: EMPTY, total: 0, pages: 0, page: 1 };
      const current = Math.min(room.pages, Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1));
      return {
        items: room.items.slice((current - 1) * PALACE_PAGE_SIZE, current * PALACE_PAGE_SIZE),
        total: room.total, pages: room.pages, page: current,
      };
    };
    /** 页码最多铺 7 个，当前页始终在窗口里。 */
    const palacePageWindow = (page, pages) => {
      const total = Math.max(1, Math.floor(Number.isFinite(pages) ? pages : 1));
      const current = Math.min(total, Math.max(1, Math.floor(Number.isFinite(page) ? page : 1)));
      if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
      const start = Math.max(1, Math.min(current - 3, total - 6));
      return Array.from({ length: 7 }, (_, index) => start + index);
    };
    const palaceToggleOf = (expanded, roomId) => (expanded === roomId ? '' : roomId);
    const palaceMotionOf = (reduced) => ({ duration: reduced === true ? 0 : 180, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });

    /** 失败回执分「当前」和「过去」：当前失败要修，过去的只说明发生过。 */
    const failureStateOf = (evolution) => {
      const rows = evolution && evolution.economy && Array.isArray(evolution.economy.recent) ? evolution.economy.recent : EMPTY;
      if (rows.length === 0) return '';
      if (rows[0] && rows[0].status === 'failed') return 'current';
      return rows.slice(1).some((row) => row && row.status === 'failed') ? 'past' : '';
    };

    /** 面板开关。 */
    const panelUi = { open: false, sessionId: '' };
    const panelListeners = new Set();
    const updatePanel = (patch) => {
      Object.assign(panelUi, patch);
      for (const listener of panelListeners) listener();
    };
    const usePanelUi = () => {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1);
        panelListeners.add(listener);
        return () => { panelListeners.delete(listener); };
      }, []);
      return panelUi;
    };

    /** 会话头：只留一个图标按钮，开合由浮层里的面板负责。 */
    const ProjectEvolution = (props) => {
      const sessionId = sessionKeyOf(props);
      const ui = usePanelUi();

      React.useEffect(() => {
        if (!sessionId) return undefined;
        if (panelUi.sessionId && panelUi.sessionId !== sessionId) updatePanel({ open: false });
        updatePanel({ sessionId });
        return undefined;
      }, [sessionId]);

      if (!sessionId) return null;
      return h('button', {
        type: 'button',
        onClick: () => updatePanel({ open: true, sessionId }),
        'aria-haspopup': 'dialog',
        'aria-expanded': ui.open === true && ui.sessionId === sessionId,
        'aria-label': '记忆面板',
        title: '记忆面板',
        style: { ...EVO_BUTTON, opacity: 0.72 },
      }, h(BrainIcon));
    };

    const PANEL_CARD = {
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '12px',
      padding: '12px',
      minWidth: 0,
    };
    const PANEL_MUTED = { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '1.5' };
    const PANEL_LABEL = { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '1.4', letterSpacing: '0.02em' };
    const PANEL_LINK = {
      border: 'none', background: 'transparent', color: 'inherit', padding: 0,
      fontSize: '11px', lineHeight: '18px', opacity: 0.72, cursor: 'pointer',
    };
    const PANEL_INPUT = {
      width: '100%', boxSizing: 'border-box', height: '30px', padding: '0 9px',
      border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
      background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
      fontSize: '12px', outline: 'none',
    };
    const PANEL_BACKDROP = {
      position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: '24px', pointerEvents: 'auto',
      background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 58%, transparent)',
    };
    const PANEL_DIALOG = {
      width: 'min(1240px, 100%)', height: 'min(780px, 100%)', display: 'flex',
      flexDirection: 'column', background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '16px', boxShadow: '0 24px 70px rgba(0, 0, 0, 0.28)', overflow: 'hidden',
    };

    const hashOf = (value) => {
      let hash = 2166136261;
      const text = String(value || '');
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return Math.abs(hash);
    };

    /**
     * 图谱只画真实关系：显式关联，以及记录自己的标签 / 主题。
     * 标签 / 主题是组：枢纽画大点，成员围在它周围画小点。
     * 位置由 id 与成员关系决定，同一份数据每次打开都在同一处。
     */
    const layoutGraph = (nodes, edges, primaryKind) => {
      const kindOf = new Map(nodes.map((node) => [node.id, node.kind]));
      const degree = new Map();
      const linkedOf = new Map();
      const membersOf = new Map();
      const addLink = (primaryId, hubId) => {
        if (!linkedOf.has(primaryId)) linkedOf.set(primaryId, new Set());
        linkedOf.get(primaryId).add(hubId);
        if (!membersOf.has(hubId)) membersOf.set(hubId, new Set());
        membersOf.get(hubId).add(primaryId);
      };
      for (const edge of edges) {
        degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
        degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
        if (kindOf.get(edge.from) === primaryKind && kindOf.get(edge.to) !== primaryKind) addLink(edge.from, edge.to);
        if (kindOf.get(edge.to) === primaryKind && kindOf.get(edge.from) !== primaryKind) addLink(edge.to, edge.from);
      }
      const primaries = nodes.filter((node) => node.kind === primaryKind);
      const hubs = nodes.filter((node) => node.kind !== primaryKind);
      const weightOf = new Map(hubs.map((hub) => [hub.id, (membersOf.get(hub.id) || EMPTY).size]));
      const groups = new Map();
      const assignedHub = new Map();
      const loose = [];
      for (const node of primaries) {
        const options = [...(linkedOf.get(node.id) || EMPTY)]
          .filter((id) => (weightOf.get(id) || 0) > 1)
          .sort((a, b) => ((weightOf.get(b) || 0) - (weightOf.get(a) || 0)) || a.localeCompare(b));
        const hubId = options[0];
        if (!hubId) { loose.push(node); continue; }
        if (!groups.has(hubId)) groups.set(hubId, []);
        groups.get(hubId).push(node);
        assignedHub.set(node.id, hubId);
      }
      const placed = new Map();
      if (primaryKind === 'memory') {
        for (const [hubId, members] of [...groups]) {
          if (members.length > 1) continue;
          for (const member of members) {
            loose.push(member);
            assignedHub.delete(member.id);
          }
          groups.delete(hubId);
        }
      }
      const clusterList = [...groups.entries()]
        .sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]));
      const groupCount = clusterList.length;
      const ring = groupCount <= 1 ? 0 : groupCount <= 4 ? 150 : groupCount <= 8 ? 182 : 212;
      const hubRadius = (size) => 8 + Math.min(10, Math.sqrt(size) * 3);
      const placePrimary = (node, x, y) => {
        placed.set(node.id, {
          ...node, x, y,
          radius: 3.2 + Math.min(2.2, (degree.get(node.id) || 0) * 0.35),
        });
      };
      clusterList.forEach(([hubId, members], index) => {
        const seed = hashOf(hubId);
        const angle = groupCount <= 1
          ? 0
          : (index / groupCount) * Math.PI * 2 - Math.PI / 2 + ((seed % 13) / 13) * 0.12;
        const cx = 320 + Math.cos(angle) * ring * 1.22;
        const cy = 236 + Math.sin(angle) * ring * 0.8;
        const hub = hubs.find((node) => node.id === hubId);
        const radius = hubRadius(members.length);
        placed.set(hubId, { ...hub, x: cx, y: cy, radius });
        const orbit = radius + 20 + Math.sqrt(members.length) * 13;
        const start = ((seed % 360) / 180) * Math.PI;
        members.forEach((node, memberIndex) => {
          const step = (memberIndex / members.length) * Math.PI * 2;
          const wobble = 0.88 + ((hashOf(node.id) % 25) / 100);
          placePrimary(node, cx + Math.cos(start + step) * orbit * wobble, cy + Math.sin(start + step) * orbit * 0.82 * wobble);
        });
      });
      if (loose.length > 0) {
        const orbit = groupCount === 0
          ? (loose.length <= 1 ? 0 : loose.length <= 8 ? 128 : loose.length <= 18 ? 168 : 206)
          : ring + 96;
        loose.forEach((node, index) => {
          const seed = hashOf(node.id);
          const angle = loose.length <= 1
            ? 0
            : (index / loose.length) * Math.PI * 2 - Math.PI / 2 + ((seed % 17) / 17) * 0.14;
          const wobble = loose.length <= 8 ? 1 : 0.64 + ((seed % 100) / 100) * 0.36;
          placePrimary(node, 320 + Math.cos(angle) * orbit * 1.22 * wobble, 236 + Math.sin(angle) * orbit * 0.8 * wobble);
        });
      }
      return {
        nodes: [...placed.values()],
        edges: edges.filter((edge) => {
          if (!placed.has(edge.from) || !placed.has(edge.to)) return false;
          const fromPrimary = kindOf.get(edge.from) === primaryKind;
          const toPrimary = kindOf.get(edge.to) === primaryKind;
          if (fromPrimary && toPrimary) return true;
          if (primaryKind !== 'memory') return true;
          if (fromPrimary) return assignedHub.get(edge.from) === edge.to;
          if (toPrimary) return assignedHub.get(edge.to) === edge.from;
          return false;
        }),
        people: primaries.length,
      };
    };

    /** 60 条投影之外也要保留当前选中项，点开的节点不能从图里消失。 */
    const projectionOf = (all, selectedId) => {
      const rows = all.slice(0, 60);
      if (selectedId && !rows.some((row) => row.id === selectedId)) {
        const selected = all.find((row) => row.id === selectedId);
        if (selected) rows[rows.length - 1] = selected;
      }
      return rows;
    };

    const graphOf = (records, selectedId) => {
      const all = Array.isArray(records) ? records : EMPTY;
      const rows = projectionOf(all, selectedId);
      const byId = new Map(rows.map((record) => [record.id, record]));
      const tagCount = new Map();
      const topicCount = new Map();
      for (const record of rows) {
        for (const tag of Array.isArray(record.tags) ? record.tags : EMPTY) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
        if (record.topicKey) topicCount.set(record.topicKey, (topicCount.get(record.topicKey) || 0) + 1);
      }
      const tags = [...tagCount.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
      const topics = [...topicCount.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const nodes = [];
      const edges = [];
      const addEdge = (from, to, type) => {
        if (!from || !to || from === to) return;
        edges.push({ from, to, type });
      };
      for (const record of rows) {
        nodes.push({ id: record.id, kind: 'memory', label: record.title || '记忆', experimental: record.experimental === true });
      }
      for (const [tag, count] of tags) {
        nodes.push({ id: `tag:${tag}`, kind: 'tag', label: `#${tag}`, count });
        for (const record of rows) {
          if (Array.isArray(record.tags) && record.tags.includes(tag)) addEdge(record.id, `tag:${tag}`, 'tag');
        }
      }
      for (const [topic, count] of topics) {
        nodes.push({ id: `topic:${topic}`, kind: 'topic', label: topic, count });
        for (const record of rows) {
          if (record.topicKey === topic) addEdge(record.id, `topic:${topic}`, 'topic');
        }
      }
      for (const record of rows) {
        for (const link of Array.isArray(record.links) ? record.links : EMPTY) {
          if (byId.has(link.id)) addEdge(record.id, link.id, 'link');
        }
      }
      return {
        ...layoutGraph(nodes, edges, 'memory'),
        shown: rows.length,
        total: all.length,
      };
    };

    /** 经验图谱只连共享条件。 */
    const ruleGraphOf = (rules, selectedId) => {
      const all = Array.isArray(rules) ? rules : EMPTY;
      const rows = projectionOf(all, selectedId);
      const conditionCount = new Map();
      for (const rule of rows) {
        const seen = new Set();
        for (const condition of Array.isArray(rule.conditions) ? rule.conditions : EMPTY) {
          if (!condition || !condition.key || !condition.value) continue;
          const id = `condition:${condition.key}:${condition.value}`;
          if (seen.has(id)) continue;
          seen.add(id);
          conditionCount.set(id, (conditionCount.get(id) || 0) + 1);
        }
      }
      const shared = [...conditionCount.entries()]
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10);
      const nodes = [];
      const edges = [];
      for (const rule of rows) {
        nodes.push({
          id: rule.id, kind: 'rule', label: rule.title || rule.id,
          state: rule.state, experimental: rule.state === 'pending' || rule.state === 'trial',
        });
      }
      for (const [id, count] of shared) {
        const [, key, ...rest] = id.split(':');
        const value = rest.join(':');
        nodes.push({
          id, kind: 'condition', label: `#${value}`, count,
          title: `${CONDITION_LABEL[key] || key} ${value}`,
        });
        for (const rule of rows) {
          if ((Array.isArray(rule.conditions) ? rule.conditions : EMPTY).some((item) => item && item.key === key && item.value === value)) {
            edges.push({ from: rule.id, to: id, type: 'condition' });
          }
        }
      }
      return {
        ...layoutGraph(nodes, edges, 'rule'),
        shown: rows.length,
        total: all.length,
      };
    };

    /** 关系图只画真实关系；节点沿用原始 id，位置由 id 决定。 */
    /** 图谱缩放：28px 命中区，悬停/聚焦才给底色。 */
    const ZoomButton = (props) => {
      const [hover, setHover] = React.useState(false);
      return h('button', {
        type: 'button', onClick: props.onClick, disabled: props.disabled,
        'aria-label': props.label, title: props.label,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setHover(true),
        onBlur: () => setHover(false),
        style: {
          width: '28px', height: '28px', padding: 0, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', border: 'none',
          borderRadius: '8px', background: hover && !props.disabled ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: 'inherit', opacity: props.disabled ? 0.35 : hover ? 0.95 : 0.72,
          cursor: props.disabled ? 'default' : 'pointer',
        },
      }, props.children);
    };

    const MemoryGraph = (props) => {
      const primaryKind = props.primaryKind || 'memory';
      const selectedId = props.selectedId;
      const graph = React.useMemo(() => (props.graphOf || graphOf)(props.records, selectedId), [props.records, props.graphOf, selectedId]);
      const [zoom, setZoom] = React.useState(1);
      const [pan, setPan] = React.useState({ x: 0, y: 0 });
      const [dragging, setDragging] = React.useState(false);
      const [hoveredId, setHoveredId] = React.useState('');
      const [hoverAt, setHoverAt] = React.useState(null);
      const svgRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const labelSet = graph.people <= 40;
      const hubCount = graph.nodes.length - graph.people;
      const shownCount = Number.isInteger(graph.shown) ? graph.shown : graph.people;
      const totalCount = Number.isInteger(props.total) && props.total >= shownCount
        ? props.total
        : (Number.isInteger(graph.total) ? graph.total : shownCount);
      const truncated = totalCount > shownCount;
      const nearIds = React.useMemo(() => {
        const set = new Set();
        if (!selectedId) return set;
        set.add(selectedId);
        for (const edge of graph.edges) {
          if (edge.from === selectedId) set.add(edge.to);
          if (edge.to === selectedId) set.add(edge.from);
        }
        return set;
      }, [graph.edges, selectedId]);
      const orderedEdges = selectedId
        ? [...graph.edges].sort((a, b) => Number(a.from === selectedId || a.to === selectedId) - Number(b.from === selectedId || b.to === selectedId))
        : graph.edges;
      const orderedNodes = selectedId
        ? [...graph.nodes].sort((a, b) => (Number(nearIds.has(a.id)) - Number(nearIds.has(b.id))) || (Number(a.id === selectedId) - Number(b.id === selectedId)))
        : graph.nodes;
      const pickHub = props.onPickHub;
      const MIN_ZOOM = 0.2;
      const MAX_ZOOM = 2.5;
      const stepZoom = (delta) => setZoom((value) => {
        const next = delta > 0 ? value * 1.25 : value / 1.25;
        return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(next * 100) / 100));
      });
      const pointAt = (event, matrix) => {
        const svg = svgRef.current;
        if (!svg || !matrix) return null;
        const point = svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        return point.matrixTransform(matrix);
      };
      const startPan = (event) => {
        if (event.button !== 0) return;
        if (event.target && event.target.closest && event.target.closest('[data-node]')) return;
        const svg = svgRef.current;
        if (!svg) return;
        const ctm = svg.getScreenCTM();
        if (!ctm) return;
        const inverse = ctm.inverse();
        const point = pointAt(event, inverse);
        if (!point) return;
        dragRef.current = [event.pointerId, inverse, point.x, point.y, pan.x, pan.y];
        setDragging(true);
        if (svg.setPointerCapture) svg.setPointerCapture(event.pointerId);
        event.preventDefault();
      };
      const movePan = (event) => {
        const drag = dragRef.current;
        if (!drag || drag[0] !== event.pointerId) return;
        const point = pointAt(event, drag[1]);
        if (!point) return;
        setPan({ x: drag[4] - (point.x - drag[2]), y: drag[5] - (point.y - drag[3]) });
        event.preventDefault();
      };
      const endPan = (event) => {
        const drag = dragRef.current;
        if (!drag || (event && drag[0] !== event.pointerId)) return;
        dragRef.current = null;
        setDragging(false);
        const svg = svgRef.current;
        if (event && svg && svg.releasePointerCapture && svg.hasPointerCapture && svg.hasPointerCapture(event.pointerId)) {
          svg.releasePointerCapture(event.pointerId);
        }
      };
      React.useEffect(() => {
        setPan({ x: 0, y: 0 });
      }, [props.records, primaryKind]);
      const frame = React.useMemo(() => {
        const list = graph.nodes;
        if (list.length === 0) return { x: 0, y: 0, width: 640, height: 472 };
        let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
        for (const node of list) {
          const wide = node.kind === primaryKind && (graph.people <= 12 || hubCount === 0 || node.id === selectedId);
          const half = node.kind === primaryKind ? (wide ? 62 : 54) : 38;
          minX = Math.min(minX, node.x - half);
          maxX = Math.max(maxX, node.x + half);
          minY = Math.min(minY, node.y - 16);
          maxY = Math.max(maxY, node.y + (node.kind === primaryKind ? (wide ? 30 : 28) : 26));
        }
        /** 画布 640×472 是布局坐标，子图不放大。 */
        const width = Math.max(640, maxX - minX + 36);
        const height = Math.max(472, maxY - minY + 36);
        return { x: (minX + maxX) / 2 - width / 2, y: (minY + maxY) / 2 - height / 2, width, height };
      }, [graph, primaryKind, selectedId]);
      const viewWidth = frame.width / zoom;
      const viewHeight = frame.height / zoom;
      const zoomButton = (label, delta, icon) => h(ZoomButton, {
        key: label, label, disabled: delta > 0 ? zoom >= MAX_ZOOM : zoom <= MIN_ZOOM,
        onClick: () => stepZoom(delta),
      }, icon);
      const magnifier = (sign) => h('svg', {
        width: '15', height: '15', viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round',
        'aria-hidden': 'true',
      },
      h('circle', { cx: '6.8', cy: '6.8', r: '4.5' }),
      h('line', { x1: '10.1', y1: '10.1', x2: '14', y2: '14' }),
      h('line', { x1: '4.8', y1: '6.8', x2: '8.8', y2: '6.8' }),
      sign > 0 ? h('line', { x1: '6.8', y1: '4.8', x2: '6.8', y2: '8.8' }) : null);
      /** 标签避让：hub 常显、选中/悬停优先，记忆标签按度数贪心排布，重叠就省掉（悬停仍出标题）。 */
      const labelLayout = React.useMemo(() => {
        const nodes = graph.nodes;
        const fsOf = (primary) => (primary ? 10.5 : 10);
        const widthOf = (text, fs) => {
          let width = 0;
          for (const ch of text) width += ch.charCodeAt(0) > 255 ? fs : fs * 0.56;
          return width;
        };
        const rank = (node) => (node.id === selectedId ? 0 : node.id === hoveredId ? 1
          : nearIds.has(node.id) ? 2 : node.kind === primaryKind ? 4 : 3);
        const boxes = [];
        const placed = new Map();
        const hits = (box) => boxes.some((other) => !(box.x2 < other.x1 || box.x1 > other.x2 || box.y2 < other.y1 || box.y1 > other.y2));
        const list = nodes.slice().sort((a, b) => rank(a) - rank(b) || (b.degree || 0) - (a.degree || 0));
        /** 条目多时不全标，用度数最高的十条记忆给方向感。 */
        const topIds = new Set(list.filter((node) => node.kind === primaryKind).slice(0, 10).map((node) => node.id));
        for (const node of list) {
          const isPrimary = node.kind === primaryKind;
          if (isPrimary && !labelSet && rank(node) > 2 && !topIds.has(node.id)) continue;
          const chars = rank(node) <= 1 ? 16 : isPrimary ? (labelSet ? 10 : 8) : 13;
          const text = SHORT(node.label, chars);
          const fs = fsOf(isPrimary);
          const width = widthOf(text, fs);
          const gap = isPrimary ? 12 : 13;
          let spot = null;
          for (const below of [true, false]) {
            const baseline = below ? node.y + node.radius + gap : node.y - node.radius - gap + fs;
            const box = { x1: node.x - width / 2 - 3, x2: node.x + width / 2 + 3, y1: baseline - fs - 2, y2: baseline + 3 };
            if (box.y1 < 3 || box.y2 > graph.height - 3) continue;
            if (hits(box)) continue;
            spot = { box, baseline, below };
            break;
          }
          if (!spot) continue;
          boxes.push(spot.box);
          placed.set(node.id, { text, isPrimary, baseline: spot.baseline, fs, width });
        }
        return placed;
      }, [graph, primaryKind, selectedId, hoveredId, labelSet, nearIds]);
      /** 空图提前返回必须放在全部 hook 之后：任何一次渲染的 hook 数量与顺序都要一致。 */
      if (!props.records || props.records.length === 0) {
        return h('div', {
          style: { flex: 1, minHeight: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
        }, props.emptyText || '还没有记忆');
      }
      const hoveredNode = hoveredId ? graph.nodes.find((node) => node.id === hoveredId) : null;
      const hoverText = hoveredNode ? String(hoveredNode.title || hoveredNode.label || '') : '';
      const hoverBubble = hoveredNode && hoverAt && hoverText
        ? h('div', {
          key: 'hover-bubble',
          style: {
            position: 'absolute', left: `${hoverAt.x + 12}px`, top: `${hoverAt.y + 14}px`, zIndex: 3,
            maxWidth: '300px', padding: '6px 8px', borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)', fontSize: '12px', lineHeight: '17px',
            whiteSpace: 'normal', overflowWrap: 'anywhere', pointerEvents: 'none',
            boxShadow: '0 6px 20px rgba(0, 0, 0, 0.18)',
          },
        }, hoverText) : null;
      return h('div', {
        style: { position: 'relative', flex: 1, minHeight: 0, display: 'flex' },
        onMouseMove: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          setHoverAt((value) => (value && Math.abs(value.x - x) < 3 && Math.abs(value.y - y) < 3 ? value : { x, y }));
        },
        onMouseLeave: () => { setHoverAt(null); setHoveredId(''); },
      },
        h('div', {
          style: {
            position: 'absolute', top: '8px', right: '8px', zIndex: 2,
            display: 'flex', alignItems: 'center', gap: '2px', padding: '2px',
            border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        },
        zoomButton('缩小图谱', -0.25, magnifier(-1)),
        zoomButton('放大图谱', 0.25, magnifier(1)),
        h('button', {
          type: 'button', onClick: () => setZoom(1),
          'aria-label': '重置缩放', title: '重置缩放',
          style: {
            minWidth: '44px', height: '28px', padding: '0 6px', border: 'none', borderRadius: '8px',
            background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
            fontSize: '11px', lineHeight: '28px', fontVariantNumeric: 'tabular-nums', cursor: 'pointer',
          },
        }, `${Math.round(zoom * 100)}%`)),
        hoverBubble,
        h('svg', {
          ref: svgRef,
          viewBox: `${frame.x + frame.width / 2 - viewWidth / 2 + pan.x} ${frame.y + frame.height / 2 - viewHeight / 2 + pan.y} ${viewWidth} ${viewHeight}`,
          preserveAspectRatio: 'xMidYMid meet',
          style: {
            width: '100%', height: '100%', flex: 1, minHeight: 0, display: 'block',
            cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none',
            userSelect: 'none', WebkitUserSelect: 'none',
          },
          onPointerDown: startPan,
          onPointerMove: movePan,
          onPointerUp: endPan,
          onPointerCancel: endPan,
          onLostPointerCapture: endPan,
          onDragStart: (event) => event.preventDefault(),
          role: 'img', 'aria-label': props.ariaLabel || '关系图',
        },
        h('g', null, orderedEdges.map((edge, index) => {
          const from = graph.nodes.find((node) => node.id === edge.from);
          const to = graph.nodes.find((node) => node.id === edge.to);
          if (!from || !to) return null;
          const linked = selectedId && (edge.from === selectedId || edge.to === selectedId);
          const dimmed = selectedId && !nearIds.has(edge.from) && !nearIds.has(edge.to);
          return h('line', {
            key: `e${index}`, x1: from.x, y1: from.y, x2: to.x, y2: to.y,
            stroke: linked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
            'stroke-width': linked ? 1.4 : 1,
            opacity: linked ? 0.72 : dimmed ? 0.08 : edge.type === 'link' ? 0.38 : 0.16,
            'stroke-dasharray': edge.type === 'link' ? undefined : '2 4',
          });
        })),
        h('g', null, orderedNodes.map((node) => {
          const isPrimary = node.kind === primaryKind;
          const active = node.id === selectedId;
          const hovered = node.id === hoveredId;
          const near = nearIds.has(node.id);
          const dimmed = Boolean(selectedId) && !near;
          const pick = isPrimary ? props.onPick : (pickHub || undefined);
          /** 记忆是主体：实心、可读；主题/标签 hub 是背景：空心、只留轮廓。 */
          const fill = active ? 'var(--dsw-alias-brand-primary)'
            : isPrimary ? 'var(--dsw-alias-label-secondary)'
              : 'none';
          const stroke = active ? 'none'
            : hovered || near ? 'var(--dsw-alias-brand-primary)'
              : node.experimental ? 'var(--dsw-alias-state-warn-primary)'
                : isPrimary ? 'none' : 'var(--dsw-alias-label-secondary)';
          const strokeWidth = !active && (hovered || near) ? 1.3 : node.experimental ? 1 : isPrimary ? 0 : 1;
          const label = labelLayout.get(node.id) || null;
          return h('g', {
            key: node.id,
            'data-node': 'true',
            transform: `translate(${node.x} ${node.y})`,
            onClick: pick ? () => pick(node) : undefined,
            onKeyDown: pick ? (event) => {
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                event.preventDefault();
                pick(node);
              }
            } : undefined,
            onFocus: () => setHoveredId(node.id),
            onBlur: () => setHoveredId((value) => (value === node.id ? '' : value)),
            onMouseEnter: () => setHoveredId(node.id),
            onMouseLeave: () => setHoveredId((value) => (value === node.id ? '' : value)),
            tabIndex: pick ? 0 : undefined,
            role: pick ? 'button' : undefined,
            focusable: pick ? 'true' : 'false',
            'aria-label': pick ? (node.title || node.label) : undefined,
            style: { cursor: pick ? 'pointer' : 'default', outline: 'none' },
          },
          h('circle', { r: Math.max(isPrimary ? 14 : 18, node.radius + 6), fill: 'transparent' }),
          active ? h('circle', { r: node.radius + 5, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', 'stroke-width': 1.4, opacity: 0.45 }) : null,
          h('circle', {
            r: node.radius, fill,
            opacity: active ? 1 : dimmed ? (isPrimary ? 0.32 : 0.14) : isPrimary ? 0.92 : 0.34,
            stroke, 'stroke-width': strokeWidth,
          }),
          label ? h('text', {
            y: label.baseline, 'text-anchor': 'middle',
            fill: label.isPrimary ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            'font-size': label.fs,
            'font-weight': 500,
            opacity: active ? 1 : dimmed ? 0.2 : label.isPrimary ? 0.9 : 0.72,
            stroke: 'var(--dsw-alias-bg-layer-1)', 'stroke-width': 2.6, 'stroke-linejoin': 'round', 'paint-order': 'stroke',
          }, label.text) : null,
          h('title', null, node.title || node.label),
          );
        }))),
        h('div', {
          style: {
            position: 'absolute', left: '10px', bottom: '8px', zIndex: 1,
            maxWidth: truncated ? 'calc(100% - 178px)' : 'calc(100% - 60px)', padding: '2px 6px', borderRadius: '6px',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '1.5',
            pointerEvents: 'none',
          },
        }, props.legend || '实心 记忆 · 空心 标签/主题 · 虚线 归类'),
        truncated ? h('div', {
          style: {
            position: 'absolute', right: '10px', bottom: '8px', zIndex: 1,
            padding: '2px 6px', borderRadius: '6px',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '1.5',
            pointerEvents: 'none', whiteSpace: 'nowrap',
          },
        }, `显示 ${shownCount} / 共 ${totalCount} 条`) : null,
      );
    };

    const Toggle = (props) => h('button', {
      type: 'button', role: 'switch', 'aria-checked': props.on === true, 'aria-label': props.ariaLabel || props.label,
      onClick: props.onClick, disabled: props.busy,
      style: {
        width: '38px', height: '22px', flex: '0 0 auto', position: 'relative', padding: 0,
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '999px',
        background: props.on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-base)',
        cursor: props.busy ? 'default' : 'pointer', opacity: props.busy ? 0.5 : 1,
      },
    }, h('span', {
      style: {
        position: 'absolute', top: '2px', left: props.on ? '18px' : '2px', width: '16px', height: '16px',
        borderRadius: '999px', background: props.on ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
        transition: reduceMotionOf() ? 'none' : 'left 120ms ease',
      },
    }));

    const STAGE = { pending: '候选', trial: '试用', active: '生效', paused: '暂停', legacy: '待复核' };
    const STAGE_TONE = {
      pending: 'var(--dsw-alias-state-warn-primary)',
      trial: 'var(--dsw-alias-brand-primary)',
      active: 'var(--dsw-alias-state-success-primary)',
      paused: 'var(--dsw-alias-label-secondary)',
      legacy: 'var(--dsw-alias-state-warn-primary)',
    };
    const stageOf = (rule) => (rule.reviewState === 'legacy_unreviewed' ? 'legacy' : rule.state);
    const StagePill = (props) => h('span', {
      style: {
        flex: '0 0 auto', padding: '0 6px', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '999px', color: STAGE_TONE[props.state] || 'inherit',
        fontSize: '11px', lineHeight: '18px',
      },
    }, STAGE[props.state] || '未定');

    const Action = (props) => h('button', {
      type: 'button', onClick: props.onClick, disabled: props.disabled,
      style: {
        ...PANEL_LINK, opacity: props.disabled ? 0.35 : 0.82,
        color: props.danger ? 'var(--dsw-alias-state-error-primary)' : 'inherit',
        cursor: props.disabled ? 'default' : 'pointer',
      },
    }, props.children);

    const Field = (props) => h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 } },
      h('span', { style: PANEL_LABEL }, props.label),
      h('input', {
        value: props.value, onChange: (event) => props.onChange(event.target.value),
        'aria-label': props.label,
        style: { ...PANEL_INPUT, height: '28px' },
      }),
    );

    const countOf = (counts, key) => {
      if (!counts || typeof counts !== 'object') return null;
      const value = counts[key];
      return Number.isInteger(value) && value >= 0 ? value : null;
    };

    /** 学习状态只是一段经历；能不能用由这里单独说。 */
    const usabilityOf = (rule, evolution, memoryOn) => {
      if (!memoryOn) return '记忆已关闭，暂不参与回答。';
      if (!evolution || evolution.enabled !== true || evolution.effectiveEnabled === false) return '自进化已关闭，暂不参与回答。';
      if (rule.reviewState === 'legacy_unreviewed') return '所属项目还没确认，暂不参与回答。';
      if (rule.state === 'paused') return '已暂停，不参与回答。';
      const unresolved = rule.applicability === 'unresolved'
        || (rule.applicability === 'conditional' && (!Array.isArray(rule.conditions) || rule.conditions.length === 0));
      if (unresolved) return '适用范围待确认，暂不参与回答。';
      if (rule.state === 'pending') return '还没生效，采纳后才参与回答。';
      if (rule.state === 'trial') return '在条件匹配的任务中参与参考，到期后暂停。';
      if (rule.state === 'active') return '在适用任务中作为默认参考，当前明确要求优先。';
      return '';
    };

    const scopeLineOf = (rule) => {
      const conditions = Array.isArray(rule.conditions) ? rule.conditions : EMPTY;
      if (rule.applicability === 'unresolved') return '待确认';
      if (rule.applicability === 'conditional' || conditions.length > 0) {
        if (conditions.length === 0) return '待确认';
        return conditions.map((item) => `${CONDITION_LABEL[item.key] || item.key} ${item.value}`).join('、');
      }
      return '本项目内';
    };

    const evidenceTextOf = (row) => {
      if (typeof row === 'string') return row;
      if (!row || typeof row !== 'object') return '';
      for (const key of ['sourceExcerpt', 'excerpt', 'text', 'note']) {
        if (typeof row[key] === 'string' && row[key].trim()) return row[key];
      }
      return '';
    };
    /** 样例和证据都带版本/核对信息，不拿「样例」二字占位。 */
    const evidenceMetaOf = (row) => {
      if (!row || typeof row !== 'object') return '';
      const bits = [];
      if (Number.isInteger(row.artifactVersion)) bits.push(`第 ${row.artifactVersion} 版`);
      else if (typeof row.artifactVersion === 'string' && row.artifactVersion) bits.push(`第 ${row.artifactVersion} 版`);
      if (typeof row.dimension === 'string' && row.dimension) bits.push(row.dimension);
      if (row.verified === true) bits.push('已核对');
      else if (row.verified === false) bits.push('未核对');
      if (row.at) bits.push(EVO_DATE(row.at));
      return bits.join(' · ');
    };

    const MemoryRow = (props) => {
      const record = props.record;
      const [hover, setHover] = React.useState(false);
      return h('button', {
        type: 'button', onClick: props.onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'flex', flexDirection: 'column', gap: 0, width: '100%', textAlign: 'left',
          border: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px',
          borderLeft: `2px solid ${props.active ? 'var(--dsw-alias-brand-primary)' : 'transparent'}`,
          background: props.active || hover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: 'inherit', padding: '4px 8px', cursor: 'pointer', minWidth: 0,
        },
      },
      h('span', { style: { fontSize: '12px', lineHeight: '16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, record.title || '记忆'),
      h('span', { style: { ...PANEL_MUTED, display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0, lineHeight: '14px' } },
        h('span', null, KIND_LABEL[record.kind] || record.kind),
        record.experimental ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '实验') : null,
        h('span', { style: { marginLeft: 'auto', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, EVO_DATE(record.updated)),
      ),
      );
    };

    /** 一条经验：状态用小标签，标题独占一行。 */
    const EvolutionRow = (props) => {
      const rule = props.rule;
      const [hover, setHover] = React.useState(false);
      return h('button', {
        type: 'button', onClick: props.onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'flex', flexDirection: 'column', gap: '1px', width: '100%', textAlign: 'left',
          border: 'none', borderRadius: '8px', minWidth: 0,
          borderLeft: `2px solid ${props.active ? 'var(--dsw-alias-brand-primary)' : 'transparent'}`,
          background: props.active || hover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: 'inherit', padding: '6px 9px', cursor: 'pointer',
        },
      },
      h('span', { style: { fontSize: '12px', lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, rule.title),
      h('span', { style: { ...PANEL_MUTED, display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, lineHeight: '16px' } },
        h(StagePill, { state: stageOf(rule) }),
        h('span', { style: { marginLeft: 'auto', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, EVO_DATE(rule.updated)),
      ));
    };

    const EvolutionDetail = (props) => {
      const rule = props.rule;
      const ruleId = rule ? rule.id : '';
      const [confirming, setConfirming] = React.useState(false);
      const [editing, setEditing] = React.useState(false);
      const [open, setOpen] = React.useState('');
      const [title, setTitle] = React.useState('');
      const [body, setBody] = React.useState('');
      React.useEffect(() => {
        setConfirming(false);
        setEditing(false);
        setOpen('');
        setTitle(rule && typeof rule.title === 'string' ? rule.title : '');
        setBody(rule && typeof rule.body === 'string' ? rule.body : '');
      }, [ruleId]);
      if (!rule) return null;
      const checkpoints = Array.isArray(rule.checkpoints) ? rule.checkpoints : EMPTY;
      const samples = Array.isArray(rule.samples) ? rule.samples : EMPTY;
      const evidence = Array.isArray(rule.learning?.evidence) ? rule.learning.evidence : EMPTY;
      const versions = Array.isArray(rule.learning?.versions) ? rule.learning.versions : EMPTY;
      const history = [
        ...checkpoints.map((row) => ({ at: row.at || row.updated || '', text: typeof row.text === 'string' ? row.text : '' })),
        ...versions.map((row, index) => ({
          at: row.at || row.updated || '',
          text: `第 ${versions.length - index} 版${row.body ? ` ${SHORT(row.body, 42)}` : row.digest ? ` ${SHORT(String(row.digest), 16)}` : ''}`,
        })),
      ].filter((row) => row.text).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
      const failureState = failureStateOf(props.evolution);
      const canManage = props.canManage && !props.busy;
      const act = (name, extra) => { if (canManage) props.onManage(name, extra || {}); };
      const actions = props.canManage
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', paddingTop: '3px' } },
          rule.state === 'pending' || rule.state === 'trial'
            ? h(Action, { disabled: !canManage, onClick: () => act('adopt') }, '采纳') : null,
          rule.state === 'paused' && rule.reviewState !== 'legacy_unreviewed'
            ? h(Action, { disabled: !canManage, onClick: () => act('resume') }, '恢复')
            : (rule.state === 'trial' || rule.state === 'active'
              ? h(Action, { disabled: !canManage, onClick: () => act('pause') }, '暂停')
              : null),
          rule.state !== 'paused'
            ? h(Action, { disabled: !canManage, onClick: () => setEditing((value) => !value) }, '修改') : null,
          rule.state === 'paused'
            ? h(Action, { disabled: !canManage, onClick: () => setOpen((value) => value === 'history' ? '' : 'history') }, '查看记录') : null,
          rule.state === 'pending'
            ? (confirming
              ? h(React.Fragment, null,
                h(Action, { disabled: !canManage, danger: true, onClick: () => act('discard') }, '确认放弃'),
                h(Action, { disabled: !canManage, onClick: () => setConfirming(false) }, '取消'))
              : h(Action, { disabled: !canManage, onClick: () => setConfirming(true) }, '放弃'))
            : null,
        )
        : h('div', { style: { ...PANEL_MUTED, paddingTop: '2px' } }, '只读');

      const editor = editing
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '2px' } },
          h(Field, { label: '标题', value: title, onChange: setTitle }),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('span', { style: PANEL_LABEL }, '经验'),
            h('textarea', {
              value: body, onChange: (event) => setBody(event.target.value), 'aria-label': '经验',
              rows: 6,
              style: { ...PANEL_INPUT, height: 'auto', minHeight: '110px', padding: '7px 9px', resize: 'vertical', lineHeight: '1.6' },
            }),
          ),
          h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
            h(Action, { disabled: !canManage || !title.trim() || !body.trim(), onClick: () => { act('edit', { title: title.trim(), body: body.trim() }); setEditing(false); } }, '保存'),
            rule.state === 'pending' || rule.state === 'trial'
              ? h(Action, { disabled: !canManage || !title.trim() || !body.trim(), onClick: () => { act('adopt', { title: title.trim(), body: body.trim() }); setEditing(false); } }, '保存并采纳')
              : null,
            h(Action, { disabled: !canManage, onClick: () => setEditing(false) }, '取消'),
          ),
        )
        : null;

      const evidencePane = open === 'evidence'
        ? h('div', { style: { ...PANEL_MUTED, display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '2px' } },
          evidence.length === 0 && samples.length === 0
            ? '暂无学习依据'
            : [
              ...evidence.slice(0, 3).map((row, index) => {
                const text = evidenceTextOf(row);
                const meta = evidenceMetaOf(row);
                return text
                  ? h('div', { key: `e${index}`, style: { display: 'flex', flexDirection: 'column', gap: '1px' } },
                    h('span', { style: { color: 'var(--dsw-alias-label-primary)', opacity: 0.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, text),
                    meta ? h('span', null, meta) : null)
                  : null;
              }),
              ...samples.slice(0, 2).map((row, index) => {
                const text = evidenceTextOf(row);
                const meta = evidenceMetaOf(row);
                return text || meta
                  ? h('div', { key: `s${index}`, style: { display: 'flex', flexDirection: 'column', gap: '1px' } },
                    text ? h('span', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, text) : null,
                    meta ? h('span', null, meta) : null)
                  : null;
              }),
            ].filter(Boolean))
        : null;
      const historyPane = open === 'history'
        ? h('div', { style: { ...PANEL_MUTED, display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '2px' } },
          history.length === 0
            ? '暂无变化记录'
            : history.map((row, index) => h('div', { key: `h${index}`, style: { display: 'flex', gap: '8px' } },
              h('span', { style: { flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, EVO_DATE(row.at) || '—'),
              h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.text))))
        : null;

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('div', { style: PANEL_LABEL }, '当前经验'),
          h('div', { style: { fontSize: '13px', lineHeight: '1.45', fontWeight: 600, wordBreak: 'break-word' } }, rule.title),
          h('div', { style: { fontSize: '12px', lineHeight: '1.65', whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.88 } }, rule.body || '没有正文'),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
          h('div', { style: PANEL_LABEL }, '适用范围'),
          h('div', { style: { fontSize: '12px', lineHeight: '1.55', wordBreak: 'break-word' } }, scopeLineOf(rule)),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: PANEL_LABEL }, '当前状态'),
            h(StagePill, { state: stageOf(rule) }),
          ),
          h('div', { style: { fontSize: '12px', lineHeight: '1.55', opacity: 0.82 } }, usabilityOf(rule, props.evolution, props.memoryOn)),
          failureState
            ? h('div', { style: { ...PANEL_MUTED, color: failureState === 'current' ? 'var(--dsw-alias-state-warn-primary)' : undefined } },
              failureState === 'current' ? '最近一次整理失败，现有经验未更新' : '以前有整理失败，最近一次已完成')
            : null,
          actions,
        ),
        editor,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '6px' } },
          h(Action, { onClick: () => setOpen((value) => value === 'evidence' ? '' : 'evidence') }, `学习依据 ${evidence.length + samples.length}`),
          h(Action, { onClick: () => setOpen((value) => value === 'history' ? '' : 'history') }, `变化记录 ${history.length}`),
        ),
        evidencePane,
        historyPane,
      );
    };


    const PalaceSlot = (props) => {
      const record = props.record;
      if (!record) {
        return h('div', {
          'aria-hidden': 'true',
          style: { height: '46px', border: '1px dashed var(--dsw-alias-border-l1)', borderRadius: '8px', opacity: 0.28 },
        });
      }
      const title = String(record.title || '记忆');
      return h('button', {
        type: 'button', title, 'aria-label': title,
        onClick: () => props.onPick(record.id),
        style: {
          height: '46px', minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center',
          padding: '4px 7px', textAlign: 'left', cursor: 'pointer',
          border: `1px solid ${props.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
          borderRadius: '8px', color: 'inherit',
          background: props.active ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-base)',
        },
      },
      h('span', {
        style: {
          fontSize: '11px', lineHeight: '15px', height: '30px', overflow: 'hidden',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word',
        },
      }, title),
      );
    };

    const PalaceRoomCard = (props) => {
      const room = props.room;
      const empty = room.total === 0;
      const preview = room.items.slice(0, palaceSlotCountOf(room.total));
      const slots = Array.from({ length: palaceSlotCountOf(room.total) }, (_, index) => preview[index] || null);
      return h('div', {
        role: 'listitem',
        style: { ...PANEL_CARD, padding: 0, position: 'relative', overflow: 'hidden', display: 'flex', width: '100%', flexDirection: 'column' },
      },
      h('div', { style: { position: 'relative', display: 'flex', flexDirection: 'column', gap: '8px', padding: '9px 10px 10px', boxSizing: 'border-box' } },
        h('button', {
          type: 'button', 'aria-expanded': empty ? undefined : props.expanded, 'aria-controls': empty ? undefined : `lite-palace-room-${room.id}`,
          disabled: empty,
          onClick: () => { if (!empty) props.onToggle(room.id); },
          style: { ...PANEL_LINK, width: '100%', display: 'flex', alignItems: 'center', gap: '7px', textAlign: 'left', opacity: 1 },
        },
        h('span', { style: { fontSize: '12px', lineHeight: '18px', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, room.name),
        h('span', { style: { ...PANEL_MUTED, flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, `${room.total} 条`),
        empty ? null : h('span', { style: { ...PANEL_MUTED, flex: '0 0 auto', marginLeft: 'auto', opacity: 0.6 } }, props.expanded ? '收起' : '展开'),
        ),
        empty
          ? h('span', { style: { ...PANEL_MUTED, padding: '2px 0 4px' } }, '还没有记录')
          : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: '6px' } },
            slots.map((record, index) => h(PalaceSlot, {
              key: record ? record.id : `slot-${room.id}-${index}`,
              record, active: Boolean(record && record.id === props.selectedId), onPick: props.onPick,
            }))),
      ),
      );
    };

    const MemoryPalace = (props) => {
      const rows = Array.isArray(props.records) ? props.records : EMPTY;
      const [expanded, setExpanded] = React.useState('');
      const [page, setPage] = React.useState(1);
      const panelRef = React.useRef(null);
      const reduced = useReducedMotion();
      const motion = palaceMotionOf(reduced);
      const rooms = React.useMemo(() => palaceRoomsOf(rows), [rows]);
      const activeRoom = rooms.find((room) => room.id === expanded) || null;
      const pageInfo = activeRoom ? palaceRoomPageOf(rows, activeRoom.id, page) : null;

      React.useEffect(() => {
        if (expanded && !rooms.some((room) => room.id === expanded)) setExpanded('');
      }, [rooms, expanded]);
      React.useEffect(() => {
        const node = panelRef.current;
        if (!expanded || !node || motion.duration === 0 || typeof node.animate !== 'function') return;
        node.animate([
          { opacity: 0, transform: 'translateY(-6px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ], { duration: motion.duration, easing: motion.easing });
      }, [expanded, page, motion.duration, motion.easing]);

      if (rows.length === 0) {
        return h('div', { style: { ...PANEL_CARD, padding: '14px', minHeight: 0 } },
          h('div', { style: PANEL_MUTED }, props.emptyText || '这个项目还没有记忆'));
      }
      const toggle = (roomId) => {
        setExpanded((current) => palaceToggleOf(current, roomId));
        setPage(1);
      };
      const goPage = (target) => {
        if (!pageInfo) return;
        setPage(Math.min(pageInfo.pages, Math.max(1, target)));
      };
      const pageButton = (label, target, disabled, current) => h('button', {
        key: `page-${target}-${label}`, type: 'button', disabled,
        'aria-current': current ? 'page' : undefined, 'aria-label': `第 ${target} 页`,
        onClick: () => goPage(target),
        style: {
          ...PANEL_LINK, minWidth: '22px', height: '22px', padding: '0 5px', borderRadius: '6px',
          border: 'none', opacity: disabled ? 0.28 : current ? 0.85 : 0.5,
          background: current ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          fontVariantNumeric: 'tabular-nums', cursor: disabled ? 'default' : 'pointer',
        },
      }, label);
      const pageSlots = pageInfo
        ? Array.from({ length: pageInfo.items.length ? Math.ceil(pageInfo.items.length / 6) * 6 : 0 }, (_, index) => pageInfo.items[index] || null)
        : EMPTY;
      return h('div', {
        role: 'group', 'aria-label': '记忆宫殿',
        onKeyDown: (event) => {
          if (!pageInfo || pageInfo.pages <= 1) return;
          if (event.key === 'ArrowRight' && pageInfo.page < pageInfo.pages) {
            event.preventDefault();
            goPage(pageInfo.page + 1);
          }
          if (event.key === 'ArrowLeft' && pageInfo.page > 1) {
            event.preventDefault();
            goPage(pageInfo.page - 1);
          }
          if (event.key === 'Home' && pageInfo.page > 1) {
            event.preventDefault();
            goPage(1);
          }
          if (event.key === 'End' && pageInfo.page < pageInfo.pages) {
            event.preventDefault();
            goPage(pageInfo.pages);
          }
        },
        style: { ...PANEL_CARD, padding: '10px', minHeight: 0, flex: '0 0 auto', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' },
      },
      h('div', {
        role: 'list',
        'aria-label': '记忆房间',
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(232px, 1fr))', gap: '9px' },
      },
        rooms.map((room) => h(PalaceRoomCard, {
          key: room.id, room, expanded: room.id === expanded, selectedId: props.selectedId,
          onPick: props.onPick, onToggle: toggle,
        }))),
      h('div', { 'aria-live': 'polite', style: { ...PANEL_MUTED, marginTop: '-2px' } }, `${rooms.length} 个房间 · ${rows.length} 条`),
      activeRoom && activeRoom.total > 0 && pageInfo
        ? h('section', {
          id: `lite-palace-room-${activeRoom.id}`, 'aria-label': activeRoom.name, ref: panelRef,
          style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '9px', display: 'flex', flexDirection: 'column', gap: '8px' },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: { fontSize: '12px', lineHeight: '1.4', fontWeight: 600 } }, activeRoom.name),
          h('span', { style: PANEL_MUTED, 'aria-live': 'polite', 'aria-atomic': 'true' }, `${pageInfo.total} 条${pageInfo.pages > 1 ? ` · 第 ${pageInfo.page} / ${pageInfo.pages} 页` : ''}`),
          h('button', {
            type: 'button', onClick: () => toggle(activeRoom.id),
            style: { ...PANEL_LINK, marginLeft: 'auto', height: '24px', padding: '0 7px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)' },
          }, '收起'),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: '6px' } },
          pageSlots.map((record, index) => h(PalaceSlot, {
            key: record ? record.id : `page-${pageInfo.page}-slot-${index}`,
            record, active: Boolean(record && record.id === props.selectedId), onPick: props.onPick,
          }))),
        pageInfo.pages > 1
          ? h('div', { role: 'navigation', 'aria-label': '分页', style: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' } },
            pageButton('上一页', pageInfo.page - 1, pageInfo.page <= 1, false),
            palacePageWindow(pageInfo.page, pageInfo.pages).map((number) => pageButton(String(number), number, false, number === pageInfo.page)),
            pageButton('下一页', pageInfo.page + 1, pageInfo.page >= pageInfo.pages, false))
          : null,
        )
        : null,
      );
    };

    /**
     * 「记住我」：用户级的表达偏好，独立于项目记忆。
     * 展开才读；读不到整块不出现，动作失败只在这里说一句。
     */
    const PersonaSection = (props) => {
      const sessionId = props.sessionId;
      const [open, setOpen] = React.useState(false);
      const [panel, setPanel] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState('');
      const [confirmClear, setConfirmClear] = React.useState(false);
      const [openDim, setOpenDim] = React.useState('');
      const [gone, setGone] = React.useState(false);
      const alive = React.useRef(true);
      const loaded = React.useRef(false);
      React.useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);
      const send = (body) => {
        if (busy) return;
        setBusy(true);
        setNote('');
        setConfirmClear(false);
        post('/lite-memory/persona', { sessionId, ...body }).then((result) => {
          if (!alive.current) return;
          setBusy(false);
          const next = result && result.body && Array.isArray(result.body.catalog) ? result.body : null;
          if (succeeded(result) && next) {
            setPanel(next);
            setNote(typeof next.reason === 'string' ? next.reason : '');
            return;
          }
          if (next) setNote(failure(result, '这次没有改动'));
          else setGone(true);
        });
      };
      React.useEffect(() => {
        if (!open || loaded.current) return;
        loaded.current = true;
        send({ op: 'status' });
      }, [open]);
      if (gone) return null;

      const catalog = panel && Array.isArray(panel.catalog) ? panel.catalog : EMPTY;
      if (panel && catalog.length === 0) return null;
      const enabled = panel ? panel.enabled === true : false;
      const formed = panel && Array.isArray(panel.formed) ? panel.formed : EMPTY;
      const observing = panel && Array.isArray(panel.observing) ? panel.observing : EMPTY;
      const evidence = panel && Array.isArray(panel.evidence) ? panel.evidence : EMPTY;
      const changes = panel && Array.isArray(panel.recentChanges) ? panel.recentChanges.slice(-5) : EMPTY;
      const valueLabelOf = (dimension, value) => {
        const row = catalog.find((item) => item.dimension === dimension);
        const hit = row && Array.isArray(row.values) ? row.values.find((item) => item.value === value) : null;
        return hit ? hit.label : value;
      };
      const heading = (text, count) => h('div', { style: { ...PANEL_LABEL, display: 'flex', alignItems: 'center', gap: '5px' } },
        h('span', null, text),
        count > 0 ? h('span', { style: { opacity: 0.7, fontVariantNumeric: 'tabular-nums' } }, String(count)) : null);
      const section = (label, count, rows) => (rows.length > 0
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 } }, heading(label, count), rows)
        : null);
      const basisText = (basis) => (basis === 'repeat_choice' ? '多次选择' : basis === 'manual_edit' ? '手动改' : '你明确说过');
      const evidenceOf = (dimension) => evidence.filter((row) => row.dimension === dimension && row.eventId);
      const basisNote = (dimension) => {
        const count = evidenceOf(dimension).length;
        if (!count) return null;
        return h(Action, { disabled: busy, onClick: () => setOpenDim(openDim === dimension ? '' : dimension) }, `依据 ${count}`);
      };
      const evidenceRows = (dimension) => (openDim === dimension
        ? evidenceOf(dimension).map((row) => h('div', { key: `evidence:${row.eventId}`, style: { ...ROW, gap: '8px', paddingLeft: '10px' } },
          h('span', { style: { ...PANEL_MUTED, flex: 1 } }, `${row.valueLabel || row.value || row.label} · ${basisText(row.basis)}${row.date ? ` · ${row.date}` : ''}`),
          h(Action, { disabled: busy, danger: true, onClick: () => send({ op: 'forget_evidence', eventId: row.eventId }) }, '删')))
        : null);
      const formedRows = formed.map((row) => h('div', { key: `formed:${row.dimension}`, style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 } },
        h('div', { style: { ...ROW, gap: '8px' } },
          h('span', { style: { ...LABEL, flex: 1 } }, `${row.label} · ${row.valueLabel || row.value}`),
          basisNote(row.dimension),
          row.lockedByUser === true
            ? h('span', { style: { ...PANEL_MUTED, flex: '0 0 auto' } }, '已确认')
            : h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' } },
              h(Action, { disabled: busy, onClick: () => send({ op: 'edit', dimension: row.dimension, value: row.value }) }, '确认'),
              h(Action, { disabled: busy, onClick: () => send({ op: 'reject', dimension: row.dimension }) }, '不用这个'))),
        evidenceRows(row.dimension)));
      const observingRows = observing.map((row) => h('div', { key: `observing:${row.dimension}`, style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 } },
        h('div', { style: ROW },
          h('span', { style: { ...LABEL, flex: 1 } }, `${row.label} · ${row.text || ''}`),
          h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' } },
            basisNote(row.dimension),
            h(Action, { disabled: busy, onClick: () => send({ op: 'reject', dimension: row.dimension }) }, '不用这个'))),
        evidenceRows(row.dimension)));
      const changeRows = changes.map((row) => {
        const ago = agoLabel(row.at);
        const from = row.from ? valueLabelOf(row.dimension, row.from) : '未定';
        const to = row.to ? valueLabelOf(row.dimension, row.to) : '';
        return h('div', { key: `change:${row.at}:${row.dimension}:${row.to}`, style: { ...ROW, gap: '8px' } },
          h('span', { style: { ...LABEL, flex: 1 } }, `${row.label} · ${from}${to ? ` → ${to}` : ''}`),
          ago ? h('span', { style: { ...PANEL_MUTED, flex: '0 0 auto' } }, ago) : null);
      });
      const empty = panel && formed.length === 0 && observing.length === 0 && changes.length === 0;
      const clearLine = panel
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '1px' } },
          h(Action, {
            disabled: busy, danger: confirmClear,
            onClick: () => { if (confirmClear) send({ op: 'clear' }); else setConfirmClear(true); },
          }, confirmClear ? '确认清空' : '清空画像'),
          confirmClear ? h(Action, { disabled: busy, onClick: () => setConfirmClear(false) }, '取消') : null)
        : null;
      const statusText = panel
        ? (formed.length > 0 ? `已记住 ${formed.length} 条` : (enabled ? '还没有形成的偏好' : '已关闭'))
        : (busy ? '读取中' : '');
      const header = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
        h('button', {
          type: 'button', 'aria-expanded': open, 'aria-label': open ? '收起记住我' : '展开记住我',
          onClick: () => { setOpen(!open); setConfirmClear(false); },
          style: { ...PANEL_LINK, display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0, height: '20px', textAlign: 'left' },
        },
        h(RefChevron, { open }),
        h('span', { style: { flex: '0 0 auto', fontSize: '12px', fontWeight: 600 } }, '记住我'),
        h('span', { style: { ...PANEL_MUTED, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, statusText)),
        panel
          ? h(Action, {
            disabled: busy, 'aria-pressed': enabled,
            onClick: () => send({ op: enabled ? 'disable' : 'enable' }),
          }, enabled ? '已开启' : '已关闭')
          : null);
      const body = panel
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px', minWidth: 0 } },
          h('div', {
            style: {
              display: 'flex', flexDirection: 'column', gap: '7px', minWidth: 0,
              opacity: enabled ? 1 : 0.45, pointerEvents: enabled ? 'auto' : 'none',
            },
          },
          section('已形成', formed.length, formedRows),
          section('观察中', observing.length, observingRows),
          section('最近变化', changes.length, changeRows),
          empty ? h('div', { style: PANEL_MUTED }, '还没有值得记下的偏好') : null),
          note ? h('div', { style: { ...PANEL_MUTED, wordBreak: 'break-word' } }, note) : null,
          clearLine)
        : h('div', { style: PANEL_MUTED }, busy ? '读取中' : '');
      return h('section', {
        'aria-label': '记住我',
        style: {
          ...PANEL_CARD, flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '7px',
          padding: '9px 11px', minHeight: 0, maxHeight: open ? '40%' : 'none', overflowY: open ? 'auto' : 'visible',
        },
      }, header, open ? body : null);
    };

    const MemoryPanel = (props) => {
      const sessionId = props.sessionId;
      const [data, setData] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [failed, setFailed] = React.useState(false);
      const [note, setNote] = React.useState('');
      const [query, setQuery] = React.useState('');
      const [tab, setTab] = React.useState('memory');
      const [memoryView, setMemoryView] = React.useState('list');
      const [evolutionView, setEvolutionView] = React.useState('list');
      const [stage, setStage] = React.useState('all');
      const [selectedMemory, setSelectedMemory] = React.useState('');
      const [selectedRule, setSelectedRule] = React.useState('');
      const [detail, setDetail] = React.useState(null);
      const [detailNote, setDetailNote] = React.useState('');
      const [editingMemory, setEditingMemory] = React.useState(false);
      const [editTitle, setEditTitle] = React.useState('');
      const [editBody, setEditBody] = React.useState('');
      const [editNote, setEditNote] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [showReason, setShowReason] = React.useState(false);
      const [showSettings, setShowSettings] = React.useState(false);
      const [tune, setTune] = React.useState(null);
      const [explainOn, setExplainOn] = React.useState(explainModeOf(sessionId));
      const [display, setDisplay] = React.useState({ ...DISPLAY_DEFAULTS });
      const [hubFilter, setHubFilter] = React.useState(null);
      const [checkup, setCheckup] = React.useState(false);
      const [expandedConflict, setExpandedConflict] = React.useState('');
      const [conflictAll, setConflictAll] = React.useState(false);
      const alive = React.useRef(true);
      const generation = React.useRef(0);
      const scopeRef = React.useRef('');
      /** 先算出当前范围键，显示设置的读取/落盘都按它来，不能等后面的派生变量。 */
      const selectedKey = data && data.selected && data.selected.key ? data.selected.key : '';
      React.useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      /** 调参与记忆列表是两份数据。 */
      const loadTune = () => {
        post('/lite-memory/tune', { sessionId, op: 'status' }).then((result) => {
          if (!alive.current) return;
          if (result.ok && result.body && result.body.ok !== false) setTune(result.body);
        });
      };
      const tuneAct = (op) => {
        if (busy) return;
        setBusy(true);
        setNote('');
        post('/lite-memory/tune', { sessionId, op }).then((result) => {
          if (!alive.current) return;
          setBusy(false);
          const body = result && result.body ? result.body : null;
          if (result.ok && body) {
            setTune((prev) => ({ ...(prev || {}), ...body, proposal: op === 'suggest' ? body.proposal : undefined }));
            setNote(typeof body.reason === 'string' ? body.reason : '');
            if (op !== 'suggest') loadTune();
            return;
          }
          setNote(failure(result, '这次没有改动'));
        });
      };

      const load = (scopeKey = '', focusRule = '') => {
        const request = generation.current + 1;
        generation.current = request;
        /** 用户选的项目立刻算数：晚到的保存/开关回执不能再把界面拉回旧范围。 */
        if (scopeKey) scopeRef.current = scopeKey;
        setLoading(true);
        setFailed(false);
        setNote('');
        post('/lite-memory/overview', { sessionId, scopeKey }).then((result) => {
          if (!alive.current || generation.current !== request) return;
          setLoading(false);
          if (result.ok && result.body && result.body.ok) {
            const next = result.body;
            const nextKey = next.selected && next.selected.key ? next.selected.key : '';
            if (scopeRef.current !== nextKey) {
              scopeRef.current = nextKey;
              setQuery('');
            }
            setData(next);
            setSelectedMemory('');
            setSelectedRule(focusRule);
            setDetail(null);
            setDetailNote('');
            setShowReason(false);
            setConflictAll(false);
            loadTune();
          } else {
            setFailed(true);
            setNote(failure(result, '读不到记忆'));
          }
        });
      };

      React.useEffect(() => { load(); }, [sessionId]);

      /** 待裁决只做两件事：把草稿另存成一条，或删掉这条待办；不在面板里悄悄合并。 */
      const resolveQueued = (row, op) => {
        if (!row || busy) return;
        setBusy(true);
        setNote('');
        post('/lite-memory/conflict', {
          sessionId, scopeKey: selectedKey, conflictId: row.id, expectedRevision: row.revision, op,
        }).then((result) => {
          if (!alive.current) return;
          setBusy(false);
          if (result.ok && result.body && result.body.ok) {
            setExpandedConflict('');
            if (op === 'drop') setNote('已忽略这条待裁决');
            load(selectedKey);
          } else setNote(failure(result, '待裁决没处理成'));
        });
      };

      /** 显示设置跟着当前项目走；换项目或换范围时重新读。 */
      React.useEffect(() => {
        setDisplay(readDisplaySettings(selectedKey));
        setShowSettings(false);
        setHubFilter(null);
        setExpandedConflict('');
        setConflictAll(false);
      }, [selectedKey]);
      React.useEffect(() => {
        setMemoryView((value) => viewModeOf(display, value));
        setEvolutionView((value) => viewModeOf(display, value));
      }, [display.graph, display.palace]);
      const setDisplayFlag = (name, value) => {
        const next = { ...display, [name]: value === true };
        setDisplay(next);
        writeDisplaySettings(selectedKey, next);
      };

      React.useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); } };
        window.addEventListener('keydown', onKey);
        const previous = typeof document !== 'undefined' ? document.body.style.overflow : '';
        if (typeof document !== 'undefined') document.body.style.overflow = 'hidden';
        return () => {
          window.removeEventListener('keydown', onKey);
          if (typeof document !== 'undefined') document.body.style.overflow = previous;
        };
      }, []);

      React.useEffect(() => {
        setEditingMemory(false);
        setEditNote('');
        if (!selectedMemory || !data) { setDetail(null); setDetailNote(''); return undefined; }
        let live = true;
        setDetail(null);
        setDetailNote('');
        post('/lite-memory/body', { sessionId, id: selectedMemory, scopeKey: data.selected.key }).then((result) => {
          if (!live) return;
          if (result.ok && result.body && result.body.ok) {
            if (result.body.status === 'gone') setDetailNote('这条记忆已经不在这里了');
            else setDetail(result.body);
          } else setDetailNote(failure(result, '读不到正文'));
        });
        return () => { live = false; };
      }, [selectedMemory, data && data.selected.key, sessionId]);

      const current = data ? data.current : null;
      const selected = data ? data.selected : null;
      const records = selected && Array.isArray(selected.records) ? selected.records : EMPTY;
      const total = selected && selected.stats && Number.isInteger(selected.stats.total) ? selected.stats.total : records.length;
      const queued = selected && Array.isArray(selected.conflicts) ? selected.conflicts : EMPTY;
      const currentKey = current ? current.key : '';
      const control = selected && selected.control
        ? selected.control
        : (current && selected && selected.key === current.key && current.control ? current.control : { enabled: true });
      const memoryOn = control.enabled !== false;
      const memoryMode = !memoryOn ? 'off'
        : (control.effectiveMode === 'tool_only' || control.mode === 'tool_only' ? 'tool_only' : 'adaptive');
      const evolution = selected && selected.evolution
        ? selected.evolution
        : (current && selected && selected.key === current.key ? current.evolution : null);
      const rules = evolution && Array.isArray(evolution.rules) ? evolution.rules : EMPTY;
      const counts = evolution && evolution.counts && typeof evolution.counts === 'object' ? evolution.counts : null;
      const effectiveEnabled = evolution
        ? (typeof evolution.effectiveEnabled === 'boolean' ? evolution.effectiveEnabled : (memoryOn && evolution.enabled === true))
        : false;
      const canToggle = Boolean(selectedKey) && selectedKey === currentKey;
      const canManage = canToggle && memoryOn;
      const globalView = Boolean(selected && selected.kind === 'global');
      const activeTab = globalView ? 'memory' : tab;
      React.useEffect(() => { if (globalView) setTab('memory'); }, [globalView]);

      const activity = evolution && evolution.activity ? evolution.activity : null;
      const latestReceipt = evolution && evolution.economy && Array.isArray(evolution.economy.recent) ? evolution.economy.recent[0] : null;
      const countsUnknown = Boolean(evolution) && (!counts || ['pending', 'trial', 'active', 'paused'].some((key) => countOf(counts, key) === null));
      const activityCode = activity && typeof activity === 'object'
        ? String(activity.code || activity.state || '')
        : (typeof activity === 'string' ? activity : '');
      const changedCount = activity && typeof activity === 'object' && Number.isInteger(activity.changed)
        ? activity.changed
        : (Number.isInteger(activity && activity.count) ? activity.count : null);
      const activityReason = activity && typeof activity === 'object' && typeof activity.reason === 'string'
        ? activity.reason
        : (latestReceipt && typeof latestReceipt.reason === 'string' ? latestReceipt.reason : '');
      const staleLearning = /没采用|作废|已更新|换到别的作品/.test(activityReason);
      const activityReasonText = staleLearning ? '整理过程中反馈或作品变了，这轮结果没采用。' : activityReason;
      let activityText = '';
      if (!evolution && memoryOn) {
        activityText = '读不到自进化状态';
      } else if (!memoryOn || !evolution || evolution.enabled !== true || (typeof evolution.effectiveEnabled === 'boolean' && !evolution.effectiveEnabled)) {
        activityText = '自进化已关闭，已有成果保留';
      } else if (activityCode === 'running' || activityCode === 'organizing') {
        activityText = '正在整理本次反馈';
      } else if (activityCode === 'updated' || activityCode === 'applied') {
        activityText = changedCount === null || changedCount < 1 ? '最近整理完成' : `最近整理完成，更新了 ${changedCount} 条经验`;
      } else if (activityCode === 'no_change' || activityCode === 'none') {
        activityText = '本次反馈未形成新的经验';
      } else if (activityCode === 'scope_unconfirmed' || activityCode === 'unknown_scope') {
        activityText = '暂未整理：适用范围待确认';
      } else if (activityCode === 'quota' || activityCode === 'exhausted') {
        activityText = '这轮先整理这些，下一条消息接着整理';
      } else if (activityCode === 'failed' || activityCode === 'error') {
        activityText = staleLearning ? '这轮整理没采用' : '最近整理失败，可查看原因';
      } else if (activityCode === 'waiting' || activityCode === 'idle' || activityCode === 'empty') {
        activityText = '等待可学习的反馈';
      }
      if (!activityText) {
        if (latestReceipt && latestReceipt.status === 'applied') {
          activityText = Number.isInteger(latestReceipt.changed) && latestReceipt.changed > 0 ? `最近整理完成，更新了 ${latestReceipt.changed} 条经验` : '最近整理完成';
        }
        else if (latestReceipt && latestReceipt.status === 'no_change') activityText = '本次反馈未形成新的经验';
        else if (latestReceipt && latestReceipt.status === 'failed') activityText = '最近整理失败，可查看原因';
        else if (rules.length === 0) activityText = countsUnknown ? '等待可学习的反馈' : '还没有整理出经验';
        else activityText = '暂无整理记录';
      }
      const filtered = React.useMemo(() => filterRecords(records, query, null), [records, query]);
      /** 图谱的标签筛选是图谱自己的，不串到列表和宫殿。 */
      const graphFiltered = React.useMemo(() => (hubFilter ? filterRecords(records, query, hubFilter) : filtered), [records, query, hubFilter, filtered]);
      const filteredRules = React.useMemo(() => {
        if (stage === 'all') return rules;
        return rules.filter((rule) => rule.state === stage);
      }, [rules, stage]);
      const selectedRuleRow = selectedRule ? rules.find((rule) => rule.id === selectedRule) : null;
      const checkupData = checkupOf(records, data && data.scopes, globalView);
      const globalScopeRow = (data && Array.isArray(data.scopes) ? data.scopes : EMPTY).find((scope) => scope && scope.kind === 'global');
      const checkupJump = (hub) => { setCheckup(false); setTab('memory'); setQuery(''); setHubFilter(hub); };
      const checkupJumpGlobal = (hub) => {
        setCheckup(false); setQuery(''); setHubFilter(hub || null);
        if (globalScopeRow) load(globalScopeRow.key);
        else setTab('memory');
      };
      const checkupRowOf = (key, label, value, unit, onClick) => h('button', {
        key, type: 'button', onClick,
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%', minWidth: 0,
          padding: '7px 9px', border: 'none', background: 'transparent', color: 'inherit',
          font: 'inherit', textAlign: 'left', cursor: 'pointer',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
        },
      },
      h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
      h('span', { style: { marginLeft: 'auto', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums', opacity: 0.72 } }, value === null || value === undefined ? '—' : `${value} ${unit}`));
      const detailRecord = selectedMemory ? records.find((record) => record.id === selectedMemory) : null;

      const onPickNode = (node) => {
        if (node.kind !== 'memory') return;
        setSelectedMemory(node.id);
        setSelectedRule('');
      };
      /** 点 hub 用精确值筛选，标签不发散成子串匹配。 */
      const onPickHub = (node) => {
        if (!node || typeof node.id !== 'string') return;
        const cut = node.id.indexOf(':');
        const kind = cut > 0 ? node.id.slice(0, cut) : '';
        const value = cut > 0 ? node.id.slice(cut + 1) : '';
        if ((kind !== 'tag' && kind !== 'topic') || !value) return;
        setHubFilter({ kind, value, display: kind === 'tag' ? `#${value}` : value });
        setQuery('');
        setSelectedMemory('');
        setSelectedRule('');
      };
      const onPickRuleNode = (node) => {
        if (node.kind !== 'rule') return;
        setSelectedRule(node.id);
        setSelectedMemory('');
        setShowReason(false);
      };

      const manage = (learningAction, extra) => {
        if (busy || !selectedRuleRow || !canManage) return;
        setBusy(true);
        const payload = {
          sessionId,
          learningAction,
          id: selectedRuleRow.id,
          expectedRevision: selectedRuleRow.revision,
          operationId: newOperationId(),
          ...extra,
        };
        if (learningAction === 'pause') payload.ids = [selectedRuleRow.id];
        post('/lite-memory/evolution', payload).then((result) => {
          if (!alive.current || (selectedKey && scopeRef.current !== selectedKey)) return;
          setBusy(false);
          if (succeeded(result)) load(selectedKey, selectedRuleRow.id);
          else setNote(failure(result, '这次没有改动'));
        });
      };

      /** 普通记忆的正文由人直接改：带读到的版本写，冲突就提示刷新，不覆盖别处的修改。 */
      const saveMemoryEdit = (record) => {
        if (busy || !canManage || !record || !record.id) return;
        const title = editTitle.trim();
        const text = editBody.trim();
        if (!title || !text) return;
        setBusy(true);
        setEditNote('');
        const payload = { sessionId, scopeKey: selectedKey, id: record.id, title, body: text, expectedRevision: record.revision };
        post('/lite-memory/entry', payload).then((result) => {
          if (!alive.current || (selectedKey && scopeRef.current !== selectedKey)) return;
          setBusy(false);
          if (succeeded(result)) {
            const nextTitle = result.body && typeof result.body.title === 'string' ? result.body.title : title;
            const nextRevision = result.body && Number.isInteger(result.body.revision) ? result.body.revision : record.revision;
            setEditingMemory(false);
            setDetail((prev) => (prev ? { ...prev, title: nextTitle, body: text, currentBody: text, revision: nextRevision } : prev));
            setData((prev) => {
              if (!prev || !prev.selected || !Array.isArray(prev.selected.records)) return prev;
              const records = prev.selected.records.map((row) => (row.id === record.id ? { ...row, title: nextTitle, revision: nextRevision } : row));
              return { ...prev, selected: { ...prev.selected, records } };
            });
            setEditNote('');
          } else {
            setEditNote(failure(result, '这次没有改动'));
            /**
             * 版本过期不是失败终点：把最新正文和版本取回来，草稿留着，
             * 人确认后再按一次保存就写在最新版本上。
             */
            if (result.status === 409 && result.body && result.body.retry) {
              post('/lite-memory/body', { sessionId, id: record.id, scopeKey: selectedKey }).then((fresh) => {
                if (!alive.current || (selectedKey && scopeRef.current !== selectedKey)
                  || !fresh.ok || !fresh.body || !fresh.body.ok || fresh.body.status === 'gone') return;
                const revision = Number.isInteger(fresh.body.revision) ? fresh.body.revision : 0;
                setDetail(fresh.body);
                setEditNote('已载入最新内容，再保存会覆盖它');
                setData((prev) => {
                  if (!prev || !prev.selected || !Array.isArray(prev.selected.records)) return prev;
                  const records = prev.selected.records.map((row) => (row.id === record.id ? { ...row, revision: revision || row.revision } : row));
                  return { ...prev, selected: { ...prev.selected, records } };
                });
              });
            }
          }
        });
      };

      /** 适用范围待确认是模型留下的不确定；人点一次就把它变成明确结论，别再让模型猜。 */
      const confirmMemoryScope = (record) => {
        if (busy || !canManage || !record || !record.id) return;
        const text = currentBodyOf(detail) || '';
        if (!text) return;
        setBusy(true);
        post('/lite-memory/entry', {
          sessionId, scopeKey: selectedKey, id: record.id,
          title: record.title || detail.title || '', body: text,
          expectedRevision: record.revision, applicability: 'all_in_scope', conditions: [],
        }).then((result) => {
          if (!alive.current || (selectedKey && scopeRef.current !== selectedKey)) return;
          setBusy(false);
          if (!succeeded(result)) {
            setNote(failure(result, '适用范围没有改动'));
            return;
          }
          const revision = result.body && Number.isInteger(result.body.revision) ? result.body.revision : record.revision;
          setDetail((prev) => (prev ? { ...prev, applicability: 'all_in_scope', conditions: [], revision } : prev));
          setData((prev) => {
            if (!prev || !prev.selected || !Array.isArray(prev.selected.records)) return prev;
            const records = prev.selected.records.map((row) => (row.id === record.id
              ? { ...row, applicability: 'all_in_scope', conditions: [], revision } : row));
            return { ...prev, selected: { ...prev.selected, records } };
          });
        });
      };

      /** 跨层搬移是人的决定：模型只能提案，面板这一下才真的换层。 */
      const moveMemory = (record) => {
        if (busy || !record || !record.id) return;
        const target = selectedKey === 'global' ? 'project' : 'global';
        setBusy(true);
        setNote('');
        const operationId = newOperationId();
        let attempts = 0;
        const step = (resume) => {
          attempts += 1;
          const payload = resume ? { sessionId, operationId } : { sessionId, id: record.id, target, operationId };
          post(resume ? '/lite-memory/resume-move' : '/lite-memory/move', payload).then((result) => {
            if (!alive.current) return;
            if (result.status === 202) {
              if (attempts < 3) {
                step(true);
                return;
              }
              setBusy(false);
              setNote('搬移还没收尾，再点一次继续');
              load(selectedKey);
              return;
            }
            if (!alive.current || (selectedKey && scopeRef.current !== selectedKey)) return;
            setBusy(false);
            if (succeeded(result)) {
              setSelectedMemory('');
              setDetail(null);
              setEditingMemory(false);
              setNote(target === 'global' ? '已移到全局，各项目都能用' : '已移回当前项目');
              load(selectedKey);
              return;
            }
            setNote(failure(result, '没有移动'));
          });
        };
        step(false);
      };

      const setControlMode = (mode) => {
        if (busy || !canToggle || mode === memoryMode) return;
        setBusy(true);
        const body = mode === 'off'
          ? { sessionId, enabled: false, operationId: newOperationId() }
          : { sessionId, enabled: true, mode, operationId: newOperationId() };
        post('/lite-memory/control', body).then((result) => {
          if (!alive.current || (selectedKey && scopeRef.current !== selectedKey)) return;
          setBusy(false);
          if (succeeded(result)) load(selectedKey);
          else setNote(failure(result, '触发方式没有改动'));
        });
      };

      const toggleEvolution = () => {
        if (busy || !evolution || !canToggle || !memoryOn) return;
        setBusy(true);
        post('/lite-memory/evolution', { sessionId, enabled: evolution.enabled !== true, operationId: newOperationId() }).then((result) => {
          if (!alive.current || (selectedKey && scopeRef.current !== selectedKey)) return;
          setBusy(false);
          if (succeeded(result)) load(selectedKey);
          else setNote(failure(result, '开关没有改动'));
        });
      };

      const closeButton = h('button', {
        type: 'button', onClick: props.onClose, 'aria-label': '关闭',
        style: { width: '30px', height: '30px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: '8px', background: 'transparent', color: 'inherit', opacity: 0.65, cursor: 'pointer' },
      }, h(CloseIcon));

      const header = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 18px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: '0 0 auto' },
      },
      h('span', { style: { width: '32px', height: '32px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: '9px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-brand-primary)' } }, h(BrainIcon)),
      h('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
        h('span', { style: { fontSize: '14px', lineHeight: '1.35', fontWeight: 600 } }, '记忆'),
        h('span', { style: { ...PANEL_MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, selected ? `${selected.label} · ${total} 条` : '读取中…'),
      ),
      h('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' } },
        activeTab === 'memory' ? h('select', {
          value: selectedKey,
          onChange: (event) => load(event.target.value),
          'aria-label': '记忆范围',
          disabled: loading || !data,
          style: { height: '30px', maxWidth: '190px', padding: '0 8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit', fontSize: '12px' },
        },
        data && Array.isArray(data.scopes) ? data.scopes.map((scope) => h('option', { key: scope.key, value: scope.key }, scope.kind === 'global' ? '全局' : scope.label)) : null) : null,
        h('button', {
          type: 'button', 'aria-expanded': showSettings, 'aria-label': '显示设置',
          onClick: () => setShowSettings((value) => !value),
          style: {
            ...PANEL_LINK, height: '30px', padding: '0 9px', borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: showSettings ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            opacity: showSettings ? 0.92 : 0.68,
          },
        }, '显示设置'),
        closeButton,
      ),
      );

      const displayToggle = (label, key) => switchItem(
        label, '', display[key] === true, !selectedKey,
        selectedKey ? () => setDisplayFlag(key, display[key] !== true) : undefined,
      );

      const explainToggle = () => switchItem(
        '解释模式',
        explainOn ? '零命中时说明原因' : '零命中时不出提示',
        explainOn,
        !sessionId,
        sessionId ? () => {
          const next = explainOn !== true;
          setExplainOn(next);
          setExplainMode(sessionId, next);
        } : undefined,
      );

      /** 三个按钮改成两个开关：亮着的即当前状态。 */
      const reminderOn = memoryMode === 'adaptive';
      const modeChoices = () => h('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '4px 18px' },
      },
      modeSwitchesOf(memoryMode).map((item) => switchItem(item.label, item.hint, item.on, item.key === 'remind' ? busy || !canToggle || !memoryOn : busy || !canToggle,
        () => setControlMode(item.key === 'remind' ? (reminderOn ? 'tool_only' : 'adaptive') : (memoryOn ? 'off' : 'adaptive')))));
      const switchItem = (label, hint, on, disabled, onClick) => h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, opacity: disabled && !on ? 0.55 : 1 },
      },
      h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
        h('span', { style: { fontSize: '12px', lineHeight: '20px', fontWeight: 600, whiteSpace: 'nowrap' } }, label),
        h(Toggle, { ariaLabel: label, on, busy: busy || disabled, onClick: disabled ? undefined : onClick }),
      ),
      hint ? h('span', { style: { ...PANEL_MUTED, lineHeight: '16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, hint) : null);
      const evolutionOn = Boolean(memoryOn && evolution && evolution.enabled === true);
      const recallLine = recallLineOf(current && current.recall);
      const switchBar = h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '3px', padding: '7px 18px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: '0 0 auto' },
      },
      globalView
        ? h('div', { style: { ...PANEL_MUTED, lineHeight: '20px' } }, '全局记忆只读，可移回项目')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          modeChoices(),
          switchItem('自进化', evolutionOn ? '实验功能，会增加 token 消耗' : '从反馈里整理经验', evolutionOn, busy || !evolution || !canToggle || !memoryOn, toggleEvolution), // ui-copy-ignore 用户指定文案
          showSettings ? displayToggle('启用图谱', 'graph') : null,
          showSettings ? displayToggle('启用记忆宫殿', 'palace') : null,
          showSettings ? explainToggle() : null,
        ),
      showSettings && !globalView && tune
        ? h('div', {
          style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '7px 18px 8px', borderTop: '1px solid var(--dsw-alias-border-l1)' },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
          h('span', { style: { fontSize: '12px', fontWeight: 600 } }, '排序调参'),
          h('span', { style: { ...PANEL_MUTED, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            tune.replayCases > 0
              ? `回放 ${tune.replayCases} 条 · ${tune.params && tune.params.summaryWeight}`
              : '标一条漏掉的查询后才可试算'),
          tune.replayCases > 0 ? h(Action, { disabled: busy, onClick: () => tuneAct('suggest') }, '试算') : null,
          tune.proposal ? h(Action, { disabled: busy, onClick: () => tuneAct('apply') }, '采纳') : null,
          tune.canRollback === true ? h(Action, { disabled: busy, onClick: () => tuneAct('rollback') }, '回滚') : null),
        tune.proposal
          ? h('div', { style: { ...PANEL_MUTED, lineHeight: '18px' } }, `${tune.proposal.key} ${tune.proposal.from} → ${tune.proposal.to}，${tune.proposal.improved > 0 ? `改善 ${tune.proposal.improved} 条、` : ''}其余不变差`)
          : null,
        tune.lastChange
          ? h('div', { style: { ...PANEL_MUTED, lineHeight: '18px' } }, `上次采纳 ${tune.lastChange.key} ${tune.lastChange.from} → ${tune.lastChange.to}`)
          : null)
        : null,
      !globalView && !canToggle ? h('div', { style: { ...PANEL_MUTED, lineHeight: '18px' } }, '只读，切换回当前项目后可修改') : null,
      note ? h('div', { style: { ...PANEL_MUTED, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' } }, note) : null,
      !globalView && recallLine ? h('div', { style: { ...PANEL_MUTED, lineHeight: '18px' } }, recallLine) : null,
      );

      const switchTab = (key) => {
        if (key === 'evolution' && selectedKey !== currentKey) load(currentKey);
        setTab(key);
      };
      const tabButton = (key, text) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': activeTab === key,
        onClick: () => switchTab(key),
        style: {
          ...PANEL_LINK, flex: '0 0 auto', height: '34px', padding: '0 18px', borderRadius: 0,
          background: 'transparent',
          opacity: activeTab === key ? 0.95 : 0.55,
          border: 'none',
          borderBottom: activeTab === key ? '2px solid var(--dsw-alias-brand-primary)' : '2px solid transparent',
        },
      }, text);

      const tabBar = h('div', { role: 'tablist', 'aria-label': '记忆内容', style: { display: 'flex', alignItems: 'center', gap: '2px', flex: '0 0 auto', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        tabButton('memory', '记忆'),
        globalView ? null : tabButton('evolution', '自进化'),
      );

      const filteredNow = Boolean(query);
      const memoryList = loading
        ? h('div', { style: { ...PANEL_MUTED, padding: '14px 9px' } }, '读取中…')
        : filtered.length === 0
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 9px', minWidth: 0 } },
            h('span', { style: { ...PANEL_MUTED, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, filteredNow ? '没有匹配的记忆' : '还没有记忆'),
            filteredNow ? h(Action, { onClick: () => { setHubFilter(null); setQuery(''); } }, '清除搜索') : null,
          )
          : filtered.map((record) => h(MemoryRow, {
            key: record.id, record, active: record.id === selectedMemory,
            onClick: () => { setSelectedMemory(record.id); setSelectedRule(''); },
          }));

      const detailProcessing = detail ? processingStatusOf(detail) : '';
      const memoryEditor = editingMemory && detailRecord
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h(Field, { label: '标题', value: editTitle, onChange: setEditTitle }),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('span', { style: PANEL_LABEL }, '经验'),
            h('textarea', {
              value: editBody, onChange: (event) => setEditBody(event.target.value), 'aria-label': '经验',
              rows: 8,
              style: { ...PANEL_INPUT, height: 'auto', minHeight: '150px', padding: '7px 9px', resize: 'vertical', lineHeight: '1.6' },
            }),
          ),
          editNote ? h('div', { style: { ...PANEL_MUTED, color: 'var(--dsw-alias-label-error)' } }, editNote) : null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
            h(Action, { disabled: busy || !editTitle.trim() || !editBody.trim(), onClick: () => saveMemoryEdit(detailRecord) }, '保存'),
            h(Action, { disabled: busy, onClick: () => { setEditingMemory(false); setEditNote(''); } }, '取消'),
          ),
        )
        : null;

      const memoryDetail = selectedMemory
        ? h('div', { style: { ...PANEL_CARD, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' } },
          detail
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '8px' } },
                h('div', { style: { flex: 1, minWidth: 0, fontSize: '13px', lineHeight: '1.45', fontWeight: 600, wordBreak: 'break-word' } }, detail.title),
                h(Action, { onClick: () => setSelectedMemory('') }, '关闭'),
              ),
              h('div', { style: PANEL_MUTED }, `${KIND_LABEL[detailRecord && detailRecord.kind] || '记忆'} · ${detail.scopeLabel || ''}${detailRecord && detailRecord.origin === 'model_drafted' ? ' · [模型]' : ''}${detailProcessing ? ` · ${PROCESSING_LABEL[detailProcessing]}` : ''}`),
              Array.isArray(detailRecord && detailRecord.tags) && detailRecord.tags.length
                ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
                  detailRecord.tags.slice(0, 6).map((tag) => h('span', { key: tag, style: { ...PANEL_MUTED, padding: '0 6px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '999px' } }, `#${tag}`))) : null,
              memoryEditor,
              editingMemory ? null : h('div', { style: { fontSize: '12px', lineHeight: '1.65', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, currentBodyOf(detail) || '没有正文'),
              !editingMemory && detailRecord && detailRecord.applicability === 'unresolved'
                ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                  h('span', { style: PANEL_MUTED }, '适用范围待确认'),
                  canManage
                    ? h(Action, {
                      disabled: busy || !currentBodyOf(detail),
                      'aria-label': '标为所有任务都适用',
                      onClick: () => confirmMemoryScope(detailRecord),
                    }, '都适用')
                    : null)
                : null,
              editingMemory ? null : h(DetailExtras, { payload: detail }),
              !editingMemory && detailRecord && canManage
                ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', paddingTop: '2px' } },
                  h(Action, {
                    disabled: busy,
                    onClick: () => {
                      setEditTitle(detailRecord.title || detail.title || '');
                      setEditBody(currentBodyOf(detail) || '');
                      setEditNote('');
                      setEditingMemory(true);
                    },
                  }, '修改'),
                )
                : null,
              !editingMemory && detailRecord && memoryOn && (globalView || canManage)
                ? h(Action, { disabled: busy, onClick: () => moveMemory(detailRecord) }, selectedKey === 'global' ? '移回项目' : '移到全局')
                : null,
            )
            : h('div', { style: PANEL_MUTED }, detailNote || '读取中…'),
        )
        : null;

      const viewToggleOf = (current, setValue, ariaLabel, modes) => {
        const button = (key, label) => h('button', {
          key, type: 'button', onClick: () => setValue(key),
          'aria-pressed': current === key,
          style: {
            ...PANEL_LINK, height: '24px', padding: '0 7px', borderRadius: '6px',
            background: current === key ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            opacity: current === key ? 0.9 : 0.5,
          },
        }, label);
        const options = Array.isArray(modes) ? modes : [['list', '列表'], ['graph', '图谱']];
        return h('div', {
          role: 'group', 'aria-label': ariaLabel,
          style: {
            display: 'flex', alignItems: 'center', gap: '2px', flex: '0 0 auto',
            height: '30px', padding: '2px', boxSizing: 'border-box',
            border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
            background: 'var(--dsw-alias-bg-base)',
          },
        }, options.map(([key, label]) => button(key, label)));
      };
      const memoryModes = [['list', '列表']];
      if (display.graph) memoryModes.push(['graph', '图谱']);
      if (display.palace) memoryModes.push(['palace', '宫殿']);
      const memoryToggle = memoryModes.length > 1 ? viewToggleOf(memoryView, setMemoryView, '记忆视图', memoryModes) : null;
      const memoryViewActive = viewModeOf(display, memoryView);
      const evolutionViewActive = graphViewOf(display.graph, evolutionView);

      const conflictReadOnly = !memoryOn || (!globalView && selectedKey !== currentKey);
      const visibleConflicts = conflictVisibleRows(queued, conflictAll);
      const conflictBar = queued.length === 0 ? null : h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '3px', padding: '7px 9px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: '0 0 auto' },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
        h('span', { style: { ...PANEL_MUTED, lineHeight: '18px', flex: 1, minWidth: 0 } }, `${queued.length} 条保存有冲突${conflictReadOnly ? ' · 只读' : ''}`),
        queued.length > 2 ? h(Action, { disabled: busy, onClick: () => setConflictAll((value) => !value) }, conflictAll ? '收起' : `查看全部 ${queued.length} 条`) : null,
      ),
      h('span', { style: { ...PANEL_MUTED, lineHeight: '18px' } }, '和已有记忆对不上，不处理就先不写进去'),
      visibleConflicts.map((row) => {
        const open = expandedConflict === row.id;
        const facts = conflictFactsOf(row);
        return h('div', {
          key: row.id || row.title,
          style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
          h('button', {
            type: 'button',
            'aria-expanded': open,
            onClick: () => setExpandedConflict(open ? '' : row.id),
            style: {
              flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', color: 'inherit',
              textAlign: 'left', font: 'inherit', fontSize: '12px', lineHeight: '20px',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer',
            },
          }, row.title),
          conflictReadOnly || facts.draftMissing ? null : h(Action, { disabled: busy, onClick: () => resolveQueued(row, 'keep') }, '存新的'),
          conflictReadOnly ? null : h(Action, { disabled: busy, onClick: () => resolveQueued(row, 'drop') }, '丢掉'),
        ),
        open ? h('div', {
          style: { ...PANEL_MUTED, padding: '2px 0 4px', lineHeight: '18px', overflowWrap: 'anywhere', maxHeight: '180px', overflowY: 'auto' },
        },
        h('div', null, `存到：${facts.scope}`),
        facts.when ? h('div', null, `什么时候用：${facts.when}`) : null,
        facts.conditions ? h('div', null, `条件：${facts.conditions}`) : null,
        facts.selection ? h('div', null, `适用范围：${facts.selection}`) : null,
        facts.triggers ? h('div', null, `触发词：${facts.triggers}`) : null,
        facts.near ? h('div', null, `相近：${facts.near}`) : null,
        facts.draftMissing
          ? h('div', null, '旧版本排队的草稿没正文，只能丢掉')
          : h('div', { style: { whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-primary)' } }, facts.body),
        ) : null);
      }));
      const memoryListPane = h('div', {
        style: {
          ...PANEL_CARD, padding: '2px 4px', minHeight: 0, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 0,
        },
      }, conflictBar, memoryList);
      const memoryGraphPane = h('div', {
        style: { ...PANEL_CARD, padding: 0, minHeight: 0, overflow: 'hidden', display: 'flex' },
      },
      h(MemoryGraph, {
        records: graphFiltered, total: hubFilter ? graphFiltered.length : total,
        selectedId: selectedMemory, onPick: onPickNode,
        onPickHub,
        emptyText: query || hubFilter ? '没有匹配的记忆' : '还没有记忆', ariaLabel: '记忆关系图',
        legend: '实心 记忆 · 空心 标签/主题 · 虚线 归类 · 点标签筛选，点记忆看正文',
      }));
      const memoryPalacePane = h(MemoryPalace, {
        key: selectedKey, records: filtered, selectedId: selectedMemory,
        onPick: (id) => { setSelectedMemory(id); setSelectedRule(''); },
        emptyText: query ? '没有匹配的记忆' : '这个项目还没有记忆',
      });
      const memoryTab = h('div', { role: 'tabpanel', 'aria-label': '记忆', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '9px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' } },
          hubFilter && memoryViewActive === 'graph' ? h('button', {
            type: 'button',
            onClick: () => setHubFilter(null),
            'aria-label': `取消只看 ${hubFilter.display}`,
            style: {
              flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: '4px',
              height: '28px', padding: '0 8px', border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: '999px', background: 'var(--dsw-alias-bg-layer-1)',
              color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '12px', cursor: 'pointer',
            },
          }, hubFilter.display, h('span', { 'aria-hidden': 'true', style: { opacity: 0.6 } }, '✕')) : null,
          h('input', {
            value: query,
            onChange: (event) => { setHubFilter(null); setQuery(event.target.value); },
            placeholder: '搜索标题或标签', 'aria-label': '搜索记忆',
            style: { ...PANEL_INPUT, width: 'auto', flex: '1 1 0', minWidth: 0 },
          }),
          memoryToggle,
        ),
        h('div', {
          style: {
            flex: 1, minHeight: 0, display: 'grid', gap: '10px',
            gridTemplateColumns: selectedMemory ? 'minmax(0, 1fr) minmax(280px, 340px)' : 'minmax(0, 1fr)',
          },
        },
        h('div', { style: { position: 'relative', minWidth: 0, minHeight: 0, display: 'flex' } },
          h('div', { style: { display: memoryViewActive === 'graph' ? 'flex' : 'none', minWidth: 0, minHeight: 0, width: '100%' } }, memoryGraphPane),
          h('div', { style: { display: memoryViewActive === 'palace' ? 'flex' : 'none', minWidth: 0, minHeight: 0, width: '100%' } }, memoryPalacePane),
          h('div', { style: { display: memoryViewActive === 'list' ? 'flex' : 'none', minWidth: 0, minHeight: 0, width: '100%', flexDirection: 'column' } }, memoryListPane)),
        h(PersonaSection, { key: 'persona', sessionId }),
        memoryDetail),
      );

      const stageFilters = [
        ['all', '全部'],
        ['pending', '候选'],
        ['trial', '试用'],
        ['active', '生效'],
        ['paused', '暂停'],
      ];
      const countText = (key) => {
        if (!counts || countsUnknown) return '—';
        if (key === 'all') return String(['pending', 'trial', 'active', 'paused'].reduce((sum, name) => sum + (countOf(counts, name) || 0), 0));
        const value = countOf(counts, key);
        return value === null ? '—' : String(value);
      };
      const filterBar = h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', flex: '0 0 auto' } },
        stageFilters.map(([key, label]) => h('button', {
          key, type: 'button', onClick: () => setStage(key),
          style: {
            ...PANEL_LINK, opacity: stage === key ? 0.92 : 0.5,
            borderBottom: stage === key ? '1px solid currentColor' : '1px solid transparent',
            fontVariantNumeric: 'tabular-nums',
          },
        }, `${label} ${countText(key)}`)),
        h('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' } },
          h('button', {
            type: 'button', 'aria-pressed': checkup, onClick: () => setCheckup((value) => !value),
            style: {
              ...PANEL_LINK, height: '30px', opacity: checkup ? 0.92 : 0.68,
              borderBottom: checkup ? '1px solid currentColor' : '1px solid transparent',
            },
          }, '结构体检'),
          display.graph ? viewToggleOf(evolutionView, setEvolutionView, '自进化视图') : null),
      );

      const stageLabel = (stageFilters.find(([key]) => key === stage) || ['all', '全部'])[1];
      const evolutionEmptyText = !memoryOn ? '记忆已关闭'
        : !evolution ? '读不到自进化状态'
          : evolution.enabled !== true ? '自进化已关闭'
            : rules.length === 0 ? (countsUnknown ? '数量未知' : '还没有整理出经验')
              : `没有${stageLabel}的经验`;
      const evolutionList = filteredRules.length === 0
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 9px', minWidth: 0 } },
          h('span', { style: { ...PANEL_MUTED, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, evolutionEmptyText),
          stage !== 'all' && (memoryOn && evolution && evolution.enabled === true) ? h(Action, { onClick: () => setStage('all') }, '看全部') : null,
        )
        : filteredRules.map((rule) => h(EvolutionRow, {
          key: rule.id, rule, active: rule.id === selectedRule,
          onClick: () => { setSelectedRule(rule.id); setSelectedMemory(''); setShowReason(false); },
        }));

      const evolutionReady = selectedKey === currentKey;
      const evolutionFailed = !evolutionReady || failed
        ? h('div', { style: { ...PANEL_CARD, padding: '9px 11px', display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' } },
          h('span', { style: { ...PANEL_MUTED, minWidth: 0 } }, !evolutionReady && loading ? '读取中…' : (note || '读不到自进化状态')),
          !evolutionReady && loading ? null : h(Action, { onClick: () => load(currentKey) }, '重试'),
        )
        : null;
      const evolutionDetailPane = selectedRuleRow
        ? h('div', { style: { ...PANEL_CARD, padding: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', padding: '8px 10px 0', flex: '0 0 auto' } },
            h(Action, { onClick: () => setSelectedRule('') }, '关闭')),
          h('div', { style: { minHeight: 0, overflowY: 'auto', padding: '0 10px 10px' } },
            h(EvolutionDetail, {
              key: selectedRuleRow.id, rule: selectedRuleRow, evolution, memoryOn,
              canManage, busy, onManage: manage,
            })))
        : null;
      const evolutionListPane = h('div', {
        style: {
          ...PANEL_CARD, padding: '4px', minHeight: 0, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: '2px',
        },
      }, evolutionList);
      const evolutionGraphPane = h('div', {
        style: { ...PANEL_CARD, padding: 0, minHeight: 0, overflow: 'hidden', display: 'flex' },
      },
      h(MemoryGraph, {
        records: filteredRules, total: filteredRules.length, graphOf: ruleGraphOf, primaryKind: 'rule',
        selectedId: selectedRule, onPick: onPickRuleNode,
        emptyText: evolutionEmptyText, ariaLabel: '经验关系图',
        legend: '实心 经验 · 空心 条件 · 虚线 共用条件 · 点经验查看',
      }));
      const evolutionCheckupPane = h('div', {
        style: {
          ...PANEL_CARD, padding: '4px', flex: '0 0 auto', minHeight: 0, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 0,
        },
      },
      checkupRowOf('duplicate', '重复标题', checkupData.duplicate, '组', () => checkupJump({ kind: 'duplicate', display: '重复标题' })),
      checkupRowOf('global', '全局条目超 200', checkupData.globalEntries, '条', () => checkupJumpGlobal()),
      checkupRowOf('globalWhen', '全局缺适用条件', checkupData.globalMissingWhen, '条',
        () => checkupJumpGlobal({ kind: 'noWhen', display: '全局缺适用条件' })),
      checkupRowOf('unread', '从未读过', checkupData.unread, '条', () => checkupJump({ kind: 'unread', display: '从未读过' })));

      const evolutionTab = evolutionFailed ? evolutionFailed : h('div', { role: 'tabpanel', 'aria-label': '自进化', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '9px' } },
        h('div', { style: { ...PANEL_CARD, padding: '9px 11px', display: 'flex', alignItems: 'flex-start', gap: '8px', flex: '0 0 auto' } },
          h('span', { style: { flex: '0 0 auto', width: '6px', height: '6px', marginTop: '5px', borderRadius: '999px', background: effectiveEnabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)', opacity: 0.8 } }),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
            h('div', { style: { fontSize: '12px', lineHeight: '1.55' } }, activityText || (rules.length === 0 ? '还没有整理出经验' : '暂无整理记录')),
            countsUnknown ? h('div', { style: PANEL_MUTED }, '数量未知') : null,
            activityReasonText
              ? (showReason
                ? h('div', { style: { ...PANEL_MUTED, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, activityReasonText)
                : h(Action, { onClick: () => setShowReason(true) }, '查看原因'))
              : null,
          ),
        ),
        filterBar,
        h('div', {
          style: {
            flex: 1, minHeight: 0, display: 'grid', gap: '10px',
            gridTemplateColumns: !checkup && selectedRuleRow ? 'minmax(0, 1fr) minmax(280px, 340px)' : 'minmax(0, 1fr)',
          },
        },
        checkup ? evolutionCheckupPane : (evolutionViewActive === 'graph' ? evolutionGraphPane : evolutionListPane),
        checkup ? null : evolutionDetailPane),
      );

      const palaceLoose = activeTab === 'memory' && viewModeOf(display, memoryView) === 'palace' && !selectedMemory;
      const content = h('section', {
        style: {
          flex: palaceLoose ? '0 1 auto' : 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
          padding: '12px 18px 14px', gap: '10px', overflowY: palaceLoose ? 'auto' : 'visible',
        },
      },
        tabBar,
        activeTab === 'memory' ? memoryTab : evolutionTab,
      );

      const shell = (children) => h('div', {
        style: PANEL_BACKDROP,
        onClick: (event) => { if (event.target === event.currentTarget) props.onClose(); },
      },
      h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': '记忆面板',
        style: {
          ...PANEL_DIALOG, width: 'min(1120px, 100%)', boxSizing: 'border-box',
          height: palaceLoose ? 'auto' : 'min(760px, 100%)', maxHeight: 'min(760px, 100%)',
        },
      }, ...children));

      if (!sessionId) return null;
      if (!data) {
        return shell([
          header,
          h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' } },
            h('span', null, loading ? '读取中…' : '读不到记忆'),
            loading || !note ? null : h(Action, { onClick: () => load() }, '重试'),
            note ? h('span', null, note) : null,
          ),
        ]);
      }

      return shell([header, switchBar, content]);
    };

    /** 面板浮层。 */
    const MemoryOverlay = () => {
      const ui = usePanelUi();
      if (!ui.open || !ui.sessionId) return null;
      return h(MemoryPanel, {
        key: ui.sessionId,
        sessionId: ui.sessionId,
        onClose: () => updatePanel({ open: false }),
      });
    };

    /** 输出末尾那几条：只算本轮的。 */
    const TurnMemory = (props) => {
      const sessionId = sessionKeyOf(props);
      const turn = props.turn && typeof props.turn === 'object' && props.turn.turn !== undefined
        ? String(props.turn.turn)
        : props.turn !== undefined && props.turn !== null ? String(props.turn) : '';
      const useRefs = props.useRefs;
      const refs = typeof useRefs === 'function' && turn ? useRefs(turn) : EMPTY;
      const groups = React.useMemo(() => {
        const list = Array.isArray(refs) ? refs : EMPTY;
        return {
          found: list.filter((item) => item.exposure === 'reference' && item.kind === 'memory-search'),
          provided: list.filter((item) => item.exposure === 'reference' && item.kind === 'memory-read'),
          update: list.filter((item) => item.exposure === 'update'),
        };
      }, [refs]);
      const [explainOn, setExplainOn] = React.useState(explainModeOf(sessionId));
      React.useEffect(() => watchExplain(() => setExplainOn(explainModeOf(sessionId))), [sessionId]);
      const noTriggerReason = typeof props.noTriggerReason === 'string' && props.noTriggerReason
        ? props.noTriggerReason
        : (typeof refs.noTriggerReason === 'string' ? refs.noTriggerReason : '');
      if (!sessionId && refs.length === 0) return null;
      if (groups.found.length === 0 && groups.provided.length === 0 && groups.update.length === 0) {
        return explainOn && noTriggerReason
          ? h('div', { style: TAIL }, h(RefSection, { label: '搜索命中', tone: 'found', items: EMPTY, sessionId, turnKey: turn, noTriggerReason }))
          : null;
      }
      const section = (label, items, tone) => (items.length === 0
        ? null
        : h(RefSection, { key: label, label, tone, items, sessionId, turnKey: turn }));
      return h('div', { style: TAIL },
        section('搜索命中', groups.found, 'found'),
        section('读过正文', groups.provided, 'provided'),
        section('本轮更新', groups.update, 'update'),
      );
    };

    const sourceCache = new Map();

    // 测试缝：Node 里验引用投影，浏览器里没有任何副作用。
    if (typeof globalThis.__LITE_MEMORY_TEST__ === 'function') {
      globalThis.__LITE_MEMORY_TEST__({ metaOf, citationOf, citationsOfMeta, citationsOfTurn, dedupe, undoRefOf, graphOf, ruleGraphOf, processingStatusOf, currentBodyOf, historyDiffsOf, MemoryPanel, PersonaSection, MemoryGraph, MemoryPalace, TurnMemory, RefSection, displayKeyOf, readDisplaySettings, writeDisplaySettings, graphViewOf, viewModeOf, filterRecords, projectionOf, failureStateOf, evidenceTextOf, evidenceMetaOf, palaceRoomsOf, palaceRoomPageOf, palaceSlotCountOf, palacePageWindow, palaceToggleOf, palaceMotionOf, palaceRoomIdOf, refMetaOf, explainKeyOf, explainModeOf, setExplainMode, recallLineOf, modeSwitchesOf, agoLabel, checkupOf, refSectionRowsOf, refDetailTitleOf, versionLine, titleCountsOf, rowKeyOf, rowKeepFlags, Row, conflictVisibleRows, conflictFactsOf });
    }

    return {
      inject: ['slots', 'sessions', 'uiConversation'],
      apply(ctx) {
        for (const name of ['memory_search', 'memory_read', 'memory_forget']) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: name }, Row));
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'memory_suggest' }, SuggestRow));
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'memory_save' }, SavedRow));
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'lite-memory:project-evolution',
          order: 30, // ui-copy-ignore
        }, ProjectEvolution));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'lite-memory:panel',
          order: 30, // ui-copy-ignore
        }, MemoryOverlay));
        ctx.slots.inject('conversation.chat.turnTail', () => {
          try {
            return ctx.slots.register({
              name: 'conversation.chat.turnTail',
              id: 'lite-memory', // ui-copy-ignore
              order: 30, // ui-copy-ignore
              inject: (sessionId) => ({ // ui-copy-ignore
                keyedHooks: {
                  refs: (turn) => { // ui-copy-ignore
                    const key = `${sessionId}|${turn}`;
                    let source = sourceCache.get(key);
                    if (!source) {
                      const getChat = () => {
                        const binding = ctx.sessions.binding(sessionId);
                        if (binding === undefined) return null;
                        return ctx.uiConversation.binding(binding).target('chat');
                      };
                      source = turnSource(getChat, String(turn));
                      sourceCache.set(key, source);
                      while (sourceCache.size > 200) {
                        sourceCache.delete(sourceCache.keys().next().value);
                      }
                    }
                    return source;
                  },
                },
              }),
            }, TurnMemory);
          } catch {
            return () => {};
          }
        });
      },
    };
  },
});
