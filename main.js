// Electron 메인 프로세스.
// 하는 일은 세 가지다: (1) 창 띄우기, (2) 감시 대상 프로젝트들의
// `.claude/team-events.jsonl`을 tail 해서 새 줄을 렌더러로 보내기,
// (3) **회사를 운영하기** — 앱에서 보낸 지시를 앱이 직접 받아 실행한다.
//
// 프로젝트는 **최대 3개까지 동시에** 붙일 수 있다. 각 프로젝트가 자기 회사를
// 갖고 독립적으로 일한다. 서로 간섭하지 않는 이유는 규약이 전부 프로젝트 폴더
// 안에 있기 때문이다 — 클레임·대기열·이벤트가 모두 `<프로젝트>/.claude/` 아래다.
// 화면(사무실)은 한 번에 하나만 보여 준다. 셋을 나란히 그리면 배율이 1/3로
// 떨어져 도트가 뭉개지고, 통행 격자(layout.js)도 사무실마다 따로 들어야 한다.
//
// 파일 감시는 fs.watch가 아니라 **폴링**이다. Windows에서 fs.watch는 "덧붙이기"를
// 놓치거나 중복 이벤트를 주는 일이 잦고, 우리가 읽는 건 append-only 로그라
// 크기 비교가 훨씬 단순하고 정확하다.

const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const POLL_MS = 300
const CONFIG_NAME = 'config.json'
// 회사 클레임은 30초에 한 번 갱신되므로 자주 볼 이유가 없다.
const WORKER_POLL_MS = 2000
const WORKER_TTL_S = 600 // 훅의 WORKER_TTL과 같은 값. 넘으면 죽은 클레임으로 본다.
const CLAIM_REFRESH_MS = 30_000 // 훅의 WORKER_REFRESH와 같은 값
const QUEUE_POLL_MS = 1000 // 대기열을 얼마나 자주 들여다볼지
const WORKER_NAME = 'team-worker.json'
const CANCEL_NAME = 'team-cancel.flag'
const COMMANDS_NAME = 'team-commands.jsonl'

// 동시에 붙일 수 있는 프로젝트 수. 늘리기 전에 생각할 것: 회사 하나가 claude를
// 하나씩 띄우므로 N개면 claude가 N개 동시에 돈다(토큰도 N배).
const MAX_PROJECTS = 3

let win = null
const watches = new Map() // dir -> { file, offset, tail, exists, replay }
const companies = new Map() // dir -> { dir, claimTimer, queueTimer, child, hasSession }
let activeDir = null // 화면에 사무실을 그리고 있는 프로젝트
let pumpTimer = null // 모든 감시를 한 타이머로 돌린다(프로젝트마다 두지 않는다)
let lastStatusJson = '' // 상태가 바뀔 때만 렌더러로 보내기 위한 직전 값

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

/**
 * 감시 목록.
 *
 * 예전 설정은 `projectDir` 하나였다. 그대로 두면 앱을 업데이트한 사람의 목록이
 * 빈 채로 뜨므로 읽을 때 옮겨 준다(쓸 때 `projectDir`은 지운다).
 */
function loadProjects() {
  const cfg = loadConfig()
  const list = Array.isArray(cfg.projects)
    ? cfg.projects
    : cfg.projectDir
      ? [cfg.projectDir]
      : []
  return list.filter((d) => typeof d === 'string' && d).slice(0, MAX_PROJECTS)
}

