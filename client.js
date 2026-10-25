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
    const TAIL = { ...DOCK, margin: '4px 0 2px', opacity: 0.9 };
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

    /** 已落定、带元数据的调用块；旧行只读。 */
    const metaOf = (block) => {
      if (block === undefined || block === null || !('kind' in block) || block.isError === true) return null;
      const meta = block.meta;
      if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null;
      return meta;
    };

    const isMemoryId = (value) => typeof value === 'string' && /^mem_[a-z0-9]{6,}$/.test(value);
    const isCandidateId = (value) => typeof value === 'string' && /^sug_[a-z0-9]{6,}$/.test(value);

    /** 一条引用的规范形态：只有定位与版次。 */
    const citationOf = (meta, kind) => {
      if (!meta || !isMemoryId(meta.id)) return null;
      if (kind === 'memory-save' && meta.changed !== true) return null;
      return {
        id: meta.id,
        title: typeof meta.title === 'string' ? meta.title : '',
        scope: meta.scope === 'global' ? 'global' : 'project',
        revision: Number.isInteger(meta.revision) ? meta.revision : 1,
        status: typeof meta.status === 'string' ? meta.status : 'ok',
        kind,
        exposure: kind === 'memory-save' || kind === 'memory-forget' ? 'update' : 'reference',
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
      for (const node of nodes) {
        const root = node && node.root;
        if (root === null || typeof root !== 'object') continue;
        for (const block of [root, ...(Array.isArray(root.subCalls) ? root.subCalls : [])]) {
          const meta = metaOf(block);
          if (!meta) continue;
          out.push(...citationsOfMeta(meta));
        }
      }
      return out;
    };

    /** 同一轮里同层同 id 同版同用途只留一条。 */
    const dedupe = (items) => {
      const seen = new Set();
      const out = [];
      for (const item of items) {
        const key = `${item.scope}:${item.id}:${item.revision}:${item.exposure}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
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
          if (!sameList(next, snapshot)) snapshot = next;
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

    const Row = (props) => {
      const line = props.phase === 'preparing' ? null : firstLine(settledText(props.block));
      return h('div', { 'data-tool': props.toolName, style: ROW }, h('span', { style: DOT }, '·'), h('span', { style: LABEL }, line ?? RUNNING[props.toolName] ?? 'memory'));
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
          if (result.ok) {
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

    /** 写入行：只有真的改了东西才给撤销，且带着当时的版本。 */
    const SavedRow = (props) => {
      const meta = metaOf(props.block);
      const [state, setState] = React.useState('idle');
      const [note, setNote] = React.useState('');
      const text = props.phase === 'preparing' ? null : settledText(props.block);
      const cwd = typeof props.cwd === 'string' ? props.cwd : '';
      const changed = meta && meta.kind === 'memory-save' && meta.changed === true && isMemoryId(meta.id) && Number.isInteger(meta.revision)
        ? meta
        : null;
      const canDrop = Boolean(changed) && Boolean(cwd) && (state === 'idle' || state === 'failed');
      const drop = () => {
        if (!canDrop) return;
        setState('saving');
        post('/lite-memory/undo', { op: 'undo', id: changed.id, revision: changed.revision, cwd }).then((result) => {
          if (result.ok) {
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
      const label = note || (firstLine(text) ?? RUNNING.memory_save);
      const button = changed && state !== 'dropped'
        ? h('button', { type: 'button', onClick: drop, disabled: !canDrop, 'aria-label': '撤销此次修改', style: state === 'idle' || state === 'failed' ? DROP : { ...DROP, opacity: 0.25, cursor: 'default' } }, '✕')
        : null;
      return h('div', { 'data-tool': props.toolName, style: ROW }, h('span', { style: DOT }, '·'), h('span', { style: LABEL }, label), button);
    };

    const versionLine = (shown) => {
      const scope = shown.scopeLabel || (shown.scope === 'global' ? '全局' : '项目');
      const version = shown.current === false ? `第 ${shown.revision} 版` : `当前第 ${shown.revision} 版`;
      const archived = shown.status === 'archived' ? ' · 已归档' : '';
      return `${version} · ${scope}${archived}`;
    };

    /** 一段引用：点开是名字，再点是当前正文。 */
    const RefSection = (props) => {
      const items = Array.isArray(props.items) ? props.items : EMPTY;
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
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
      if (items.length === 0) return null;
      const close = () => {
        generation.current += 1;
        setShown(null);
        setNote('');
        setOpen(false);
      };
      const show = (item) => {
        if (shown && shown.id === item.id) {
          close();
          return;
        }
        const request = generation.current + 1;
        generation.current = request;
        setOpen(true);
        setShown({ id: item.id, ref: item, loading: true });
        setNote('');
        post('/lite-memory/body', { id: item.id, revision: item.revision }).then((result) => {
          if (!alive.current || generation.current !== request) return;
          const payload = result.ok && result.body ? result.body : null;
          if (!payload || payload.ok !== true) {
            setShown({ id: item.id, ref: item, invalid: true });
            return;
          }
          if (payload.status === 'gone') {
            setShown({ id: item.id, ref: item, gone: true });
            return;
          }
          setShown({
            id: item.id,
            ref: item,
            title: typeof payload.title === 'string' ? payload.title : '',
            when: typeof payload.when === 'string' ? payload.when : '',
            scope: payload.scope === 'global' ? 'global' : 'project',
            scopeLabel: typeof payload.scopeLabel === 'string' ? payload.scopeLabel : '',
            revision: Number.isInteger(payload.revision) ? payload.revision : item.revision,
            status: typeof payload.status === 'string' ? payload.status : 'ok',
            body: typeof payload.body === 'string' ? payload.body : '',
            current: payload.revision === item.revision,
          });
        });
      };
      const rows = open ? items.map((item) => h('button', {
        key: `${item.scope}|${item.id}|${item.revision}`, // ui-copy-ignore
        type: 'button', // ui-copy-ignore
        onClick: () => show(item), // ui-copy-ignore
        'aria-label': `查看记忆 ${item.title || item.id}`,
        title: item.title || item.id,
        style: ITEM, // ui-copy-ignore
      }, item.title || item.id)) : [];
      const detail = shown && shown.ref && items.some((item) => item.id === shown.id && item.revision === shown.ref.revision)
        ? h('div', { style: BODY },
          shown.loading ? '读取中' : null,
          shown.gone ? '这条记忆已删除' : null,
          shown.invalid ? '读取失败，点名字重试' : null,
          !shown.loading && !shown.gone && !shown.invalid ? h(React.Fragment, null,
            shown.title && shown.title !== shown.ref.title ? h('div', { style: { opacity: 0.9 } }, shown.title) : null,
            h('div', null, versionLine(shown)),
            shown.when ? h('div', null, shown.when) : null,
            shown.body ? h('div', null, shown.body) : null,
          ) : null,
        )
        : null;
      return h('div', { style: DOCK, 'data-memory-section': props.label },
        h('button', {
          type: 'button',
          onClick: () => { if (open) close(); else setOpen(true); },
          'aria-expanded': open,
          'aria-label': `${open ? '收起' : '展开'}${props.label}`,
          style: CHIP,
        }, `${props.label} ${items.length} 条${open ? ' · 收起' : ''}`),
        ...rows,
        detail,
        note ? h('div', { style: BODY }, note) : null,
      );
    };

    /** 续聊摘要：只列这一轮落定的记忆，不猜任务内容。 */
    const Handoff = (props) => {
      const items = Array.isArray(props.items) ? props.items : EMPTY;
      const [open, setOpen] = React.useState(false);
      const [note, setNote] = React.useState('');
      if (items.length === 0) return null;
      const text = ['本轮记忆', ...items.map((item) => `- ${item.scope === 'global' ? '【全局】' : ''}${item.id}「${item.title || item.id}」第 ${item.revision} 版`)].join('\n');
      const copy = () => {
        setNote('');
        const done = () => setNote('已复制');
        const fail = () => setNote('复制失败，手动选中');
        try {
          const clipboard = typeof navigator === 'object' && navigator !== null ? navigator.clipboard : null;
          if (clipboard && typeof clipboard.writeText === 'function') {
            clipboard.writeText(text).then(done, fail);
            return;
          }
        } catch {
          /* fall through */
        }
        fail();
      };
      return h('div', { style: DOCK },
        h('button', {
          type: 'button',
          onClick: () => { setOpen(!open); setNote(''); },
          'aria-expanded': open,
          style: CHIP,
        }, '准备续聊摘要'),
        open ? h('div', { style: BODY },
          text,
          h('div', null,
            h('button', { type: 'button', onClick: copy, style: KEEP_ON }, '复制摘要'),
            note ? h('span', { style: { marginLeft: '8px' } }, note) : null,
          ),
        ) : null,
      );
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
          reference: list.filter((item) => item.exposure === 'reference'),
          update: list.filter((item) => item.exposure === 'update'),
        };
      }, [refs]);
      if (!sessionId && refs.length === 0) return null;
      if (groups.reference.length === 0 && groups.update.length === 0) return null;
      return h('div', { style: TAIL },
        h(RefSection, { label: '本轮参考', items: groups.reference, sessionId, turnKey: turn }),
        h(RefSection, { label: '本轮更新', items: groups.update, sessionId, turnKey: turn }),
        h(Handoff, { items: groups.update }),
      );
    };

    const sourceCache = new Map();

    // 测试缝：Node 里验引用投影，浏览器里没有任何副作用。
    if (typeof globalThis.__LITE_MEMORY_TEST__ === 'function') {
      globalThis.__LITE_MEMORY_TEST__({ metaOf, citationOf, citationsOfMeta, citationsOfTurn, dedupe });
    }

    return {
      inject: ['slots', 'sessions', 'uiConversation'],
      apply(ctx) {
        for (const name of ['memory_search', 'memory_read', 'memory_forget']) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: name }, Row));
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'memory_suggest' }, SuggestRow));
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'memory_save' }, SavedRow));
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
