/**
 * dsh-session-mover — host 半
 * 注册 /api/dsh-session-mover：state / queue / unqueue / clear
 * 只排队不直接改：改写 cwd 要搬物理目录，必须等 harness 停止，
 * 由 apply-queue.mjs 在下次启动前消费队列。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { listSessions, executeMove, executeUnarchive, deleteSession } from './core.mjs'

export const name = 'dsh-session-mover'
export const inject = []

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.dirname(HERE)
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
const WORKSPACE_FILE = path.join(DSH_HOME, 'storages', 'workspace.json')
const QUEUE_FILE = path.join(PLUGIN_DIR, 'queue.json')
const PROJCACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
const BACKUP_ROOT = path.join(PLUGIN_DIR, 'backup')
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)) }
const readQueue = () => readJson(QUEUE_FILE, { items: [] })
const writeQueue = (q) => writeJson(QUEUE_FILE, q)

function state() {
  const ws = readJson(WORKSPACE_FILE, null)
  if (!ws) return { error: 'workspace.json unreadable' }
  const queue = readQueue().items
  const workspaces = Object.entries(ws.tables.workspaces).map(([id, r]) => ({
    id, path: r.path, title: r.title, count: r.sessionIds.length,
  }))
  let sessions = []
  try { sessions = listSessions({ sessionsRoot: SESSIONS_ROOT, workspaceState: ws, projcacheDir: PROJCACHE_DIR }) } catch { sessions = [] }
  return {
    queue,
    workspaces,
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId, title: s.title || null, cwd: s.cwd, workspaceId: s.workspaceId,
      origin: s.origin || null, delegationDepth: s.delegationDepth || 0,
      archived: s.archived, bytes: s.bytes,
      queued: queue.some((q) => q.sessionId === s.sessionId),
    })),
  }
}
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
  res.end(body)
}
/**
 * 启动早期自带消费队列 —— 不依赖任何外部启动脚本。
 *
 * 判定：改写会话 cwd 会搬动物理目录，必须在 DSH 建好会话索引之前完成，
 * 否则「我改文件、DSH 用内存状态覆盖回去」。这里用 workspaceRegistry
 * 是否已注册来探测时机；已注册说明索引已建立，本次跳过（留给下次启动）。
 */
