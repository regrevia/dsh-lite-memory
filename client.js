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

    const KEEP = { idle: 'keep', saving: 'saving', saved: 'kept', failed: '重试' };
    const ROW = { display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 0', fontSize: '12px', lineHeight: '1.6', opacity: 0.7 };
    const DOT = { flex: '0 0 auto', opacity: 0.8 };
    const LABEL = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const KEEP_STYLE = { flex: '0 0 auto', border: '1px solid currentColor', background: 'transparent', color: 'inherit', borderRadius: '999px', padding: '0 8px', fontSize: '12px', lineHeight: '18px' };
    const KEEP_ON = { ...KEEP_STYLE, opacity: 0.9, cursor: 'pointer' };
    const KEEP_OFF = { ...KEEP_STYLE, opacity: 0.45, cursor: 'default' };
    const DROP = { flex: '0 0 auto', border: 'none', background: 'transparent', color: 'inherit', padding: '0 2px', fontSize: '12px', lineHeight: '18px', opacity: 0.55, cursor: 'pointer' };
    const DOCK = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, fontSize: '12px', lineHeight: '1.6' };
    const CHIP = { alignSelf: 'flex-start', border: 'none', background: 'transparent', color: 'inherit', padding: 0, fontSize: '12px', lineHeight: '1.6', opacity: 0.6, cursor: 'pointer', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const ITEM = { alignSelf: 'flex-start', border: 'none', background: 'transparent', color: 'inherit', padding: 0, fontSize: '12px', lineHeight: '1.6', opacity: 0.75, cursor: 'pointer', textAlign: 'left', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
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

    /** 按钮只认结果行里的 id。 */
    const idOf = (value, prefix) => {
      const re = new RegExp(`\\b${prefix}_[a-z0-9]{6,}\\b`);
      const match = typeof value === 'string' ? re.exec(value) : null;
      return match ? match[0] : null;
    };

    const newOperationId = () => `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    /** 只在产生这行的那一轮显示。 */
    const useLive = (phase) => {
      const live = React.useRef(phase !== 'result');
      if (phase !== 'result') live.current = true;
      return live.current;
    };

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

    /** 「N 条记忆引用」只在本会话读过记忆时出现。 */
    const watchers = new Map();
    const bumpCitations = (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return;
      for (const notify of watchers.get(sessionId) || []) notify();
    };
    const watchCitations = (sessionId, notify) => {
      if (typeof sessionId !== 'string' || !sessionId) return () => {};
      const bucket = watchers.get(sessionId) || new Set();
      bucket.add(notify);
      watchers.set(sessionId, bucket);
      return () => {
        bucket.delete(notify);
        if (bucket.size === 0) watchers.delete(sessionId);
      };
    };

    const useCitationBump = (phase, sessionId) => {
      React.useEffect(() => {
        if (phase === 'result') bumpCitations(sessionId);
      }, [phase, sessionId]);
    };

    const Row = (props) => {
      useCitationBump(props.phase, props.sessionId);
      if (!useLive(props.phase)) return null;
      const line = props.phase === 'preparing' ? null : firstLine(settledText(props.block));
      return h('div', { 'data-tool': props.toolName, style: ROW }, h('span', { style: DOT }, '·'), h('span', { style: LABEL }, line ?? RUNNING[props.toolName] ?? 'memory'));
    };

    /** 建议行：一个「keep」按钮，按 candidateId 确认。 */
    const SuggestRow = (props) => {
      useCitationBump(props.phase, props.sessionId);
      if (!useLive(props.phase)) return null;
      const [state, setState] = React.useState('idle');
      const [note, setNote] = React.useState('');
      const operationId = React.useRef('');
      const text = props.phase === 'preparing' ? null : settledText(props.block);
      const line = firstLine(text) ?? RUNNING.memory_suggest;
      const candidateId = idOf(text, 'sug');
      const cwd = typeof props.cwd === 'string' ? props.cwd : '';
      const canKeep = Boolean(candidateId) && Boolean(cwd) && state === 'idle';
      const keep = () => {
        if (!canKeep) return;
        if (!operationId.current) operationId.current = newOperationId();
        setState('saving');
        post('/lite-memory/keep', { op: 'keep', candidateId, operationId: operationId.current, cwd }).then((result) => {
          if (result.ok) {
            setState('saved');
            bumpCitations(props.sessionId);
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

    /** 自动写入行：一个「✕」，有旧版本就还原成新一版，没有就归档。 */
    const SavedRow = (props) => {
      useCitationBump(props.phase, props.sessionId);
      if (!useLive(props.phase)) return null;
      const [state, setState] = React.useState('idle');
      const [note, setNote] = React.useState('');
      const text = props.phase === 'preparing' ? null : settledText(props.block);
      const entryId = idOf(text, 'mem');
      const cwd = typeof props.cwd === 'string' ? props.cwd : '';
      const canDrop = Boolean(entryId) && Boolean(cwd) && state === 'idle';
      const drop = () => {
        if (!canDrop) return;
        setState('saving');
        post('/lite-memory/undo', { op: 'undo', id: entryId, cwd }).then((result) => {
          if (result.ok) {
            setState('dropped');
            setNote(result.body && result.body.mode === 'restored' ? 'memory · restored' : 'memory · archived');
            return;
          }
          setNote(failure(result, '没有撤销'));
          setState('failed');
        });
      };
      const label = note || (firstLine(text) ?? RUNNING.memory_save);
      const button = entryId && state !== 'dropped'
        ? h('button', { type: 'button', onClick: drop, disabled: !canDrop, 'aria-label': '删除这条记忆', style: DROP }, '✕')
        : null;
      return h('div', { 'data-tool': props.toolName, style: ROW }, h('span', { style: DOT }, '·'), h('span', { style: LABEL }, label), button);
    };

    /** 输入框下面的那一条：引用了几条。 */
    const Citations = (props) => {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const [items, setItems] = React.useState([]);
      const [open, setOpen] = React.useState(false);
      const [shown, setShown] = React.useState(null);
      const [note, setNote] = React.useState('');
      const [tick, setTick] = React.useState(0);

      React.useEffect(() => watchCitations(sessionId, () => setTick((n) => n + 1)), [sessionId]);
      React.useEffect(() => {
        let stopped = false;
        if (!sessionId) {
          setItems([]);
          return () => { stopped = true; };
        }
        post('/lite-memory/citations', { sessionId }).then((result) => {
          if (stopped) return;
          setItems(result.ok && result.body && Array.isArray(result.body.items) ? result.body.items : []);
        });
        return () => { stopped = true; };
      }, [sessionId, tick]);

      if (items.length === 0) return null;

      const showBody = (item) => {
        if (shown && shown.id === item.id) {
          setShown(null);
          return;
        }
        setNote('');
        post('/lite-memory/body', { sessionId, id: item.id }).then((result) => {
          if (result.ok && result.body && typeof result.body.body === 'string') {
            setShown({ id: item.id, title: result.body.title || item.title, body: result.body.body });
            return;
          }
          setShown(null);
          setNote(failure(result, '没有读到正文'));
        });
      };

      const titleOf = (item) => `${item.scope === 'global' ? '[全局] ' : ''}${item.title}`;
      const rows = open ? items.map((item) => h('button', { key: item.id, type: 'button', onClick: () => showBody(item), 'aria-label': `查看记忆 ${item.title}`, style: ITEM }, titleOf(item))) : [];

      const toggle = () => {
        setOpen(!open);
        setShown(null);
        setNote('');
      };

      return h('div', { style: DOCK, 'data-memory-citations': items.length },
        h('button', { type: 'button', onClick: toggle, 'aria-expanded': open, 'aria-label': open ? '收起记忆引用' : '展开记忆引用', style: CHIP }, `记忆引用 ${items.length} 条${open ? ' · 收起' : ''}`),
        ...rows,
        shown ? h('div', { style: BODY }, h('div', { style: { opacity: 0.9 } }, shown.title), shown.body) : null,
        note ? h('div', { style: BODY }, note) : null,
      );
    };

    return {
      inject: ['slots'],
      apply(ctx) {
        for (const name of ['memory_search', 'memory_read', 'memory_forget']) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: name }, Row));
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'memory_suggest' }, SuggestRow));
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'memory_save' }, SavedRow));
        ctx.slots.inject('conversation.composer.dock', () => {
          try {
            return ctx.slots.register({ name: 'conversation.composer.dock', id: 'lite-memory', order: 2 }, Citations);
          } catch {
            return () => {};
          }
        });
      },
    };
  },
});
