// Electron 메인 프로세스.
// 하는 일은 두 가지뿐이다: (1) 창 띄우기, (2) 감시 대상 프로젝트의
// `.claude/team-events.jsonl`을 tail 해서 새 줄을 렌더러로 보내기.
//
// 파일 감시는 fs.watch가 아니라 **폴링**이다. Windows에서 fs.watch는 "덧붙이기"를
// 놓치거나 중복 이벤트를 주는 일이 잦고, 우리가 읽는 건 append-only 로그라
// 크기 비교가 훨씬 단순하고 정확하다.

const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const fs = require('fs')
const path = require('path')

const POLL_MS = 300
const CONFIG_NAME = 'config.json'

let win = null
let watch = null // { file, offset, timer, tail }

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

  send('watch:status', { projectDir, file, exists: fs.existsSync(file) })

  watch.timer = setInterval(() => pump(replay), POLL_MS)
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
    },
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
  const prompt =
    agent && agent !== 'lead'
      ? `${agent} 서브에이전트를 사용해서 다음을 처리해줘: ${body}`
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
    child.unref()
    return { ok: true, spawned: true }
  } catch (err) {
    return { ok: false, error: `claude 실행 실패: ${err.message}` }
  }
})
