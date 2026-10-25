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

    const KEEP = { idle: 'keep', saving: 'saving', saved: 'kept', kept: 'kept' };
    const ROW = { display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 0', fontSize: '12px', lineHeight: '1.6', opacity: 0.7 };
    const DOT = { flex: '0 0 auto', opacity: 0.8 };
    const LABEL = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const KEEP_STYLE = { flex: '0 0 auto', border: '1px solid currentColor', background: 'transparent', color: 'inherit', borderRadius: '999px', padding: '0 8px', fontSize: '12px', lineHeight: '18px' };
    const KEEP_ON = { ...KEEP_STYLE, opacity: 0.9, cursor: 'pointer' };
    const KEEP_OFF = { ...KEEP_STYLE, opacity: 0.45, cursor: 'default' };
    const DROP = { flex: '0 0 auto', border: 'none', background: 'transparent', color: 'inherit', padding: '0 2px', fontSize: '12px', lineHeight: '18px', opacity: 0.55, cursor: 'pointer' };

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

    /** 结果行里带标题时把它取出来，用于点按钮后原路回传。 */
    const quoted = (value) => {
      const match = typeof value === 'string' ? /"([^"]+)"/.exec(value) : null;
      return match ? match[1] : null;
    };

    const post = (payload) => {
      if (typeof fetch !== 'function') return Promise.resolve(null);
      return fetch('/lite-memory/keep', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
    };

    const Row = (props) => {
      const line = props.phase === 'preparing' ? null : firstLine(settledText(props.block));
      return h('div', { 'data-tool': props.toolName, style: ROW }, h('span', { style: DOT }, '·'), h('span', { style: LABEL }, line ?? RUNNING[props.toolName] ?? 'memory'));
    };

    /** 建议行：一个「keep」按钮，点了直接写盘。 */
    const SuggestRow = (props) => {
      const [state, setState] = React.useState('idle');
      const text = props.phase === 'preparing' ? null : settledText(props.block);
      const label = firstLine(text) ?? RUNNING.memory_suggest;
      const title = quoted(text);
      const cwd = typeof props.cwd === 'string' ? props.cwd : '';
      const actions = props.inputActions;
      const canKeep = Boolean(title) && Boolean(cwd) && state === 'idle';
      const keep = () => {
        if (!canKeep) return;
        setState('saving');
        /** 写盘通道不通时退回一条普通消息，至少不丢这条建议。 */
        const fallback = () => {
          try {
            const message = `保留记忆「${title}」`;
            const span = actions && typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : null;
            const inserted = span && actions && typeof actions.insertText === 'function' ? actions.insertText(message, span) : false;
            if (inserted === false && actions && typeof actions.setDraft === 'function') actions.setDraft(message);
            if (actions && typeof actions.submit === 'function') actions.submit();
            setState('kept');
          } catch {
            setState('idle');
          }
        };
        if (typeof fetch !== 'function') return fallback();
        post({ op: 'keep', title, cwd }).then((value) => setState(value && value.ok ? 'saved' : 'kept'));
      };
      const button = title
        ? h('button', { type: 'button', onClick: keep, disabled: !canKeep, 'aria-label': '保留这条记忆', style: canKeep ? KEEP_ON : KEEP_OFF }, KEEP[state] ?? KEEP.idle)
        : null;
      return h('div', { 'data-tool': props.toolName, style: ROW }, h('span', { style: DOT }, '·'), h('span', { style: LABEL }, label), button);
    };

    /** 自动写入行：一个「✕」，点了把它移入归档。 */
    const SavedRow = (props) => {
      const [state, setState] = React.useState('idle');
      const text = props.phase === 'preparing' ? null : settledText(props.block);
      const title = quoted(text);
      const cwd = typeof props.cwd === 'string' ? props.cwd : '';
      const canDrop = Boolean(title) && Boolean(cwd) && state === 'idle';
      const drop = () => {
        if (!canDrop) return;
        setState('saving');
        post({ op: 'undo', title, cwd }).then((value) => setState(value && value.ok ? 'dropped' : 'idle'));
      };
      const label = state === 'dropped' ? 'memory · dropped' : firstLine(text) ?? RUNNING.memory_save;
      const button = title && state !== 'dropped' ? h('button', { type: 'button', onClick: drop, disabled: !canDrop, 'aria-label': '删除这条记忆', style: DROP }, '✕') : null;
      return h('div', { 'data-tool': props.toolName, style: ROW }, h('span', { style: DOT }, '·'), h('span', { style: LABEL }, label), button);
    };

    return {
      inject: ['slots'],
      apply(ctx) {
        for (const name of ['memory_search', 'memory_read', 'memory_forget']) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: name }, Row));
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'memory_suggest' }, SuggestRow));
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'memory_save' }, SavedRow));
      },
    };
  },
});
