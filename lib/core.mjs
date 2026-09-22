/**
 * dsh-session-mover — 核心引擎
 *
 * 会话文件是「多帧拼接的 zstd」：第一帧独占 header 行，后续帧是事件批次。
 * 迁移只重压第一帧（改 cwd），其余帧字节原样搬 —— 事件数据零改动。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = 0xFD2FB528

/** 与 dsh 的 projectKey 逐字对齐：分隔符折叠成 '-'，非 ASCII -> ~XXXX */
export function projectKey(cwd) {
  if (!cwd || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = '', sepRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i), ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!sepRun) readable += '-'
      sepRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch; sepRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0'); sepRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** 扫描拼接的 zstd 帧边界 */
export function scanFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    const start = off
    if (buf.length - off < 4) return { frames, tornStart: off }
    if (buf.readUInt32LE(off) !== MAGIC) throw new Error('bad zstd magic at ' + off)
    off += 4
    const fhd = buf[off++]
    const fcsFlag = (fhd >> 6) & 3, single = (fhd >> 5) & 1
    const checksum = (fhd >> 2) & 1, didFlag = fhd & 3
    if (!single) off += 1
    off += [0, 1, 2, 4][didFlag]
    let fcsSize = [1, 2, 4, 8][fcsFlag]
    if (fcsFlag === 0 && !single) fcsSize = 0
    off += fcsSize
    for (;;) {
      if (off + 3 > buf.length) return { frames, tornStart: start }
      const bh = buf.readUIntLE(off, 3); off += 3
      const last = bh & 1, type = (bh >> 1) & 3, size = bh >>> 3
      if (type === 3) throw new Error('reserved zstd block type')
      off += type === 1 ? 1 : size
      if (off > buf.length) return { frames, tornStart: start }
      if (last) break
    }
    if (checksum) off += 4
    if (off > buf.length) return { frames, tornStart: start }
    frames.push({ start, end: off, checksumFlag: checksum })
  }
  return { frames }
}

/** 读一个会话文件的 header 与帧结构 */
export function readSession(file) {
  const buf = fs.readFileSync(file)
  const { frames, tornStart } = scanFrames(buf)
  if (frames.length === 0) throw new Error('no zstd frame in ' + file)
  if (tornStart !== undefined) throw new Error('torn zstd frame at ' + tornStart)
  const first = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8')
  const nl = first.indexOf('\n')
  const headerLine = nl < 0 ? first : first.slice(0, nl)
  return { buf, frames, header: JSON.parse(headerLine), tailOfFrame: nl < 0 ? '' : first.slice(nl + 1) }
}

/** 生成「换了 cwd」的新文件内容：只重压第一帧 */
export function rewriteCwdBuffer(sess, newCwd) {
  const header = { ...sess.header, cwd: newCwd }
  const firstText = JSON.stringify(header) + '\n' + sess.tailOfFrame
  const firstFrame = zlib.zstdCompressSync(Buffer.from(firstText, 'utf8'), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: sess.frames[0].checksumFlag },
  })
  return Buffer.concat([firstFrame, sess.buf.subarray(sess.frames[0].end)])
}

/**
 * 在一个会话目录里挑选**当前代际**的日志文件。
 *
 * 目录里可能同时存在多个代际：`session.jsonl.zstd`（v0 老格式）与
 * `session.v3.jsonl.zstd`（v3 当前格式）。DSH 读的是版本号最高的那个，
 * 所以这里也必须按版本号取最大 —— 不能依赖 readdir 的返回顺序（那是未定义行为，
 * 曾经因此差点改错文件）。
 * @param files - 该会话目录下的全部文件名
 * @returns 当前代际的文件名，或 undefined
 */
export function pickCurrentLog(files) {
  let best
  let bestVersion = -1
  for (const f of files) {
    let v = -1
    const m = /^session\.v([0-9]+)\.jsonl\.zstd$/.exec(f)
    if (m) v = parseInt(m[1], 10)
    else if (f === 'session.jsonl.zstd' || f === 'session.jsonl') v = 0
    else continue
    if (v > bestVersion) { bestVersion = v; best = f }
  }
  return best
}
/** 在 sessions 根下按 id 找会话目录 */
export function findSession(sessionsRoot, sessionId) {
  for (const projDir of fs.readdirSync(sessionsRoot)) {
    const p = path.join(sessionsRoot, projDir)
    let st
    try { st = fs.statSync(p) } catch { continue }
    if (!st.isDirectory()) continue
    for (const sdir of fs.readdirSync(p)) {
      if (!sdir.includes(sessionId)) continue
      const sp = path.join(p, sdir)
      let st2
      try { st2 = fs.statSync(sp) } catch { continue }
      if (!st2.isDirectory()) continue
      const logFile = pickCurrentLog(fs.readdirSync(sp))
      if (!logFile) continue
      return { dir: sp, dirName: sdir, projDir, file: path.join(sp, logFile), logFile }
    }
  }
  return undefined
}

