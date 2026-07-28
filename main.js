// Electron 메인 프로세스.
// 하는 일은 두 가지뿐이다: (1) 창 띄우기, (2) 감시 대상 프로젝트의
// `.claude/team-events.jsonl`을 tail 해서 새 줄을 렌더러로 보내기.
//
// 파일 감시는 fs.watch가 아니라 **폴링**이다. Windows에서 fs.watch는 "덧붙이기"를
// 놓치거나 중복 이벤트를 주는 일이 잦고, 우리가 읽는 건 append-only 로그라
// 크기 비교가 훨씬 단순하고 정확하다.

const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron')
const fs = require('fs')
const path = require('path')

const POLL_MS = 300
const CONFIG_NAME = 'config.json'
// 워커 클레임은 30초에 한 번 갱신되므로 자주 볼 이유가 없다.
const WORKER_POLL_MS = 2000
const WORKER_TTL_S = 600 // 훅의 WORKER_TTL과 같은 값. 넘으면 죽은 워커로 본다.

let win = null
let watch = null // { file, offset, timer, tail, exists, worker, workerAt }

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_NAME)
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
  } catch (e) {
    console.error('설정 저장 실패:', e.message)
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function eventsFileFor(projectDir) {
  return path.join(projectDir, '.claude', 'team-events.jsonl')
}

/**
 * 지시를 처리할 워커 세션이 살아 있는가.
 *
 *   'none' — 클레임 파일 자체가 없다. 워커를 쓰지 않는 기존 방식이므로 정상이다.
 *   'live' — 최근에 갱신된 클레임이 있다.
 *   'dead' — 클레임은 있는데 오래됐다. **보낸 지시가 아무도 처리하지 않는다.**
 *
 * 'dead'를 화면에 드러내는 것이 이 함수의 존재 이유다. 워커가 꺼진 것과 그냥
 * 조용한 것은 화면에서 구분되지 않아, 지시가 안 먹히는 걸 세 시간 동안 못 알아챘다.
 */
function workerState(projectDir) {
  let raw
  try {
    raw = fs.readFileSync(path.join(projectDir, '.claude', 'team-worker.json'), 'utf8')
  } catch {
    return 'none'
  }
  let at = 0
  try {
    at = Number(JSON.parse(raw).at) || 0
  } catch {
    return 'dead' // 읽을 수 없는 클레임은 믿지 않는다
  }
  return Date.now() / 1000 - at > WORKER_TTL_S ? 'dead' : 'live'
}

/** 상태줄에 필요한 것이 바뀌었을 때만 렌더러로 보낸다(300ms마다 도배하지 않게). */
function pumpStatus(projectDir, { force = false } = {}) {
  if (!watch) return
  const now = Date.now()
  if (!force && now - (watch.workerAt ?? 0) < WORKER_POLL_MS) return
  watch.workerAt = now
  const worker = workerState(projectDir)
  const exists = fs.existsSync(watch.file)
  if (!force && worker === watch.worker && exists === watch.exists) return
  watch.worker = worker
  watch.exists = exists
  send('watch:status', { projectDir, file: watch.file, exists, worker })
}

function stopWatching() {
  if (watch?.timer) clearInterval(watch.timer)
  watch = null
}

/**
 * 프로젝트 폴더를 감시한다. 파일이 아직 없어도 실패가 아니다 —
 * 훅이 첫 이벤트를 쓰는 순간부터 따라간다.
 */
function startWatching(projectDir, { replay = true } = {}) {
  stopWatching()
  if (!projectDir) return

  const file = eventsFileFor(projectDir)
  watch = { file, offset: 0, tail: '', timer: null }

  // 앱을 나중에 켰어도 최근 활동은 보여준다. 처음부터 읽되, 렌더러가
  // "지난 것"으로 취급하도록 replay 플래그를 붙인다.
  if (!replay) {
    try {
      watch.offset = fs.statSync(file).size
    } catch {
      /* 파일이 없으면 0에서 시작 */
    }
  }

  pumpStatus(projectDir, { force: true })

  watch.timer = setInterval(() => {
    pump(replay)
    pumpStatus(projectDir)
  }, POLL_MS)
  pump(replay)
  replay = false
}

function pump(isReplay) {
  if (!watch) return
  let size
  try {
    size = fs.statSync(watch.file).size
  } catch {
    return // 아직 파일 없음 — 조용히 기다린다
  }

  if (size < watch.offset) {
    // 파일이 잘렸다(새 세션이 로그를 비웠거나 회전). 처음부터 다시 읽는다.
    watch.offset = 0
    watch.tail = ''
    send('events:reset', null)
  }
  if (size === watch.offset) return

  let chunk = ''
  try {
    const fd = fs.openSync(watch.file, 'r')
    const len = size - watch.offset
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, watch.offset)
    fs.closeSync(fd)
    chunk = buf.toString('utf8')
    watch.offset = size
  } catch (e) {
    return
  }

  // 훅이 줄을 쓰는 도중에 읽었을 수 있다. 마지막 조각은 다음 턴으로 넘긴다.
  const text = watch.tail + chunk
  const lines = text.split('\n')
  watch.tail = lines.pop() ?? ''

  const events = []
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    try {
      const ev = JSON.parse(s)
      ev._replay = Boolean(isReplay)
      events.push(ev)
    } catch {
      // 깨진 줄 하나 때문에 멈추지 않는다
    }
  }
  if (events.length) send('events:new', events)
}