function consumeQueueIfEarly(ctx) {
  let pending = []
  try { pending = readQueue().items || [] } catch { return }
  let indexBuilt = true
  try { indexBuilt = ctx.get('workspaceRegistry') !== undefined } catch { indexBuilt = true }

  console.log('[dsh-session-mover] boot timing: workspaceRegistry=' + (indexBuilt ? 'ready (late)' : 'absent (early, safe to rewrite)') + '; queued=' + pending.length)

  if (pending.length === 0) return

  if (indexBuilt) {
    console.log('[dsh-session-mover] ' + pending.length + ' move(s) queued but this boot was too late (session index already built); deferring to next boot.')
    return
  }

  console.log('[dsh-session-mover] consuming ' + pending.length + ' queued operation(s)...')
  const failed = []
  for (const item of pending) {
    const tag = String(item.sessionId).slice(0, 20)
    try {
      let r
      if (item.action === 'unarchive') {
        r = executeUnarchive({ sessionsRoot: SESSIONS_ROOT, workspaceFile: WORKSPACE_FILE, sessionId: item.sessionId, dryRun: false })
      } else if (item.action === 'delete') {
        r = deleteSession({ sessionsRoot: SESSIONS_ROOT, workspaceFile: WORKSPACE_FILE, projcacheDir: PROJCACHE_DIR, backupRoot: BACKUP_ROOT, sessionId: item.sessionId, dryRun: false })
      } else {
        r = executeMove({ sessionsRoot: SESSIONS_ROOT, workspaceFile: WORKSPACE_FILE, projcacheDir: PROJCACHE_DIR, backupRoot: BACKUP_ROOT, sessionId: item.sessionId, toCwd: item.targetPath, workspaceId: item.targetWorkspaceId, unarchive: item.unarchive, dryRun: false })
      }
      if (r.ok) {
        console.log('  OK   ' + tag + '  ' + String(r.oldCwd || '') + ' -> ' + String(r.targetCwd || ''))
      } else {
        console.log('  FAIL ' + tag + '  ' + String(r.error))
        failed.push(item)
      }
    } catch (e) {
      console.log('  FAIL ' + tag + '  ' + String((e && e.message) || e))
      failed.push(item)
    }
  }
  try { writeQueue({ items: failed }) } catch { }
  console.log('[dsh-session-mover] queue done; remaining=' + failed.length)
}
export function apply(ctx) {
  try { consumeQueueIfEarly(ctx) } catch (e) { console.log('[dsh-session-mover] boot-time queue error: ' + String((e && e.message) || e)) }

  // 兜底：若本次启动时机偏晚（插件在 bundles 里排得靠后），改在 harness 退出时消费队列。
  // 退出阶段 registry 已不再写盘，因此不会出现「改了又被内存状态覆盖」。
  // 这样插件就不再依赖加载顺序 —— 分发给别人时不要求改任何配置。
  ctx.effect(() => {
    return () => {
      try {
        const left = readQueue().items || []
        if (left.length === 0) return
        console.log('[dsh-session-mover] dispose: consuming ' + left.length + ' queued operation(s)...')
        const failed = []
        for (const item of left) {
          const tag = String(item.sessionId).slice(0, 20)
          try {
            let r
            if (item.action === 'unarchive') {
              r = executeUnarchive({ sessionsRoot: SESSIONS_ROOT, workspaceFile: WORKSPACE_FILE, sessionId: item.sessionId, dryRun: false })
            } else if (item.action === 'delete') {
              r = deleteSession({ sessionsRoot: SESSIONS_ROOT, workspaceFile: WORKSPACE_FILE, projcacheDir: PROJCACHE_DIR, backupRoot: BACKUP_ROOT, sessionId: item.sessionId, dryRun: false })
            } else {
              r = executeMove({ sessionsRoot: SESSIONS_ROOT, workspaceFile: WORKSPACE_FILE, projcacheDir: PROJCACHE_DIR, backupRoot: BACKUP_ROOT, sessionId: item.sessionId, toCwd: item.targetPath, workspaceId: item.targetWorkspaceId, unarchive: item.unarchive, dryRun: false })
            }
            if (r.ok) console.log('  OK   ' + tag)
            else { console.log('  FAIL ' + tag + '  ' + String(r.error)); failed.push(item) }
          } catch (e) {
            console.log('  FAIL ' + tag + '  ' + String((e && e.message) || e))
            failed.push(item)
          }
        }
        writeQueue({ items: failed })
        console.log('[dsh-session-mover] dispose queue done; remaining=' + failed.length)
      } catch (e) {
        console.log('[dsh-session-mover] dispose error: ' + String((e && e.message) || e))
      }
    }
  }, 'dsh-session-mover: pending queue on dispose')

  ctx.inject(['webServer'], (ctx) => {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-session-mover',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') return send(res, 200, { ok: true, state: state() })
        const body = await readBody(req)
        const method = body.method

        if (method === 'state') return send(res, 200, { ok: true, state: state() })

        if (method === 'queue') {
          const sid = body.sessionId
          const targetPath = body.targetPath
          const action = (body.action === 'unarchive' || body.action === 'delete') ? body.action : 'move'
          if (!sid) return send(res, 400, { ok: false, error: 'bad request' })
          if (action === 'move' && !targetPath) return send(res, 400, { ok: false, error: 'bad request' })
          const q = readQueue()
          const items = q.items.filter((i) => i.sessionId !== sid)
          items.push({
            sessionId: sid,
            action: action,
            targetWorkspaceId: body.targetWorkspaceId || null,
            targetPath: targetPath || null,
            unarchive: action === 'unarchive' ? true : !!body.unarchive,
            queuedAt: new Date().toISOString(),
          })
          writeQueue({ items })
          return send(res, 200, { ok: true, queued: items.length, state: state() })
        }

        if (method === 'unqueue') {
          const q = readQueue()
          writeQueue({ items: q.items.filter((i) => i.sessionId !== body.sessionId) })
          return send(res, 200, { ok: true, state: state() })
        }

        if (method === 'clear') {
          writeQueue({ items: [] })
          return send(res, 200, { ok: true, state: state() })
        }

        return send(res, 400, { ok: false, error: 'unknown method' })
      } catch (e) {
        return send(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  }), 'dsh-session-mover: http route')
  })
}