function saveProjects(list) {
  const cfg = loadConfig()
  delete cfg.projectDir // 예전 키를 남겨 두면 다음에 또 마이그레이션된다
  saveConfig({ ...cfg, projects: list, activeDir })
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function eventsFileFor(projectDir) {
  return path.join(projectDir, '.claude', 'team-events.jsonl')
}

/**
 * 회사가 문을 열었는가 — 즉 앱에서 보낸 지시를 받아 줄 주체가 있는가.
 *
 *   'open'    — 이 앱이 그 프로젝트의 대기열을 맡고 있다.
 *   'busy'    — 회사가 열려 있고, 지금 지시 하나를 실행하는 중이다.
 *   'foreign' — 다른 주체(다른 앱 창·예전 방식의 워커 세션)가 클레임을 쥐고 있다.
 *   'closed'  — 아무도 안 맡고 있다. **보낸 지시가 처리되지 않는다.**
 *
 * 'closed'를 화면에 드러내는 것이 이 함수의 존재 이유다. 회사가 닫힌 것과 그냥
 * 조용한 것은 화면에서 구분되지 않아, 지시가 안 먹히는 걸 세 시간 동안 못 알아챘다.
 */
function companyState(dir) {
  // 우리가 맡고 있으면 파일을 볼 필요가 없다 — 우리가 진실이다.
  const c = companies.get(dir)
  if (c) return c.child ? 'busy' : 'open'
  let at = 0
  try {
    at = Number(JSON.parse(fs.readFileSync(claimPath(dir), 'utf8')).at) || 0
  } catch {
    return 'closed' // 없거나 읽을 수 없는 클레임은 믿지 않는다
  }
  return Date.now() / 1000 - at > WORKER_TTL_S ? 'closed' : 'foreign'
}

/** 아직 아무도 안 집어간 지시 수. 탭 배지에 "대기 N건"으로 뜬다. */
function pendingCount(dir) {
  try {
    return fs
      .readFileSync(path.join(dir, '.claude', COMMANDS_NAME), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim()).length
  } catch {
    return 0
  }
}

let lastStatusAt = 0

/**
 * 프로젝트 전체의 상태를 렌더러로. **바뀌었을 때만** 보낸다(300ms마다 도배하지 않게).
 *
 * 보이지 않는 프로젝트도 여기 담긴다 — 탭 배지가 "저쪽이 지금 일하는 중"을
 * 보여줘야 하기 때문이다. 그게 없으면 다른 탭이 멈춘 건지 도는 건지 알 수 없다.
 */
function pumpStatusAll({ force = false } = {}) {
  const now = Date.now()
  if (!force && now - lastStatusAt < WORKER_POLL_MS) return
  lastStatusAt = now
  const projects = loadProjects().map((dir) => ({
    dir,
    exists: watches.get(dir)?.exists ?? false,
    company: companyState(dir),
    queued: pendingCount(dir),
  }))
  const payload = { projects, activeDir, max: MAX_PROJECTS }
  const json = JSON.stringify(payload)
  if (!force && json === lastStatusJson) return
  lastStatusJson = json
  send('projects:status', payload)
}

/** 감시 타이머는 **하나뿐**이다. 프로젝트마다 두면 3배로 깨어난다. */
function ensurePump() {
  if (pumpTimer) return
  pumpTimer = setInterval(() => {
    for (const dir of [...watches.keys()]) pump(dir)
    pumpStatusAll()
  }, POLL_MS)
}

function stopWatching(dir) {
  watches.delete(dir)
  if (!watches.size && pumpTimer) {
    clearInterval(pumpTimer)
    pumpTimer = null
  }
}

/**
 * 프로젝트 폴더를 감시한다. 파일이 아직 없어도 실패가 아니다 —
 * 훅이 첫 이벤트를 쓰는 순간부터 따라간다.
 */
function startWatching(dir, { replay = true } = {}) {
  if (!dir) return
  const file = eventsFileFor(dir)
  let offset = 0
  // 앱을 나중에 켰어도 최근 활동은 보여준다. 처음부터 읽되, 렌더러가
  // "지난 것"으로 취급하도록 replay 플래그를 붙인다.
  if (!replay) {
    try {
      offset = fs.statSync(file).size
    } catch {
      /* 파일이 없으면 0에서 시작 */
    }
  }
  watches.set(dir, { file, offset, tail: '', exists: false, replay })
  ensurePump()
}

/**
 * 새 줄을 읽어 렌더러로 넘긴다.
 *
 * **활성 프로젝트가 아니면 파싱하지 않고 오프셋만 넘긴다.** 배지에 필요한 것은
 * 회사 상태와 대기 건수뿐이고 그 둘은 파일에서 직접 읽는다. 보이지도 않는
 * 사무실의 시뮬레이션을 셋씩 돌릴 이유가 없다 — 탭을 옮기면 그 프로젝트를
 * 처음부터 다시 읽어(activate) 현재 모습을 복원한다.
 */
function pump(dir) {
  const w = watches.get(dir)
  if (!w) return
  let size
  try {
    size = fs.statSync(w.file).size
  } catch {
    w.exists = false
    return // 아직 파일 없음 — 조용히 기다린다
  }
  w.exists = true

  if (size < w.offset) {
    // 파일이 잘렸다(새 세션이 로그를 비웠거나 회전). 처음부터 다시 읽는다.
    w.offset = 0
    w.tail = ''
    if (dir === activeDir) send('events:reset', { dir })
  }
  if (size === w.offset) return

  let chunk = ''
  try {
    const fd = fs.openSync(w.file, 'r')
    const len = size - w.offset
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, w.offset)
    fs.closeSync(fd)
    chunk = buf.toString('utf8')
    w.offset = size
  } catch {
    return
  }

  if (dir !== activeDir) {
    w.tail = ''
    return // 안 보이는 사무실 — 오프셋만 따라간다
  }

  const isReplay = w.replay
  w.replay = false

  // 훅이 줄을 쓰는 도중에 읽었을 수 있다. 마지막 조각은 다음 턴으로 넘긴다.
  const text = w.tail + chunk
  const lines = text.split('\n')
  w.tail = lines.pop() ?? ''

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
  if (events.length) send('events:new', { dir, events })
}

