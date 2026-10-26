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
        origin: meta.origin === 'project_evolution' ? 'project_evolution' : 'user_explicit',
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

    /** 撤销只认真正写入且版本一致的那次保存。 */
    const undoRefOf = (meta, cwd) => (meta
      && meta.kind === 'memory-save'
      && meta.changed === true
      && isMemoryId(meta.id)
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
      const archived = shown.status === 'archived' ? ' · 已归档' : '';
      return `${scope}${archived}`;
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
        post('/lite-memory/body', { id: item.id, revision: item.revision, sessionId }).then((result) => {
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
      }, `${item.title || item.id}${item.origin === 'project_evolution' ? ' · 实验' : ''}`)) : [];
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

    const EVO_BUTTON = { flex: '0 0 auto', width: '28px', height: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', color: 'inherit', borderRadius: '999px', padding: 0, cursor: 'pointer' };

    /** 大脑：两瓣轮廓加一条中线，状态只靠透明度和面板文字。 */
    const BrainIcon = () => h('svg', {
      width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true', focusable: 'false',
    },
    h('path', { d: 'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z' }),
    h('path', { d: 'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z' }),
    h('path', { d: 'M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4' }));

    const CloseIcon = () => h('svg', {
      width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
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
    const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0);

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
     * 位置由 id 决定，同一份记忆每次打开都在同一处。
     */
    const graphOf = (records) => {
      const rows = (Array.isArray(records) ? records : EMPTY).slice(0, 60);
      const byId = new Map(rows.map((record) => [record.id, record]));
      const tagCount = new Map();
      const topicCount = new Map();
      for (const record of rows) {
        for (const tag of Array.isArray(record.tags) ? record.tags : EMPTY) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
        if (record.topicKey) topicCount.set(record.topicKey, (topicCount.get(record.topicKey) || 0) + 1);
      }
      const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
      const topics = [...topicCount.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const nodes = [];
      const edges = [];
      const degree = new Map();
      const addEdge = (from, to, type) => {
        if (!from || !to || from === to) return;
        edges.push({ from, to, type });
        degree.set(from, (degree.get(from) || 0) + 1);
        degree.set(to, (degree.get(to) || 0) + 1);
      };
      for (const record of rows) {
        nodes.push({ id: record.id, kind: 'memory', label: record.title || record.id, experimental: record.experimental === true });
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
      const memoryNodes = nodes.filter((node) => node.kind === 'memory');
      const memoryById = new Map(memoryNodes.map((node) => [node.id, node]));
      const count = memoryNodes.length;
      const spread = 0.55 + Math.min(0.45, count * 0.06);
      memoryNodes.forEach((node, index) => {
        const seed = hashOf(node.id);
        const ring = count <= 1 ? 0 : count <= 8 ? 128 : count <= 18 ? 168 : 206;
        const wobble = count <= 8 ? 1 : 0.64 + ((seed % 100) / 100) * 0.36;
        const angle = count <= 1 ? 0 : (index / count) * Math.PI * 2 - Math.PI / 2 + ((seed % 17) / 17) * 0.16;
        memoryById.set(node.id, {
          ...node,
          x: 320 + Math.cos(angle) * ring * 1.22 * wobble * spread,
          y: 236 + Math.sin(angle) * ring * 0.8 * wobble * spread,
          radius: 5.5 + Math.min(4, (degree.get(node.id) || 0) * 0.7),
        });
      });
      const hubs = nodes.filter((node) => node.kind !== 'memory');
      hubs.forEach((node, index) => {
        const angle = (index / Math.max(1, hubs.length)) * Math.PI * 2 + Math.PI / 7;
        memoryById.set(node.id, {
          ...node,
          x: 320 + Math.cos(angle) * 284 * spread,
          y: 236 + Math.sin(angle) * 198 * spread,
          radius: node.kind === 'tag' ? 4 : 5,
        });
      });
      const placed = [...memoryById.values()];
      return { nodes: placed, edges: edges.filter((edge) => memoryById.has(edge.from) && memoryById.has(edge.to)), people: count };
    };

    const MemoryGraph = (props) => {
      const graph = React.useMemo(() => graphOf(props.records), [props.records]);
      const selectedId = props.selectedId;
      if (!props.records || props.records.length === 0) {
        return h('div', {
          style: { flex: 1, minHeight: '260px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
        }, '还没有记忆');
      }
      const labelSet = graph.people <= 10;
      return h('svg', {
        viewBox: '0 0 640 472', preserveAspectRatio: 'xMidYMid meet',
        style: { width: '100%', flex: 1, minHeight: 0, display: 'block' },
        role: 'img', 'aria-label': '记忆关系图',
      },
      h('g', null, graph.edges.map((edge, index) => {
        const from = graph.nodes.find((node) => node.id === edge.from);
        const to = graph.nodes.find((node) => node.id === edge.to);
        if (!from || !to) return null;
        const linked = selectedId && (edge.from === selectedId || edge.to === selectedId);
        return h('line', {
          key: `e${index}`, x1: from.x, y1: from.y, x2: to.x, y2: to.y,
          stroke: linked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
          strokeWidth: linked ? 1.4 : 1,
          opacity: linked ? 0.65 : edge.type === 'link' ? 0.38 : 0.16,
          strokeDasharray: edge.type === 'link' ? undefined : '2 4',
        });
      })),
      h('g', null, graph.nodes.map((node) => {
        const isMemory = node.kind === 'memory';
        const active = node.id === selectedId;
        const fill = !isMemory ? 'var(--dsw-alias-label-secondary)'
          : node.experimental ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-brand-primary)';
        const showLabel = active || (isMemory && labelSet) || (!isMemory && true);
        return h('g', {
          key: node.id,
          transform: `translate(${node.x} ${node.y})`,
          onClick: () => props.onPick(node),
          style: { cursor: 'pointer' },
        },
        active ? h('circle', { r: node.radius + 5, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.4, opacity: 0.5 }) : null,
        h('circle', { r: node.radius, fill, opacity: isMemory ? 0.9 : 0.5 }),
        showLabel ? h('text', {
          y: node.radius + 12, textAnchor: 'middle',
          fill: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
          fontSize: isMemory ? 10 : 8.5, opacity: active ? 0.95 : 0.68,
        }, SHORT(node.label, isMemory ? 9 : 10)) : null,
        h('title', null, node.label),
        );
      })),
      );
    };

    const Kpi = (props) => h('div', { style: { ...PANEL_CARD, padding: '10px 11px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        h('span', { style: { width: '6px', height: '6px', borderRadius: '999px', background: props.color, opacity: 0.85 } }),
        h('span', { style: PANEL_LABEL }, props.label),
      ),
      h('div', { style: { fontSize: '23px', lineHeight: '1.25', fontWeight: 600, letterSpacing: '-0.02em' } }, String(props.value)),
    );

    const KindBars = (props) => {
      const rows = props.rows;
      const max = rows.reduce((top, row) => Math.max(top, row.count), 1);
      if (rows.length === 0) return h('div', { style: PANEL_MUTED }, '暂无记录');
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        rows.map((row, index) => h('div', { key: row.kind, style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '6px' } },
            h('span', { style: { fontSize: '11px', opacity: 0.78 } }, KIND_LABEL[row.kind] || row.kind),
            h('span', { style: { ...PANEL_MUTED, fontVariantNumeric: 'tabular-nums' } }, String(row.count)),
          ),
          h('div', { style: { height: '3px', borderRadius: '999px', background: 'var(--dsw-alias-border-l1)', overflow: 'hidden' } },
            h('div', { style: { width: `${Math.max(4, pct(row.count, max))}%`, height: '100%', borderRadius: '999px', background: 'var(--dsw-alias-brand-primary)', opacity: Math.max(0.35, 0.9 - index * 0.1) } }),
          ),
        )),
      );
    };

    const Toggle = (props) => h('button', {
      type: 'button', role: 'switch', 'aria-checked': props.on === true, 'aria-label': '自进化',
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
        transition: 'left 120ms ease',
      },
    }));

    const MemoryRow = (props) => {
      const record = props.record;
      return h('button', {
        type: 'button', onClick: props.onClick,
        style: {
          display: 'flex', flexDirection: 'column', gap: '2px', width: '100%', textAlign: 'left',
          border: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)',
          background: props.active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: 'inherit', padding: '8px 7px', cursor: 'pointer', minWidth: 0,
        },
      },
      h('span', { style: { fontSize: '12px', lineHeight: '1.45', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.92 } }, record.title || record.id),
      h('span', { style: { ...PANEL_MUTED, display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 } },
        h('span', null, KIND_LABEL[record.kind] || record.kind),
        record.experimental ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '实验') : null,
        h('span', { style: { marginLeft: 'auto', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, EVO_DATE(record.updated)),
      ),
      );
    };

    const RuleDetail = (props) => {
      const rule = props.rule;
      const ruleId = rule ? rule.id : '';
      const [confirming, setConfirming] = React.useState(false);
      React.useEffect(() => { setConfirming(false); }, [ruleId]);
      if (!rule) return null;
      const checkpoints = Array.isArray(rule.checkpoints) ? rule.checkpoints : EMPTY;
      const samples = Array.isArray(rule.samples) ? rule.samples : EMPTY;
      const conditions = Array.isArray(rule.conditions) ? rule.conditions : EMPTY;
      const scopeLine = rule.applicability === 'conditional' || conditions.length > 0
        ? (conditions.length
          ? `适用 ${conditions.map((item) => `${CONDITION_LABEL[item.key] || item.key} ${item.value}`).join('、')}`
          : '条件未定')
        : '所有项目';
      const actions = props.onManage
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', paddingTop: '2px' } },
          Array.isArray(rule.learning?.versions) && rule.learning.versions.length > 0
            ? h('button', { type: 'button', onClick: () => props.onManage('undo'), style: PANEL_LINK }, '撤回') : null,
          h('button', { type: 'button', onClick: () => props.onManage('pin'), style: PANEL_LINK }, rule.learning?.pinned === true ? '取消固定' : '固定'),
          rule.state === 'paused'
            ? h('button', { type: 'button', onClick: () => props.onManage('resume'), style: PANEL_LINK }, '恢复')
            : h('button', { type: 'button', onClick: () => props.onManage('pause'), style: PANEL_LINK }, '暂停'),
          confirming
            ? h(React.Fragment, null,
              h('button', { type: 'button', onClick: () => props.onManage('delete'), style: { ...PANEL_LINK, color: 'var(--dsw-alias-state-error-primary)' } }, '确认删除'),
              h('button', { type: 'button', onClick: () => setConfirming(false), style: PANEL_LINK }, '取消'))
            : h('button', { type: 'button', onClick: () => setConfirming(true), style: PANEL_LINK }, '删除'),
        )
        : h('div', { style: { ...PANEL_MUTED, paddingTop: '2px' } }, '只读');
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
        h('div', { style: { fontSize: '12px', lineHeight: '1.45', fontWeight: 600 } }, rule.title),
        h('div', { style: PANEL_MUTED }, EVO_STATE[rule.state] || rule.state),
        h('div', { style: PANEL_MUTED }, scopeLine),
        h('div', { style: { fontSize: '12px', lineHeight: '1.65', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '150px', overflowY: 'auto', opacity: 0.88 } }, rule.body || '没有正文'),
        h('div', { style: PANEL_MUTED }, `来源 ${Array.isArray(rule.learning?.evidence) ? rule.learning.evidence.length : 0} 条`),
        checkpoints.length ? h('div', { style: PANEL_MUTED }, `检查点：${checkpoints[0].text}`) : null,
        samples.length ? h('div', { style: PANEL_MUTED }, `样例 ${samples.length} 项 · 未验证`) : null,
        actions,
      );
    };

    const MemoryPanel = (props) => {
      const sessionId = props.sessionId;
      const [data, setData] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [note, setNote] = React.useState('');
      const [query, setQuery] = React.useState('');
      const [tab, setTab] = React.useState('memory');
      const [selectedMemory, setSelectedMemory] = React.useState('');
      const [selectedRule, setSelectedRule] = React.useState('');
      const [detail, setDetail] = React.useState(null);
      const [detailNote, setDetailNote] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const alive = React.useRef(true);
      React.useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      const load = (scopeKey = '') => {
        setLoading(true);
        setNote('');
        post('/lite-memory/overview', { sessionId, scopeKey }).then((result) => {
          if (!alive.current) return;
          setLoading(false);
          if (result.ok && result.body && result.body.ok) {
            const next = result.body;
            if (!data || !data.selected || next.selected.key !== data.selected.key) setQuery('');
            setData(next);
            setSelectedMemory('');
            setSelectedRule('');
            setDetail(null);
            setDetailNote('');
          } else {
            setNote(failure(result, '读不到记忆'));
          }
        });
      };

      React.useEffect(() => { load(); }, [sessionId]);

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
        if (!selectedMemory || !data) { setDetail(null); setDetailNote(''); return undefined; }
        let live = true;
        setDetail(null);
        setDetailNote('');
        post('/lite-memory/body', { sessionId, id: selectedMemory, scopeKey: data.selected.key }).then((result) => {
          if (!live) return;
          if (result.ok && result.body && result.body.ok) {
            if (result.body.status === 'gone') setDetailNote('这条记忆已删除');
            else setDetail(result.body);
          } else setDetailNote(failure(result, '读不到正文'));
        });
        return () => { live = false; };
      }, [selectedMemory, data && data.selected.key, sessionId]);

      if (!sessionId) return null;
      const current = data ? data.current : null;
      const selected = data ? data.selected : null;
      const records = selected && Array.isArray(selected.records) ? selected.records : EMPTY;
      const archived = selected && Array.isArray(selected.archived) ? selected.archived : EMPTY;
      const stats = selected && selected.stats ? selected.stats : { total: 0, experimental: 0, links: 0, tags: 0, archived: 0 };
      const currentKey = current ? current.key : '';
      const selectedKey = selected ? selected.key : '';
      const control = selected && selected.control ? selected.control : (current && current.control ? current.control : { enabled: true });
      const memoryOn = control.enabled !== false;
      const evolution = selected && selected.evolution ? selected.evolution : (current ? current.evolution : null);
      const rules = evolution && Array.isArray(evolution.rules) ? evolution.rules : EMPTY;
      const economy = evolution && evolution.economy ? evolution.economy : null;
      const usageLine = economy && economy.calls > 0
        ? (economy.knownCalls > 0 ? `整理 ${economy.calls} 次 · 输入 ${economy.inputTokens} / 输出 ${economy.outputTokens}` : `整理 ${economy.calls} 次 · 用量未知`)
        : '';
      const canToggle = Boolean(selectedKey) && selectedKey === currentKey;
      const filtered = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return records;
        return records.filter((record) =>
          `${record.title} ${record.summary} ${(record.tags || []).join(' ')} ${KIND_LABEL[record.kind] || ''}`.toLowerCase().includes(needle));
      }, [records, query]);
      const kinds = React.useMemo(() => {
        const counts = new Map();
        for (const record of records) counts.set(record.kind, (counts.get(record.kind) || 0) + 1);
        return [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
      }, [records]);
      const graph = React.useMemo(() => graphOf(records), [records]);
      const selectedRuleRow = selectedRule ? rules.find((rule) => rule.id === selectedRule) : null;
      const detailRecord = selectedMemory
        ? records.find((record) => record.id === selectedMemory) || archived.find((record) => record.id === selectedMemory)
        : null;

      const manage = (learningAction) => {
        if (busy || !selectedRuleRow || !canToggle) return;
        setBusy(true);
        post('/lite-memory/evolution', {
          sessionId,
          learningAction,
          id: selectedRuleRow.id,
          expectedRevision: selectedRuleRow.revision,
          operationId: newOperationId(),
          ...(learningAction === 'pause' ? { ids: [selectedRuleRow.id] } : {}),
          ...(learningAction === 'pin' ? { pinned: selectedRuleRow.learning?.pinned !== true } : {}),
        }).then((result) => {
          if (!alive.current) return;
          setBusy(false);
          if (result.ok) {
            setSelectedRule('');
            load(selectedKey);
          } else setNote(failure(result, '这次没有改动'));
        });
      };

      const toggleControl = () => {
        if (busy || !canToggle) return;
        setBusy(true);
        post('/lite-memory/control', { sessionId, enabled: !memoryOn, operationId: newOperationId() }).then((result) => {
          if (!alive.current) return;
          setBusy(false);
          if (result.ok) load(selectedKey);
          else setNote(failure(result, '开关没有改动'));
        });
      };

      const toggle = () => {
        if (busy || !evolution || !canToggle || !memoryOn) return;
        setBusy(true);
        post('/lite-memory/evolution', { sessionId, enabled: !(evolution.enabled === true), operationId: newOperationId() }).then((result) => {
          if (!alive.current) return;
          setBusy(false);
          if (result.ok) load(selectedKey);
          else setNote(failure(result, '开关没有改动'));
        });
      };

      const onPickNode = (node) => {
        if (node.kind === 'memory') {
          setSelectedMemory(node.id);
          setSelectedRule('');
          setTab('memory');
        } else {
          setQuery(node.label.replace(/^#/, ''));
          setTab('memory');
        }
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
        h('span', { style: { ...PANEL_MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, selected ? `${selected.label} · ${stats.total} 条` : '读取中…'),
      ),
      h('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' } },
        h('select', {
          value: selectedKey,
          onChange: (event) => load(event.target.value),
          'aria-label': '记忆范围',
          disabled: loading || !data,
          style: { height: '30px', maxWidth: '190px', padding: '0 8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit', fontSize: '12px' },
        },
        data ? data.scopes.map((scope) => h('option', { key: scope.key, value: scope.key }, scope.kind === 'global' ? '全局' : scope.label)) : null),
        closeButton,
      ),
      );

      const kpis = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '10px' } },
        h(Kpi, { label: '记忆', value: stats.total, color: 'var(--dsw-alias-brand-primary)' }),
        h(Kpi, { label: '关联', value: stats.links, color: 'var(--dsw-alias-state-success-primary)' }),
        h(Kpi, { label: '实验', value: stats.experimental, color: 'var(--dsw-alias-state-warn-primary)' }),
        h(Kpi, { label: '归档', value: stats.archived, color: 'var(--dsw-alias-label-secondary)' }),
      );

      const leftRail = h('aside', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px', borderRight: '1px solid var(--dsw-alias-border-l1)', overflowY: 'auto', minWidth: 0 } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', padding: '2px 2px 4px' } },
          h('span', { style: PANEL_LABEL }, '当前范围'),
          h('span', { style: { fontSize: '13px', lineHeight: '1.4', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, selected ? selected.label : '—'),
          selected && selected.kind === 'project' ? h('span', { style: PANEL_MUTED }, selected.key === currentKey ? '当前项目' : '其他项目') : h('span', { style: PANEL_MUTED }, '跨项目共享'),
        ),
        h('div', { style: { ...PANEL_CARD, display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
            h('span', { style: { fontSize: '12px', lineHeight: '1.4', fontWeight: 600 } }, '项目记忆'),
            h(Toggle, { on: memoryOn, busy: busy || !canToggle, onClick: canToggle ? toggleControl : undefined }),
          ),
          h('div', { style: PANEL_MUTED }, memoryOn ? '已开启 · 本项目与全局可用' : '已关闭 · 本项目不使用任何记忆'),
          canToggle ? null : h('div', { style: PANEL_MUTED }, '只读 · 回到当前项目才能改'),
        ),
        h('div', { style: { ...PANEL_CARD, display: 'flex', flexDirection: 'column', gap: '8px', opacity: memoryOn ? 1 : 0.55 } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
            h('span', { style: { fontSize: '12px', lineHeight: '1.4', fontWeight: 600 } }, '自进化'),
            h(Toggle, { on: evolution ? evolution.enabled === true : false, busy: busy || !evolution || !canToggle || !memoryOn, onClick: canToggle && memoryOn ? toggle : undefined }),
          ),
          h('div', { style: PANEL_MUTED }, !memoryOn ? '随项目记忆暂停' : evolution ? (evolution.enabled ? `已开启 · ${rules.length} 条规则` : '未开启') : '未开启'),
          memoryOn && evolution && evolution.enabled
            ? h('div', { style: PANEL_MUTED }, `候选 ${evolution.counts?.pending || 0} · 试用 ${evolution.counts?.trial || 0} · 生效 ${evolution.counts?.active || 0}`)
            : (memoryOn && canToggle ? h('div', { style: PANEL_MUTED }, '关闭后停止整理，结果保留。') : null),
          memoryOn && usageLine ? h('div', { style: PANEL_MUTED }, usageLine) : null,
          canToggle ? null : h('div', { style: PANEL_MUTED }, '只读 · 回到当前项目才能改'),
        ),
        h('div', { style: { ...PANEL_CARD, display: 'flex', flexDirection: 'column', gap: '9px' } },
          h('div', { style: { fontSize: '12px', lineHeight: '1.4', fontWeight: 600 } }, '记忆类型'),
          h(KindBars, { rows: kinds }),
        ),
        note ? h('div', { style: { ...PANEL_MUTED, color: 'var(--dsw-alias-state-error-primary)' } }, note) : null,
      );

      const center = h('main', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px', minWidth: 0, minHeight: 0, overflow: 'hidden' } },
        kpis,
        h('div', { style: { ...PANEL_CARD, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 12px 8px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
            h('span', { style: { fontSize: '12px', lineHeight: '1.4', fontWeight: 600 } }, '记忆图谱'),
            h('span', { style: PANEL_MUTED }, `${stats.total} 条记忆 · ${graph.edges.length} 条连线`),
          ),
          loading
            ? h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' } }, '读取中…')
            : h(MemoryGraph, { records, selectedId: selectedMemory, onPick: onPickNode }),
          h('div', { style: { ...PANEL_MUTED, display: 'flex', gap: '12px' } },
            h('span', null, '— 显式关联'),
            h('span', null, '╌ 标签与主题'),
            h('span', { style: { marginLeft: 'auto' } }, '点击节点查看'),
          ),
        ),
      );

      const list = tab === 'memory'
        ? (filtered.length === 0
          ? h('div', { style: { ...PANEL_MUTED, padding: '12px 4px' } }, query ? '没有匹配的记忆' : '还没有记忆')
          : filtered.map((record) => h(MemoryRow, {
            key: record.id, record, active: record.id === selectedMemory,
            onClick: () => { setSelectedMemory(record.id); setSelectedRule(''); },
          })))
        : tab === 'rules'
          ? (rules.length === 0
            ? h('div', { style: { ...PANEL_MUTED, padding: '12px 4px' } }, evolution && evolution.enabled ? '还没有整理出规则' : '自进化未开启')
            : rules.map((rule) => h('button', {
              key: rule.id, type: 'button', onClick: () => { setSelectedRule(rule.id); setSelectedMemory(''); },
              style: {
                display: 'flex', flexDirection: 'column', gap: '2px', width: '100%', textAlign: 'left',
                border: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)',
                background: rule.id === selectedRule ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                color: 'inherit', padding: '8px 7px', cursor: 'pointer', minWidth: 0,
              },
            },
            h('span', { style: { fontSize: '12px', lineHeight: '1.45', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.92 } }, rule.title),
            h('span', { style: { ...PANEL_MUTED, display: 'flex', gap: '5px' } },
              h('span', null, EVO_STATE[rule.state] || rule.state),
            ))))
          : (archived.length === 0
            ? h('div', { style: { ...PANEL_MUTED, padding: '12px 4px' } }, '没有归档')
            : archived.map((record) => h('button', {
              key: record.id, type: 'button',
              onClick: () => { setSelectedMemory(record.id); setSelectedRule(''); },
              style: {
                display: 'flex', flexDirection: 'column', gap: '2px', width: '100%', textAlign: 'left',
                border: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)',
                background: record.id === selectedMemory ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                color: 'inherit', padding: '8px 7px', cursor: 'pointer', minWidth: 0,
              },
            },
            h('span', { style: { fontSize: '12px', lineHeight: '1.45', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.78 } }, record.title || record.id),
            h('span', { style: { ...PANEL_MUTED, display: 'flex', gap: '5px' } },
              h('span', null, '已归档'),
              h('span', { style: { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' } }, EVO_DATE(record.updated)),
            ))));

      const detailPane = selectedMemory
        ? h('div', { style: { ...PANEL_CARD, maxHeight: '46%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '5px' } },
          detail
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
              h('div', { style: { fontSize: '12px', lineHeight: '1.45', fontWeight: 600 } }, detail.title),
              h('div', { style: PANEL_MUTED }, `${detail.status === 'archived' ? '已归档' : (KIND_LABEL[detailRecord?.kind] || '记忆')} · ${detail.scopeLabel || ''}`),
              Array.isArray(detailRecord?.tags) && detailRecord.tags.length
                ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
                  detailRecord.tags.slice(0, 6).map((tag) => h('span', { key: tag, style: { ...PANEL_MUTED, padding: '0 6px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '999px' } }, `#${tag}`))) : null,
              h('div', { style: { fontSize: '12px', lineHeight: '1.65', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, detail.body || '没有正文'),
            )
            : h('div', { style: PANEL_MUTED }, detailNote || '读取中…'),
        )
        : selectedRuleRow
          ? h('div', { style: { ...PANEL_CARD, maxHeight: '46%', overflowY: 'auto' } },
            h(RuleDetail, { key: selectedRuleRow.id, rule: selectedRuleRow, onManage: canToggle ? manage : null }))
          : null;

      const tabButton = (key, text) => h('button', {
        type: 'button', onClick: () => setTab(key),
        style: {
          ...PANEL_LINK, flex: 1, height: '28px', borderRadius: '7px',
          background: tab === key ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          opacity: tab === key ? 0.95 : 0.55,
          border: tab === key ? '1px solid var(--dsw-alias-border-l1)' : '1px solid transparent',
          fontVariantNumeric: 'tabular-nums',
        },
      }, text);

      const rightRail = h('section', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, padding: '14px', gap: '9px', borderLeft: '1px solid var(--dsw-alias-border-l1)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' } },
          tabButton('memory', `记忆 ${stats.total}`),
          tabButton('rules', `规则 ${rules.length}`),
          tabButton('archive', `归档 ${stats.archived}`),
        ),
        tab === 'memory'
          ? h('input', {
            value: query, onChange: (event) => setQuery(event.target.value),
            placeholder: '搜索标题或标签', 'aria-label': '搜索记忆', style: { ...PANEL_INPUT, flex: '0 0 auto' },
          }) : null,
        h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', borderTop: '1px solid var(--dsw-alias-border-l1)' } }, list),
        detailPane,
      );

      if (!data) {
        return h('div', {
          style: PANEL_BACKDROP,
          onClick: (event) => { if (event.target === event.currentTarget) props.onClose(); },
        },
        h('div', {
          role: 'dialog', 'aria-modal': 'true', 'aria-label': '记忆面板',
          style: { ...PANEL_DIALOG, boxSizing: 'border-box' },
        }, header, h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' } }, loading ? '读取中…' : (note || '没有数据'))));
      }

      return h('div', {
        style: PANEL_BACKDROP,
        onClick: (event) => { if (event.target === event.currentTarget) props.onClose(); },
      },
      h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': '记忆面板',
        style: { ...PANEL_DIALOG, boxSizing: 'border-box' },
      },
      header,
      h('div', { style: { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '224px minmax(0, 1fr) 330px' } },
        leftRail,
        center,
        rightRail,
      )));
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
          reference: list.filter((item) => item.exposure === 'reference'),
          update: list.filter((item) => item.exposure === 'update'),
        };
      }, [refs]);
      if (!sessionId && refs.length === 0) return null;
      if (groups.reference.length === 0 && groups.update.length === 0) return null;
      return h('div', { style: TAIL },
        h(RefSection, { label: '本轮参考', items: groups.reference, sessionId, turnKey: turn }),
        h(RefSection, { label: '本轮更新', items: groups.update, sessionId, turnKey: turn }),
      );
    };

    const sourceCache = new Map();

    // 测试缝：Node 里验引用投影，浏览器里没有任何副作用。
    if (typeof globalThis.__LITE_MEMORY_TEST__ === 'function') {
      globalThis.__LITE_MEMORY_TEST__({ metaOf, citationOf, citationsOfMeta, citationsOfTurn, dedupe, undoRefOf, graphOf });
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
