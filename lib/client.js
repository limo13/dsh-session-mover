// Browser half of dsh-session-mover.
// Contributes a "Move to workspace" action on the session header and talks to
// the Host half over /api/dsh-session-mover. Moves are QUEUED, not applied
// live: the Host cannot rewrite a session's cwd while the harness holds its
// index and file locks, so apply-queue.mjs performs them just before the next
// boot. The UI says so explicitly.
window.__ModuleLoader__.load({
  id: 'dsh-session-mover',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    const React = require('react')
    const { useState, useEffect, useCallback, useSyncExternalStore } = React
    const h = React.createElement

    const inject = ['slots', 'sessions', 'workspaces']

    const CSS = [
      '.sm-wrap{position:relative;display:inline-flex}',
      '.sm-btn{display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsh-border,#3a3f4b);background:transparent;color:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.sm-btn:hover{background:rgba(127,127,127,.12)}',
      '.sm-btn[disabled]{opacity:.45;cursor:default}',
      '.sm-panel{position:absolute;top:34px;right:0;z-index:60;min-width:280px;max-height:360px;overflow:auto;padding:8px;border-radius:10px;border:1px solid var(--dsh-border,#3a3f4b);background:var(--dsh-bg-elevated,#22262f);box-shadow:0 8px 28px rgba(0,0,0,.45);font-size:12px;color:inherit}',
      '.sm-title{padding:4px 8px 8px;opacity:.6;font-size:11px;line-height:1.5}',
      '.sm-item{display:block;width:100%;text-align:left;padding:7px 8px;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer;font-size:12px}',
      '.sm-item:hover{background:rgba(127,127,127,.16)}',
      '.sm-item[disabled]{opacity:.45;cursor:default}',
      '.sm-item small{display:block;opacity:.55;margin-top:2px;font-size:10px}',
      '.sm-note{padding:8px;opacity:.75;line-height:1.5}',
      '.sm-err{padding:8px;color:#e06c75;line-height:1.5}',
      '.sm-panel-up{top:auto;bottom:34px;right:0;left:auto}',
      '.sm-sec{padding:2px;font-size:13px}',
      '.sm-group{margin:16px 0 6px;padding-bottom:6px;border-bottom:1px solid rgba(127,127,127,.25);font-weight:600;opacity:.85;font-size:12px}',
      '.sm-groupbtn{display:block;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid rgba(127,127,127,.25);padding:7px 2px;margin:16px 0 8px;cursor:pointer;color:inherit;font:inherit;font-size:12px;font-weight:600;opacity:.85}',
      '.sm-groupbtn:hover{opacity:1}',
      '.sm-sub{margin:6px 0 14px;padding:9px 11px;border-radius:9px;background:rgba(127,127,127,.09);font-size:12px;line-height:1.6}',
      '.sm-subrow{display:flex;justify-content:space-between;gap:10px;align-items:center}',
      '.sm-subbtn{height:24px;padding:0 9px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.sm-subbtn:hover{background:rgba(127,127,127,.15)}',
      '.sm-toolbar{display:flex;gap:8px;margin:12px 0 6px;flex-wrap:wrap}',
      '.sm-search{flex:1;min-width:170px;height:31px;padding:0 11px;border-radius:7px;border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.08);color:inherit;font-size:12px;outline:none}',
      '.sm-search:focus{border-color:rgba(127,127,127,.75)}',
      '.sm-select{height:31px;padding:0 9px;border-radius:7px;border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.08);color:inherit;font-size:12px;cursor:pointer}',
      '.sm-select option{background:#22262f;color:#e6e6e6}',
      '.sm-hit{padding:6px 2px;font-size:11px;opacity:.6}',
      '.sm-empty{padding:14px 8px;font-size:12px;opacity:.6;text-align:center}',
      '.sm-row{padding:9px 11px;border-radius:9px;margin-bottom:5px;background:rgba(127,127,127,.06)}',
      '.sm-rowtitle{font-size:13px;line-height:1.5;word-break:break-word}',
      '.sm-dim{opacity:.5;font-size:11px}',
      '.sm-rowcwd{opacity:.55;font-size:11px;margin-top:3px;word-break:break-all}',
      '.sm-rowacts{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}',
      '.sm-mini{height:25px;padding:0 10px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font-size:12px;cursor:pointer}',
      '.sm-mini:hover{background:rgba(127,127,127,.15)}',
      '.sm-mini[disabled]{opacity:.4;cursor:default}',
      '.sm-tag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:5px;font-size:10px;background:rgba(224,108,117,.2);color:#e06c75;vertical-align:middle}',
      '.sm-menu{margin-top:7px;padding:6px;border-radius:8px;background:rgba(127,127,127,.1);max-height:240px;overflow:auto}',
      '.sm-danger{border-color:rgba(224,108,117,.55);color:#e06c75}',
      '.sm-danger:hover{background:rgba(224,108,117,.15)}',
      '.sm-warn{font-size:12px;color:#e06c75;align-self:center;margin-right:2px}',
      '.sm-qbox{margin:8px 0 18px;padding:11px 13px;border-radius:10px;border:1px solid rgba(224,180,80,.5);background:rgba(224,180,80,.09)}',
      '.sm-qhead{font-size:12px;font-weight:600;margin-bottom:8px;line-height:1.5}',
      '.sm-qitem{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:7px 0;border-top:1px solid rgba(127,127,127,.22)}',
      '.sm-qdesc{flex:1;min-width:170px;font-size:12px;line-height:1.5}',
      '.sm-qsub{width:100%;font-size:11px;opacity:.62;line-height:1.5}',
      '.sm-qtag{display:inline-block;padding:1px 7px;border-radius:5px;font-size:10px;background:rgba(127,127,127,.25)}',
    ].join('')
    async function api(method, params) {
      const r = await fetch('/api/dsh-session-mover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ method: method }, params || {})),
      })
      return r.json()
    }

    let CTX = null

    function useSessionsSnapshot() {
      const sessions = CTX.get('sessions')
      return useSyncExternalStore(
        function (cb) { return sessions.list.subscribe(cb) },
        function () { return sessions.list.getSnapshot() },
      )
    }

    function MoverAction() {
      const [open, setOpen] = useState(false)
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [err, setErr] = useState('')
      const snap = useSessionsSnapshot()
      const sessionId = snap && snap.current ? snap.current : null

      const load = useCallback(async function () {
        try {
          setErr('')
          const r = await api('state')
          if (r.ok) setData(r.state)
          else setErr(r.error || 'load failed')
        } catch (e) { setErr(String((e && e.message) || e)) }
      }, [])

      useEffect(function () { if (open) load() }, [open, load])

      if (!sessionId) return null

      const mine = data && data.sessions
        ? data.sessions.find(function (s) { return s.sessionId === sessionId })
        : null

      async function submit(target, unarchive, action) {
        setBusy(true); setErr(''); setNote('')
        try {
          const r = await api('queue', {
            sessionId: sessionId,
            action: action || 'move',
            targetWorkspaceId: target ? target.id : null,
            targetPath: target ? target.path : (mine ? mine.cwd : ''),
            unarchive: !!unarchive,
          })
          if (r.ok) { setData(r.state); setNote('已排队（共 ' + r.queued + ' 项）。重启 DSH 后才执行；可在顶部「待执行操作」里撤销') }
          else setErr(r.error || 'queue failed')
        } catch (e) { setErr(String((e && e.message) || e)) }
        setBusy(false)
      }

      const children = []
      children.push(h('div', { className: 'sm-title', key: 't' },
        mine
          ? '当前归属：' + (mine.workspaceId ? '已归入工作区' : '未分组') + (mine.archived ? ' · 已归档' : '') +
            '\n选择目标后写入队列，重启 DSH 时自动执行。'
          : '读取会话状态…'))
      if (data) {
        data.workspaces.forEach(function (w) {
          const isCurrent = mine && mine.workspaceId === w.id && mine.cwd === w.path
          children.push(h('button', {
            key: 'w-' + w.id,
            className: 'sm-item',
            disabled: busy || isCurrent,
            onClick: function () { submit(w, mine && mine.archived) },
          }, w.title + (isCurrent ? '（当前）' : ''),
             h('small', null, w.path + ' · ' + w.count + ' 个会话')))
        })
        children.push(h('button', {
          key: 'ungroup',
          className: 'sm-item',
          disabled: busy || !mine || !mine.workspaceId,
          onClick: function () { submit(null, mine && mine.archived) },
        }, '移出到「未分组」'))
        if (mine && mine.archived) {
          children.push(h('button', {
            key: 'unarchive',
            className: 'sm-item',
            disabled: busy,
            onClick: function () { submit(null, true, 'unarchive') },
          }, '接续（取消归档）',
             h('small', null, '原地恢复归档会话，不搬目录、不改归属')))
        }
      } else {
        children.push(h('div', { className: 'sm-note', key: 'loading' }, '加载中…'))
      }
      if (note) children.push(h('div', { className: 'sm-note', key: 'n' }, note))
      if (err) children.push(h('div', { className: 'sm-err', key: 'e' }, err))

      return h('div', { className: 'sm-wrap' },
        h('button', {
          className: 'sm-btn',
          disabled: busy,
          title: '把当前会话移动到某个工作区（重启后生效）',
          onClick: function () { setOpen(!open) },
        }, '移至工作区'),
        open ? h('div', { className: 'sm-panel' }, children) : null,
      )
    }
    function MoverSection() {
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const [err, setErr] = useState('')
      const [menuFor, setMenuFor] = useState(null)
      const [confirmFor, setConfirmFor] = useState(null)
      const [expanded, setExpanded] = useState(function () {
        try {
          const raw = localStorage.getItem('dsh-sm-expanded')
          return raw === null ? {} : JSON.parse(raw)
        } catch (e) { return {} }
      })
      const [hideSub, setHideSub] = useState(function () {
        try { return localStorage.getItem('dsh-sm-hidesub') !== '0' } catch (e) { return true }
      })
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')

      const load = useCallback(async function () {
        try {
          setErr('')
          const r = await api('state')
          if (r.ok) setData(r.state)
          else setErr(r.error || 'load failed')
        } catch (e) { setErr(String((e && e.message) || e)) }
      }, [])

      useEffect(function () { load() }, [load])

      async function act(sessionId, action, target, wasArchived) {
        setBusy(sessionId); setErr(''); setNote(''); setMenuFor(null); setConfirmFor(null)
        try {
          const r = await api('queue', {
            sessionId: sessionId,
            action: action,
            targetWorkspaceId: (target && target.id) ? target.id : null,
            targetPath: (target && target.path) ? target.path : null,
            unarchive: action === 'unarchive' ? true : !!wasArchived,
          })
          if (r.ok) { setData(r.state); setNote('已排队（共 ' + r.queued + ' 项）。重启 DSH 后才执行；可在顶部「待执行操作」里撤销') }
          else setErr(r.error || 'queue failed')
        } catch (e) { setErr(String((e && e.message) || e)) }
        setBusy('')
      }

      async function unqueue(sessionId) {
        setBusy(sessionId); setErr(''); setNote('')
        try {
          const r = await api('unqueue', { sessionId: sessionId })
          if (r.ok) { setData(r.state); setNote('已撤销该操作，未改动任何文件') }
          else setErr(r.error || 'unqueue failed')
        } catch (e) { setErr(String((e && e.message) || e)) }
        setBusy('')
      }

      async function clearQueue() {
        setBusy('__all__'); setErr(''); setNote('')
        try {
          const r = await api('clear')
          if (r.ok) { setData(r.state); setNote('已撤销全部待执行操作，未改动任何文件') }
          else setErr(r.error || 'clear failed')
        } catch (e) { setErr(String((e && e.message) || e)) }
        setBusy('')
      }

      const isOpen = function (k) { return !!expanded[k] }
      const toggle = function (k) {
        setExpanded(function (prev) {
          const next = Object.assign({}, prev)
          if (next[k]) delete next[k]
          else next[k] = true
          try { localStorage.setItem('dsh-sm-expanded', JSON.stringify(next)) } catch (e) { }
          return next
        })
      }
      const toggleSub = function () {
        setHideSub(function (prev) {
          const v = !prev
          try { localStorage.setItem('dsh-sm-hidesub', v ? '1' : '0') } catch (e) { }
          return v
        })
      }

      if (data === null) {
        return h('div', { className: 'sm-sec' },
          h('div', { className: 'sm-note' }, '加载中…'),
          err ? h('div', { className: 'sm-err' }, err) : null)
      }

      const ungrouped = { key: '__ung', label: '未分组', path: null, items: [] }
      const groups = []
      const byId = new Map()
      data.workspaces.forEach(function (w) {
        const g = { key: w.id, label: w.title, path: w.path, ws: w, items: [] }
        byId.set(w.id, g); groups.push(g)
      })
      const queuedIds = (data.queue || []).map(function (q) { return String(q.sessionId) })
      const isQueued = function (sid) {
        const x = String(sid)
        for (let i = 0; i < queuedIds.length; i++) {
          const q = queuedIds[i]
          if (q === x || q.indexOf(x) >= 0 || x.indexOf(q) >= 0) return true
        }
        return false
      }
      const subCount = data.sessions.filter(function (s) { return s.origin === 'subagent' || s.delegationDepth > 0 }).length
      const q = query.trim().toLowerCase()
      const searching = q.length > 0
      const liveSessions = data.sessions.filter(function (s) {
        if ((s.origin === 'subagent' || s.delegationDepth > 0) && hideSub) return false
        if (filter === 'ungrouped' && s.workspaceId) return false
        if (filter === 'grouped' && !s.workspaceId) return false
        if (filter === 'archived' && !s.archived) return false
        if (filter === 'live' && s.archived) return false
        if (searching) {
          const hay = (String(s.title || '') + ' ' + String(s.cwd || '') + ' ' + String(s.sessionId || '')).toLowerCase()
          if (hay.indexOf(q) < 0) return false
        }
        return true
      })
      liveSessions.forEach(function (s) {
        if (isQueued(s.sessionId)) return
        const g = (s.workspaceId && byId.get(s.workspaceId)) || ungrouped
        g.items.push(s)
      })
      if (ungrouped.items.length > 0) groups.push(ungrouped)

      const archCount = data.sessions.filter(function (s) { return s.archived }).length
      const rows = []
      if (data.queue && data.queue.length > 0) {
        const qitems = [h('div', { className: 'sm-qhead', key: 'qh' },
          '待执行操作（' + data.queue.length + '）—— 重启 DSH 后才会执行，此刻尚未改动任何文件')]
        data.queue.forEach(function (it) {
          const s = data.sessions.find(function (x) { return x.sessionId === it.sessionId })
          const label = (s && s.title) ? s.title : String(it.sessionId).replace(/^session-/, '').slice(0, 20)
          let tag = '移动'
          let desc = ''
          if (it.action === 'delete') {
            tag = '删除'
            desc = '移入回收站，并从工作区归属与归档记录中移除（可从 backup\\\\deleted 找回）'
          } else if (it.action === 'unarchive') {
            tag = '接续'
            desc = '取消归档；工作目录与归属都不变'
          } else {
            const w = data.workspaces.find(function (x) { return x.id === it.targetWorkspaceId })
            desc = w
              ? ('移入工作区「' + w.title + '」 ' + w.path + '（改工作目录 + 搬移会话目录）')
              : '移出到「未分组」（仅改归属，不改工作目录）'
          }
          qitems.push(h('div', { className: 'sm-qitem', key: it.sessionId },
            h('div', { className: 'sm-qdesc', key: 'd' },
              h('span', { className: 'sm-qtag', key: 't' }, tag), ' ' + label),
            h('div', { className: 'sm-qsub', key: 's' }, desc),
            h('button', {
              key: 'u', className: 'sm-mini', disabled: busy === it.sessionId,
              onClick: function () { unqueue(it.sessionId) },
            }, '撤销')))
        })
        qitems.push(h('button', {
          key: 'cq', className: 'sm-mini sm-danger', disabled: busy === '__all__',
          onClick: function () { clearQueue() },
        }, '全部撤销'))
        rows.push(h('div', { className: 'sm-qbox', key: 'qbox' }, qitems))
      }
      rows.push(h('div', { className: 'sm-title', key: 'h' },
        '共 ' + data.sessions.length + ' 个会话（其中子代理 ' + subCount + ' 个、已归档 ' + archCount + ' 个）。' +
        ((data.queue && data.queue.length > 0)
          ? ('其中 ' + data.queue.length + ' 个已排入上方待执行列表，已从下方列表移除，避免重复操作。')
          : '') +
        '归档会话不会出现在侧边栏，可在此接续，或直接移动到某个工作区（移动时会自动接续）。'))
      rows.push(h('div', { className: 'sm-toolbar', key: 'tb' },
        h('input', {
          key: 'q',
          className: 'sm-search',
          type: 'search',
          placeholder: '搜索标题 / 路径 / id…',
          value: query,
          onChange: function (e) { setQuery(e.target.value) },
        }),
        h('select', {
          key: 'f',
          className: 'sm-select',
          value: filter,
          onChange: function (e) { setFilter(e.target.value) },
        },
          h('option', { key: 'a', value: 'all' }, '全部'),
          h('option', { key: 'b', value: 'ungrouped' }, '仅未分组'),
          h('option', { key: 'c', value: 'grouped' }, '仅已归组'),
          h('option', { key: 'd', value: 'archived' }, '仅已归档'),
          h('option', { key: 'e', value: 'live' }, '仅未归档'),
        )))
      if (searching || filter !== 'all') {
        const shown = groups.reduce(function (n, g) { return n + g.items.length }, 0)
        rows.push(h('div', { className: 'sm-hit', key: 'hit' },
          '匹配 ' + shown + ' 个会话' + (searching ? '，搜索中分组自动展开' : '')))
      }

      rows.push(h('div', { className: 'sm-sub', key: 'sub' },
        h('div', { className: 'sm-subrow', key: 'r' },
          h('span', { key: 'l' }, '子代理会话 ' + subCount + ' 个' + (hideSub ? '（已隐藏）' : '（已显示）')),
          h('button', { key: 'b', className: 'sm-subbtn', onClick: toggleSub }, hideSub ? '显示' : '隐藏'))))

      groups.forEach(function (g) {
        if (g.items.length === 0) return
        const opened = searching || isOpen(g.key)
        rows.push(h('button', {
          key: 'g-' + g.key,
          className: 'sm-groupbtn',
          onClick: function () { toggle(g.key) },
        }, (opened ? '▾  ' : '▸  ') + g.label + (g.path ? '  (' + g.path + ')' : '') + ' · ' + g.items.length + ' 个'))
        if (!opened) return
        g.items.forEach(function (s) {
          const isMenu = menuFor === s.sessionId
          const acts = []
          if (confirmFor === s.sessionId) {
            acts.push(h('span', { key: 'warn', className: 'sm-warn' }, '确认删除该会话？'))
            acts.push(h('button', {
              key: 'delyes', className: 'sm-mini sm-danger', disabled: busy === s.sessionId,
              onClick: function () { act(s.sessionId, 'delete', null, false) },
            }, '确认删除'))
            acts.push(h('button', {
              key: 'delno', className: 'sm-mini',
              onClick: function () { setConfirmFor(null) },
            }, '取消'))
          } else {
            if (s.archived) {
              acts.push(h('button', {
                key: 'resume', className: 'sm-mini', disabled: busy === s.sessionId,
                onClick: function () { act(s.sessionId, 'unarchive', null, true) },
              }, '接续'))
            }
            acts.push(h('button', {
              key: 'move', className: 'sm-mini', disabled: busy === s.sessionId,
              onClick: function () { setMenuFor(isMenu ? null : s.sessionId) },
            }, '移动到 ▾'))
            acts.push(h('button', {
              key: 'del', className: 'sm-mini sm-danger', disabled: busy === s.sessionId,
              onClick: function () { setConfirmFor(s.sessionId); setMenuFor(null) },
            }, '删除'))
          }

          const body = [
            h('div', { className: 'sm-rowtitle', key: 't' },
              (s.title || '(无标题)'),
              s.archived ? h('span', { className: 'sm-tag', key: 'tag' }, '归档') : null,
              h('span', { className: 'sm-dim', key: 'id' },
                '  ' + String(s.sessionId).replace(/^session-/, '').slice(0, 8) + ' · ' + Math.round(s.bytes / 1024) + ' KB')),
            h('div', { className: 'sm-rowcwd', key: 'c' }, s.cwd),
            h('div', { className: 'sm-rowacts', key: 'a' }, acts),
          ]
          if (isMenu) {
            const opts = []
            data.workspaces.forEach(function (w) {
              const same = (s.workspaceId === w.id && s.cwd === w.path)
              opts.push(h('button', {
                key: 'o-' + w.id, className: 'sm-item', disabled: same,
                onClick: function () { act(s.sessionId, 'move', w, s.archived) },
              }, w.title + (same ? '（当前）' : ''), h('small', null, w.path)))
            })
            if (s.workspaceId) {
              opts.push(h('button', {
                key: 'o-ung', className: 'sm-item',
                onClick: function () { act(s.sessionId, 'move', { id: null, path: s.cwd }, s.archived) },
              }, '移出到「未分组」', h('small', null, '仅移出归属，不改工作目录')))
            }
            body.push(h('div', { className: 'sm-menu', key: 'm' }, opts))
          }
          rows.push(h('div', { className: 'sm-row', key: s.sessionId }, body))
        })
      })

      if (groups.every(function (g) { return g.items.length === 0 })) {
        rows.push(h('div', { className: 'sm-empty', key: 'emp' }, '没有符合当前搜索/筛选条件的会话'))
      }
      if (note) rows.push(h('div', { className: 'sm-note', key: 'n' }, note))
      if (err) rows.push(h('div', { className: 'sm-err', key: 'e' }, err))
      return h('div', { className: 'sm-sec' }, rows)
    }
    function apply(ctx) {
      CTX = ctx
      const slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(function () {
        const id = 'dsh-session-mover-style'
        if (!document.getElementById(id)) {
          const s = document.createElement('style')
          s.id = id
          s.textContent = CSS
          document.head.appendChild(s)
        }
        return function () {
          const el = document.getElementById(id)
          if (el) el.remove()
        }
      }, 'dsh-session-mover: style')

      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'session-mover', order: 60, label: function () { return '会话迁移' } },
          MoverSection,
        )
      })

      slots.inject('conversation.session.header.actions', function () {
        return slots.register(
          { name: 'conversation.session.header.actions', id: 'session-mover', order: 60 },
          MoverAction,
        )
      })
    }

    module.exports = { inject: inject, apply: apply }
    return module.exports
  },
})