/**
 * 화면에 그릴 프로젝트를 바꾼다.
 *
 * 비활성 프로젝트는 이벤트를 파싱하지 않으므로(위 pump), 전환하면 그 사무실을
 * **처음부터 다시 읽어** 지금 모습을 복원한다. 렌더러는 events:reset을 받고
 * 상태를 비운 뒤 흘러오는 replay를 다시 적용한다.
 */
function activate(dir) {
  if (!dir || !watches.has(dir)) return
  activeDir = dir
  saveProjects(loadProjects())
  send('events:reset', { dir })
  const w = watches.get(dir)
  w.offset = 0
  w.tail = ''
  w.replay = true
  pump(dir)
  pumpStatusAll({ force: true })
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

  win.webContents.once('did-finish-load', () => {
    const projects = loadProjects()
    const saved = loadConfig().activeDir
    activeDir = projects.includes(saved) ? saved : (projects[0] ?? null)
    // **보이지 않아도 회사는 연다.** 탭에 없는 프로젝트가 일을 멈추면 "동시에
    // 세 개"가 성립하지 않는다. 화면만 하나일 뿐이다.
    for (const dir of projects) {
      openCompany(dir)
      startWatching(dir, { replay: dir === activeDir })
    }
    pumpStatusAll({ force: true })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  for (const dir of [...watches.keys()]) stopWatching(dir)
  closeAllCompanies() // 창을 닫으면 회사도 문을 닫는다
  if (process.platform !== 'darwin') app.quit()
})

// 종료 경로가 여럿이라 여기서도 정리한다. 클레임을 남긴 채 죽으면 그 프로젝트는
// TTL(10분)이 지날 때까지 "다른 회사가 맡고 있음"으로 보여 지시가 멈춘다.
app.on('before-quit', closeAllCompanies)

/** 프로젝트를 하나 더 붙인다. 상한(3개)에 걸리면 거절하고 이유를 돌려준다. */
ipcMain.handle('project:add', async () => {
  const projects = loadProjects()
  if (projects.length >= MAX_PROJECTS) {
    return { ok: false, error: `동시에 붙일 수 있는 프로젝트는 ${MAX_PROJECTS}개까지입니다` }
  }
  const res = await dialog.showOpenDialog(win, {
    title: '추가할 프로젝트 폴더 선택',
    properties: ['openDirectory'],
  })
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true }
  const dir = res.filePaths[0]
  if (projects.includes(dir)) return { ok: false, error: '이미 붙어 있는 프로젝트입니다' }

  const next = [...projects, dir]
  activeDir = dir // 방금 고른 것을 바로 보여 준다
  saveProjects(next)
  openCompany(dir)
  startWatching(dir, { replay: true })
  send('events:reset', { dir })
  pumpStatusAll({ force: true })
  return { ok: true, dir, hooked: fs.existsSync(path.join(dir, '.claude')) }
})

