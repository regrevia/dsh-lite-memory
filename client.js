window.__ModuleLoader__.load({
  id: 'dsh-lite-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** One muted line per memory call: a summary, never the payload. */
    const RUNNING = {
      memory_save: '记忆 · 写入中',
      memory_suggest: '记忆 · 判断中',
      memory_search: '记忆 · 检索中',
      memory_read: '记忆 · 读取中',
      memory_forget: '记忆 · 归档中',
    };

    const LABELS = { idle: '保留', saving: '保存中', saved: '已保存', kept: '已保留' };
    const ROW = { display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 0', fontSize: '12px', lineHeight: '1.6', opacity: 0.7 };
    const DOT = { flex: '0 0 auto', opacity: 0.8 };
    const LABEL = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const KEEP = { flex: '0 0 auto', border: '1px solid currentColor', background: 'transparent', color: 'inherit', borderRadius: '999px', padding: '0 8px', fontSize: '12px', lineHeight: '18px' };
    const KEEP_ON = { ...KEEP, opacity: 0.9, cursor: 'pointer' };
    const KEEP_OFF = { ...KEEP, opacity: 0.45, cursor: 'default' };

    /** 结果文本已经是中文，这里只取第一行。 */
    const settledText = (block) => {
      if (block === undefined || block === null || !('kind' in block)) return null;
      const content = Array.isArray(block.content) ? block.content : [];
      for (const item of content) {
        if (item !== null && item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) return item.text;
      }
      if (block.error !== undefined) return '记忆 · 已中止';
      if (block.isError === true) return '记忆 · 失败';
      return null;
    };

    const firstLine = (value) => (typeof value === 'string' ? value.split('\n')[0] : null);

    const Row = (props) => {
      const line = props.phase === 'preparing' ? null : firstLine(settledText(props.block));
      return h('div', { 'data-tool': props.toolName, style: ROW }, h('span', { style: DOT }, '·'), h('span', { style: LABEL }, line ?? RUNNING[props.toolName] ?? '记忆'));
    };

    /** 建议行只有一个「保留」：点击直接写盘。 */
    const SuggestRow = (props) => {
      const [state, setState] = React.useState('idle');
      const text = props.phase === 'preparing' ? null : settledText(props.block);
      const label = firstLine(text) ?? RUNNING.memory_suggest ?? '记忆';
      const match = typeof text === 'string' && text.startsWith('可记「') ? /「([^」]+)」/.exec(text) : null;
      const title = match ? match[1] : null;
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
        fetch('/lite-memory/keep', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, cwd }),
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((value) => setState(value && value.ok ? 'saved' : 'kept'))
          .catch(() => setState('kept'));
      };
      const button = title
        ? h('button', { type: 'button', onClick: keep, disabled: !canKeep, 'aria-label': '保留这条记忆', style: canKeep ? KEEP_ON : KEEP_OFF }, LABELS[state] ?? LABELS.idle)
        : null;
      return h('div', { 'data-tool': props.toolName, style: ROW }, h('span', { style: DOT }, '·'), h('span', { style: LABEL }, label), button);
    };

    return {
      inject: ['slots'],
      apply(ctx) {
        for (const name of ['memory_save', 'memory_search', 'memory_read', 'memory_forget']) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: name }, Row));
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'memory_suggest' }, SuggestRow));
      },
    };
  },
});