function readTitle(projcacheDir, id) {
  if (!projcacheDir) return null
  try {
    const j = JSON.parse(fs.readFileSync(path.join(projcacheDir, id + '.json'), 'utf8'))
    const t = j && j.record && j.record.rows && j.record.rows.title
    return (t && t.val) || null
  } catch { return null }
}

/** 全量会话清单（带归属与归档状态） */
export function listSessions({ sessionsRoot, workspaceState, projcacheDir }) {
  const owner = new Map()
  for (const [wid, rec] of Object.entries(workspaceState.tables.workspaces))
    for (const sid of rec.sessionIds) owner.set(sid, { workspaceId: wid, path: rec.path, title: rec.title })
  const archived = new Set(workspaceState.global.archivedSessionIds || [])
  const rows = []
  for (const projDir of fs.readdirSync(sessionsRoot)) {
    const p = path.join(sessionsRoot, projDir)
    let st; try { st = fs.statSync(p) } catch { continue }
    if (!st.isDirectory()) continue
    for (const sdir of fs.readdirSync(p)) {
      const sp = path.join(p, sdir)
      let st2; try { st2 = fs.statSync(sp) } catch { continue }
      if (!st2.isDirectory()) continue
      const logFile = pickCurrentLog(fs.readdirSync(sp))
      if (!logFile) continue
      const full = path.join(sp, logFile)
      let header = null
      try { header = readSession(full).header } catch (e) { header = { id: sdir, cwd: '(error: ' + e.message + ')' } }
      const id = header.id || sdir
      rows.push({
        sessionId: id,
        cwd: header.cwd,
        title: readTitle(projcacheDir, id),
        origin: header.origin || null,
        delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : 0,
        parentSession: header.parentSession || null,
        workspaceId: owner.has(id) ? owner.get(id).workspaceId : null,
        workspacePath: owner.has(id) ? owner.get(id).path : null,
        archived: archived.has(id),
        bytes: fs.statSync(full).size,
        logFile,
        projDir,
      })
    }
  }
  return rows
}

/** 执行一次迁移（返回结果对象，不抛业务错） */
export function executeMove(opts) {
  const { sessionsRoot, workspaceFile, projcacheDir, backupRoot, sessionId, toCwd, workspaceId, unarchive, dryRun } = opts
  const loc = findSession(sessionsRoot, sessionId)
  if (!loc) return { ok: false, error: 'session not found: ' + sessionId }
  const sess = readSession(loc.file)
  const id = sess.header.id
  const oldCwd = sess.header.cwd
  const targetCwd = toCwd || oldCwd
  const needRelocate = targetCwd !== oldCwd

  const wsRaw = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'))
  const plan = {
    ok: true, sessionId: id, oldCwd, targetCwd, needRelocate,
    fromDir: loc.dir, workspaceId: workspaceId || null, unarchive: !!unarchive, dryRun: !!dryRun,
  }
  if (dryRun) return plan

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  plan.stamp = stamp

  // 1. 备份
  const prevBackups = fs.existsSync(backupRoot)
    ? fs.readdirSync(backupRoot).filter(function (n) { return n.startsWith(id + '__') })
    : []
  const backupDir = path.join(backupRoot, id + '__' + stamp)
  fs.mkdirSync(backupDir, { recursive: true })
  fs.cpSync(loc.dir, backupDir, { recursive: true })
  plan.backupDir = backupDir
  plan.prunedBackups = []
  for (const n of prevBackups) {
    try { fs.rmSync(path.join(backupRoot, n), { recursive: true, force: true }); plan.prunedBackups.push(n) } catch { }
  }

  // 2. 需要搬目录时：写新文件 -> 校验 -> 才移除旧目录
  if (needRelocate) {
    const newBuf = rewriteCwdBuffer(sess, targetCwd)
    const newProjDir = path.join(sessionsRoot, projectKey(targetCwd))
    const newDir = path.join(newProjDir, loc.dirName)
    fs.mkdirSync(newDir, { recursive: true })
    const newFile = path.join(newDir, loc.logFile)
    fs.writeFileSync(newFile, newBuf)
    const chk = readSession(newFile)
    if (chk.header.cwd !== targetCwd) return { ok: false, error: 'verification failed; original dir kept', backupDir }
    plan.newDir = newDir
    fs.rmSync(loc.dir, { recursive: true, force: true })
  }

  // 3. workspace.json
  let changed = false
  for (const rec of Object.values(wsRaw.tables.workspaces)) {
    const i = rec.sessionIds.indexOf(id)
    if (i >= 0) { rec.sessionIds.splice(i, 1); changed = true }
  }
  if (workspaceId) {
    const rec = wsRaw.tables.workspaces[workspaceId]
    if (!rec) return { ok: false, error: 'unknown workspaceId: ' + workspaceId, backupDir }
    if (!rec.sessionIds.includes(id)) { rec.sessionIds.unshift(id); changed = true }
    plan.attachedTo = rec.path
  }
  if (unarchive) {
    const i = wsRaw.global.archivedSessionIds.indexOf(id)
    if (i >= 0) { wsRaw.global.archivedSessionIds.splice(i, 1); changed = true }
  }
  if (changed) {
    writeWorkspaceBackup(workspaceFile, stamp)
    fs.writeFileSync(workspaceFile, JSON.stringify(wsRaw, null, 2))
  }
  plan.workspaceChanged = changed

  // 4. projcache（明文缓存，重建即可）
  const pc = path.join(projcacheDir, id + '.json')
  if (fs.existsSync(pc)) { fs.rmSync(pc); plan.projcacheCleared = true }

  return plan
}
/**
 * 原地「接续」归档会话：不搬目录、不动 cwd、不动归属，
 * 只把该 id 从 workspace.json 的 archivedSessionIds 移除。
 */