/** 프로젝트를 뗀다. 그 회사는 문을 닫고 진행 중이던 일도 멈춘다. */
ipcMain.handle('project:remove', (_e, dir) => {
  const next = loadProjects().filter((d) => d !== dir)
  closeCompany(dir)
  stopWatching(dir)
  if (activeDir === dir) activeDir = next[0] ?? null
  saveProjects(next)
  if (activeDir) activate(activeDir)
  else send('events:reset', { dir: null })
  pumpStatusAll({ force: true })
  return { ok: true, activeDir }
})

/** 화면에 보여 줄 프로젝트를 바꾼다(나머지는 계속 일한다). */
ipcMain.handle('project:activate', (_e, dir) => {
  activate(dir)
  return { ok: true, activeDir }
})

ipcMain.handle('project:list', () => {
  pumpStatusAll({ force: true })
  return { projects: loadProjects(), activeDir, max: MAX_PROJECTS }
})

// 클립보드는 **메인 프로세스**에서 쓴다. 샌드박스가 켜진 preload에서는 electron의
// clipboard 모듈을 못 불러온다(undefined라 호출 즉시 예외가 났다).
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text ?? ''))
  return true
})

// ---------------------------------------------------------------------------
// 회사
//
// 팀뷰는 **하나의 기업체**다. 앱이 켜져 있으면 회사가 문을 연 것이고, 앱에서 보낸
// 지시는 언제나 회사가 받는다. 사람이 다른 창에서 클로드와 대화하고 있어도 그
// 세션으로 지시가 새어 들어가지 않는다. 예전에는 "새 세션으로 즉시 실행" 체크박스로
// 그걸 사람이 매번 골라야 했는데, 끄고 보내면 지시가 **그때 마침 턴을 끝내는 아무
// 세션**에게 갔다. 회사가 하나면 고를 것도 없다.
//
// 지시를 회사 것으로 묶어 주는 장치가 `.claude/team-worker.json` 클레임이다.
// 훅(team_events.py)은 살아 있는 `mode: "poller"` 클레임을 보면 대기열을 아예
// 건드리지 않는다. 예전에는 이 클레임을 **대화형 워커 세션**이 적었는데, 갱신이
// 훅이 돌 때만 일어나서 워커가 조용하면 10분 뒤 만료됐다. 그러면 훅의 마지막
// 폴백("아무 세션이나 처리한다")으로 떨어져 사람과 대화하던 세션이 지시를 집어갔다.
// 이제 클레임을 **앱이** 적는다. 앱은 대화를 하지 않으니 조용해질 일이 없다.
// ---------------------------------------------------------------------------

// 회사는 프로젝트마다 하나씩이다(companies Map). 진행 중인 claude는 회사가
// 자기 `child`로 들고 있다 — 예전에는 전역 Set 하나에 모아 뒀는데, 회사가
// 여럿이면 **A에서 누른 취소가 B·C가 돌리던 작업까지 죽인다.**

function claimPath(projectDir) {
  return path.join(projectDir, '.claude', WORKER_NAME)
}

/**
 * "지금 이 회사가 대기열을 맡고 있다"고 적는다.
 *
 * `session_id`를 함께 적는 이유: 훅의 read_claim()이 이 키가 없는 클레임을 통째로
 * 버린다. 앱은 세션이 아니므로 pid로 유일한 이름을 만든다.
 */
function writeClaim(projectDir) {
  try {
    fs.writeFileSync(
      claimPath(projectDir),
      JSON.stringify({
        mode: 'poller',
        session_id: `teamview-app:${process.pid}`,
        pid: process.pid,
        at: Date.now() / 1000,
      }),
      'utf8',
    )
  } catch {
    /* .claude가 없는 폴더면 클레임도 의미가 없다 */
  }
}

/** 우리 클레임일 때만 지운다. 다른 회사가 이어받았다면 남의 것을 건드리지 않는다. */
function clearClaim(projectDir) {
  try {
    if (JSON.parse(fs.readFileSync(claimPath(projectDir), 'utf8')).pid !== process.pid) return
    fs.unlinkSync(claimPath(projectDir))
  } catch {
    /* 없으면 그만 */
  }
}

