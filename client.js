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

    /** 真成功要 HTTP 与响应体同时确认；2xx 但 ok:false 仍按失败显示。 */
    const succeeded = (result) => Boolean(result && result.ok && result.body && result.body.ok === true);

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

    /** 同轮同 id 同用途去重：位置取首次，内容取最后。 */
    const dedupe = (items) => {
      const seen = new Map();
      const out = [];
      for (const item of items) {
        const key = `${item.scope}:${item.id}:${item.exposure}`;
        const at = seen.get(key);
        if (at === undefined) {
          seen.set(key, out.length);
          out.push(item);
        } else {
          out[at] = item;
        }
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
    /** 位置由 id 决定；同一份数据每次打开都在同一处。 */
    const layoutGraph = (nodes, edges, primaryKind) => {
      const degree = new Map();
      for (const edge of edges) {
        degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
        degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
      }
      const placed = new Map();
      const primaries = nodes.filter((node) => node.kind === primaryKind);
      const count = primaries.length;
      const spread = 0.55 + Math.min(0.45, count * 0.06);
      primaries.forEach((node, index) => {
        const seed = hashOf(node.id);
        const ring = count <= 1 ? 0 : count <= 8 ? 128 : count <= 18 ? 168 : 206;
        const wobble = count <= 8 ? 1 : 0.64 + ((seed % 100) / 100) * 0.36;
        const angle = count <= 1 ? 0 : (index / count) * Math.PI * 2 - Math.PI / 2 + ((seed % 17) / 17) * 0.16;
        placed.set(node.id, {
          ...node,
          x: 320 + Math.cos(angle) * ring * 1.22 * wobble * spread,
          y: 236 + Math.sin(angle) * ring * 0.8 * wobble * spread,
          radius: 5.5 + Math.min(4, (degree.get(node.id) || 0) * 0.7),
        });
      });
      const hubs = nodes.filter((node) => node.kind !== primaryKind);
      const kindOf = new Map(nodes.map((node) => [node.id, node.kind]));
      const linkedOf = new Map(hubs.map((node) => [node.id, new Set()]));
      for (const edge of edges) {
        if (linkedOf.has(edge.from) && kindOf.get(edge.to) === primaryKind) linkedOf.get(edge.from).add(edge.to);
        if (linkedOf.has(edge.to) && kindOf.get(edge.from) === primaryKind) linkedOf.get(edge.to).add(edge.from);
      }
      const groups = new Map();
      for (const node of hubs) {
        const linked = [...linkedOf.get(node.id)].sort();
        const key = linked.length > 0 ? linked.join('|') : `solo:${node.id}`;
        if (!groups.has(key)) groups.set(key, { linked, hubs: [] });
        groups.get(key).hubs.push(node);
      }
      for (const group of groups.values()) {
        const points = group.linked.map((id) => placed.get(id)).filter(Boolean);
        const cx = points.length > 0 ? points.reduce((sum, point) => sum + point.x, 0) / points.length : 320;
        const cy = points.length > 0 ? points.reduce((sum, point) => sum + point.y, 0) / points.length : 236;
        const outward = Math.hypot(cx - 320, cy - 236);
        group.hubs.forEach((node, index) => {
          const seed = hashOf(node.id);
          const base = outward > 12
            ? Math.atan2(cy - 236, cx - 320)
            : ((seed % 360) / 180) * Math.PI;
          const angle = base + (index - (group.hubs.length - 1) / 2) * 0.6;
          const distance = group.linked.length >= 3 && group.hubs.length === 1 ? 0 : 48 + group.hubs.length * 4;
          placed.set(node.id, {
            ...node,
            x: cx + Math.cos(angle) * distance,
            y: cy + Math.sin(angle) * distance * 0.82,
            radius: node.kind === 'topic' ? 5 : 4,
          });
        });
      }
      return {
        nodes: [...placed.values()],
        edges: edges.filter((edge) => placed.has(edge.from) && placed.has(edge.to)),
        people: count,
      };
    };

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
      const addEdge = (from, to, type) => {
        if (!from || !to || from === to) return;
        edges.push({ from, to, type });
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
      return layoutGraph(nodes, edges, 'memory');
    };

    /** 经验图谱只连共享条件。 */
    const ruleGraphOf = (rules) => {
      const rows = (Array.isArray(rules) ? rules : EMPTY).slice(0, 60);
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
      return layoutGraph(nodes, edges, 'rule');
    };

    /** 关系图只画真实关系；节点沿用原始 id，位置由 id 决定。 */
    const MemoryGraph = (props) => {
      const primaryKind = props.primaryKind || 'memory';
      const graph = React.useMemo(() => (props.graphOf || graphOf)(props.records), [props.records, props.graphOf]);
      const [zoom, setZoom] = React.useState(1);
      const selectedId = props.selectedId;
      const labelSet = graph.people <= 10;
      const stepZoom = (delta) => setZoom((value) => Math.min(2.5, Math.max(0.75, Math.round((value + delta) * 100) / 100)));
      const frame = React.useMemo(() => {
        const list = graph.nodes;
        if (list.length === 0) return { x: 0, y: 0, width: 640, height: 472 };
        let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
        for (const node of list) {
          const half = node.kind === primaryKind ? 62 : 38;
          minX = Math.min(minX, node.x - half);
          maxX = Math.max(maxX, node.x + half);
          minY = Math.min(minY, node.y - 16);
          maxY = Math.max(maxY, node.y + (node.kind === primaryKind ? 28 : 24));
        }
        const width = Math.max(380, maxX - minX + 36);
        const height = Math.max(250, maxY - minY + 36);
        return { x: (minX + maxX) / 2 - width / 2, y: (minY + maxY) / 2 - height / 2, width, height };
      }, [graph, primaryKind]);
      if (!props.records || props.records.length === 0) {
        return h('div', {
          style: { flex: 1, minHeight: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
        }, props.emptyText || '还没有记忆');
      }
      const viewWidth = frame.width / zoom;
      const viewHeight = frame.height / zoom;
      const zoomButton = (label, delta, icon) => h('button', {
        type: 'button', onClick: () => stepZoom(delta),
        disabled: delta > 0 ? zoom >= 2.5 : zoom <= 0.75,
        'aria-label': label, title: label,
        style: {
          width: '26px', height: '26px', padding: 0, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', border: 'none',
          borderRadius: '6px', background: 'transparent', color: 'inherit',
          opacity: delta > 0 ? (zoom >= 2.5 ? 0.28 : 0.68) : (zoom <= 0.75 ? 0.28 : 0.68),
          cursor: 'pointer',
        },
      }, icon);
      const magnifier = (sign) => h('svg', {
        width: '15', height: '15', viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round',
        'aria-hidden': 'true',
      },
      h('circle', { cx: '6.8', cy: '6.8', r: '4.5' }),
      h('line', { x1: '10.1', y1: '10.1', x2: '14', y2: '14' }),
      h('line', { x1: '4.8', y1: '6.8', x2: '8.8', y2: '6.8' }),
      sign > 0 ? h('line', { x1: '6.8', y1: '4.8', x2: '6.8', y2: '8.8' }) : null);
      return h('div', { style: { position: 'relative', flex: 1, minHeight: 0, display: 'flex' } },
        h('div', {
          style: {
            position: 'absolute', top: '6px', right: '6px', zIndex: 2,
            display: 'flex', alignItems: 'center', gap: '1px', padding: '2px',
            border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        },
        zoomButton('缩小图谱', -0.25, magnifier(-1)),
        zoomButton('放大图谱', 0.25, magnifier(1))),
        h('svg', {
          viewBox: `${frame.x + frame.width / 2 - viewWidth / 2} ${frame.y + frame.height / 2 - viewHeight / 2} ${viewWidth} ${viewHeight}`,
          preserveAspectRatio: 'xMidYMid meet',
          style: { width: '100%', height: '100%', flex: 1, minHeight: 0, display: 'block' },
          role: 'img', 'aria-label': props.ariaLabel || '关系图',
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
          const isPrimary = node.kind === primaryKind;
          const active = node.id === selectedId;
          const fill = !isPrimary ? 'var(--dsw-alias-label-secondary)'
            : node.state ? (STAGE_TONE[node.state] || 'var(--dsw-alias-brand-primary)')
              : node.experimental ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-brand-primary)';
          const showLabel = active || (isPrimary && labelSet) || !isPrimary;
          return h('g', {
            key: node.id,
            transform: `translate(${node.x} ${node.y})`,
            onClick: isPrimary ? () => props.onPick(node) : undefined,
            style: { cursor: isPrimary ? 'pointer' : 'default' },
          },
          active ? h('circle', { r: node.radius + 5, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.4, opacity: 0.5 }) : null,
          h('circle', { r: node.radius, fill, opacity: isPrimary ? 0.9 : 0.5 }),
          showLabel ? h('text', {
            y: node.radius + 12, textAnchor: 'middle',
            fill: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            fontSize: isPrimary ? 10 : 8.5, opacity: active ? 0.95 : 0.68,
          }, SHORT(node.label, isPrimary ? 9 : 10)) : null,
          h('title', null, node.title || node.label),
          );
        }))),
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
        transition: 'left 120ms ease',
      },
    }));

    const STAGE = { pending: '候选', trial: '试用', active: '生效', paused: '暂停' };
    const STAGE_TONE = {
      pending: 'var(--dsw-alias-state-warn-primary)',
      trial: 'var(--dsw-alias-brand-primary)',
      active: 'var(--dsw-alias-state-success-primary)',
      paused: 'var(--dsw-alias-label-secondary)',
    };
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
      return typeof row.text === 'string' ? row.text : (typeof row.note === 'string' ? row.note : '');
    };

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
        ...versions.map((row) => ({ at: row.at || row.updated || '', text: typeof row.title === 'string' ? row.title : '修改' })),
      ].filter((row) => row.text).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
      const canManage = props.canManage && !props.busy;
      const act = (name, extra) => { if (canManage) props.onManage(name, extra || {}); };
      const actions = props.canManage
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', paddingTop: '3px' } },
          rule.state === 'pending' || rule.state === 'trial'
            ? h(Action, { disabled: !canManage, onClick: () => act('adopt') }, '采纳') : null,
          rule.state === 'paused'
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
              ...evidence.slice(0, 3).map((row, index) => h('div', { key: `e${index}` }, evidenceTextOf(row))),
              ...samples.slice(0, 2).map((row, index) => h('div', { key: `s${index}` }, evidenceTextOf(row) || '样例')),
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
            h(StagePill, { state: rule.state }),
          ),
          h('div', { style: { fontSize: '12px', lineHeight: '1.55', opacity: 0.82 } }, usabilityOf(rule, props.evolution, props.memoryOn)),
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
      const [busy, setBusy] = React.useState(false);
      const [showReason, setShowReason] = React.useState(false);
      const alive = React.useRef(true);
      const generation = React.useRef(0);
      const scopeRef = React.useRef('');
      React.useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      const load = (scopeKey = '', focusRule = '') => {
        const request = generation.current + 1;
        generation.current = request;
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
          } else {
            setFailed(true);
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

      const current = data ? data.current : null;
      const selected = data ? data.selected : null;
      const records = selected && Array.isArray(selected.records) ? selected.records : EMPTY;
      const total = selected && selected.stats && Number.isInteger(selected.stats.total) ? selected.stats.total : records.length;
      const currentKey = current ? current.key : '';
      const selectedKey = selected ? selected.key : '';
      const control = selected && selected.control
        ? selected.control
        : (current && selected && selected.key === current.key && current.control ? current.control : { enabled: true });
      const memoryOn = control.enabled !== false;
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
        activityText = '本轮整理额度已用完';
      } else if (activityCode === 'failed' || activityCode === 'error') {
        activityText = '最近整理失败，可查看原因';
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
      const activityReason = activity && typeof activity === 'object' && typeof activity.reason === 'string'
        ? activity.reason
        : (latestReceipt && typeof latestReceipt.reason === 'string' ? latestReceipt.reason : '');

      const filtered = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return records;
        return records.filter((record) => {
          const tags = Array.isArray(record.tags) ? record.tags.join(' ') : '';
          return `${record.title} ${record.summary} ${tags} ${KIND_LABEL[record.kind] || ''}`.toLowerCase().includes(needle);
        });
      }, [records, query]);
      const filteredRules = React.useMemo(() => {
        if (stage === 'all') return rules;
        return rules.filter((rule) => rule.state === stage);
      }, [rules, stage]);
      const selectedRuleRow = selectedRule ? rules.find((rule) => rule.id === selectedRule) : null;
      const detailRecord = selectedMemory ? records.find((record) => record.id === selectedMemory) : null;

      const onPickNode = (node) => {
        if (node.kind !== 'memory') return;
        setSelectedMemory(node.id);
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
          if (!alive.current) return;
          setBusy(false);
          if (succeeded(result)) load(selectedKey, selectedRuleRow.id);
          else setNote(failure(result, '这次没有改动'));
        });
      };

      const toggleControl = () => {
        if (busy || !canToggle) return;
        setBusy(true);
        post('/lite-memory/control', { sessionId, enabled: !memoryOn, operationId: newOperationId() }).then((result) => {
          if (!alive.current) return;
          setBusy(false);
          if (succeeded(result)) load(selectedKey);
          else setNote(failure(result, '开关没有改动'));
        });
      };

      const toggleEvolution = () => {
        if (busy || !evolution || !canToggle || !memoryOn) return;
        setBusy(true);
        post('/lite-memory/evolution', { sessionId, enabled: evolution.enabled !== true, operationId: newOperationId() }).then((result) => {
          if (!alive.current) return;
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
        closeButton,
      ),
      );

      const memorySwitch = h('div', { style: { ...PANEL_CARD, flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '4px', padding: '9px 11px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
          h('span', { style: { fontSize: '12px', lineHeight: '1.4', fontWeight: 600 } }, '启用记忆'),
          h(Toggle, { ariaLabel: '启用记忆', on: memoryOn, busy: busy || !canToggle, onClick: canToggle ? toggleControl : undefined }),
        ),
        h('div', { style: PANEL_MUTED }, '读取项目和全局记忆'), // ui-copy-ignore 用户指定文案
      );
      const evolutionSwitch = h('div', { style: { ...PANEL_CARD, flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '4px', padding: '9px 11px', opacity: memoryOn ? 1 : 0.55 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
          h('span', { style: { fontSize: '12px', lineHeight: '1.4', fontWeight: 600 } }, '自进化'),
          h(Toggle, { ariaLabel: '自进化', on: Boolean(memoryOn && evolution && evolution.enabled === true), busy: busy || !evolution || !canToggle || !memoryOn, onClick: canToggle && memoryOn ? toggleEvolution : undefined }),
        ),
        h('div', { style: PANEL_MUTED }, '从反馈中整理经验，按需使用'), // ui-copy-ignore 用户指定文案
        h('div', { style: PANEL_MUTED }, '实验功能，会增加 token 消耗'), // ui-copy-ignore 用户指定文案
      );
      const switchBar = h('div', { style: { display: 'flex', alignItems: 'stretch', gap: '10px', flexWrap: 'wrap', padding: '12px 18px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flex: '0 0 auto' } },
        globalView ? h('div', { style: { ...PANEL_MUTED, padding: '2px 0' } }, '全局记忆只读') : memorySwitch,
        globalView ? null : evolutionSwitch,
        !memoryOn && !globalView ? h('div', { style: { ...PANEL_MUTED, flexBasis: '100%' } }, '记忆已关闭，内容只读') : null,
        !globalView && !canToggle ? h('div', { style: { ...PANEL_MUTED, flexBasis: '100%' } }, '只读，切换回当前项目后可修改') : null,
        note ? h('div', { style: { ...PANEL_MUTED, flexBasis: '100%', color: 'var(--dsw-alias-state-error-primary)' } }, note) : null,
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

      const memoryList = loading
        ? h('div', { style: { ...PANEL_MUTED, padding: '12px 4px' } }, '读取中…')
        : filtered.length === 0
          ? h('div', { style: { ...PANEL_MUTED, padding: '12px 4px' } }, query ? '没有匹配的记忆' : '还没有记忆')
          : filtered.map((record) => h(MemoryRow, {
            key: record.id, record, active: record.id === selectedMemory,
            onClick: () => { setSelectedMemory(record.id); setSelectedRule(''); },
          }));

      const memoryDetail = selectedMemory
        ? h('div', { style: { ...PANEL_CARD, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' } },
          detail
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '8px' } },
                h('div', { style: { flex: 1, minWidth: 0, fontSize: '13px', lineHeight: '1.45', fontWeight: 600, wordBreak: 'break-word' } }, detail.title),
                h(Action, { onClick: () => setSelectedMemory('') }, '关闭'),
              ),
              h('div', { style: PANEL_MUTED }, `${KIND_LABEL[detailRecord && detailRecord.kind] || '记忆'} · ${detail.scopeLabel || ''}`),
              Array.isArray(detailRecord && detailRecord.tags) && detailRecord.tags.length
                ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
                  detailRecord.tags.slice(0, 6).map((tag) => h('span', { key: tag, style: { ...PANEL_MUTED, padding: '0 6px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '999px' } }, `#${tag}`))) : null,
              h('div', { style: { fontSize: '12px', lineHeight: '1.65', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, detail.body || '没有正文'),
            )
            : h('div', { style: PANEL_MUTED }, detailNote || '读取中…'),
        )
        : null;

      const viewToggleOf = (current, setValue, ariaLabel) => {
        const button = (key, label) => h('button', {
          key, type: 'button', onClick: () => setValue(key),
          'aria-pressed': current === key,
          style: {
            ...PANEL_LINK, height: '24px', padding: '0 7px', borderRadius: '6px',
            background: current === key ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            opacity: current === key ? 0.9 : 0.5,
          },
        }, label);
        return h('div', {
          role: 'group', 'aria-label': ariaLabel,
          style: {
            display: 'flex', alignItems: 'center', gap: '2px', flex: '0 0 auto',
            height: '30px', padding: '2px', boxSizing: 'border-box',
            border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
            background: 'var(--dsw-alias-bg-base)',
          },
        }, button('list', '列表'), button('graph', '图谱'));
      };
      const memoryToggle = viewToggleOf(memoryView, setMemoryView, '记忆视图');

      const memoryListPane = h('div', {
        style: {
          ...PANEL_CARD, padding: '2px 4px', minHeight: 0, overflowY: 'auto',
        },
      }, memoryList);
      const memoryGraphPane = h('div', {
        style: { ...PANEL_CARD, padding: 0, minHeight: 0, overflow: 'hidden', display: 'flex' },
      },
      h(MemoryGraph, { records: filtered, selectedId: selectedMemory, onPick: onPickNode, emptyText: query ? '没有匹配的记忆' : '还没有记忆', ariaLabel: '记忆关系图' }));
      const memoryTab = h('div', { role: 'tabpanel', 'aria-label': '记忆', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '9px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' } },
          h('input', {
            value: query, onChange: (event) => setQuery(event.target.value),
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
        memoryView === 'graph' ? memoryGraphPane : memoryListPane,
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
        h('span', { style: { marginLeft: 'auto' } }, viewToggleOf(evolutionView, setEvolutionView, '自进化视图')),
      );

      const stageLabel = (stageFilters.find(([key]) => key === stage) || ['all', '全部'])[1];
      const evolutionEmptyText = !memoryOn ? '记忆已关闭'
        : !evolution ? '读不到自进化状态'
          : evolution.enabled !== true ? '自进化已关闭'
            : rules.length === 0 ? (countsUnknown ? '数量未知' : '还没有整理出经验')
              : `没有${stageLabel}的经验`;
      const evolutionList = filteredRules.length === 0
        ? h('div', { style: { ...PANEL_MUTED, padding: '12px 4px' } }, evolutionEmptyText)
        : filteredRules.map((rule) => h('button', {
          key: rule.id, type: 'button', onClick: () => { setSelectedRule(rule.id); setSelectedMemory(''); setShowReason(false); },
          style: {
            display: 'flex', flexDirection: 'column', gap: '3px', width: '100%', textAlign: 'left',
            border: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)',
            background: rule.id === selectedRule ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: 'inherit', padding: '8px 7px', cursor: 'pointer', minWidth: 0,
          },
        },
        h('span', { style: { fontSize: '12px', lineHeight: '1.45', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.92 } }, rule.title),
        h('span', { style: { ...PANEL_MUTED, display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
          h(StagePill, { state: rule.state }),
          h('span', { style: { marginLeft: 'auto', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, EVO_DATE(rule.updated)),
        )));

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
          ...PANEL_CARD, padding: '2px 4px', minHeight: 0, overflowY: 'auto',
        },
      }, evolutionList);
      const evolutionGraphPane = h('div', {
        style: { ...PANEL_CARD, padding: 0, minHeight: 0, overflow: 'hidden', display: 'flex' },
      },
      h(MemoryGraph, {
        records: filteredRules, graphOf: ruleGraphOf, primaryKind: 'rule',
        selectedId: selectedRule, onPick: onPickRuleNode,
        emptyText: evolutionEmptyText, ariaLabel: '经验关系图',
      }));
      const evolutionTab = evolutionFailed ? evolutionFailed : h('div', { role: 'tabpanel', 'aria-label': '自进化', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '9px' } },
        h('div', { style: { ...PANEL_CARD, padding: '9px 11px', display: 'flex', alignItems: 'flex-start', gap: '8px', flex: '0 0 auto' } },
          h('span', { style: { flex: '0 0 auto', width: '6px', height: '6px', marginTop: '5px', borderRadius: '999px', background: effectiveEnabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)', opacity: 0.8 } }),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
            h('div', { style: { fontSize: '12px', lineHeight: '1.55' } }, activityText || (rules.length === 0 ? '还没有整理出经验' : '暂无整理记录')),
            countsUnknown ? h('div', { style: PANEL_MUTED }, '数量未知') : null,
            activityReason
              ? (showReason
                ? h('div', { style: { ...PANEL_MUTED, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, activityReason)
                : h(Action, { onClick: () => setShowReason(true) }, '查看原因'))
              : null,
          ),
        ),
        filterBar,
        h('div', {
          style: {
            flex: 1, minHeight: 0, display: 'grid', gap: '10px',
            gridTemplateColumns: selectedRuleRow ? 'minmax(0, 1fr) minmax(280px, 340px)' : 'minmax(0, 1fr)',
          },
        },
        evolutionView === 'graph' ? evolutionGraphPane : evolutionListPane,
        evolutionDetailPane),
      );

      const content = h('section', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, padding: '14px', gap: '10px' } },
        tabBar,
        activeTab === 'memory' ? memoryTab : evolutionTab,
      );

      const shell = (children) => h('div', {
        style: PANEL_BACKDROP,
        onClick: (event) => { if (event.target === event.currentTarget) props.onClose(); },
      },
      h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': '记忆面板',
        style: { ...PANEL_DIALOG, width: 'min(1120px, 100%)', height: 'min(760px, 100%)', boxSizing: 'border-box' },
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
      if (!sessionId && refs.length === 0) return null;
      if (groups.found.length === 0 && groups.provided.length === 0 && groups.update.length === 0) return null;
      return h('div', { style: TAIL },
        h(RefSection, { label: '检索发现', items: groups.found, sessionId, turnKey: turn }),
        h(RefSection, { label: '已提供正文', items: groups.provided, sessionId, turnKey: turn }),
        h(RefSection, { label: '本轮更新', items: groups.update, sessionId, turnKey: turn }),
      );
    };

    const sourceCache = new Map();

    // 测试缝：Node 里验引用投影，浏览器里没有任何副作用。
    if (typeof globalThis.__LITE_MEMORY_TEST__ === 'function') {
      globalThis.__LITE_MEMORY_TEST__({ metaOf, citationOf, citationsOfMeta, citationsOfTurn, dedupe, undoRefOf, graphOf, ruleGraphOf, MemoryPanel });
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