/**
 * 렌더러 오류를 **파일로** 남긴다.
 *
 * Electron은 Windows에서 GUI 서브시스템 앱이라 stdout/stderr이 콘솔에 붙지 않는다.
 * console.error로만 찍다가 화면이 까맣게 죽었는데 로그는 텅 빈 상황을 겪었다.
 * 경로는 창 제목줄에서 확인할 수 없으니 시작할 때 한 줄 적어 둔다.
 */
function rendererLogPath() {
  return path.join(app.getPath('userData'), 'renderer.log')
}

function logRenderer(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  console.error('[renderer]', line)
  try {
    fs.appendFileSync(rendererLogPath(), stamped + '\n', 'utf8')
  } catch {
    /* 로그를 못 남기는 것이 앱을 멈출 이유는 아니다 */
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1820,
    height: 1120,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#11131a',
    autoHideMenuBar: true,
    title: 'Team View — 우리 팀 사무실',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 창이 가려지면 Chromium이 requestAnimationFrame을 멈춘다. 보통은 배터리를
      // 아끼는 좋은 기본값이지만 **이 앱은 다른 창 뒤에서 보라고 만든 것**이다.
      // 껐다 켜면 그동안 팀이 멈춰 있었던 것처럼 보인다. 그래서 끈다.
      backgroundThrottling: false,
    },
  })
  // 렌더러가 죽으면 창은 그냥 까맣게 남고 아무 단서도 없다. 세 번 당했다.
  // 콘솔 오류와 로드 실패를 메인 stdout으로 끌어와 터미널에서 바로 보이게 한다.
  // Electron 버전에 따라 (event, level, message, line, source)로도, event 하나로도 온다.
  // 예전 서명만 보고 있다가 **오류를 통째로 놓쳤다** — 창은 까맣고 로그는 비어 있었다.
  win.webContents.on('console-message', (...args) => {
    const e = args[0]
    const level = typeof args[1] === 'number' ? args[1] : e?.level
    const message = typeof args[2] === 'string' ? args[2] : e?.message
    const line = typeof args[3] === 'number' ? args[3] : e?.lineNumber
    const source = typeof args[4] === 'string' ? args[4] : e?.sourceId
    if (level === 2 || level === 3 || level === 'warning' || level === 'error') {
      logRenderer(`${message}  (${source}:${line})`)
    }
  })
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    logRenderer(`로드 실패 ${code} ${desc} — ${url}`)
  })
  win.webContents.on('render-process-gone', (e, details) => {
    logRenderer(`렌더러 프로세스 종료: ${details.reason}`)
  })
  win.webContents.on('preload-error', (e, preloadPath, err) => {
    logRenderer(`preload 오류 ${preloadPath}: ${err.message}`)
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()

  const cfg = loadConfig()
  win.webContents.once('did-finish-load', () => {
    if (cfg.projectDir) startWatching(cfg.projectDir)
    else send('watch:status', { projectDir: null, file: null, exists: false })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopWatching()
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('project:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '감시할 프로젝트 폴더 선택',
    properties: ['openDirectory'],
  })
  if (res.canceled || !res.filePaths[0]) return null
  const projectDir = res.filePaths[0]
  saveConfig({ ...loadConfig(), projectDir })
  startWatching(projectDir)
  return projectDir
})

ipcMain.handle('project:current', () => loadConfig().projectDir ?? null)

// 클립보드는 **메인 프로세스**에서 쓴다. 샌드박스가 켜진 preload에서는 electron의
// clipboard 모듈을 못 불러온다(undefined라 호출 즉시 예외가 났다).
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text ?? ''))
  return true
})

// 앱이 띄운 claude 프로세스들. 취소할 때 이걸 정리한다.
const spawned = new Set()

/**
 * 세 가지를 한꺼번에 한다.
 *   1. 아직 안 집어간 대기열을 버린다
 *   2. 앱이 띄운 claude 프로세스를 죽인다
 *   3. **이미 돌고 있는 세션**을 멈추도록 취소 깃발을 세운다
 *
 * 3번이 핵심이다. 밖에서 남의 세션을 죽일 수는 없지만, PreToolUse 훅이 이 깃발을
 * 보면 다음 도구 호출을 deny 한다 — 에이전트는 도구를 못 쓰고 이유를 읽고 멈춘다.
 * 깃발에 시각을 적어 두고, 훅은 오래된 깃발을 무시한다(눌러 놓고 잊은 취소가
 * 다음 작업을 잡아먹지 않도록).
 */