/**
 * 이 회사가 돌리던 claude를 죽인다. **다른 회사 것은 건드리지 않는다.**
 *
 * Windows에서는 `shell: true`로 띄운 자식이 **cmd 래퍼**라 그 pid만 죽이면 정작
 * claude는 살아남는다. taskkill로 트리째 정리한다.
 */
function killChild(c) {
  const child = c?.child
  if (!child) return 0
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(child.pid)
    }
  } catch {
    return 0 // 이미 끝난 프로세스
  }
  c.child = null
  return 1
}

/**
 * 대기열에서 **한 건만** 꺼내고 나머지는 파일에 남긴다.
 *
 * 통째로 들고 오지 않는 이유: 한 건을 처리하는 동안 취소가 들어오면 아직 시작하지
 * 않은 나머지는 버려져야 한다. 메모리로 들고 있으면 취소(파일 삭제)가 그것들에
 * 닿지 못해, 취소를 눌러도 뒤이어 계속 실행된다.
 */
function takeOneCommand(claudeDir) {
  const qf = path.join(claudeDir, COMMANDS_NAME)
  let lines
  try {
    lines = fs
      .readFileSync(qf, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
  } catch {
    return null // 대기열 없음 — 평상시다
  }
  let taken = null
  const rest = []
  for (const line of lines) {
    let c = null
    try {
      c = JSON.parse(line)
    } catch {
      continue // 깨진 줄 하나 때문에 멈추지 않는다
    }
    if (!taken && c.status === 'pending') taken = c
    else rest.push(line)
  }
  if (!taken) return null
  // **꺼냈으면 반드시 지운다.** 못 지우면 다음 폴에서 같은 지시를 또 집어 두 번
  // 실행된다. Windows의 공유 위반은 순간적이라 몇 번 다시 해 본다.
  for (let i = 0; i < 3; i++) {
    try {
      if (rest.length) fs.writeFileSync(qf, rest.join('\n') + '\n', 'utf8')
      else fs.unlinkSync(qf)
      return taken
    } catch {
      /* 곧바로 재시도 */
    }
  }
  return null // 지우지 못했으면 아예 집지 않는다 — 중복 실행보다 지연이 낫다
}

// 담당을 콕 집어 보내도 **그 역할에 맞는 일인지 먼저 보게 한다.** 프론트를 골라
// 놓고 기획안 수정을 보내면 프론트가 기획서를 고치고 있었다. 사람이 고른 담당은
// 지시일 뿐 판단이 아니다.
const HANDOFF =
  ` 맡기기 전에 이 일이 그 팀원의 역할에 맞는지 먼저 판단해줘.` +
  ` 맞지 않으면 억지로 시키지 말고 성격에 맞는 팀원에게 넘겨.` +
  ` 어느 쪽이든 누구에게 맡겼는지 한 줄로 밝혀줘.`

function promptFor(cmd) {
  const who = cmd.agent
  const body = String(cmd.text ?? '')
  return who && who !== 'lead'
    ? `다음 지시를 ${who} 서브에이전트에게 맡기려 해.${HANDOFF} 지시: ${body}`
    : `다음 지시를 읽고 성격에 맞는 서브에이전트에게 위임해서 처리해줘.` +
        ` 직접 처리하지 말고 Task 도구를 쓰고, 여러 파트가 걸리면 planner로 나눈 뒤 각자에게 넘겨줘.` +
        ` 지시: ${body}`
}

// 파일 편집을 물어보지 않고 승인한다.
//
// **이건 안전장치를 내리는 설정이다.** 그래도 필요한 이유: 회사는 `claude -p`로
// 도는 비대화형 세션이라 권한을 물어볼 상대가 없다. 물으면 답이 없어 그냥 멈춘다.
// 실제로 board 프로젝트에서 리드가 Write를 시도했다가 "파일 쓰기 권한이 없어
// 중단했습니다"로 두 번 끝났다 — 화면에는 그냥 조용한 것과 구분되지 않았다.
//
// 지금까지의 대안은 프로젝트마다 `settings.json`에 허용 목록을 쌓는 것이었는데
// (한 프로젝트는 그렇게 216줄이 쌓였다) 새 프로젝트를 붙일 때마다 처음부터
// 다시 겪는다. 팀뷰에 보내는 지시는 애초에 "알아서 해줘"가 전제이므로 여기서 연다.
//
// `bypassPermissions`가 아니라 `acceptEdits`인 이유: 파일 편집만 열고 나머지는
// 평소 규칙을 그대로 따르게 둔다. 열 이유가 없는 것까지 열지 않는다.
const PERMISSION_MODE = 'acceptEdits'

/**
 * 지시 하나를 회사에 태운다.
 *
 * `--continue`로 이전 대화를 이어받아 **회사의 기억을 유지한다.** 매번 새 세션이면
 * "아까 그거 계속해줘"가 통하지 않는다. 다만 이어받을 세션이 없는 첫 실행에는
 * 붙이지 않는다 — 없는 세션을 이어받으려다 실패하면 그 지시가 통째로 날아간다.
 *
 * `TEAMVIEW_POLLER`는 훅이 "이 세션은 회사가 띄운 것"이라고 알아보는 표식이다.
 * 이게 있어야 그 세션의 활동이 화면에 기록되고, 취소 깃발을 훅이 함부로 내리지 않는다.
 */
function runCommand(c, cmd) {
  const dir = c.dir
  const args = ['-p', '--permission-mode', PERMISSION_MODE]
  if (c.hasSession) args.push('--continue')
  args.push(promptFor(cmd))

  let child
  try {
    child = spawn('claude', args, {
      cwd: dir,
      shell: true, // Windows에서 claude는 .cmd 래퍼다
      stdio: 'ignore',
      env: { ...process.env, TEAMVIEW_POLLER: String(process.pid) },
    })
  } catch (err) {
    logRenderer(`회사 실행 실패(${dir}): ${err.message}`)
    return
  }

  c.child = child
  pumpStatusAll({ force: true })

  child.on('error', (err) => logRenderer(`claude 실행 실패(${dir}): ${err.message}`))
  child.on('exit', (code) => {
    if (c.child === child) {
      c.child = null
      // 성공했을 때만 다음부터 이어받는다. 실패한 실행을 이어받으면 그 오류 상태가
      // 계속 따라다닌다.
      if (code === 0) c.hasSession = true
    }
    // 훅은 회사가 띄운 세션에서 취소 깃발을 **지우지 않는다**(지우면 곧바로 다음
    // 지시를 집어가 "취소했는데 계속 일한다"가 된다). 실행이 끝난 지금 회사가 내린다.
    try {
      fs.unlinkSync(path.join(dir, '.claude', CANCEL_NAME))
    } catch {
      /* 없으면 그만 */
    }
    pumpStatusAll({ force: true })
  })
}

/** 그 회사의 대기열을 한 번 들여다본다. 회사는 **한 번에 한 건만** 처리한다. */
function pumpQueue(c) {
  if (!c || c.child) return
  const claudeDir = path.join(c.dir, '.claude')
  // 취소 직후에는 새 지시를 시작하지 않는다. 깃발은 실행이 끝나며 내려간다.
  if (fs.existsSync(path.join(claudeDir, CANCEL_NAME))) return
  const cmd = takeOneCommand(claudeDir)
  if (cmd) runCommand(c, cmd)
}

/**
 * 그 프로젝트의 회사 문을 연다. 이미 열려 있으면 그대로 둔다.
 *
 * 회사들은 서로를 모른다 — 클레임·대기열·이벤트가 전부 자기 프로젝트 폴더 안에
 * 있어서 간섭할 통로가 없다.
 */
function openCompany(dir) {
  if (!dir || companies.has(dir)) return
  // 훅이 없는 폴더에서는 회사를 열 수 없다 — 지시를 적어도 아무도 읽지 못한다.
  if (!fs.existsSync(path.join(dir, '.claude'))) return
  const c = { dir, claimTimer: null, queueTimer: null, child: null, hasSession: false }
  companies.set(dir, c)
  writeClaim(dir)
  c.claimTimer = setInterval(() => writeClaim(dir), CLAIM_REFRESH_MS)
  c.queueTimer = setInterval(() => pumpQueue(c), QUEUE_POLL_MS)
}

/**
 * 회사 문을 닫는다. **실행 중이던 일도 멈춘다.**
 * 앱을 껐는데 백그라운드에서 파일이 계속 고쳐지고 있으면 놀랄 일이다.
 */
function closeCompany(dir) {
  const c = companies.get(dir)
  if (!c) return
  clearInterval(c.claimTimer)
  clearInterval(c.queueTimer)
  killChild(c)
  clearClaim(c.dir)
  companies.delete(dir)
}

function closeAllCompanies() {
  for (const dir of [...companies.keys()]) closeCompany(dir)
}

/**
 * 세 가지를 한꺼번에 한다.
 *   1. 아직 안 집어간 대기열을 버린다
 *   2. 회사가 띄운 claude 프로세스를 죽인다
 *   3. **이미 돌고 있는 세션**을 멈추도록 취소 깃발을 세운다
 *
 * 3번이 핵심이다. 밖에서 남의 세션을 죽일 수는 없지만, PreToolUse 훅이 이 깃발을
 * 보면 다음 도구 호출을 deny 한다 — 에이전트는 도구를 못 쓰고 이유를 읽고 멈춘다.
 * 깃발에 시각을 적어 두고, 훅은 오래된 깃발을 무시한다(눌러 놓고 잊은 취소가
 * 다음 작업을 잡아먹지 않도록).
 */
ipcMain.handle('command:cancel', (_e, dir) => {
  const projectDir = dir || activeDir
  // **그 프로젝트만** 취소한다. 예전에는 앱이 띄운 프로세스를 전역 Set 하나에
  // 모아 뒀는데, 회사가 여럿이면 A에서 누른 취소가 B·C까지 죽였다.
  if (!projectDir) return { ok: false, error: '프로젝트가 선택되지 않았습니다' }
  let queued = 0
  let flagged = false
  const claudeDir = path.join(projectDir, '.claude')
  const qf = path.join(claudeDir, COMMANDS_NAME)
  try {
    if (fs.existsSync(qf)) {
      queued = fs.readFileSync(qf, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length
      fs.unlinkSync(qf)
    }
  } catch {
    /* 이미 없으면 그만 */
  }
  try {
    fs.writeFileSync(path.join(claudeDir, CANCEL_NAME), String(Date.now() / 1000), 'utf8')
    flagged = true
  } catch {
    /* 훅이 없는 프로젝트면 깃발도 의미가 없다 */
  }
  const killed = killChild(companies.get(projectDir))
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
  pumpStatusAll({ force: true })
  return { ok: true, queued, killed, flagged }
})

// ---------------------------------------------------------------------------
// 개별 지시 전달
//
// 하는 일은 하나다: `.claude/team-commands.jsonl`에 한 줄 쓴다. 그 줄을 집어가는
// 것은 **언제나 회사**다(위 pumpQueue). 보내는 쪽에 고를 것이 없다 — 예전에는
// "새 세션으로 즉시 실행" 체크박스가 있었고, 끄고 보내면 지시가 그때 마침 턴을
// 끝내는 아무 세션에게 갔다. 회사가 하나뿐이면 그 갈림길 자체가 없다.
// ---------------------------------------------------------------------------

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
}

ipcMain.handle('command:send', async (_e, { dir, agent, text, broadcast }) => {
  const projectDir = dir || activeDir
  if (!projectDir) return { ok: false, error: '프로젝트가 선택되지 않았습니다' }
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, error: '내용이 비어 있습니다' }

  const claudeDir = path.join(projectDir, '.claude')
  if (!fs.existsSync(claudeDir)) {
    return { ok: false, error: `.claude 폴더가 없습니다: ${claudeDir}` }
  }

  const ts = Date.now() / 1000
  try {
    appendJsonl(path.join(claudeDir, COMMANDS_NAME), {
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

  // 1초 폴을 기다리지 않고 곧바로 들여다본다. 보내자마자 팀이 움직여야 한다.
  const c = companies.get(projectDir)
  const busy = Boolean(c && c.child)
  if (c) pumpQueue(c)
  pumpStatusAll({ force: true })
  // 회사가 닫혀 있으면 지시는 파일에 남지만 아무도 집어가지 않는다. 숨기지 않는다.
  return { ok: true, dir: projectDir, companyOpen: Boolean(c), busy }
})
