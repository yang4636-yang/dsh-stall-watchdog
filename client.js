/* stall-watchdog client half: a config card on the plugin detail page.
 *
 * Plain JS in the deployment's module-loader format (no build step). The card
 * binds the Host row's volatile Config form (`configForms.get('stall-watchdog')`):
 * shown values are the live committed config; edits write through the settings
 * controller into the profile layer, and the Loader commits each value into the
 * running plugin's refs — the next tool call already uses the new threshold.
 */
window.__ModuleLoader__.load({
  id: 'dsh-stall-watchdog',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // The profile entry id of the Host row; configForms namespaces by entry id.
    const FORM_NS = 'stall-watchdog'

    const DICT = {
      zh: {
        title: '环节超时自查',
        intro: '以下设置即时生效，无需重启：改动写进本 profile，插件的下一个工具调用就用新值。',
        enabled: '启用监控',
        enabledHint: '关闭后不再注入任何提醒。',
        stallSec: '超时阈值（秒）',
        stallSecHint: '单个工具调用超过这个时长仍未返回，就提醒模型自查。',
        repeatSec: '重复提醒间隔（秒）',
        repeatSecHint: '同一调用一直不返回时，每隔多久再催一次；0 = 只提醒一次。',
        maxReminders: '最多提醒次数',
        maxRemindersHint: '仅在重复间隔大于 0 时生效。',
        excludeTools: '不监控的工具（每行一个）',
        excludeToolsHint: '本就该长时间运行的后台类工具，列在这里避免误报。',
        message: '自定义提醒文案',
        messageHint: '留空用内置文案。可用 {tool} {elapsed} {threshold} {attempt}。',
        saved: '已保存',
        failed: '保存失败',
        loading: '正在读取配置…',
        unavailable: '配置服务不可用：请确认设置组件已启用后刷新页面。',
        readonly: '当前配置被更高优先级覆盖，界面只读。',
      },
      en: {
        title: 'Stall watchdog',
        intro: 'Settings apply live: edits are written to this profile and the next tool call uses them.',
        enabled: 'Monitoring',
        enabledHint: 'When off, no reminders are injected.',
        stallSec: 'Stall threshold (seconds)',
        stallSecHint: 'Remind the model when one tool call runs past this long.',
        repeatSec: 'Repeat interval (seconds)',
        repeatSecHint: 'Re-notify while the same call is pending; 0 = notify once.',
        maxReminders: 'Max reminders',
        maxRemindersHint: 'Only when the repeat interval is above 0.',
        excludeTools: 'Excluded tools (one per line)',
        excludeToolsHint: 'Long-running background tools that should not be watched.',
        message: 'Custom reminder text',
        messageHint: 'Empty uses the built-in text. Placeholders: {tool} {elapsed} {threshold} {attempt}.',
        saved: 'Saved',
        failed: 'Save failed',
        loading: 'Loading configuration…',
        unavailable: 'Configuration service unavailable: enable the settings client and refresh.',
        readonly: 'Overridden by a higher-priority layer; read-only.',
      },
    }

    function lang() {
      const nav = (typeof navigator !== 'undefined' && navigator.language) || 'zh'
      return String(nav).toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    function humanize(sec) {
      if (!Number.isFinite(sec) || sec <= 0) return ''
      if (sec < 60) return sec + 's'
      const m = Math.floor(sec / 60)
      const s = sec % 60
      if (m < 60) return s === 0 ? m + 'min' : m + 'm' + s + 's'
      const hr = Math.floor(m / 60)
      const rm = m % 60
      return rm === 0 ? hr + 'h' : hr + 'h' + rm + 'm'
    }

    const S = {
      card: {
        display: 'flex', flexDirection: 'column', gap: 14,
        padding: '14px 16px', borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13, lineHeight: 1.5,
      },
      title: { fontSize: 14, fontWeight: 600, margin: 0 },
      intro: { color: 'var(--dsw-alias-label-secondary)', margin: 0 },
      row: { display: 'flex', flexDirection: 'column', gap: 4 },
      labelLine: { display: 'flex', alignItems: 'baseline', gap: 8 },
      label: { fontWeight: 550 },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      input: {
        width: 150, boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)', font: 'inherit',
      },
      wide: { width: '100%', minHeight: 52, resize: 'vertical' },
      badge: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' },
      badgeFail: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
      switchRow: { display: 'flex', alignItems: 'center', gap: 10 },
      human: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
    }

    function useSnapshot(source) {
      const [value, setValue] = React.useState(() => source.getSnapshot())
      React.useEffect(() => source.subscribe(() => setValue(source.getSnapshot())), [source])
      return value
    }

    /** One numeric field: local draft, commit on blur or Enter. */
    function NumberField(props) {
      const { t, field, value, min, disabled, onCommit, busy, hint } = props
      const [draft, setDraft] = React.useState(String(value))
      const [flash, setFlash] = React.useState(null)
      React.useEffect(() => { setDraft(String(value)) }, [value])
      const commit = () => {
        const n = Number.parseInt(draft, 10)
        if (!Number.isFinite(n) || n < min) {
          setDraft(String(value))
          setFlash('bad')
          setTimeout(() => setFlash(null), 1500)
          return
        }
        if (n === value) { setDraft(String(value)); return }
        Promise.resolve(onCommit(field, n)).then((ok) => {
          setFlash(ok ? 'ok' : 'bad')
          setTimeout(() => setFlash(null), 1800)
        })
      }
      return h('div', { style: S.row },
        h('div', { style: S.labelLine },
          h('span', { style: S.label }, t[field]),
          h('span', { style: S.human }, field.endsWith('Sec') ? humanize(value) : ''),
        ),
        h('input', {
          style: S.input, type: 'number', min: min, step: 1, value: draft,
          disabled: disabled || busy,
          onChange: (e) => setDraft(e.target.value),
          onBlur: commit,
          onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } },
        }),
        hint ? h('div', { style: S.hint }, t[hint]) : null,
        flash === 'ok' ? h('span', { style: S.badge }, t.saved) : null,
        flash === 'bad' ? h('span', { style: S.badgeFail }, t.failed) : null,
      )
    }

    /** A multiline text field, commit on blur. */
    function TextField(props) {
      const { t, field, value, disabled, busy, onCommit, hint, toText, fromText } = props
      const [draft, setDraft] = React.useState(toText(value))
      const [flash, setFlash] = React.useState(null)
      React.useEffect(() => { setDraft(toText(value)) }, [value])
      const commit = () => {
        const next = fromText(draft)
        if (JSON.stringify(next) === JSON.stringify(value)) return
        Promise.resolve(onCommit(field, next)).then((ok) => {
          setFlash(ok ? 'ok' : 'bad')
          setTimeout(() => setFlash(null), 1800)
        })
      }
      return h('div', { style: S.row },
        h('div', { style: S.labelLine }, h('span', { style: S.label }, t[field])),
        h('textarea', {
          style: Object.assign({}, S.input, S.wide), value: draft,
          disabled: disabled || busy,
          onChange: (e) => setDraft(e.target.value),
          onBlur: commit,
        }),
        hint ? h('div', { style: S.hint }, t[hint]) : null,
        flash === 'ok' ? h('span', { style: S.badge }, t.saved) : null,
        flash === 'bad' ? h('span', { style: S.badgeFail }, t.failed) : null,
      )
    }

    function Card(props) {
      const t = DICT[lang()]
      const { form, busyRef } = props
      const snap = useSnapshot(form)
      const value = snap.value || {}
      const busy = busyRef.current > 0
      const readonly = snap.writable === false
      const commit = (field, v) => {
        busyRef.current += 1
        return Promise.resolve(form.set(field, v))
          .then((ok) => ok !== false)
          .catch(() => false)
          .then((r) => { busyRef.current -= 1; return r }, (e) => { busyRef.current -= 1; return false })
      }
      if (snap.status === 'loading') return h('div', { style: S.card }, t.loading)
      if (snap.status === 'unavailable') return h('div', { style: S.card }, t.unavailable)
      const disabled = readonly
      return h('div', { style: S.card },
        h('h3', { style: S.title }, t.title),
        h('p', { style: S.intro }, t.intro),
        readonly ? h('p', { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-warn-primary)' }) }, t.readonly) : null,
        h('div', { style: S.switchRow },
          h('input', {
            type: 'checkbox',
            checked: value.enabled !== false,
            disabled: disabled || busy,
            onChange: (e) => commit('enabled', e.target.checked),
          }),
          h('span', { style: S.label }, t.enabled),
          h('span', { style: S.hint }, t.enabledHint),
        ),
        h(NumberField, { t, field: 'stallSec', value: value.stallSec ?? 600, min: 1, disabled, busy, onCommit: commit, hint: 'stallSecHint' }),
        h(NumberField, { t, field: 'repeatSec', value: value.repeatSec ?? 0, min: 0, disabled, busy, onCommit: commit, hint: 'repeatSecHint' }),
        h(NumberField, { t, field: 'maxReminders', value: value.maxReminders ?? 3, min: 1, disabled, busy, onCommit: commit, hint: 'maxRemindersHint' }),
        h(TextField, {
          t, field: 'excludeTools', value: Array.isArray(value.excludeTools) ? value.excludeTools : [],
          disabled, busy, onCommit: commit, hint: 'excludeToolsHint',
          toText: (arr) => arr.join('\n'),
          fromText: (text) => text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
        }),
        h(TextField, {
          t, field: 'message', value: typeof value.message === 'string' ? value.message : '',
          disabled, busy, onCommit: commit, hint: 'messageHint',
          toText: (x) => x, fromText: (x) => x,
        }),
      )
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        const form = ctx.configForms.get(FORM_NS)
        const busyRef = { current: 0 }
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-stall-watchdog',
          order: 30,
          inject: () => ({ form, busyRef }),
        }, (props) => h(Card, props)))
      },
    }
  },
})