export function executeUnarchive({ sessionsRoot, workspaceFile, sessionId, dryRun }) {
  const loc = findSession(sessionsRoot, sessionId)
  if (!loc) return { ok: false, error: 'session not found: ' + sessionId }
  const sess = readSession(loc.file)
  const id = sess.header.id
  const wsRaw = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'))
  const archived = wsRaw.global.archivedSessionIds || []
  const idx = archived.indexOf(id)
  const plan = {
    ok: true, action: 'unarchive', sessionId: id, oldCwd: sess.header.cwd,
    targetCwd: sess.header.cwd, needRelocate: false,
    wasArchived: idx >= 0, dryRun: !!dryRun,
  }
  if (dryRun || idx < 0) return plan
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeWorkspaceBackup(workspaceFile, stamp)
  archived.splice(idx, 1)
  fs.writeFileSync(workspaceFile, JSON.stringify(wsRaw, null, 2))
  plan.workspaceChanged = true
  plan.stamp = stamp
  return plan
}
/**
 * 删除一个会话：不是物理抹除，而是把会话目录**移动**到回收站目录
 * （backupRoot/deleted/<id>__<stamp>/），同时清理 workspace.json 与 projcache。
 * 需要释放空间时手动清空该目录即可。
 */
export function deleteSession({ sessionsRoot, workspaceFile, projcacheDir, backupRoot, sessionId, dryRun }) {
  const loc = findSession(sessionsRoot, sessionId)
  if (!loc) return { ok: false, error: 'session not found: ' + sessionId }
  const sess = readSession(loc.file)
  const id = sess.header.id
  const title = null
  const plan = {
    ok: true, action: 'delete', sessionId: id, title: title,
    cwd: sess.header.cwd, fromDir: loc.dir, dryRun: !!dryRun,
  }
  if (dryRun) return plan

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  plan.stamp = stamp

  // 1. 会话目录 -> 回收站（复制 + 移除，因为可能跨卷）
  const trashDir = path.join(backupRoot, 'deleted', id + '__' + stamp)
  fs.mkdirSync(path.dirname(trashDir), { recursive: true })
  fs.cpSync(loc.dir, trashDir, { recursive: true })
  plan.trashDir = trashDir
  fs.rmSync(loc.dir, { recursive: true, force: true })

  // 2. workspace.json：移出归属 + 移出归档集合
  const wsRaw = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'))
  let changed = false
  for (const rec of Object.values(wsRaw.tables.workspaces)) {
    const i = rec.sessionIds.indexOf(id)
    if (i >= 0) { rec.sessionIds.splice(i, 1); changed = true }
  }
  const arch = wsRaw.global.archivedSessionIds || []
  const ai = arch.indexOf(id)
  if (ai >= 0) { arch.splice(ai, 1); changed = true }
  if (changed) {
    writeWorkspaceBackup(workspaceFile, stamp)
    fs.writeFileSync(workspaceFile, JSON.stringify(wsRaw, null, 2))
  }
  plan.workspaceChanged = changed

  // 3. projcache 一并进回收站
  const pc = path.join(projcacheDir, id + '.json')
  if (fs.existsSync(pc)) {
    try { fs.renameSync(pc, path.join(trashDir, 'projcache.json')) }
    catch { fs.copyFileSync(pc, path.join(trashDir, 'projcache.json')); fs.rmSync(pc) }
    plan.projcacheCleared = true
  }
  return plan
}

function writeWorkspaceBackup(workspaceFile, stamp) {
  const dir = path.dirname(workspaceFile)
  const base = path.basename(workspaceFile)
  const keep = base + '.' + stamp + '.bak'
  const target = workspaceFile + '.' + stamp + '.bak'
  fs.copyFileSync(workspaceFile, target)
  try {
    for (const n of fs.readdirSync(dir)) {
      if (n !== keep && n.startsWith(base + '.') && n.endsWith('.bak')) {
        try { fs.rmSync(path.join(dir, n), { force: true }) } catch { }
      }
    }
  } catch { }
  return target
}