ipcMain.handle('command:cancel', () => {
  const projectDir = loadConfig().projectDir
  let queued = 0
  let flagged = false
  if (projectDir) {
    const claudeDir = path.join(projectDir, '.claude')
    const qf = path.join(claudeDir, 'team-commands.jsonl')
    try {
      if (fs.existsSync(qf)) {
        queued = fs.readFileSync(qf, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length
        fs.unlinkSync(qf)
      }
    } catch {
      /* 이미 없으면 그만 */
    }
    try {
      fs.writeFileSync(path.join(claudeDir, 'team-cancel.flag'), String(Date.now() / 1000), 'utf8')
      flagged = true
    } catch {
      /* 훅이 없는 프로젝트면 깃발도 의미가 없다 */
    }
  }
  let killed = 0
  for (const child of spawned) {
    try {
      process.kill(child.pid)
      killed++
    } catch {
      /* 이미 끝난 프로세스 */
    }
    spawned.delete(child)
  }
  if (projectDir) {
    try {
      appendJsonl(eventsFileFor(projectDir), {
        ts: Date.now() / 1000,
        type: 'cancel',
        agent: 'lead',
        detail: `취소 — 대기 ${queued}건${killed ? ` · 실행 ${killed}건 중단` : ''}`,
      })
    } catch {
      /* 기록 실패가 취소를 막지는 않는다 */
    }
  }
  return { ok: true, queued, killed, flagged }
})

// ---------------------------------------------------------------------------
// 개별 지시 전달
//
// 기본 동작은 **대기열에 넣기**다: `.claude/team-commands.jsonl`에 한 줄 쓰고,
// 그 프로젝트에 설치된 team_events.py 훅이 세션이 한 턴을 끝낼 때(Stop) 집어간다.
// 즉 지금 돌고 있는 세션에 끼워 넣는 방식이라 새 프로세스가 뜨지 않는다.
//
// spawn=true면 `claude -p`로 **새 프로세스를 띄워 즉시** 실행한다. 자율적으로 파일을
// 고칠 수 있는 동작이라 기본값은 꺼져 있고, 사용자가 체크박스로 켤 때만 실행한다.
// ---------------------------------------------------------------------------

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
}

ipcMain.handle('command:send', async (_e, { agent, text, spawn: doSpawn, broadcast }) => {
  const projectDir = loadConfig().projectDir
  if (!projectDir) return { ok: false, error: '프로젝트가 선택되지 않았습니다' }
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, error: '내용이 비어 있습니다' }

  const claudeDir = path.join(projectDir, '.claude')
  if (!fs.existsSync(claudeDir)) {
    return { ok: false, error: `.claude 폴더가 없습니다: ${claudeDir}` }
  }

  const ts = Date.now() / 1000
  try {
    appendJsonl(path.join(claudeDir, 'team-commands.jsonl'), {
      ts,
      // 전체 지시는 리드가 받아 알아서 팀에 나눈다(특정 서브에이전트를 지정하지 않는다)
      agent: broadcast ? 'lead' : agent,
      text: body,
      status: 'pending',
    })
    // 화면에도 즉시 반영한다. 이건 실제로 일어난 일(지시 전달)이므로 가짜 활동이 아니다.
    appendJsonl(eventsFileFor(projectDir), {
      ts,
      type: 'command',
      agent,
      detail: body.slice(0, 60),
    })
  } catch (err) {
    return { ok: false, error: `기록 실패: ${err.message}` }
  }

  if (!doSpawn) return { ok: true, spawned: false }

  // 새 Claude Code 프로세스로 즉시 실행
  // 담당이 지정돼 있으면 그 팀원에게, 아니면 **내용을 읽고 알아서** 고르게 한다.
  // 규칙(정규식)으로 나누던 것을 걷어냈다 - 문장의 뜻을 읽는 일은 모델이 낫다.
  // 담당을 콕 집어 보내도 **그 역할에 맞는 일인지 먼저 보게 한다.** 프론트를 골라
  // 놓고 기획안 수정을 보내면 프론트가 기획서를 고치고 있었다. 사람이 고른 담당은
  // 지시일 뿐 판단이 아니다.
  const HANDOFF =
    ` 맡기기 전에 이 일이 그 팀원의 역할에 맞는지 먼저 판단해줘.` +
    ` 맞지 않으면 억지로 시키지 말고 성격에 맞는 팀원에게 넘겨.` +
    ` 어느 쪽이든 누구에게 맡겼는지 한 줄로 밝혀줘.`

  const prompt =
    agent && agent !== 'lead'
      ? `다음 지시를 ${agent} 서브에이전트에게 맡기려 해.${HANDOFF} 지시: ${body}`
      : `다음 지시를 읽고 성격에 맞는 서브에이전트에게 위임해서 처리해줘.` +
        ` 직접 처리하지 말고 Task 도구를 쓰고, 여러 파트가 걸리면 planner로 나눈 뒤 각자에게 넘겨줘.` +
        ` 지시: ${body}`
  try {
    const { spawn } = require('child_process')
    const child = spawn('claude', ['-p', prompt], {
      cwd: projectDir,
      shell: true, // Windows에서 claude는 .cmd 래퍼다
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', (err) => console.error('claude 실행 실패:', err.message))
    child.on('exit', () => spawned.delete(child))
    spawned.add(child)
    child.unref()
    return { ok: true, spawned: true }
  } catch (err) {
    return { ok: false, error: `claude 실행 실패: ${err.message}` }
  }
})
