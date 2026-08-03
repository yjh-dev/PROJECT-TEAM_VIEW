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

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Notification } = require('electron')
const { spawn, execFile, execFileSync } = require('child_process')
const crypto = require('crypto')
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
// 화면이 죽었을 때 "그때 무엇을 하고 있었는지"를 적기 위한 것들.
// **죽은 뒤에는 물어볼 수 없으므로** 살아 있는 동안 받아 둔다.
let crashCount = 0
const CRASH_RELOAD_MAX = 3
let lastVitals = null // 렌더러가 주기적으로 보내는 상태
const bootAt = Date.now()
// 창이 지금 사용자 눈앞에 있는지. 창 이벤트로만 갱신한다(getter는 못 믿는다 —
// notifyDone의 주석 참고).
let winFocused = false
const watches = new Map() // dir -> { file, offset, tail, exists, replay }
const companies = new Map() // dir -> { dir, claimTimer, queueTimer, child }
let activeDir = null // 화면에 사무실을 그리고 있는 프로젝트
let pumpTimer = null // 모든 감시를 한 타이머로 돌린다(프로젝트마다 두지 않는다)
let lastStatusJson = '' // 상태가 바뀔 때만 렌더러로 보내기 위한 직전 값

// 설정·좌석·대화 기록이 사는 곳은 `%APPDATA%\<package.json의 name>`이다.
// 표시 이름은 '윤사무실'이지만 name은 `team-view`로 남겨 뒀다 — 바꾸는 순간
// Electron이 빈 새 폴더를 보게 돼 붙여 둔 프로젝트·좌석·대화 기록이 통째로 고아가 된다.
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

// 붙인 프로젝트가 윤사무실과 일할 준비가 됐는지 검사한 결과를 잠깐 들고 있는다.
// 이 파일들은 자주 바뀌지 않으므로 상태를 갱신할 때마다 디스크를 뒤질 이유가 없다.
const healthCache = new Map() // dir -> { at, health }
const HEALTH_TTL_MS = 10_000

function countAgentFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length
  } catch {
    return 0
  }
}

/**
 * 이 프로젝트가 윤사무실과 일할 준비가 됐는가.
 *
 * 셋 중 하나라도 빠지면 붙여도 원하는 대로 움직이지 않는다. 그런데 지금까지는
 * **붙여서 지시를 보내보고, 안 움직이는 걸 보고 나서야** 알 수 있었다. 실제로
 * 어떤 프로젝트는 훅만 깔려 있고 팀원이 없어서 리드가 혼자 일했는데, 그걸
 * 알아내려고 이벤트 로그를 집계해야 했다. 화면이 미리 말해 줬어야 하는 일이다.
 *
 *   hooks  — 훅이 설치되고 settings에 **등록**됐는가. 없으면 활동이 기록되지 않는다.
 *   agents — 부를 팀원이 있는가. 없으면 **리드가 혼자 다 한다.**
 *   guide  — CLAUDE.md가 있는가. 없으면 어떤 일이 누구 몫인지 리드가 알 수 없다.
 */
function projectHealth(dir) {
  const hit = healthCache.get(dir)
  if (hit && Date.now() - hit.at < HEALTH_TTL_MS) return hit.health

  const claudeDir = path.join(dir, '.claude')
  // 훅은 파일만 있어서는 안 된다 — settings에 등록돼야 실제로 돈다.
  let hooks = false
  for (const name of ['settings.json', 'settings.local.json']) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(claudeDir, name), 'utf8'))
      if (JSON.stringify(cfg.hooks ?? {}).includes('team_events')) hooks = true
    } catch {
      /* 없거나 깨진 설정은 '없음'으로 본다 */
    }
  }
  // 사용자 전역(~/.claude/agents)에 둔 팀원도 그 프로젝트에서 부를 수 있다.
  const agents =
    countAgentFiles(path.join(claudeDir, 'agents')) +
    countAgentFiles(path.join(app.getPath('home'), '.claude', 'agents'))

  const health = {
    hooks,
    agents,
    guide: fs.existsSync(path.join(dir, 'CLAUDE.md')),
    stale: agents ? staleAgents(dir) : 0, // 팀원이 아예 없으면 '낡음'이 아니라 '없음'이다
    // 훅도 낡는다. **팀원 정의만 보고 있었더니 훅 수정이 기존 프로젝트에 영영
    // 닿지 않았다** — `rm -rf`가 44자에서 잘리던 문제를 고쳐도, 이미 세팅된
    // 프로젝트는 옛 훅 그대로라 화면에는 여전히 잘린 명령이 찍힌다.
    hookStale: staleHook(dir),
    // 지침도 낡는다. 팀원 정의와 훅만 보고 있었더니 **CLAUDE.md의 팀 규칙이 옛것으로
    // 남았다** — 검수를 마지막 관문으로 바꾼 뒤에도 이미 세팅된 프로젝트에는
    // "테스트가 필요한 규모면 부릅니다"가 그대로 있어 새 규칙과 정면으로 부딪혔다.
    guideStale: staleGuide(dir),
    // **되돌릴 수단이 있는가.**
    //
    // 회사는 확인 없이 파일을 고치고 지운다(`bypassPermissions`). 실제로 한 작업에서
    // `rm -rf`가 여러 번 돌았다. git이 아니면 그걸 되돌릴 방법이 아무것도 없는데,
    // 그동안 앱은 확인조차 하지 않았다 — README에만 "버전 관리되는 폴더에 붙이세요"
    // 라고 적혀 있었고, 정작 붙여 둔 프로젝트 둘 다 git이 아니었다.
    git: !!gitRoot(dir),
    stack: detectStack(dir),
  }
  healthCache.set(dir, { at: Date.now(), health })
  return health
}

// ---------------------------------------------------------------------------
// 대화 보관
//
// 지금까지 채팅은 메모리에만 있어서 **앱을 끄면 사라졌다.** 무엇을 시켰고 팀이 뭐라
// 답했는지가 유일하게 남는 곳인데, 다시 켜면 빈 화면이었다.
//
// **프로젝트 폴더에 쓰지 않는다.** 남의 작업 폴더에 앱이 파일을 남기면 커밋에 섞이고
// 지우기도 애매하다. 앱 데이터 폴더에 프로젝트별로 따로 둔다.
// ---------------------------------------------------------------------------

// **한 시간짜리 작업이면 200줄로는 앞부분이 통째로 안 보인다.** 실측: ConvertFlow에
// 901줄, daily에 591줄이 저장돼 있는데 화면에는 마지막 200줄만 올라왔다 — 기획·설계
// 단계에서 무슨 이야기가 오갔는지 볼 방법이 없었다.
const CHAT_KEEP = 1000 // 화면이 들고 있는 줄 수와 같게
const CHAT_MAX_LINES = 5000 // 이보다 커지면 뒤쪽만 남기고 정리한다

function chatPath(dir) {
  const enc = String(dir).replace(/[^a-zA-Z0-9]/g, '-').slice(-120)
  return path.join(app.getPath('userData'), 'chats', `${enc}.jsonl`)
}

function loadChat(dir) {
  try {
    const lines = fs.readFileSync(chatPath(dir), 'utf8').split(/\r?\n/).filter((l) => l.trim())
    return lines.slice(-CHAT_KEEP).map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

function appendChat(dir, msg) {
  const file = chatPath(dir)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(msg) + '\n', 'utf8')
    // 무한정 커지지 않게 가끔 뒤쪽만 남긴다. 매번 세면 비싸니 append 뒤 크기로 가늠한다.
    if (fs.statSync(file).size > CHAT_MAX_LINES * 400) {
      const kept = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-CHAT_KEEP)
      fs.writeFileSync(file, kept.join('\n') + '\n', 'utf8')
    }
  } catch {
    /* 대화를 못 남기는 것이 앱을 멈출 이유는 아니다 */
  }
}

// ---------------------------------------------------------------------------
// 실행 환경 — 윤사무실은 Claude Code 위에서 돈다
//
// 팀원이 실제로 일하려면 (1) claude CLI가 깔려 있고 (2) 로그인돼 있어야 한다.
// 기획·화면설계는 Figma에 만들므로 (3) Figma MCP 연결도 필요하다.
//
// 셋 다 **명령으로 확인할 수 있다.** 짐작하지 않는다.
//   claude auth status → {"loggedIn":true,"email":...,"subscriptionType":"max"}
//   claude mcp list    → "figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected"
//
// 로그인 자체는 앱 안에서 못 한다. 둘 다 **브라우저 OAuth**라 창을 띄워 주고
// 끝났는지 지켜보는 것이 앱이 할 수 있는 전부다.
// ---------------------------------------------------------------------------

/** 명령을 한 번 돌리고 출력을 받는다. 실패해도 던지지 않는다. */
function runCmd(cmd, args, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { shell: true, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ err, out: String(stdout ?? ''), errOut: String(stderr ?? '') }),
    )
  })
}

const runClaude = (args, t) => runCmd('claude', args, t)

/** 명령을 찾을 수 없다는 응답인가. 메시지는 셸·언어마다 달라 넓게 본다. */
const NOT_FOUND = /not recognized|command not found|ENOENT|없는 명령|찾을 수 없습니다|is not recognized/i

/**
 * 윤사무실이 돌려면 이 컴퓨터에 있어야 하는 것들.
 *
 * **앱만 복사해서는 동작하지 않는다.** 윤사무실은 claude CLI를 띄우고, 그 활동은 python
 * 훅이 기록한다. 다른 PC에 exe만 옮기면 화면은 뜨지만 아무 일도 일어나지 않는데,
 * 무엇이 없어서인지 알 방법이 없다. 그래서 이름을 붙여 하나씩 확인한다.
 *
 * `install`이 있는 것만 앱이 대신 실행해 줄 수 있다(그것도 **동의를 받은 뒤**).
 * 나머지는 설치 프로그램을 받아야 하므로 공식 페이지를 열어 주는 데서 멈춘다 —
 * 남의 컴퓨터에 설치 파일을 내려받아 실행하는 일까지 앱이 하지는 않는다.
 */
const REQUIREMENTS = [
  {
    key: 'node',
    label: 'Node.js',
    probe: ['node', ['--version']],
    why: 'Claude Code를 설치·실행하는 데 필요합니다',
    url: 'https://nodejs.org/ko/download',
  },
  {
    key: 'python',
    label: 'Python',
    probe: ['python', ['--version']],
    why: '팀 활동을 화면에 기록하는 훅이 python으로 돕니다. 없으면 사무실이 조용합니다',
    url: 'https://www.python.org/downloads/',
  },
  {
    key: 'claude',
    label: 'Claude Code',
    probe: ['claude', ['--version']],
    why: '팀원이 실제로 일하는 실행기입니다',
    install: ['npm', ['i', '-g', '@anthropic-ai/claude-code']],
    needs: 'node',
  },
  {
    key: 'git',
    label: 'Git',
    probe: ['git', ['--version']],
    why: '회사는 권한을 묻지 않고 파일을 고칩니다. 되돌릴 수단은 git뿐입니다',
    url: 'https://git-scm.com/downloads',
    optional: true,
  },
]

/** 설치된 것과 빠진 것을 가른다. */
async function checkRequirements() {
  const out = []
  for (const r of REQUIREMENTS) {
    const res = await runCmd(r.probe[0], r.probe[1], 10_000)
    const combined = res.out + res.errOut
    const ok = !NOT_FOUND.test(combined) && !(res.err && !res.out.trim())
    out.push({
      key: r.key,
      label: r.label,
      why: r.why,
      url: r.url ?? null,
      optional: Boolean(r.optional),
      canInstall: Boolean(r.install),
      installed: ok,
      version: ok ? combined.trim().split(/\r?\n/)[0].slice(0, 40) : null,
    })
  }
  return out
}

let envCache = null
// 로그인 상태는 자주 바뀌지 않는다. 반면 `claude mcp list`는 서버마다 헬스 체크를 해
// 몇 초씩 걸린다 — 상태 점을 계속 켜 두려면 캐시가 넉넉해야 한다.
const ENV_TTL_MS = 5 * 60_000

/**
 * `claude auth status`(출력은 JSON이 기본)를 읽어 **누구로 로그인돼 있는지**까지 알아낸다.
 *
 * **절대 던지지 않는다.** 환경 확인이 앱을 막으면 안 된다 — CLI가 올라가 출력 모양이
 * 바뀌든, 안내 문구가 섞여 오든, 아무 말도 없든 "로그인 안 됨"으로 떨어질 뿐이어야 한다.
 * 예전에 여기서 던져서 창이 비었던 적이 있다.
 *
 * `orgId`는 **일부러 읽지 않는다.** 화면에 보여줄 값이 아니고, 응답이나 로그에 남을
 * 이유도 없다. 읽지 않으면 샐 수도 없다.
 */
function parseAuthStatus(text) {
  const blank = { loggedIn: false, email: null, orgName: null, subscriptionType: null, authMethod: null }
  const s = String(text ?? '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return blank
  let j = null
  try {
    j = JSON.parse(s.slice(a, b + 1))
  } catch {
    return blank // JSON이 아니면 로그인 안 된 것으로 본다(예전 동작 그대로)
  }
  // 로그인했을 때만 계정 정보를 담는다. 로그아웃 응답에 값이 남아 있어도 새면 안 된다.
  if (!j || typeof j !== 'object' || !j.loggedIn) return blank
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null)
  return {
    loggedIn: true,
    email: str(j.email),
    orgName: str(j.orgName),
    subscriptionType: str(j.subscriptionType),
    authMethod: str(j.authMethod),
  }
}

/**
 * 지금 이 컴퓨터가 윤사무실을 쓸 수 있는 상태인가.
 *
 * `claude mcp list`는 서버마다 헬스 체크를 해서 몇 초 걸린다. 그래서 결과를 캐시하고,
 * 로그인 창을 띄운 뒤처럼 **바뀌었을 법한 순간에만** 강제로 다시 본다.
 */
async function checkEnv({ force = false } = {}) {
  if (!force && envCache && Date.now() - envCache.at < ENV_TTL_MS) return envCache.value

  const value = {
    claude: {
      installed: false,
      loggedIn: false,
      email: null,
      orgName: null,
      subscriptionType: null,
      authMethod: null,
      plan: null,
    },
    figma: { connected: false, present: false },
  }

  const auth = await runClaude(['auth', 'status'])
  const combined = auth.out + auth.errOut
  const notFound = NOT_FOUND.test(combined)
  value.claude.installed = !notFound
  if (!notFound) {
    Object.assign(value.claude, parseAuthStatus(auth.out))
    // plan은 이 값이 생기기 전부터 화면이 쓰던 이름이다. 그대로 채워 둔다.
    value.claude.plan = value.claude.subscriptionType ?? value.claude.authMethod ?? null
  }

  // 로그인도 안 된 상태에서 MCP를 물어봐야 의미가 없다(느리기만 하다).
  if (value.claude.loggedIn) {
    const mcp = await runClaude(['mcp', 'list'])
    // **이름이 정확히 `figma`인 줄만 센다.** 같은 목록에 `claude.ai Figma`(claude.ai 계정에
    // 붙은 커넥터)가 이미 `✔ Connected`로 떠 있을 수 있지만, 그것을 "연결됨"으로 쳐 주면
    // 안 된다 — claude.ai 커넥터는 도구 이름이 `mcp__claude_ai_Figma__*`로 붙는데(실측:
    // 지난 세션 기록에 `mcp__claude_ai_Gmail__*`·`mcp__claude_ai_Google_Drive__*`가 그대로
    // 남아 있다), 화면설계를 맡는 ux-designer의 `tools:`는 `mcp__figma__*`만 허용한다.
    // 커넥터를 인정하면 배너는 초록인데 팀원은 "Figma가 연결되지 않았습니다"라고 보고한다.
    const line = (mcp.out + mcp.errOut).split(/\r?\n/).find((l) => /^\s*figma\s*:/i.test(l))
    value.figma.present = Boolean(line)
    value.figma.connected = Boolean(line && /connected/i.test(line) && !/needs auth/i.test(line))
  }

  envCache = { at: Date.now(), value }
  return value
}

/**
 * cmd.exe가 삼키면 안 되는 글자들. cmd는 `&`·`|`·`<`·`>`를 만나면 그 자리에서 명령을
 * 갈라 버리고, `%`는 환경변수로 펼치며, `"`는 우리가 만든 인용을 깨뜨린다.
 * 지금 인자는 전부 고정 문자열이지만, 나중에 사용자 입력이 섞여도 여기서 막힌다.
 */
const CMD_UNSAFE = /["&|<>^%()\r\n]/

/** 공백이 있는 토큰만 인용한다. cmd는 `\"` 이스케이프를 모르므로 홑겹으로만 감싼다. */
function quoteForCmd(token) {
  return /\s/.test(token) ? `"${token}"` : token
}

/**
 * 로그인 창을 띄운다. **새 콘솔 창**으로 여는 이유는 둘 다 사람이 손으로 끝내야 하는
 * 대화형 절차이기 때문이다(브라우저가 열리고 코드를 붙여넣는 식). 앱이 stdio를
 * 가로채면 그 과정을 볼 수도 마칠 수도 없다.
 */
function openInTerminal(args, title, exe = 'claude') {
  // 다른 OS는 기본 터미널을 특정하기 어렵다 — 명령을 알려 주는 쪽이 정직하다.
  if (process.platform !== 'win32') return false

  const tokens = [exe, ...args].map(String)
  // 못 띄우면 조용히 넘어가지 않는다. false를 돌려주면 호출부가 `manual` 문구를 띄운다.
  if (CMD_UNSAFE.test(title) || tokens.some((t) => CMD_UNSAFE.test(t))) return false

  // start "제목" cmd /k <exe> ... — 창이 남아야 사용자가 브라우저 로그인을 마치고 결과를 읽는다.
  //
  // **명령줄을 우리가 직접 만들고 windowsVerbatimArguments로 넘긴다.** 배열로 넘기면
  // spawn(shell:false)이 libuv 규칙으로 한 번 더 인용해 준다. 그래서 제목을 `"${title}"`로
  // 감싸 두면 `"\"윤사무실 - Figma 연결\""`가 되는데, cmd는 `\"`를 이스케이프로 읽지 않고
  // 따옴표 토글로만 읽는다. 결과적으로 제목이 첫 공백에서 잘려 start가 그 다음 토큰을
  // 실행할 명령으로 착각했다 — 사용자가 실제로 본 오류가
  // `'-'을(를) 찾을 수 없습니다. 이름을 올바르게 입력했는지 확인하고 다시 시도하십시오.`
  // 였다(`윤사무실 - Figma 연결`의 `-`가 명령 자리로 밀렸다).
  //
  // 제목은 **항상** 감싼다. start는 인용된 첫 토큰만 제목으로 보고, 안 감싸면 그것을
  // 실행할 명령으로 삼는다(공백 없는 제목이 오면 그대로 터진다).
  const line = ['start', `"${title}"`, 'cmd', '/k', ...tokens.map(quoteForCmd)].join(' ')
  try {
    const child = spawn('cmd.exe', ['/c', line], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    })
    child.on('error', (e) => console.error('터미널 창을 띄우지 못했습니다:', e.message))
    child.unref()
    // 나중에 이 창을 닫으려면 **누구인지**를 알아야 한다. spawn이 준 pid는 `start`를
    // 실행하고 곧 끝나는 부모라 창과 무관하다 — 창을 쥔 것은 손자 cmd다.
    const win = { pid: null, exe }
    findWindowPid(child.pid, exe).then((pid) => {
      win.pid = pid
    })
    return win
  } catch (e) {
    console.error('터미널 창을 띄우지 못했습니다:', e.message)
    return false
  }
}

// 창이 생길 때까지 잠깐 걸린다. 조금씩 늘려 가며 네 번만 본다(총 5초 남짓).
const WINDOW_PID_TRIES = [300, 700, 1500, 2500]

/**
 * `start`가 띄운 **손자 cmd**의 pid를 찾는다. 부모 pid로 짚는다.
 *
 * **창 제목으로는 못 짚는다 — 실측으로 확인했다.** 이 PC의 기본 콘솔이
 * Windows Terminal이라 `tasklist /FI "WINDOWTITLE eq 윤사무실 - …"`이 우리 cmd가 아니라
 * **사용자의 다른 탭까지 담고 있는 WindowsTerminal.exe**(우리 창보다 17분 먼저 떠 있던
 * 프로세스)를 가리켰다. 그걸 죽이면 사용자가 쓰던 터미널이 통째로 날아간다.
 * `IMAGENAME eq cmd.exe`를 같이 걸면 이번엔 아무것도 안 잡힌다 — 핸드오프된 cmd에는
 * 자기 창이 없기 때문이다. 그래서 제목은 사람이 읽는 용도로만 쓴다.
 *
 * `wmic`은 최신 Windows에서 빠져서 PowerShell로 묻는다. 못 찾으면 null —
 * **창을 못 닫을 뿐, 다른 것을 죽이지는 않는다.**
 */
function findWindowPid(parentPid, exe) {
  return new Promise((resolve) => {
    if (!parentPid) return resolve(null)
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='cmd.exe' and ParentProcessId=${Number(parentPid)}" | ` +
      'ForEach-Object { "$($_.ProcessId) |CMD| $($_.CommandLine)" }'
    let i = 0
    const attempt = () => {
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 10_000, encoding: 'utf8' },
        (err, out) => {
          for (const l of String(out ?? '').split(/\r?\n/)) {
            const m = l.match(/^(\d+) \|CMD\| (.*)$/)
            // 부모가 맞아도 명령줄까지 확인한다. pid는 재사용되므로 둘 다 맞아야 우리 것이다.
            if (m && m[2].includes(exe)) return resolve(Number(m[1]))
          }
          if (err && i === 0) console.error('창 pid를 찾지 못했습니다:', err.message)
          if (++i >= WINDOW_PID_TRIES.length) return resolve(null)
          setTimeout(attempt, WINDOW_PID_TRIES[i])
        },
      )
    }
    setTimeout(attempt, WINDOW_PID_TRIES[0])
  })
}

/**
 * 우리가 띄운 창을 닫는다. **우리가 띄운 것만** — pid를 손에 쥐고 있을 때만 죽인다.
 *
 * `cmd /k`로 띄우는 이유는 사용자가 결과를 읽어야 해서다. 그런데 성공하면 읽을 것이
 * 없다 — `claude mcp login`·`claude auth login`은 인증이 끝나면 스스로 끝나고
 * **빈 프롬프트 창만 남는다.** 여러 번 시도하면 그 빈 창이 쌓인다(실제로 네 개까지).
 * 그래서 성공했을 때만 닫는다. 실패·시간 초과면 남겨 둔다 — 실패는 이유를 봐야 하고,
 * 시간 초과는 아직 브라우저에서 마치는 중일 수 있다.
 */
function closeTerminal(win) {
  if (!win || typeof win !== 'object' || !win.pid) return
  // /T는 콘솔 호스트(conhost)까지 같이 정리한다. 실측으로 이 조합만 창이 사라졌다.
  execFile('taskkill', ['/PID', String(win.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, (err) => {
    if (err) console.error('창을 닫지 못했습니다:', err.message)
  })
}

// 최대 3분 동안 30초 간격으로 확인한다. 브라우저 로그인은 보통 1분 안에 끝난다.
const WATCH_EVERY_MS = 30_000
const WATCH_TRIES = 6

/**
 * 무엇이 끝났다고 볼 것인가. **모르는 항목은 성공으로 치지 않는다.**
 *
 * 전에는 `what === 'figma' ? env.figma.connected : env.claude.loggedIn`이었다.
 * `figma`가 아닌 것은 전부 "claude 로그인됨"으로 판정하는 모양이라, 이미 로그인돼
 * 있으면(늘 그렇다) 무엇을 물어보든 **첫 확인에서 곧장 성공**이 됐다. 실제로
 * `openAndWatch(undefined, …)`가 `figma.connected:false`인 env를 달고 `ok:true`를
 * 돌려주는 것을 재현했다. 여기서 기본값으로 성공하는 길을 없앤다 —
 * 모르면 모른다고 하는 것이 이 앱의 규칙이다.
 */
const WATCH_DONE = { figma: (env) => env.figma.connected === true, claude: (env) => env.claude.loggedIn === true }

/**
 * 창을 띄운 뒤 **끝났는지 지켜본다** — 사람이 브라우저에서 마치는 동안 앱이 알아채야지,
 * 다시 눌러 보라고 하면 안 된다.
 *
 * 처음 연결(env:login)과 계정 전환(env:switch)이 이 하나를 같이 쓴다. 전에 감시를
 * 두 벌로 두면 한쪽만 고쳐져 어긋난다 — 같은 화면을 두 규칙이 그리게 된다.
 */
async function openAndWatch(what, args, title) {
  // 무엇이 끝났다고 볼지 모르면 **창부터 띄우지 않는다.** 지켜볼 기준이 없는데
  // 창을 띄우면 사람만 움직이고 앱은 아무것도 판정하지 못한다.
  const done = WATCH_DONE[what]
  if (!done) return { ok: false, error: '알 수 없는 항목입니다' }

  const win = openInTerminal(args, title)
  if (!win) {
    return { ok: false, manual: `claude ${args.join(' ')}`, error: '이 OS에서는 터미널을 자동으로 열 수 없습니다' }
  }
  for (let i = 0; i < WATCH_TRIES; i++) {
    await new Promise((r) => setTimeout(r, WATCH_EVERY_MS))
    const env = await checkEnv({ force: true })
    send('env:status', env)
    if (done(env)) {
      // 성공했으면 창에 읽을 것이 없다 — `cmd /k`가 남긴 빈 프롬프트를 치운다.
      closeTerminal(win)
      return { ok: true, env }
    }
  }
  // **시간이 지났다고 창을 닫지 않는다.** 사용자가 아직 브라우저에서 마치는 중일 수
  // 있고, 창을 뺏으면 거기서 끝낼 방법이 사라진다.
  //
  // 실패 응답에는 `error`가 늘 있어야 화면이 한 갈래로 처리할 수 있다. `timeout`은
  // 그 위에 얹는 사정이다(화면은 지금도 timeout을 먼저 본다 — 그 길을 막지 않는다).
  return { ok: false, timeout: true, error: '3분 안에 끝나지 않았습니다 — 창에서 마친 뒤 "다시 확인"을 눌러 주세요', env: await checkEnv({ force: true }) }
}

/** 지금 지시를 처리 중인 회사 이름들. 하나라도 있으면 계정을 건드리면 안 된다. */
function runningCompanies() {
  return [...companies.values()].filter((c) => c.child).map((c) => path.basename(c.dir))
}

/** CLI가 왜 실패했는지 한 줄만. 길게 실으면 화면이 읽히지 않는다. */
function firstLine(text) {
  return String(text ?? '').trim().split(/\r?\n/)[0].slice(0, 200)
}

// ── Figma 연결 ─────────────────────────────────────────────────────────────
//
// **`claude mcp add`는 등록만 하고 그 자리에서 끝난다. 인증을 시작하지 않는다.**
// 실측: `Figma 연결`을 누르면 창에 두 줄만 찍히고 프롬프트로 돌아왔다 —
//   Added HTTP MCP server figma with URL: https://mcp.figma.com/mcp to local config
//   File modified: C:\Users\...\.claude.json [project: ...]
// 그리고 `claude mcp list`는 계속 `figma: ... - ! Needs authentication`이었다. 앱은
// 3분을 기다리다 timeout으로 끝났고, 사용자는 "아무 일도 안 일어난다"를 봤다.
// 브라우저 OAuth를 여는 명령은 따로 있다 — `claude mcp login <name>`.
//
// 그래서 둘로 나눈다.
//  · `add`는 사람 손이 필요 없다 → 조용히(runClaude) 돌린다. 창을 띄울 이유가 없다.
//  · `login`만 창으로 띄운다. `mcp login`은 **stdin이 터미널이어야** 한다(실측:
//    "stdin isn't a terminal, so authentication can't be completed here").
//
// 스코프는 `-s user`다. 기본값 `local`은 **폴더마다 따로** 저장된다
// (`~/.claude.json`의 `projects[cwd].mcpServers`). 앱은 자기 폴더에서 등록하는데 팀원은
// 회사 폴더를 cwd로 돌아서(아래 spawn의 `cwd: dir`) 그 등록을 못 봤다 — 실측으로
// `.claude.json`에 서로 다른 프로젝트 3곳에 `figma`가 따로 박혀 있었다. user 스코프는
// 어느 폴더에서 물어도 보인다.
const FIGMA_URL = 'https://mcp.figma.com/mcp'
const FIGMA_ADD = ['mcp', 'add', '-s', 'user', '--transport', 'http', 'figma', FIGMA_URL]
const FIGMA_LOGIN = ['mcp', 'login', 'figma']

/**
 * 등록돼 있는가. `claude mcp get`은 있으면 0, 없으면 1로 끝난다(실측).
 * `mcp list`와 달리 로그인 여부와 무관하게 답하므로 등록 판정은 이쪽이 정확하다.
 */
async function figmaRegistered() {
  const r = await runClaude(['mcp', 'get', 'figma'])
  return !r.err
}

/**
 * Figma를 잇는다. 첫 연결(env:login)과 다시 연결(env:switch)이 같이 쓴다.
 *
 * `relogin`이면 먼저 **자격증명을 지운다.** 등록 정보(`~/.claude.json`)와 OAuth 토큰
 * (`~/.claude/.credentials.json`의 `mcpOAuth["figma|<url 해시>"]`)은 **서로 다른 파일**에
 * 산다 — 실측으로 확인했다. 그래서 예전처럼 `remove` → `add`를 해도 토큰은 그대로 남아
 * 같은 계정으로 도로 붙는다. 계정을 바꾸려면 `mcp logout`이 맞다. 등록은 건드리지 않아
 * "지웠는데 못 붙인" 반쯤 나간 상태도 안 생긴다.
 *
 * 이미 등록돼 있으면 `add`를 **부르지 않는다.** 같은 이름이 있으면 exit 1로 실패한다
 * (실측: "MCP server figma already exists in user config").
 */
async function connectFigma(title, { relogin = false } = {}) {
  const registered = await figmaRegistered()

  if (relogin && registered) {
    const out = await runClaude(['mcp', 'logout', 'figma'])
    // 앞 단계가 실패하면 다음을 실행하지 않는다 — 지난 계정이 남은 채로 창만 띄우면
    // 사용자는 같은 계정으로 다시 붙고도 "바꿨다"고 믿는다.
    if (out.err) {
      return { ok: false, error: `Figma 인증을 지우지 못했습니다 — ${firstLine(out.errOut || out.out) || '알 수 없는 오류'}` }
    }
  }

  if (!registered) {
    const add = await runClaude(FIGMA_ADD)
    if (add.err) {
      return { ok: false, error: `Figma를 등록하지 못했습니다 — ${firstLine(add.errOut || add.out) || '알 수 없는 오류'}` }
    }
  }

  envCache = null // 방금 바꿔 놓고 캐시된 지난 판정을 돌려주면 안 된다
  return openAndWatch('figma', FIGMA_LOGIN, title)
}

/**
 * 계정을 **바꾼다**. 로그인과 다르다 — 이미 로그인돼 있으면 `claude auth login`은
 * "이미 로그인됨"으로 끝나서 다른 계정으로 갈 수가 없었다. 먼저 나가야 한다.
 *
 * 처리 중인 지시가 있으면 거절한다. 로그아웃하는 순간 **돌고 있는 claude가 인증을
 * 잃어 그 지시가 통째로 실패한다.** 화면에서도 버튼을 막지만, 막는 자리는 여기여야
 * 한다 — 화면은 상태를 늦게 안다.
 */
async function switchAccount(what) {
  if (what !== 'claude' && what !== 'figma') return { ok: false, error: '알 수 없는 항목입니다' }

  const running = runningCompanies()
  if (running.length) {
    return { ok: false, busy: true, running, error: '지시가 처리 중입니다 — 끝나거나 취소한 뒤에 바꾸세요' }
  }

  if (what === 'figma') {
    // 다시 연결 = 지난 자격증명을 지우고(logout) 다시 인증한다(login). 왜 remove/add가
    // 아닌지는 connectFigma 주석에 있다 — 토큰이 등록 정보와 다른 파일에 산다.
    return connectFigma('윤사무실 - Figma 다시 연결', { relogin: true })
  }

  // 로그아웃은 사람 손이 필요 없다 — 조용히 끝내고 로그인 창만 띄운다.
  // **실패하면 창을 띄우지 않는다.** 반쯤 나간 상태로 두면 무엇이 참인지 알 수 없다.
  const out = await runClaude(['auth', 'logout'])
  if (out.err) {
    return { ok: false, error: `로그아웃하지 못했습니다 — ${firstLine(out.errOut || out.out) || '알 수 없는 오류'}` }
  }
  envCache = null
  return openAndWatch('claude', ['auth', 'login'], '윤사무실 - Claude 계정 전환')
}

// ---------------------------------------------------------------------------
// 세팅 — 빈 프로젝트를 팀이 일할 수 있는 상태로 만든다
//
// 지금까지 이 셋을 사람이 손으로 갖춰야 했다. 그래서 훅만 깔고 팀원을 안 둔
// 프로젝트에서 리드가 혼자 일했고, 아무것도 없는 빈 폴더를 붙였다가 "지시를
// 보내도 아무 일도 안 일어난다"가 됐다. 붙이는 자리에서 바로 갖추게 한다.
//
// **자동으로 하지 않는다.** 남의 폴더에 파일을 쓰는 일이라 무엇을 넣을지 보여주고
// 확인을 받는다(renderer의 확인 창 → project:setup).
// ---------------------------------------------------------------------------

/** 윤사무실이 들고 다니는 템플릿 뿌리. 패키징 후에도 같은 위치다(package.json의 files). */
function templateDir() {
  return path.join(__dirname, 'templates')
}

const HOOK_EVENTS = [
  ['PreToolUse', 'pre'],
  ['PostToolUse', 'post'],
  ['SubagentStop', 'subagent_stop'],
  ['UserPromptSubmit', 'prompt'],
  ['Stop', 'stop'],
  ['SessionStart', 'session'],
]

/**
 * 훅을 settings.json에 **병합**한다. 기존 설정은 건드리지 않는다.
 *
 * 통째로 덮어쓰면 그 프로젝트가 쓰던 다른 훅(포매터·시크릿 가드 등)이 사라진다.
 * 이미 team_events가 걸려 있는 이벤트는 그대로 두고 없는 것만 채운다.
 */
function mergeHooks(claudeDir) {
  const file = path.join(claudeDir, 'settings.json')
  let cfg = {}
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* 없거나 깨졌으면 새로 만든다 */
  }
  if (!cfg.hooks || typeof cfg.hooks !== 'object') cfg.hooks = {}
  let added = 0
  for (const [event, kind] of HOOK_EVENTS) {
    const command = `python "$CLAUDE_PROJECT_DIR/.claude/hooks/team_events.py" ${kind}`
    const groups = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : []
    // 이미 걸려 있으면 두 번 넣지 않는다(같은 이벤트가 두 줄씩 기록된다).
    if (JSON.stringify(groups).includes('team_events.py')) {
      cfg.hooks[event] = groups
      continue
    }
    groups.push({ hooks: [{ type: 'command', command, timeout: 10 }] })
    cfg.hooks[event] = groups
    added++
  }
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8')
  return added
}

/**
 * CLAUDE.md의 **팀 규칙 부분만** 새 템플릿으로 바꾼다(`갱신`을 고른 경우에만).
 *
 * 이 파일은 위쪽 절반(개요·기술 스택·주요 명령어)이 사람의 것이고, `## 팀으로
 * 일합니다`부터 끝까지가 앱의 것이다. 그동안 통째로 "있으면 건드리지 않는다"로
 * 뒀더니 **오래 쓴 프로젝트가 낡은 규칙을 영영 갖고 갔다.** 실측: 검수 규칙을
 * 고친 뒤에도 ConvertFlow에는 "테스트가 필요한 규모면 부릅니다"가 남아 새 규칙과
 * 정면으로 부딪혔다.
 *
 * 사람이 쓴 위쪽은 그대로 두고, 아래쪽만 바꾼다. 혹시 아래에 사람이 덧붙인 게
 * 있을 수 있으니 바꾸기 전 `.bak`을 남긴다.
 */
const TEAM_SECTION = '## 팀으로 일합니다'

/** 템플릿에서 `## 제목` 한 덩어리를 떼어 온다(다음 `## `이나 `---` 앞까지). */
function sectionOf(text, title) {
  const i = text.indexOf(title)
  if (i < 0) return null
  const rest = text.slice(i + title.length)
  const stop = rest.search(/\n##\s|\n---\s*\n/)
  return (title + (stop < 0 ? rest : rest.slice(0, stop))).trim()
}
function refreshTeamRules(target) {
  const cur = fs.readFileSync(target, 'utf8')
  const tpl = fs.readFileSync(path.join(templateDir(), 'CLAUDE.md'), 'utf8')
  const norm = (s) => s.replace(/\r\n/g, '\n')
  const at = norm(cur).indexOf(TEAM_SECTION)
  const tplAt = norm(tpl).indexOf(TEAM_SECTION)
  // 사람이 그 제목을 지웠거나 템플릿 구조가 바뀌었으면 손대지 않는다.
  if (at < 0 || tplAt < 0) return 'CLAUDE.md 팀 규칙 위치를 찾지 못해 그대로 뒀습니다'
  let head = norm(cur).slice(0, at)
  // **윗부분에도 앱이 새로 넣는 자리가 생길 수 있다.** `## Figma`가 그렇다 —
  // 사람이 채우는 영역에 있지만 앱이 쓰는 약속이라, 없으면 기존 프로젝트는
  // 갱신을 눌러도 영영 못 받는다. 사람이 쓴 내용은 건드리지 않고 **없는 제목만
  // 덧붙인다.**
  for (const title of ['## Figma']) {
    if (head.includes(title)) continue
    const block = sectionOf(norm(tpl).slice(0, tplAt), title)
    if (block) head = head.replace(/\n*(---\s*\n*)?$/, '\n\n' + block + '\n\n---\n\n')
  }
  const next = head + norm(tpl).slice(tplAt)
  if (next === norm(cur)) return null // 이미 최신이면 조용히 넘어간다
  fs.writeFileSync(target + '.bak', cur, 'utf8')
  fs.writeFileSync(target, next, 'utf8')
  return 'CLAUDE.md 팀 규칙 갱신 (개요·스택은 그대로, 이전 내용은 CLAUDE.md.bak)'
}

/**
 * 빠진 것을 채운다. 이미 있는 파일은 **덮어쓰지 않는다** — 사람이 고쳐 둔 것을
 * 되돌리면 안 된다.
 */
function setupProject(dir, parts = {}) {
  const claudeDir = path.join(dir, '.claude')
  const done = []
  try {
    if (parts.hooks) {
      fs.mkdirSync(path.join(claudeDir, 'hooks'), { recursive: true })
      fs.copyFileSync(
        path.join(__dirname, 'hooks', 'team_events.py'),
        path.join(claudeDir, 'hooks', 'team_events.py'),
      )
      const added = mergeHooks(claudeDir)
      done.push(`훅 설치 (settings.json에 ${added}개 등록)`)
    }
    if (parts.agents) {
      const src = path.join(templateDir(), 'agents')
      const dst = path.join(claudeDir, 'agents')
      fs.mkdirSync(dst, { recursive: true })
      let added = 0
      let updated = 0
      // **해고한 사람을 세팅이 되살리면 안 된다.** 갱신을 누를 때마다 내보낸 팀원이
      // 돌아오면 해고 기능 자체가 무효다.
      const fired = new Set(firedIds(dir))
      for (const f of fs.readdirSync(src)) {
        if (!f.endsWith('.md')) continue
        if (fired.has(f.replace(/\.md$/i, ''))) continue
        const target = path.join(dst, f)
        const exists = fs.existsSync(target)
        // 평소에는 있는 파일을 건드리지 않는다. 다만 **갱신을 고른 경우**에는 덮어쓴다 —
        // 그러지 않으면 오래 쓴 프로젝트가 새 규칙을 영영 받지 못한다.
        if (exists && !parts.update) continue
        const norm = (s) => s.replace(/\r\n/g, '\n')
        if (exists && norm(fs.readFileSync(target, 'utf8')) === norm(fs.readFileSync(path.join(src, f), 'utf8'))) continue
        fs.copyFileSync(path.join(src, f), target)
        exists ? updated++ : added++
      }
      const bits = []
      if (added) bits.push(`팀원 ${added}명 추가`)
      if (updated) bits.push(`팀원 ${updated}명 갱신`)
      if (fired.size) bits.push(`해고자 ${fired.size}명 제외`)
      done.push(bits.join(' · ') || '팀원 변경 없음')
    }
    if (parts.guide) {
      const target = path.join(dir, 'CLAUDE.md')
      if (!fs.existsSync(target)) {
        fs.copyFileSync(path.join(templateDir(), 'CLAUDE.md'), target)
        done.push('CLAUDE.md 생성 (개요·스택·명령어는 비어 있음)')
      } else if (parts.update) {
        const msg = refreshTeamRules(target)
        if (msg) done.push(msg)
      }
    }
  } catch (err) {
    return { ok: false, error: err.message, done }
  }
  invalidateTeam(dir) // 방금 바꿨으니 명단·건강 검사를 다시 한다
  return { ok: true, done }
}

/**
 * 템플릿과 **내용이 다른** 팀원 파일 수.
 *
 * 윤사무실을 고치면 앱 동작은 바로 바뀌지만 **이미 세팅된 프로젝트의 팀원 정의는 그대로**다.
 * 세팅은 "이미 있는 파일을 건드리지 않는" 원칙이라 다시 눌러도 갱신되지 않았다. 그래서
 * 오래 쓴 프로젝트일수록 새 규칙(묻는 말 예외·Figma 강제 같은)을 못 받는다.
 *
 * CLAUDE.md는 비교하지 않는다 — 개요·스택을 사람이 채우는 파일이라 다른 게 정상이다.
 */
// ---------------------------------------------------------------------------
// 팀원 고용·해고
//
// **명단의 진실은 디스크다.** 앱이 명단을 따로 들고 있으면, 사람이 파일을 손으로
// 넣거나 지웠을 때 화면과 실제가 어긋난다. Claude Code가 서브에이전트를 찾는 자리를
// 그대로 읽는다:
//
//   [리드(항상 있다, 파일이 없다)] + <프로젝트>/.claude/agents/*.md + ~/.claude/agents/*.md
//
// **파일 형식에 새 키를 만들지 않는다.** Claude Code가 모르는 키를 넣으면 그 파일은
// 윤사무실 전용이 되고, 사람이 claude로 직접 쓸 때 걸림돌이 된다. 화면에 붙는 한글
// 이름표(label)는 파일이 아니라 렌더러 사전이 정한다.
// ---------------------------------------------------------------------------

const FIRED_DIRNAME = 'team-fired'
// 자리 상한. 화면의 책상 칸 수와 같아야 한다(renderer/agents.js의 DESK_CELLS).
const SEAT_CAPACITY = 14

// 좌석은 **명단 순서가 아니라 id에 묶는다.** 순서에 묶으면 한 명을 해고하는 순간
// 뒤의 모두가 한 칸씩 밀려 사무실이 통째로 재배치된다 — 어제 보던 화면이 아니게 된다.
//
// 이 표는 **지금 배치를 그대로 굳힌 것**이다(renderer/agents.js의 ROSTER 순서 ×
// DESK_CELLS). 배열 위치가 곧 좌석 번호다. **순서를 바꾸지 마라** — 이미 돌아가는
// 회사들의 자리가 전부 움직인다. 검사(tools/check-logic.js)가 이 값을 지킨다.
const PRESET_SEATS = [
  'planner', // 0
  'ux-designer', // 1
  'frontend-dev', // 2
  'backend-dev', // 3
  'mobile-dev', // 4
  'code-reviewer', // 5
  'qa-tester', // 6
  'debugger', // 7
  'release-manager', // 8
  'scout', // 9
]

// 파일명이 되는 값이라 안전한 글자만 받는다(경로 탈출·이상한 파일명 방지).
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
// 도구 이름. MCP 도구는 `mcp__figma__get_screenshot`처럼 밑줄이 섞인다.
const SAFE_TOOL = /^[A-Za-z][A-Za-z0-9_]{0,79}$/

function agentsDirOf(dir) {
  return path.join(dir, '.claude', 'agents')
}

function firedDirOf(dir) {
  return path.join(dir, '.claude', FIRED_DIRNAME)
}

/** 이 컴퓨터의 전역 팀원. 어느 프로젝트에서나 부를 수 있고, 여기서 해고하지 못한다. */
function userAgentsDir() {
  return path.join(app.getPath('home'), '.claude', 'agents')
}

/**
 * 팀원 정의 한 장에서 id·설명·도구를 읽는다.
 *
 * **절대 던지지 않는다.** 사람이 손으로 고치는 파일이라 frontmatter가 깨져 있는 일이
 * 흔한데, 그 한 장 때문에 명단 전체가 비면 사무실이 텅 빈 채로 뜬다. 못 읽으면
 * 파일명으로 살린다 — 이름 없는 사람이라도 자리에는 앉아 있어야 한다.
 */
function parseAgentFile(file) {
  const out = { id: path.basename(file).replace(/\.md$/i, ''), desc: '', tools: [] }
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    if (!text.startsWith('---\n')) return out // frontmatter가 없으면 파일명이 전부다
    const end = text.indexOf('\n---', 3)
    if (end < 0) return out
    for (const line of text.slice(4, end).split('\n')) {
      const m = /^(name|description|tools)\s*:\s*(.*)$/.exec(line)
      if (!m) continue
      const val = m[2].trim().replace(/^['"]|['"]$/g, '').trim()
      if (m[1] === 'name') {
        if (val) out.id = val
      } else if (m[1] === 'description') {
        out.desc = val.slice(0, 160) // 목록에 한 줄로 뜨는 값이다. 더 길면 화면만 밀린다.
      } else {
        out.tools = val.split(',').map((t) => t.trim()).filter(Boolean)
      }
    }
  } catch {
    /* 못 읽어도 파일명으로 산다 */
  }
  return out
}

/** 해고자 명단(파일명 기준). 세팅·갱신이 이들을 되살리면 해고 기능 자체가 무효다. */
function firedIds(dir) {
  try {
    return fs
      .readdirSync(firedDirOf(dir))
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .map((f) => f.replace(/\.md$/i, ''))
  } catch {
    return [] // 해고자 폴더가 없는 게 보통이다
  }
}

/**
 * id마다 자리 번호를 준다.
 *
 *   1. 프리셋에 있는 id는 **언제나** 그 번호다(기존 회사 화면이 움직이지 않게).
 *   2. 그 밖의 id는 앱 설정(userData)에 적힌 번호를 그대로 쓴다.
 *   3. 처음 보는 id는 **가장 낮은 빈 번호**를 받고, 그 자리를 설정에 적어 굳힌다.
 *
 * **프로젝트 폴더에 쓰지 않는다.** 남의 작업 폴더에 앱 파일을 남기면 커밋에 섞인다
 * (대화 기록을 userData에 두는 것과 같은 이유).
 */
function assignSeats(dir, ids) {
  const cfg = loadConfig()
  const all = cfg.seats && typeof cfg.seats === 'object' ? cfg.seats : {}
  const saved = { ...(all[dir] ?? {}) }
  const used = new Map() // 번호 -> id
  const out = new Map() // id -> 번호(또는 null)
  let dirty = false

  for (const id of ids) {
    const n = PRESET_SEATS.indexOf(id)
    if (n < 0) continue
    out.set(id, n)
    used.set(n, id)
    // 프리셋은 코드가 진실이다. 장부에 남아 있으면 지운다(둘이 어긋날 여지를 없앤다).
    if (saved[id] !== undefined) {
      delete saved[id]
      dirty = true
    }
  }
  for (const id of ids) {
    if (out.has(id)) continue
    const n = saved[id]
    // 장부 번호가 프리셋과 부딪히면 **프리셋이 이긴다.** 장부 쪽은 아래에서 다시 적는다.
    if (!Number.isInteger(n) || n < 0 || n >= SEAT_CAPACITY || used.has(n)) continue
    out.set(id, n)
    used.set(n, id)
  }
  for (const id of ids) {
    if (out.has(id)) continue
    let n = 0
    while (n < SEAT_CAPACITY && used.has(n)) n++
    if (n >= SEAT_CAPACITY) {
      // 자리가 없다. 화면에 그릴 수 없으니 솔직히 비워 보낸다(없는 칸에 그리면 벽 밖이다).
      out.set(id, null)
      if (saved[id] !== undefined) {
        delete saved[id]
        dirty = true
      }
      continue
    }
    out.set(id, n)
    used.set(n, id)
    if (saved[id] !== n) {
      saved[id] = n
      dirty = true
    }
  }
  if (dirty) saveConfig({ ...cfg, seats: { ...all, [dir]: saved } })
  return out
}

// 명단은 자주 바뀌지 않는다. 상태를 300ms마다 보내면서 디스크를 매번 뒤질 이유가 없다
// (projectHealth와 같은 방식·같은 수명).
const teamCache = new Map() // dir -> { at, team }
const TEAM_TTL_MS = 10_000

function invalidateTeam(dir) {
  teamCache.delete(dir)
  healthCache.delete(dir) // 팀원 수·낡음 판정도 같이 바뀐다
}

/**
 * 이 프로젝트의 실제 팀 명단.
 *
 * 같은 id가 프로젝트와 전역에 다 있으면 **프로젝트가 이긴다** — Claude Code가 고르는
 * 것과 같은 규칙이어야 화면과 실제가 어긋나지 않는다.
 */
function readTeam(dir) {
  const hit = teamCache.get(dir)
  if (hit && Date.now() - hit.at < TEAM_TTL_MS) return hit.team

  const byId = new Map()
  // 전역을 먼저 읽고 프로젝트로 덮는다(덮는 쪽이 이긴다).
  for (const [scope, folder] of [['user', userAgentsDir()], ['project', agentsDirOf(dir)]]) {
    let names = []
    try {
      names = fs.readdirSync(folder)
    } catch {
      continue // 폴더가 없는 건 흔한 일이다
    }
    for (const name of names.sort()) {
      if (!name.toLowerCase().endsWith('.md')) continue
      const file = path.join(folder, name)
      const info = parseAgentFile(file)
      if (!info.id) continue
      // 전역 팀원은 이 프로젝트 밖의 것이라 여기서 해고하지 않는다(남의 프로젝트가 같이 잃는다).
      byId.set(info.id, { ...info, scope, file, fireable: scope === 'project' })
    }
  }
  const ids = [...byId.keys()].sort()
  const seats = assignSeats(dir, ids)
  const team = [
    // 리드는 파일이 없고 언제나 있다. 자리도 따로다(renderer의 LEAD_DESK).
    { id: 'lead', desc: '팀을 이끌고 일을 나눈다', tools: [], scope: 'lead', file: null, seat: null, fireable: false },
    ...ids
      .map((id) => ({ ...byId.get(id), seat: seats.get(id) ?? null }))
      // 자리 순으로 보낸다. 자리가 없는 사람은 뒤로.
      .sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99)),
  ]
  teamCache.set(dir, { at: Date.now(), team })
  return team
}

/** 남은 자리 수. 리드는 자기 자리가 따로라 세지 않는다. */
function freeSeats(team) {
  return Math.max(0, SEAT_CAPACITY - team.filter((m) => m.seat !== null).length)
}

/** 지금 지시를 처리하는 중인가. 처리 중이면 팀 구성을 바꾸지 않는다. */
function companyBusy(dir) {
  return Boolean(companies.get(dir)?.child)
}

/**
 * 고를 수 있는 팀원 목록(카탈로그).
 *   employed  — 이미 팀에 있다
 *   fired     — 해고했다. 다시 부르면 **그 파일이 그대로 돌아온다**
 *   available — 아직 부른 적 없다
 */
function teamCatalog(dir) {
  const employed = new Set(readTeam(dir).map((m) => m.id))
  const fired = firedIds(dir)
  const out = []
  const seen = new Set()
  const add = (id, file, state) => {
    if (seen.has(id)) return
    seen.add(id)
    const info = parseAgentFile(file)
    out.push({ id, desc: info.desc, tools: info.tools, state })
  }
  let templates = []
  try {
    templates = fs.readdirSync(path.join(templateDir(), 'agents')).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    /* 템플릿을 못 읽어도 해고자는 보여 줘야 한다 */
  }
  // 화면 순서를 프리셋 자리 순으로 맞춘다(목록과 사무실 배치가 따로 놀지 않게).
  const order = (f) => {
    const i = PRESET_SEATS.indexOf(f.replace(/\.md$/i, ''))
    return i < 0 ? PRESET_SEATS.length : i
  }
  for (const f of templates.sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
    const id = f.replace(/\.md$/i, '')
    const state = employed.has(id) ? 'employed' : fired.includes(id) ? 'fired' : 'available'
    add(id, path.join(templateDir(), 'agents', f), state)
  }
  // 카탈로그에 없는 해고자(직접 만든 팀원)도 다시 부를 수 있어야 한다.
  for (const id of fired) add(id, path.join(firedDirOf(dir), id + '.md'), employed.has(id) ? 'employed' : 'fired')
  return out
}

function listTeam(dir) {
  if (!dir) return { ok: false, error: '프로젝트가 선택되지 않았습니다' }
  const members = readTeam(dir)
  return {
    ok: true,
    busy: companyBusy(dir),
    capacity: SEAT_CAPACITY,
    free: freeSeats(members),
    members,
    catalog: teamCatalog(dir),
  }
}

/**
 * 지금 팀 구성을 바꿔도 되는가. 되면 null, 안 되면 그대로 돌려줄 실패 응답.
 *
 * **처리 중이면 전부 막는다.** 지시가 도는 중에 팀원이 사라지면 리드가 없는 사람을
 * 부르다 실패하고, 그 실패는 사용자 눈에 원인 불명으로 보인다. 프런트도 버튼을
 * 막지만 **여기서 한 번 더 거절한다** — 화면 상태는 언제든 낡을 수 있다.
 */
function teamWriteBlock(dir) {
  if (!dir) return { ok: false, error: '프로젝트가 선택되지 않았습니다' }
  // 남의 폴더에 파일을 만들거나 옮기는 일이다. 붙여 둔 프로젝트만 허용한다.
  if (!loadProjects().includes(dir)) return { ok: false, error: '붙어 있지 않은 프로젝트입니다' }
  if (!fs.existsSync(path.join(dir, '.claude'))) {
    return { ok: false, error: '아직 세팅되지 않은 프로젝트입니다 — 상단 "세팅하기"를 누르세요' }
  }
  if (companyBusy(dir)) {
    return { ok: false, busy: true, error: '지금 지시를 처리하는 중입니다 — 끝난 뒤에 바꿔주세요' }
  }
  return null
}

/**
 * 명단이 바뀐 뒤에 할 일.
 *
 * 이벤트 한 줄을 남기는 것이 화면과의 유일한 약속이다. **detail을 붙이지 않는다** —
 * 고용·해고는 작업이 아니라서 작업 배지가 붙으면 안 된다(가짜 활동을 만들지 않는다).
 */
function afterTeamChange(dir, type, id) {
  invalidateTeam(dir)
  try {
    appendJsonl(eventsFileFor(dir), { ts: Date.now() / 1000, type, agent: id })
  } catch {
    /* 기록에 실패해도 파일은 이미 옮겨졌다. 되돌리지 않는다. */
  }
  pumpStatusAll({ force: true })
}

/**
 * 카탈로그에서 한 명 고용한다.
 *
 * 해고자가 있으면 **그 파일을 우선 복원**한다 — 사람이 고쳐 둔 내용이 있는데
 * 템플릿으로 덮으면 그 수정이 조용히 사라진다.
 */
function hireAgent(dir, rawId) {
  const blocked = teamWriteBlock(dir)
  if (blocked) return blocked
  const id = String(rawId ?? '').trim()
  if (!SAFE_AGENT_ID.test(id)) return { ok: false, code: 'VALIDATION', error: '팀원 id가 올바르지 않습니다' }
  const team = readTeam(dir)
  if (team.some((m) => m.id === id)) return { ok: false, error: `${id}은(는) 이미 팀에 있습니다` }
  if (freeSeats(team) <= 0) return { ok: false, full: true, error: `자리가 없습니다 (최대 ${SEAT_CAPACITY}명)` }

  const firedFile = path.join(firedDirOf(dir), id + '.md')
  const tplFile = path.join(templateDir(), 'agents', id + '.md')
  const from = fs.existsSync(firedFile) ? 'fired' : fs.existsSync(tplFile) ? 'template' : null
  if (!from) return { ok: false, error: `${id} 정의를 찾지 못했습니다` }

  const target = path.join(agentsDirOf(dir), id + '.md')
  try {
    fs.mkdirSync(agentsDirOf(dir), { recursive: true })
    if (from === 'fired') fs.renameSync(firedFile, target)
    else fs.copyFileSync(tplFile, target)
  } catch (err) {
    return { ok: false, error: `팀원 파일을 만들지 못했습니다: ${err.message}` }
  }
  afterTeamChange(dir, 'hire', id)
  return { ok: true, id, from, path: target }
}

/** YAML 한 줄에 그대로 넣어도 되는 값인지 보고, 위험하면 따옴표로 감싼다. */
function yamlValue(s) {
  return /^[\s'"[\]{}>|*&!%#@`,-]|:\s|\s#/.test(s) ? JSON.stringify(s) : s
}

/**
 * 새 팀원 정의 본문을 만든다. **빈 파일을 만들지 않는다.**
 *
 * 기존 정의들에는 실제 사고를 겪고 쌓인 공통 규칙이 들어 있다(산출물을 파일로 남길
 * 것, 확인 절차, 스크린샷을 한 번만 받을 것 등). 껍데기만 만들어 주면 그 기준이
 * 통째로 빠진 팀원이 생긴다 — 말로만 답하고 끝내는 팀원이 그렇게 나온다.
 *
 * 본은 **요청한 도구와 가장 많이 겹치는 정의**로 고른다. Figma 도구를 고른 팀원이
 * "스크린샷은 한 번만" 규칙을 못 받으면 그 자리에서 토큰이 샌다(실측: 스크린샷 하나
 * 27만 자가 이후 30여 호출에 곱해졌다).
 */
function renderAgentFile({ id, label, description, tools }) {
  const base = path.join(templateDir(), 'agents')
  let files = []
  try {
    files = fs.readdirSync(base).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    return { text: null, basedOn: null }
  }
  if (!files.length) return { text: null, basedOn: null }

  const want = new Set(tools.map((t) => t.toLowerCase()))
  const order = (f) => {
    const i = PRESET_SEATS.indexOf(f.replace(/\.md$/i, ''))
    return i < 0 ? PRESET_SEATS.length : i
  }
  let pick = null
  let best = -Infinity
  for (const f of files.sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
    const have = parseAgentFile(path.join(base, f)).tools.map((t) => t.toLowerCase())
    // 겹치는 도구가 많은 쪽. 같으면 도구 구성이 비슷한 쪽(도구를 안 고르면 가장 단출한 정의).
    const score = have.filter((t) => want.has(t)).length * 100 - Math.abs(have.length - want.size)
    if (score > best) {
      best = score
      pick = f
    }
  }
  let src = ''
  try {
    src = fs.readFileSync(path.join(base, pick), 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return { text: null, basedOn: null }
  }
  const end = src.indexOf('\n---', 3)
  // frontmatter를 걷어내고 **역할 선언 한 줄만** 갈아 끼운다. 나머지 문단(원칙·절차·
  // 출력 규칙)은 본을 그대로 잇는다 — 그게 이 파일을 만드는 이유다.
  const body = (end < 0 ? src : src.slice(end + 4)).replace(/^\s*\n/, '').replace(/^너는[^\n]*\n/, '').trimStart()
  const desc = description.replace(/\s+/g, ' ').trim()
  const head = ['---', `name: ${id}`, `description: ${yamlValue(desc)}`]
  if (tools.length) head.push(`tools: ${tools.join(', ')}`)
  head.push('---', '')
  const text =
    head.join('\n') +
    `\n<!-- 윤사무실에서 만든 팀원 정의. 아래 규칙 문단은 templates/agents/${pick}에서 가져왔다. 역할에 맞게 고쳐 써라. -->\n\n` +
    `너는 ${label || id} 담당이다. ${desc}\n\n` +
    // 물려받은 문단에는 본 정의의 예시가 그대로 남아 있다(리뷰어를 본으로 삼으면
    // `git diff`가 절차에 남는 식). 지우면 품질 기준까지 같이 빠지므로, 지우는 대신
    // **예시가 아니라 수준을 따르라고** 못 박는다.
    `아래는 기존 팀원 정의에서 물려받은 공통 규칙이다. **네 일에 맞게 읽어라** —` +
    ` 예시가 네 역할과 다르면 그 예시가 아니라 그 꼼꼼함을 네 일에 적용해라.\n\n` +
    body
  return { text, basedOn: pick }
}

/** 카탈로그에 없는 팀원을 직접 만든다. */
function createAgent(dir, spec = {}) {
  const blocked = teamWriteBlock(dir)
  if (blocked) return blocked
  const bad = (error) => ({ ok: false, code: 'VALIDATION', error })
  const id = String(spec.id ?? '').trim().toLowerCase()
  const label = String(spec.label ?? '').trim().slice(0, 20)
  const description = String(spec.description ?? '').trim().slice(0, 160)
  const tools = Array.isArray(spec.tools) ? spec.tools.map((t) => String(t).trim()).filter(Boolean) : []

  if (!id) return bad('id를 적어주세요')
  if (!SAFE_AGENT_ID.test(id)) return bad('id는 영문 소문자·숫자·하이픈만 쓸 수 있습니다 (예: data-analyst)')
  if (id === 'lead') return bad('lead는 리드가 쓰는 이름입니다')
  if (!description) return bad('무슨 일을 하는 팀원인지 한 줄로 적어주세요')
  for (const t of tools) if (!SAFE_TOOL.test(t)) return bad(`쓸 수 없는 도구 이름입니다: ${t}`)
  const team = readTeam(dir)
  if (team.some((m) => m.id === id)) return bad(`${id}은(는) 이미 팀에 있습니다`)
  if (firedIds(dir).includes(id)) return bad(`${id}은(는) 해고자 명단에 있습니다 — 고용으로 다시 부르세요`)
  if (fs.existsSync(path.join(templateDir(), 'agents', id + '.md'))) {
    return bad(`${id}은(는) 기본 팀원입니다 — 목록에서 고용하세요`)
  }
  if (freeSeats(team) <= 0) return { ok: false, full: true, error: `자리가 없습니다 (최대 ${SEAT_CAPACITY}명)` }

  const { text, basedOn } = renderAgentFile({ id, label, description, tools })
  if (!text) return { ok: false, error: '본으로 삼을 팀원 정의를 읽지 못했습니다' }
  const target = path.join(agentsDirOf(dir), id + '.md')
  try {
    fs.mkdirSync(agentsDirOf(dir), { recursive: true })
    fs.writeFileSync(target, text, 'utf8')
  } catch (err) {
    return { ok: false, error: `팀원 파일을 만들지 못했습니다: ${err.message}` }
  }
  afterTeamChange(dir, 'hire', id)
  // label은 파일에 넣지 않는다(새 키를 만들지 않는다). 화면이 쓸 수 있게 돌려만 준다.
  return { ok: true, id, label, path: target, basedOn }
}

/**
 * 대기열에 그 사람 앞으로 온 지시를 리드에게 돌린다.
 *
 * 안 그러면 리드가 **없는 사람**을 부르다 실패한다. 그 실패는 사용자 눈에 원인 불명으로
 * 보인다 — 방금 해고했다는 사실과 이어지지 않기 때문이다.
 */
function requeueToLead(dir, id) {
  const qf = path.join(dir, '.claude', COMMANDS_NAME)
  let lines
  try {
    lines = fs.readFileSync(qf, 'utf8').split(/\r?\n/)
  } catch {
    return 0 // 대기열이 없는 게 보통이다
  }
  let n = 0
  const out = []
  for (const line of lines) {
    if (!line.trim()) continue
    let c = null
    try {
      c = JSON.parse(line)
    } catch {
      out.push(line) // 깨진 줄은 그대로 둔다(우리가 못 읽는다고 지울 이유는 없다)
      continue
    }
    if (c.agent === id) {
      c.agent = 'lead'
      n++
    }
    out.push(JSON.stringify(c))
  }
  if (!n) return 0
  try {
    fs.writeFileSync(qf, out.join('\n') + '\n', 'utf8')
  } catch (err) {
    logRenderer(`대기열을 리드로 돌리지 못했습니다(${id}): ${err.message}`, '지시')
    return 0
  }
  return n
}

/**
 * 해고한다. **지우지 않는다.**
 *
 * `.claude/agents/<id>.md` → `.claude/team-fired/<id>.md`로 **옮긴다.** 사람이 고쳐 둔
 * 정의가 사라지면 되살릴 수단이 없다. 앱이 팀원 정의 파일을 지우는 경로는 만들지 않는다.
 */
function fireAgent(dir, rawId) {
  const blocked = teamWriteBlock(dir)
  if (blocked) return blocked
  const id = String(rawId ?? '').trim()
  if (!id || /[\\/]|\.\./.test(id)) return { ok: false, code: 'VALIDATION', error: '팀원 id가 올바르지 않습니다' }
  if (id === 'lead') return { ok: false, error: '리드는 해고할 수 없습니다' }
  const m = readTeam(dir).find((x) => x.id === id)
  if (!m) return { ok: false, error: `${id}은(는) 팀에 없습니다` }
  if (!m.fireable || !m.file) {
    return { ok: false, error: `${id}은(는) 이 컴퓨터 전체의 팀원입니다(~/.claude/agents) — 여기서는 해고할 수 없습니다` }
  }
  const movedTo = path.join(firedDirOf(dir), path.basename(m.file))
  try {
    fs.mkdirSync(firedDirOf(dir), { recursive: true })
    fs.renameSync(m.file, movedTo)
  } catch (err) {
    return { ok: false, error: `팀원 파일을 옮기지 못했습니다: ${err.message}` }
  }
  // 파일을 옮긴 **뒤에** 대기열을 고친다. 순서가 반대면 옮기기가 실패했을 때
  // 멀쩡한 팀원 앞으로 온 지시만 리드에게 뺏긴다.
  const requeued = requeueToLead(dir, id)
  afterTeamChange(dir, 'fire', id)
  return { ok: true, id, movedTo, requeued }
}

// ---------------------------------------------------------------------------
// 작업 전 스냅샷
//
// git 저장소로 만들어 줘도 **돌아갈 지점이 첫 커밋 하나뿐**이다. 지시를 열 번
// 보내면 그 사이 상태는 어디에도 남지 않는다. 그래서 지시를 집어가는 순간마다
// 자동으로 현재 상태를 남긴다 — 사람이 아무것도 하지 않아도 매 지시가 되돌릴 수
// 있는 단위가 된다.
//
// **사용자의 git을 조금도 건드리지 않는다.** 별도 인덱스 파일에 담고 커밋 객체만
// 만들어 `refs/teamview/` 아래에 매단다. `git log`·`git branch`·`git status`·
// `git stash` 어디에도 나타나지 않는다(실측으로 확인).
//
// `git stash create`를 쓰지 않은 이유: 그건 **추적되지 않는 새 파일을 담지 않는다.**
// 팀이 하는 일의 대부분이 새 파일을 만드는 것이라, 그걸로는 되돌려도 만들어진
// 파일이 그대로 남는다.

const SNAP_REF_PREFIX = 'refs/teamview/snap'

/**
 * 그 프로젝트에서 git을 돌린다. 실패하면 null(예외를 밖으로 던지지 않는다).
 *
 * **성공했는데 출력이 없는 명령이 많다**(`add`·`update-ref`·`checkout`). 그래서
 * 결과를 참·거짓으로 보면 안 된다 — 빈 문자열은 성공이다. 반드시 `=== null`로
 * 실패를 가려야 한다. 처음에 falsy로 판정했다가 스냅샷이 통째로 안 만들어졌다.
 */
function git(dir, args, opts = {}) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      ...opts,
    })
  } catch {
    return null
  }
}

/**
 * 지금 작업트리 전체를 트리 객체로 굳힌다(무시 목록은 존중).
 *
 * 사용자의 인덱스(`.git/index`)를 쓰면 그 사람이 `git add` 해 둔 것이 날아간다.
 * 우리 전용 인덱스 파일을 따로 쓴다.
 */
function writeWorkTree(dir) {
  const idx = path.join(dir, '.git', 'teamview-index')
  const env = { ...process.env, GIT_INDEX_FILE: idx }
  try {
    if (git(dir, ['add', '-A'], { env }) === null) return null
    const tree = git(dir, ['write-tree'], { env })
    return tree ? tree.trim() : null
  } finally {
    try {
      fs.unlinkSync(idx)
    } catch {
      /* 남아도 다음에 덮어쓴다 */
    }
  }
}

/**
 * 지시를 실행하기 직전 상태를 남긴다. git이 아니면 조용히 넘어간다.
 * 반환값은 스냅샷 참조 이름(결과물 패널이 이걸로 되돌린다).
 */
function takeSnapshot(dir, label) {
  if (!gitRoot(dir)) return null
  const tree = writeWorkTree(dir)
  if (!tree) return null
  const head = git(dir, ['rev-parse', 'HEAD'])
  const parent = head ? ['-p', head.trim()] : [] // 커밋이 하나도 없는 저장소도 있다
  const msg = `teamview snapshot — ${String(label ?? '').slice(0, 120)}`
  const commit = git(dir, ['commit-tree', tree, ...parent, '-m', msg])
  if (!commit) return null
  const ref = `${SNAP_REF_PREFIX}/${Date.now()}`
  if (git(dir, ['update-ref', ref, commit.trim()]) === null) return null
  pruneSnapshots(dir)
  return ref
}

// 스냅샷을 무한히 쌓아 두지 않는다. 오래된 것부터 지운다 — 참조가 없어지면
// git이 알아서 객체를 정리한다.
const SNAP_KEEP = 30

function pruneSnapshots(dir) {
  const out = git(dir, ['for-each-ref', '--format=%(refname)', SNAP_REF_PREFIX])
  if (!out) return
  const refs = out.trim().split('\n').filter(Boolean).sort()
  for (const ref of refs.slice(0, Math.max(0, refs.length - SNAP_KEEP))) {
    git(dir, ['update-ref', '-d', ref])
  }
}

/**
 * 스냅샷 이후 무엇이 달라졌는지. **되돌리기 전에 사람에게 보여 줄 목록이다.**
 * 되돌리기가 오히려 작업을 날리는 일이 없어야 한다.
 */
function snapshotDiff(dir, ref) {
  const tree = writeWorkTree(dir)
  if (!tree) return null
  const out = git(dir, ['diff', '--name-status', ref, tree])
  if (out === null) return null
  const items = []
  for (const line of out.split('\n')) {
    const [st, ...rest] = line.split('\t')
    const p = rest.join('\t').trim()
    if (!p) continue
    items.push({ status: st.trim()[0], path: p })
  }
  return items
}

/** 스냅샷 시점으로 되돌린다. 만들어진 것은 지우고, 고쳐지거나 지워진 것은 되살린다. */
function restoreSnapshot(dir, ref) {
  const items = snapshotDiff(dir, ref)
  if (!items) return { ok: false, error: '변경 내용을 읽지 못했습니다' }
  let removed = 0
  let restored = 0
  const failed = []
  for (const it of items) {
    const full = path.join(dir, it.path)
    if (it.status === 'A') {
      try {
        fs.unlinkSync(full)
        removed++
      } catch (err) {
        failed.push(`${it.path}: ${err.message}`)
      }
    } else {
      if (git(dir, ['checkout', ref, '--', it.path]) !== null) restored++
      else failed.push(it.path)
    }
  }
  // 파일을 지우고 남은 빈 폴더를 치운다. 남겨 두면 되돌렸는데 흔적이 남는다.
  pruneEmptyDirs(dir, items)
  return { ok: failed.length === 0, removed, restored, failed }
}

/** 되돌리며 비게 된 폴더만 지운다. 프로젝트 최상위는 절대 건드리지 않는다. */
function pruneEmptyDirs(dir, items) {
  const dirs = new Set()
  for (const it of items) {
    if (it.status !== 'A') continue
    let d = path.dirname(path.join(dir, it.path))
    while (d.length > dir.length) {
      dirs.add(d)
      d = path.dirname(d)
    }
  }
  // 깊은 것부터 지워야 상위가 비워진다
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      if (fs.readdirSync(d).length === 0) fs.rmdirSync(d)
    } catch {
      /* 비어 있지 않거나 이미 없으면 그만 */
    }
  }
}

ipcMain.handle('snapshot:diff', (_e, { dir, ref }) => {
  if (!loadProjects().includes(dir)) return { ok: false, error: '붙어 있지 않은 프로젝트입니다' }
  const items = snapshotDiff(dir, ref)
  return items ? { ok: true, items } : { ok: false, error: '스냅샷을 읽지 못했습니다' }
})

ipcMain.handle('snapshot:restore', (_e, { dir, ref }) => {
  if (!loadProjects().includes(dir)) return { ok: false, error: '붙어 있지 않은 프로젝트입니다' }
  // 되돌리기도 되돌릴 수 있어야 한다. 되돌리기 직전 상태를 한 번 더 남긴다.
  takeSnapshot(dir, '되돌리기 직전')
  const res = restoreSnapshot(dir, ref)
  if (res.ok || res.restored || res.removed) pumpStatusAll({ force: true })
  return res
})

/**
 * 이 폴더를 관리하는 git 저장소의 최상위 경로. 아니면 null.
 *
 * `.git`이 있는지만 보면 안 된다 — 상위 폴더의 저장소에 속한 하위 폴더도 버전
 * 관리를 받는다(그 경우 되돌릴 수 있으므로 경고할 이유가 없다). git에게 직접 묻는다.
 */
function gitRoot(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    }).trim()
  } catch {
    return null // git이 없거나, 저장소가 아니거나
  }
}

/** 커밋할 사람 정보가 설정돼 있는가. 없으면 `git commit`이 통째로 실패한다. */
function gitIdentity() {
  const read = (key) => {
    try {
      return execFileSync('git', ['config', '--get', key], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 4000,
      }).trim()
    } catch {
      return ''
    }
  }
  return { name: read('user.name'), email: read('user.email') }
}

// 처음 만드는 .gitignore. **이게 없으면 첫 커밋에 node_modules가 통째로 들어간다** —
// 되돌릴 수단을 만들려다 몇 만 개 파일을 커밋하게 된다.
const DEFAULT_GITIGNORE = `node_modules/
.next/
dist/
build/
out/
coverage/
*.log

# 환경변수 — 실수로 올라가면 되돌리기 어렵다
.env
.env.*
!.env.example

# OS
.DS_Store
Thumbs.db
`

/**
 * 되돌릴 수 있게 만든다: `git init` + 첫 커밋까지.
 *
 * **init만 해서는 아무것도 지켜지지 않는다.** 커밋이 하나 있어야 돌아갈 지점이
 * 생긴다. 그래서 .gitignore를 먼저 두고(없을 때만) 전체를 한 번 커밋한다.
 */
function gitInit(dir) {
  const already = gitRoot(dir)
  if (already) return { ok: true, already: true, root: already }

  const run = (args) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    })

  const done = []
  try {
    run(['init'])
    done.push('저장소 생성')

    const ignore = path.join(dir, '.gitignore')
    if (!fs.existsSync(ignore)) {
      fs.writeFileSync(ignore, DEFAULT_GITIGNORE, 'utf8')
      done.push('.gitignore 추가')
    }

    run(['add', '-A'])
    // 사람 정보가 없으면 커밋이 실패한다. 전역 설정을 건드리지 않고 이 커밋에만 붙인다.
    const id = gitIdentity()
    const who = []
    if (!id.name) who.push('-c', 'user.name=윤사무실')
    if (!id.email) who.push('-c', 'user.email=yunoffice@localhost')
    execFileSync('git', ['-C', dir, ...who, 'commit', '-m', '첫 상태 — 윤사무실이 되돌릴 지점을 만들었습니다'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    })
    const n = run(['rev-list', '--count', 'HEAD']).trim()
    done.push(`첫 커밋 (${n}개)`)
  } catch (err) {
    // stderr에 진짜 이유가 있다. 삼키면 사용자는 "왜 안 되지"만 남는다.
    const why = String(err.stderr || err.message || '').trim().split('\n').slice(-3).join(' ')
    return { ok: false, error: why || '알 수 없는 오류', done }
  }
  healthCache.delete(dir) // 방금 바뀌었다
  return { ok: true, done, root: gitRoot(dir) }
}

// 채팅 패널 폭. 창 크기와 달리 앱이 기억해 줘야 매번 다시 끌지 않는다.
ipcMain.handle('ui:chat-width', (_e, px) => {
  const w = Number(px)
  if (!Number.isFinite(w) || w < 200 || w > 4000) return { ok: false }
  const cfg = loadConfig()
  cfg.chatWidth = Math.round(w)
  saveConfig(cfg)
  return { ok: true }
})

ipcMain.handle('git:init', (_e, dir) => {
  if (!loadProjects().includes(dir)) return { ok: false, error: '붙어 있지 않은 프로젝트입니다' }
  const res = gitInit(dir)
  if (res.ok) pumpStatusAll({ force: true })
  return res
})

/**
 * 프로젝트에 깔린 훅이 앱이 들고 있는 것보다 낡았는가.
 *
 * 훅은 **우리 파일이라 사람이 고칠 일이 없다** — 다르면 낡은 것이고 덮어써도 된다.
 * (CLAUDE.md는 사람이 개요·스택을 채워 넣는 파일이라 이렇게 다루면 안 된다.
 * 그래서 지침 변경은 매 지시에 붙는 프롬프트 쪽에도 같이 적어 둔다.)
 */
function staleHook(dir) {
  const src = path.join(__dirname, 'hooks', 'team_events.py')
  const dst = path.join(dir, '.claude', 'hooks', 'team_events.py')
  try {
    if (!fs.existsSync(dst)) return false // 없는 건 '낡음'이 아니라 '없음'이다
    const a = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n')
    const b = fs.readFileSync(dst, 'utf8').replace(/\r\n/g, '\n')
    return a !== b
  } catch {
    return false
  }
}

/**
 * CLAUDE.md의 **팀 규칙 부분만** 앱보다 낡았는지. 위쪽(개요·기술 스택·주요 명령어)은
 * 사람이 채우는 자리라 다른 게 정상이므로 비교하지 않는다.
 */
function staleGuide(dir) {
  const target = path.join(dir, 'CLAUDE.md')
  try {
    if (!fs.existsSync(target)) return false // 없는 건 '낡음'이 아니라 '없음'이다
    const norm = (s) => s.replace(/\r\n/g, '\n')
    const cur = norm(fs.readFileSync(target, 'utf8'))
    const tpl = norm(fs.readFileSync(path.join(templateDir(), 'CLAUDE.md'), 'utf8'))
    const a = cur.indexOf(TEAM_SECTION)
    const b = tpl.indexOf(TEAM_SECTION)
    if (a < 0 || b < 0) return false // 사람이 구조를 바꿨으면 건드릴 판단을 하지 않는다
    return cur.slice(a) !== tpl.slice(b)
  } catch {
    return false
  }
}

function staleAgents(dir) {
  const src = path.join(templateDir(), 'agents')
  const dst = path.join(dir, '.claude', 'agents')
  let n = 0
  try {
    // 해고한 사람은 '없는 것'이지 '낡은 것'이 아니다. 세지 않으면 갱신 배지가
    // 영영 남고, 그 배지를 눌러 갱신하면 해고자가 되살아난다.
    const fired = new Set(firedIds(dir))
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith('.md')) continue
      if (fired.has(f.replace(/\.md$/i, ''))) continue
      const want = fs.readFileSync(path.join(src, f), 'utf8')
      let have = null
      try {
        have = fs.readFileSync(path.join(dst, f), 'utf8')
      } catch {
        /* 없으면 다른 것으로 친다 */
      }
      // 줄바꿈은 비교에서 뺀다. git이 체크아웃할 때 CRLF로 바꾸는 탓에, 방금 복사한
      // 파일도 전부 '다름'으로 잡혔다(6개 중 6개가 줄바꿈만 달랐다). 그대로 두면
      // 갱신 버튼이 영영 사라지지 않는다.
      if (have === null || have.replace(/\r\n/g, '\n') !== want.replace(/\r\n/g, '\n')) n++
    }
  } catch {
    return 0 // 템플릿을 못 읽으면 판단하지 않는다
  }
  return n
}

/**
 * 이 프로젝트가 **무엇으로 만들어져 있는지**.
 *
 * 팀이 며칠 굴러간 프로젝트를 다시 열면 무슨 스택인지 기억나지 않는다. CLAUDE.md에
 * 적어 두면 좋지만 비어 있는 경우가 많아서, 실제 파일에서 읽어 낸다 — **짐작하지
 * 않고 있는 것만** 적는다.
 */
function detectStack(dir) {
  const has = (...p) => fs.existsSync(path.join(dir, ...p))
  const out = []
  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    /* 노드 프로젝트가 아닐 수 있다 */
  }
  if (pkg) {
    const d = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    const pick = [
      ['next', 'Next.js'],
      ['nuxt', 'Nuxt'],
      ['@remix-run/react', 'Remix'],
      ['astro', 'Astro'],
      ['react', 'React'],
      ['vue', 'Vue'],
      ['svelte', 'Svelte'],
      ['@angular/core', 'Angular'],
      ['express', 'Express'],
      ['fastify', 'Fastify'],
      ['@nestjs/core', 'NestJS'],
      ['electron', 'Electron'],
      ['react-native', 'React Native'],
      ['typescript', 'TypeScript'],
      ['tailwindcss', 'Tailwind'],
      ['@supabase/supabase-js', 'Supabase'],
      ['@supabase/ssr', 'Supabase'],
      ['@prisma/client', 'Prisma'],
      ['drizzle-orm', 'Drizzle'],
      ['mongoose', 'MongoDB'],
      ['pg', 'PostgreSQL'],
      ['vitest', 'Vitest'],
      ['jest', 'Jest'],
      ['playwright', 'Playwright'],
    ]
    // 프레임워크는 가장 위쪽 하나만 — Next.js면 React를 따로 적지 않는다.
    const framework = pick.slice(0, 10).find(([k]) => d[k])
    if (framework) out.push(framework[1])
    for (const [k, name] of pick.slice(10)) if (d[k] && !out.includes(name)) out.push(name)
  }
  // 의존성이 하나도 없는 프로젝트도 있다(내장 모듈만 쓰는 경우). 그래도 무엇으로
  // 도는지는 알려 준다 — 빈칸보다 낫다.
  if (pkg && !out.length) {
    const major = String(pkg.engines?.node ?? '').match(/\d+/)
    out.push(major ? `Node ${major[0]}` : 'Node.js')
  }
  if (!out.includes('TypeScript') && has('tsconfig.json')) out.push('TypeScript')
  if (has('requirements.txt') || has('pyproject.toml')) out.push('Python')
  if (has('go.mod')) out.push('Go')
  if (has('Cargo.toml')) out.push('Rust')
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) out.push('JVM')
  if (has('Gemfile')) out.push('Ruby')
  if (has('composer.json')) out.push('PHP')
  if (has('Dockerfile') || has('compose.yaml') || has('docker-compose.yml')) out.push('Docker')
  return out.slice(0, 8)
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
    health: projectHealth(dir),
    run: runState(dir),
  }))
  // 기억해 둔 채팅 폭을 같이 보낸다. 화면이 처음 뜰 때 지난번 폭으로 맞춘다.
  const payload = {
    projects,
    activeDir,
    max: MAX_PROJECTS,
    chatWidth: loadConfig().chatWidth || null,
    // 보고 있는 프로젝트 것만 보낸다. 셋 다 담으면 300ms마다 오가는 양이 세 배가 된다.
    usage: activeDir ? usageSummary(activeDir) : null,
    // 화면이 캐릭터를 세울 실제 명단. **새 채널을 만들지 않는다** — 상태와 명단이
    // 따로 오면 순서가 어긋나 빈 자리나 유령 캐릭터가 생긴다.
    team: activeDir ? readTeam(activeDir).map(({ id, scope, seat }) => ({ id, scope, seat })) : null,
  }
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

  // **팀원이 바뀌는 지점마다 되돌릴 지점을 남긴다.**
  //
  // 지시 시작에만 남기면 116분 5단계 작업에 스냅샷이 하나뿐이다. "리뷰 수정만
  // 되돌리고 싶다"가 안 되고 통째로 처음으로 돌아가야 한다.
  //
  // 보고 있지 않은 사무실도 남긴다 — 되돌리기는 나중에 탭을 옮겨서 하게 된다.
  // 다시 읽는 중(replay)에는 남기지 않는다. 탭을 옮길 때마다 옛 이벤트로
  // 스냅샷이 쌓이면 보관 한도를 옛것으로 채워 버린다.
  if (!w.replay && chunk.includes('"agent_start"')) {
    const who = []
    for (const line of chunk.split('\n')) {
      if (!line.includes('agent_start')) continue
      try {
        const ev = JSON.parse(line.trim())
        if (ev.type === 'agent_start' && ev.agent) who.push(ev.agent)
      } catch {
        /* 깨진 줄은 넘긴다 */
      }
    }
    // 한 번에 여러 명이 시작해도 스냅샷은 하나면 된다(그 시점 상태는 하나다).
    if (who.length) takeSnapshot(dir, `${who.join('·')} 시작 전`)
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
  // 탭을 옮기는 순간은 사람이 그 프로젝트를 들여다보는 순간이다. 캐시가 식기를
  // 기다리지 말고 다시 검사한다(방금 훅을 깔았을 수도 있다).
  healthCache.delete(dir)
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

/**
 * 정상 상태가 가는 곳. **오류 로그와 파일을 나눈다.**
 *
 * `renderer.log`는 화면이 까맣게 죽었는데 로그가 텅 비어 있던 일을 겪고 만든
 * **오류 파일**이다. 그런데 `실행 준비됨`·`작업 종료` 같은 정상 상태가 같이 들어오면서
 * 87줄 중 대부분이 평상시 기록이 됐다 — 진짜 오류(`화면 프로세스 종료: crashed`,
 * `보조 프로세스 종료`)가 그 사이에 묻혔다.
 *
 * 레벨만 붙이고 한 파일에 두면 결국 사람이 눈으로 걸러야 한다. 파일을 나누면
 * `renderer.log`를 여는 것만으로 "무엇이 잘못됐나"가 답이 된다. 평상시 흐름이
 * 필요할 때가 있으므로(누가 실행을 껐다 켰는지 등) 버리지는 않고 옆에 둔다.
 */
function activityLogPath() {
  return path.join(app.getPath('userData'), 'activity.log')
}

// 로그 파일 상한. 이벤트 로그(512KB)·채팅(2000줄)에는 있는데 여기만 없어서
// 몇 달 쓰면 한없이 자랐다. 실행이 실패할 때마다 15줄씩 붙기도 한다.
const LOG_MAX_BYTES = 256 * 1024
const LOG_KEEP_BYTES = 64 * 1024

/**
 * 화면이 죽거나 멎었을 때 같이 남길 사정.
 *
 * `crashed` 한 단어만 남으면 다음에 또 나도 알 수 있는 게 없다. 메인 쪽에서 아는 것과,
 * 렌더러가 마지막으로 알려 준 상태를 함께 적는다.
 */
function crashContext() {
  const mb = (n) => `${Math.round(n / 1024 / 1024)}MB`
  const lines = []
  lines.push(
    `켠 지 ${Math.round((Date.now() - bootAt) / 60000)}분 · 붙은 프로젝트 ${loadProjects().length}개` +
      ` · 보는 중 ${activeDir ? path.basename(activeDir) : '없음'}`,
  )
  const busy = runningCompanies()
  lines.push(`실행 중인 지시 ${busy.length}건${busy.length ? ` (${busy.join(', ')})` : ''}` +
    ` · 띄워 둔 서버 ${runners.size}개`)
  try {
    const m = process.memoryUsage()
    lines.push(`메인 메모리 rss ${mb(m.rss)} · heap ${mb(m.heapUsed)}`)
  } catch {
    /* 못 재면 그만 */
  }
  if (lastVitals) {
    const age = Math.round((Date.now() - lastVitals.at) / 1000)
    lines.push(
      `화면(${age}초 전): 대화 ${lastVitals.messages}줄 · 팀원 ${lastVitals.agents}명` +
        ` · 결과물 ${lastVitals.outputs}개 · 이벤트 누적 ${lastVitals.events}건` +
        (lastVitals.heap ? ` · heap ${mb(lastVitals.heap)}` : ''),
    )
    if (lastVitals.lastEvent) lines.push(`마지막 이벤트: ${lastVitals.lastEvent}`)
  } else {
    lines.push('화면 상태를 받은 적 없음 (뜨자마자 죽었을 수 있습니다)')
  }
  return lines
}

// 화면이 살아 있는 동안 자기 상태를 알려 준다. 죽고 나면 물어볼 수 없다.
ipcMain.handle('ui:vitals', (_e, v) => {
  lastVitals = { ...v, at: Date.now() }
  return { ok: true }
})

// 화면 쪽에서 잡힌 예외. console-message로도 오지만 형식이 버전마다 달라 놓친 적이 있다.
ipcMain.handle('ui:error', (_e, info) => {
  logRenderer(`화면 오류: ${String(info?.message ?? '').slice(0, 300)}`)
  if (info?.source) logRenderer(`    ${info.source}:${info.line ?? '?'}`)
  if (info?.stack) for (const l of String(info.stack).split('\n').slice(0, 6)) logRenderer(`    ${l.trim()}`)
  return { ok: true }
})

function appendLog(file, line) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  try {
    // 넘치면 **뒤쪽만 남긴다.** 오래된 줄보다 최근 줄이 진단에 쓸모 있다.
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) {
        const buf = fs.readFileSync(file, 'utf8')
        const kept = buf.slice(-LOG_KEEP_BYTES)
        // 잘린 첫 줄이 반쪽짜리로 남지 않게 줄 경계까지 버린다
        fs.writeFileSync(file, kept.slice(kept.indexOf('\n') + 1), 'utf8')
      }
    } catch {
      /* 파일이 없으면 아래에서 만들어진다 */
    }
    fs.appendFileSync(file, stamped + '\n', 'utf8')
  } catch {
    /* 로그를 못 남기는 것이 앱을 멈출 이유는 아니다 */
  }
}

/**
 * **잘못된 것만** 여기 적는다. 평상시 상태는 logActivity로 보낸다.
 *
 * 파일을 나눈 것만으로는 부족했다. 실측 89줄을 새 분류에 태워 보니 정상 34줄이
 * 빠지고도 오류 파일에 55줄이 남는데, 그중 **30줄이 자식 프로세스가 죽으며 뱉은
 * pnpm 스택 트레이스** 한 건이었다. 정작 이 파일을 만든 이유였던 화면 크래시는
 * `렌더러 프로세스 종료: crashed` 같은 4줄뿐이라 그 사이에 다시 묻힌다.
 *
 * 그래서 어디서 난 오류인지 앞에 붙인다 — `[화면]`만 훑으면 앱이 죽은 기록이,
 * `[실행]`·`[지시]`를 보면 남의 프로세스가 죽은 기록이 나온다. 버리는 것은 없다.
 */
function logRenderer(line, where = '화면') {
  console.error('[renderer]', line)
  appendLog(rendererLogPath(), `[${where}] ${line}`)
}

/** 평상시 흐름(실행 시작·중지·작업 종료). 오류 파일을 채우지 않는다. */
function logActivity(line) {
  console.log('[activity]', line)
  appendLog(activityLogPath(), line)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1820,
    height: 1120,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#11131a',
    autoHideMenuBar: true,
    title: '윤사무실 — 우리 팀이 일하는 곳',
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
  // **창이 눈앞에 있는지는 이벤트로 따라간다.**
  //
  // `win.isFocused()`를 그때그때 물어보면 안 된다 — 창을 최소화해 둔 상태에서도
  // `focus=true visible=true min=false`를 돌려주는 것을 실측으로 확인했다(같은 순간
  // Win32는 `IsIconic=true, foreground=false`였다). 그 값을 믿으면 자리를 비운
  // 사람에게 알림이 가지 않는다 — 알림이 필요한 바로 그 상황에서.
  win.on('focus', () => {
    winFocused = true
    try {
      // 보러 온 순간 깜빡임은 제 몫을 다했다. 계속 깜빡이면 성가시기만 하다.
      win.flashFrame(false)
    } catch {
      /* 지원하지 않는 플랫폼 */
    }
  })
  win.on('blur', () => {
    winFocused = false
  })
  // **최소화는 blur를 동반하지 않는다** — 최소화만 했을 때 `minimize`는 오고 `blur`는
  // 오지 않는 것을 실측으로 확인했다. blur 하나만 듣고 있었으면 최소화해 둔 사람은
  // 알림을 못 받았다.
  win.on('minimize', () => {
    winFocused = false
  })
  win.on('hide', () => {
    winFocused = false
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
  // **화면이 죽으면 되살린다.**
  //
  // 한 번 이런 줄이 남았다: `렌더러 프로세스 종료: crashed`. 그게 전부였다 —
  // 왜 죽었는지도, 그때 무엇을 하고 있었는지도 없었고, 창은 까맣게 남아 앱을
  // 다시 켜는 것 말고는 방법이 없었다.
  //
  // 이제 죽은 사정을 최대한 적고, 다시 띄운다. 회사(대기열·실행)는 메인 프로세스에
  // 있어서 화면이 죽어도 계속 돌고 있다 — 화면만 붙이면 하던 일이 이어진다.
  win.webContents.on('render-process-gone', (e, details) => {
    crashCount += 1
    logRenderer(
      `화면 프로세스 종료: ${details.reason}` +
        (details.exitCode !== undefined ? ` (코드 ${details.exitCode})` : '') +
        ` · ${crashCount}번째`,
    )
    for (const line of crashContext()) logRenderer(`    ${line}`)

    // 되살리기를 무한히 되풀이하지 않는다. 계속 죽는다면 원인이 남아 있는 것이고,
    // 껐다 켜기를 반복하면 로그만 불어난다.
    if (crashCount > CRASH_RELOAD_MAX) {
      logRenderer(`    되살리기를 멈춥니다 — ${CRASH_RELOAD_MAX}번을 넘겼습니다`)
      dialog.showErrorBox(
        '윤사무실 — 화면을 되살리지 못했습니다',
        `화면이 ${crashCount}번 종료됐습니다.\n\n` +
          `팀 작업 자체는 계속 돌고 있습니다(대기열·실행은 화면과 별개입니다).\n` +
          `앱을 다시 켜 주세요. 자세한 내용은 아래 파일에 있습니다:\n${rendererLogPath()}`,
      )
      return
    }
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        logRenderer('    화면을 다시 띄웁니다')
        win.reload()
      }
    }, 800)
  })

  // 죽은 것과 멎은 것은 다르다. 멎은 쪽은 로그에 아무것도 안 남아 "느려졌나?"로만 보였다.
  win.webContents.on('unresponsive', () => {
    logRenderer('화면이 응답하지 않습니다')
    for (const line of crashContext()) logRenderer(`    ${line}`)
  })
  win.webContents.on('responsive', () => logRenderer('화면이 다시 응답합니다'))

  // GPU·유틸리티 프로세스가 죽으면 화면이 이상해지는데 원인이 화면 쪽에 안 남는다.
  app.on('child-process-gone', (_e, d) => {
    logRenderer(`보조 프로세스 종료: ${d.type}${d.name ? `(${d.name})` : ''} — ${d.reason}`)
  })

  win.webContents.on('preload-error', (e, preloadPath, err) => {
    logRenderer(`preload 오류 ${preloadPath}: ${err.message}`)
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

/**
 * **윤사무실은 한 번에 하나만 뜬다.**
 *
 * 앱 하나가 프로젝트를 셋까지 다루므로 창을 여러 개 띄울 이유가 없다. 반면 두 개가
 * 뜨면 조용히 망가진다 — `openCompany`는 남의 클레임을 확인하지 않고 덮어쓰기 때문에
 * **둘 다 자기가 회사라고 믿고 같은 대기열을 집어간다.** 같은 지시가 두 번 실행될 수
 * 있다. 설정(config.json)·대화 기록·세션 id도 전부 한 벌뿐이라 서로 덮어쓴다.
 *
 * 두 번째 실행은 창을 새로 만들지 않고 **이미 떠 있는 창을 앞으로 가져온 뒤** 스스로
 * 종료한다. 바로가기를 두 번 눌렀을 때 아무 반응이 없으면 안 켜진 줄 알기 때문이다.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  // **메인 프로세스가 예외로 죽지 않게 한다.**
  //
  // Electron은 메인에서 예외가 새어 나오면 "A JavaScript error occurred in the main
  // process"라는 회색 창을 띄우고 앱을 끝낸다. 사용자에게는 스택 트레이스만 남고,
  // 돌던 지시도 함께 사라진다. 이 앱은 대부분 타이머·이벤트로 돌아가므로, 한 군데서
  // 난 예외 때문에 전부를 끄는 것보다 남기고 계속 도는 편이 낫다.
  process.on('uncaughtException', (err) => {
    logRenderer(`메인 예외: ${err?.message ?? err}`)
    for (const l of String(err?.stack ?? '').split('\n').slice(1, 6)) logRenderer(`    ${l.trim()}`)
    for (const l of crashContext()) logRenderer(`    ${l}`)
  })
  process.on('unhandledRejection', (reason) => {
    logRenderer(`메인 미처리 거부: ${reason?.message ?? reason}`)
  })

  app.whenReady().then(() => {
    // Windows는 이 값이 있어야 알림에 앱 이름과 아이콘이 붙는다. 없으면 알림이
    // "electron.app.Electron" 이름으로 뜨거나 아예 뜨지 않는다.
    if (process.platform === 'win32') app.setAppUserModelId('dev.yjh.teamview')
    // **앱을 켠 시각을 남긴다.** 기록에 이 줄이 없어서, 실행이 몇 초 만에 멈춘 것이
    // 사람이 끈 것인지 앱을 껐다 켠 것인지 로그만으로는 가릴 수 없었다.
    logActivity(`앱을 켰습니다 (v${app.getVersion()}, pid ${process.pid})`)
    // 지난번에 앱이 강제로 끝났다면 서버가 남아 있을 수 있다.
    cleanupOrphanRunners()
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
      // **켤 때도 지난 대화를 되살린다.**
      //
      // 화면은 `events:reset`을 받아야 저장해 둔 대화를 불러온다. 그런데 시작할
      // 때는 그걸 보내지 않아서, **탭을 한 번 옮기기 전까지 대화가 비어 보였다.**
      // 기록은 멀쩡히 있는데(실측: 452줄) 화면에만 안 나왔다 — 앱을 새로 깔면
      // 지난 대화가 날아간 것처럼 보인다.
      send('events:reset', { dir: activeDir })
      pumpStatusAll({ force: true })
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

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
  // 붙이는 순간 무엇이 빠졌는지 알려준다. 나중에 안 움직이는 걸 보고 찾아내는 것보다
  // 지금 한 줄 읽는 편이 낫다.
  return { ok: true, dir, health: projectHealth(dir) }
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

/**
 * 빠진 구성을 채운다. 훅이 깔리면 그 자리에서 회사를 연다 —
 * 세팅해 놓고 앱을 다시 켜야 한다면 반쪽짜리다.
 */
ipcMain.handle('project:setup', (_e, { dir, parts }) => {
  if (!dir) return { ok: false, error: '프로젝트가 지정되지 않았습니다' }
  const res = setupProject(dir, parts ?? { hooks: true, agents: true, guide: true })
  if (res.ok) {
    openCompany(dir) // .claude가 방금 생겼을 수 있다
    if (!watches.has(dir)) startWatching(dir, { replay: true })
    pumpStatusAll({ force: true })
  }
  return { ...res, health: projectHealth(dir) }
})

// ---------- 팀원 고용·해고 IPC ----------
//
// 넷 다 **동기**로 처리한다. 큐를 집어가는 타이머와 같은 스레드에서 도니, 파일을
// 옮기는 사이에 지시가 시작되는 일이 생기지 않는다.

ipcMain.handle('team:list', (_e, { dir } = {}) => listTeam(dir || activeDir))
ipcMain.handle('team:hire', (_e, { dir, id } = {}) => hireAgent(dir || activeDir, id))
ipcMain.handle('team:create', (_e, { dir, ...spec } = {}) => createAgent(dir || activeDir, spec))
ipcMain.handle('team:fire', (_e, { dir, id } = {}) => fireAgent(dir || activeDir, id))

// ---------- 실행 환경 IPC ----------

ipcMain.handle('env:check', (_e, opts) => checkEnv(opts ?? {}))

// 대화 보관 — 앱을 껐다 켜도 그 프로젝트에서 오간 말이 남아 있어야 한다.
ipcMain.handle('chat:load', (_e, dir) => (dir ? loadChat(dir) : []))
ipcMain.handle('chat:append', (_e, { dir, msg }) => {
  if (dir && msg) appendChat(dir, msg)
  return true
})
ipcMain.handle('env:requirements', () => checkRequirements())

/**
 * 빠진 프로그램을 설치하도록 돕는다. **반드시 동의를 먼저 받는다.**
 *
 * 남의 컴퓨터에 프로그램을 넣는 일이라 앱이 조용히 처리하면 안 된다. 무엇을 왜 넣는지,
 * 어떤 명령이 실행되는지 그대로 보여주고 사람이 누른 뒤에만 진행한다.
 *
 * 그리고 **앱이 직접 설치하지 않는다.**
 *   · npm으로 되는 것(claude) → 명령을 새 터미널에 띄운다. 무엇이 도는지 보인다.
 *   · 설치 프로그램이 필요한 것(Node·Python·Git) → 공식 다운로드 페이지를 연다.
 * 설치 파일을 대신 내려받아 실행하는 데까지 가지 않는 이유는, 그 순간 앱이 무엇을
 * 실행하는지 사람이 확인할 방법이 사라지기 때문이다.
 */
ipcMain.handle('env:install', async (_e, key) => {
  const req = REQUIREMENTS.find((r) => r.key === key)
  if (!req) return { ok: false, error: '알 수 없는 항목입니다' }

  const cmdText = req.install ? `${req.install[0]} ${req.install[1].join(' ')}` : null
  const detail = req.install
    ? `아래 명령을 새 터미널 창에서 실행합니다.\n\n    ${cmdText}\n\n${req.why}`
    : `설치 프로그램이 필요합니다. 공식 다운로드 페이지를 브라우저로 엽니다.\n\n    ${req.url}\n\n${req.why}\n\n내려받아 설치한 뒤 "다시 확인"을 눌러 주세요.`

  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['취소', req.install ? '설치 실행' : '다운로드 페이지 열기'],
    defaultId: 1,
    cancelId: 0,
    title: `${req.label} 설치`,
    message: `${req.label}이(가) 설치되어 있지 않습니다. 진행할까요?`,
    detail,
  })
  if (response !== 1) return { ok: false, canceled: true }

  if (req.install) {
    // 선행 조건이 없으면 명령 자체가 실패한다(예: npm 없이 claude 설치).
    if (req.needs) {
      const dep = await runCmd(REQUIREMENTS.find((r) => r.key === req.needs).probe[0], ['--version'], 10_000)
      if (NOT_FOUND.test(dep.out + dep.errOut)) {
        return { ok: false, error: `${req.needs}가 먼저 필요합니다` }
      }
    }
    if (!openInTerminal(req.install[1], `윤사무실 - ${req.label} 설치`, req.install[0])) {
      return { ok: false, manual: cmdText }
    }
    return { ok: true, started: true, cmd: cmdText }
  }

  await shell.openExternal(req.url)
  return { ok: true, opened: req.url }
})

/**
 * 로그인/연결을 시작한다. 창을 띄운 뒤 **끝났는지 지켜본다** — 사람이 브라우저에서
 * 마치는 동안 앱이 알아서 알아채야지, 다시 눌러 보라고 하면 안 된다.
 */
ipcMain.handle('env:login', async (_e, what) => {
  // Figma는 등록(add)과 인증(login)이 별개 명령이다 — connectFigma가 순서를 쥔다.
  // 사람이 브라우저에서 마쳐야 하는 것은 `login`뿐이라 창도 그때만 뜬다.
  if (what === 'figma') return connectFigma('윤사무실 - Figma 연결')
  return openAndWatch(what, ['auth', 'login'], '윤사무실 - Claude 로그인')
})

/**
 * 계정 전환. **로그인과 따로 둔다** — 아직 한 번도 연결 안 한 사람이 밟는 길과,
 * 이미 붙어 있는 걸 다른 계정으로 바꾸는 길은 밟아야 할 순서가 다르다.
 */
ipcMain.handle('env:switch', (_e, payload) => switchAccount(typeof payload === 'string' ? payload : payload?.what))

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

/**
 * 팀이 만든 결과물 링크를 기본 브라우저로 연다.
 *
 * 답변에 Figma 링크가 오는데 지금까지 **텍스트라 열 수가 없었다.** 한 시간짜리
 * 작업의 산출물을 손으로 옮겨 적어야 했다. http(s)만 연다 — 답변은 모델이 만든
 * 문자열이라 `file:` 같은 것이 섞여 들어오면 안 된다.
 */
ipcMain.handle('open:external', async (_e, url) => {
  const s = String(url ?? '')
  if (!/^https?:\/\//i.test(s)) return { ok: false, error: '열 수 없는 주소입니다' }
  await shell.openExternal(s)
  return { ok: true }
})

// ---------------------------------------------------------------------------
// 로컬 실행
//
// **"로컬에서 실행시켜줘"는 회사가 할 수 없는 일이다.**
//
// 회사는 지시 하나를 `claude -p`(비대화형)로 돌리고 끝나면 프로세스를 접는다.
// dev 서버처럼 끝나지 않는 프로세스를 그 안에서 띄우면 세션이 끝날 때 같이 죽는다.
// 실제로 그렇게 됐다 — 팀원이 서버를 띄우고 `/` 200까지 확인해 "실행 중입니다"라고
// 보고했는데, 그 보고가 화면에 뜰 무렵엔 이미 서버가 없었다. 사람이 "안 열리는데"
// 라고 알려 주기 전까지 아무도 몰랐다.
//
// 그래서 **오래 사는 프로세스는 앱이 직접 든다.** 지시 세션과 수명을 분리하고,
// 화면에 주소와 끄는 버튼을 둔다. 팀원에게 시키고 뒷정리를 못 하는 것보다 낫다.

const runners = new Map() // dir -> { child, script, port, url, startedAt, lines }
const stopping = new Set() // 사용자가 끈 것. 그 exit는 실패로 치지 않는다.

// 띄워 둔 서버를 디스크에도 적어 둔다.
//
// 앱을 정상으로 닫으면 before-quit이 서버를 내린다. 그런데 **강제 종료되거나
// 크래시하면 그 핸들러가 돌지 않아** 서버가 주인 없이 남는다(실제로 겪었다 —
// 포트를 쥔 프로세스가 남아 다음에 띄울 때 3001로 밀렸고, 아무도 그 주인을
// 몰랐다). 다음 실행 때 이 기록으로 찾아 정리한다.
function runnersFile() {
  return path.join(app.getPath('userData'), 'runners.json')
}

function saveRunners() {
  const rows = [...runners.entries()].map(([dir, r]) => ({ dir, pid: r.child.pid, at: r.startedAt }))
  try {
    fs.writeFileSync(runnersFile(), JSON.stringify(rows), 'utf8')
  } catch {
    /* 못 적어도 실행 자체는 된다 */
  }
}

/**
 * 지난번에 남은 서버를 정리한다.
 *
 * **PID만 보고 죽이지 않는다.** 그 사이 다른 프로그램이 같은 번호를 받았을 수
 * 있다. 그 프로세스의 명령줄에 우리가 띄운 폴더가 들어 있는지 확인하고 나서
 * 끊는다 — 사용자가 터미널에서 직접 띄운 서버를 죽이면 안 된다.
 */
function cleanupOrphanRunners() {
  let rows = []
  try {
    rows = JSON.parse(fs.readFileSync(runnersFile(), 'utf8'))
  } catch {
    return // 기록이 없으면 정리할 것도 없다
  }
  if (!Array.isArray(rows) || !rows.length) return
  try {
    fs.unlinkSync(runnersFile())
  } catch {
    /* 지우기 실패는 무시 — 아래에서 다시 쓴다 */
  }
  if (process.platform !== 'win32') return

  for (const row of rows) {
    if (!row?.pid || !row?.dir) continue
    const ps =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(row.pid)}" -EA SilentlyContinue;` +
      ` if ($p -and $p.CommandLine -like ${JSON.stringify('*' + path.basename(row.dir) + '*')}) { 'ours' }`
    execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 8000 }, (err, out) => {
      if (err || !String(out).includes('ours')) return // 이미 죽었거나 남의 프로세스다
      logActivity(`지난번에 남은 서버를 정리합니다 — ${path.basename(row.dir)} (PID ${row.pid})`)
      execFile('taskkill', ['/PID', String(row.pid), '/T', '/F'], () => {})
    })
  }
}

/** 이 프로젝트를 띄우는 명령. package.json의 스크립트에서 고른다. */
function runScriptFor(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const s = pkg.scripts || {}
    for (const name of ['dev', 'start', 'serve']) if (s[name]) return name
  } catch {
    /* 노드 프로젝트가 아니면 띄울 방법을 모른다 */
  }
  return null
}

function runState(dir) {
  const r = runners.get(dir)
  return {
    script: runScriptFor(dir), // 없으면 버튼을 숨긴다
    running: !!r,
    url: r?.url ?? null,
    // **주소를 본 것과 서버가 사는 것을 가른다.** `url`만 보고 링크를 내주던 탓에,
    // 주소를 찍고 곧바로 죽은 서버의 링크가 계속 눌리는 채로 남았다(버그 2).
    ready: !!r?.ready,
    dead: !!r?.dead,
    startedAt: r?.startedAt ?? null,
  }
}

/** 자식이 뱉는 줄에서 주소를 줍는다. 포트는 우리가 정하지 않는다(3000이 차 있으면 밀린다). */
function sniffUrl(text) {
  // **색상 코드를 먼저 걷어낸다.** Vite는 포트를 굵게 칠해서 내보낸다:
  //     http://localhost:<ESC>[1m5173<ESC>[22m/
  // 그대로 주우면 주소 안에 escape 문자가 섞인 채로 굳어 링크가 열리지 않는다.
  //
  // 다만 로그에 남은 `실행 준비됨 — daily http://localhost:`는 **이것 때문이 아니었다.**
  // 그 줄의 바이트를 세어 보니 escape 문자가 0개이고 길이가 59자다 — 값 자체에
  // 포트가 없었다는 뜻이다. 진짜 원인은 스트림 조각이 `http://localhost:`에서
  // 끊긴 것이고, 그쪽은 makeLineReader가 막는다. 둘 다 실재하는 별개의 구멍이라
  // 색상 걷어내기도 그대로 둔다.
  const clean = String(text).replace(new RegExp(String.fromCharCode(27) + '\[[0-9;]*[A-Za-z]', 'g'), '')
  // 포트가 붙은 쪽을 먼저 고른다 — 한 줄에 둘 다 나오면 접속되는 것은 그쪽이다.
  const m =
    /https?:\/\/(?:localhost|127\.0\.0\.1):\d+[^\s]*/i.exec(clean) ||
    /https?:\/\/(?:localhost|127\.0\.0\.1)[^\s]*/i.exec(clean)
  return m ? m[0].replace(/[.,)]+$/, '') : null
}

// 개행 없이 이만큼 쌓이면 그냥 한 줄로 흘려보낸다. 진행 막대처럼 `\r`로만 덮어쓰는
// 출력은 개행이 영영 안 올 수 있는데, 그걸 무한정 들고 있으면 메모리가 샌다.
const LINE_BUF_MAX = 64 * 1024

/**
 * 스트림 조각을 **완성된 줄로만** 넘긴다.
 *
 * 자식의 stdout은 줄 단위로 오지 않는다 — 아무 데서나 잘린다. 그걸 그대로 훑다가
 * 주소를 통째로 잃었다. 실측(renderer.log, 08-02 12:16:12 외 4회):
 *
 *     실행 준비됨 — daily http://localhost:
 *
 * 실제 주소는 `http://localhost:5173/`인데 조각이 `http://localhost:`에서 끊겼고,
 * sniffUrl의 포트 없는 fallback이 걸린 채 `if (!r.url)` 가드 때문에 그 값이 굳었다.
 * 링크를 눌러도 아무 데도 가지 않는다. (색상 코드는 sniffUrl이 이미 걷어낸다 —
 * 온전한 줄이면 ANSI가 섞여 있어도 제대로 주웠다. 문제는 오직 조각 분할이었다.)
 *
 * 실패 원인으로 보여 줄 `r.lines`도 같은 이유로 반토막 난 줄이 쌓였다 — 한 글자씩
 * 들어오면 한 줄이 74줄이 된다(실측).
 *
 * **스트림마다 따로** 하나씩 둬야 한다. stdout과 stderr가 버퍼를 나눠 쓰면 서로의
 * 반쪽이 이어 붙어 없던 줄이 생긴다.
 */
function makeLineReader(onLine) {
  let buf = ''
  const cut = (upTo, next) => {
    onLine(buf.slice(0, upTo).replace(/\r$/, ''))
    buf = buf.slice(next)
  }
  return {
    push(chunk) {
      buf += String(chunk)
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) cut(nl, nl + 1)
      if (buf.length > LINE_BUF_MAX) cut(buf.length, buf.length)
    },
    /** 프로세스가 끝나면 개행 없이 남은 꼬리도 흘려보낸다 — 마지막 줄을 버리지 않는다. */
    flush() {
      if (buf.length) cut(buf.length, buf.length)
    },
  }
}

/**
 * 이 줄이 "서버가 죽었다"는 신호인가.
 *
 * **주소가 보이는 것과 서버가 살아 있는 것은 다르다.** 실측(08-02 12:52:47):
 * vite가 `http://localhost:5173/`을 찍은 **직후** 죽었는데, 그 뒤로도 같은 워크스페이스의
 * dev:server가 살아 있어서 `npm run dev` 자체는 4분 25초를 더 버텼다. 앱은 주소를 본
 * 순간 "실행 준비됨"이라고 단정했고, 사용자에게는 열리지 않는 링크만 남았다.
 *
 * 종료코드만 보면 그 4분을 "정상"으로 보낸다. 그래서 출력에서 직접 읽는다.
 * 흔한 `Failed`·`error` 같은 말은 넣지 않는다 — 컴파일 경고에도 나와서 멀쩡한 서버를
 * 죽었다고 하게 된다. 여기 걸리면 "준비됨"을 **말하지 않을** 뿐이므로, 틀리는 쪽은
 * 언제나 조용한 쪽이다.
 */
const RUN_DEAD_RE = /ELIFECYCLE|ERR_PNPM_\w*FAIL|Exit status [1-9]|Command failed with exit code [1-9]/i

// 주소를 주운 뒤 이만큼 지켜본다. 이 사이에 죽으면 "준비됨"이라고 하지 않는다.
// 위 실측에서 vite는 주소를 찍고 1초 안에 죽었다.
const RUN_SETTLE_MS = 4000

function startRun(dir) {
  if (runners.get(dir)) return { ok: true, already: true, ...runState(dir) }
  const script = runScriptFor(dir)
  if (!script) return { ok: false, error: 'package.json에 dev·start 스크립트가 없어 실행 방법을 모릅니다' }

  let child
  try {
    child = spawn('npm', ['run', script], {
      cwd: dir,
      shell: true, // Windows에서 npm은 .cmd다
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (err) {
    return { ok: false, error: `실행 실패: ${err.message}` }
  }

  // `ready`는 `url`과 다르다 — 주소를 주웠는가(url)와 그러고도 살아 있는가(ready).
  // `dead`는 프로세스는 남았는데 서버만 죽은 경우다(아래 RUN_DEAD_RE 참고).
  const r = { child, script, url: null, port: null, startedAt: Date.now(), lines: [], ready: false, dead: false, settleTimer: null }
  runners.set(dir, r)
  // **누가 켰는지 남긴다.** 기록에 시작이 없어서, 준비↔중지가 몇 초 만에 되풀이될 때
  // 사람이 껐다 켠 것인지 앱이 스스로 그런 것인지 로그만으로는 가릴 수 없었다.
  logActivity(`실행 시작 — ${path.basename(dir)} (npm run ${script}, pid ${child.pid})`)

  // 주소를 봤다고 바로 "준비됨"이라 하지 않는다 — 짧게 지켜본 뒤에만 참이 된다.
  const settle = () => {
    r.settleTimer = null
    if (runners.get(dir) !== r || r.dead || r.ready || !r.url) return
    r.ready = true
    logActivity(`실행 준비됨 — ${path.basename(dir)} ${r.url}`)
    pumpStatusAll({ force: true })
  }

  const onLine = (line) => {
    // 마지막 200줄만 들고 있는다. 실패했을 때 무엇 때문인지 보여 주려는 것이지
    // 로그 뷰어를 만들려는 게 아니다.
    if (line.trim()) r.lines.push(line)
    if (r.lines.length > 200) r.lines.splice(0, r.lines.length - 200)

    // **죽었다는 신호가 오면 준비됨을 거둬들인다.** 이미 말했더라도 정정한다 —
    // 열리지 않는 링크를 계속 들고 있는 것이 사용자에게는 더 나쁘다.
    if (!r.dead && RUN_DEAD_RE.test(line)) {
      r.dead = true
      if (r.ready) logRenderer(`실행이 주소를 내놓고 죽었습니다 — ${path.basename(dir)} ${r.url}`, '실행')
      r.ready = false
      pumpStatusAll({ force: true })
      return
    }
    if (r.url || r.dead) return
    const u = sniffUrl(line)
    if (!u) return
    r.url = u
    // 주소를 잡았다는 것까지는 화면에 알린다(버튼이 "준비 중…"에 멈춰 있지 않게).
    // 다만 누를 수 있는 링크로는 아직 내주지 않는다.
    pumpStatusAll({ force: true })
    r.settleTimer = setTimeout(settle, RUN_SETTLE_MS)
    // 앱을 끄는 것을 이 타이머가 붙잡지 않게 한다.
    if (r.settleTimer.unref) r.settleTimer.unref()
  }

  // **스트림마다 버퍼를 따로 둔다.** 섞으면 stdout의 반쪽에 stderr의 반쪽이 이어 붙는다.
  const outReader = makeLineReader(onLine)
  const errReader = makeLineReader(onLine)
  child.stdout.on('data', (b) => outReader.push(b))
  child.stderr.on('data', (b) => errReader.push(b))
  child.stdout.on('end', () => outReader.flush())
  child.stderr.on('end', () => errReader.flush())
  child.on('exit', (code) => {
    // 개행 없이 끝난 마지막 줄까지 넣고 나서 tail을 뜬다 — 죽은 이유가 대개 거기 있다.
    outReader.flush()
    errReader.flush()
    if (r.settleTimer) clearTimeout(r.settleTimer)
    r.ready = false
    const me = runners.get(dir)
    runners.delete(dir)
    saveRunners()
    const name = path.basename(dir)

    // **끈 것과 죽은 것을 가른다.**
    //
    // 중지는 taskkill로 하므로 자식은 코드 1로 끝난다. 그걸 그대로 적었더니
    // 사용자가 정상적으로 누른 '실행 중지'가 로그에 `실행이 코드 1로 끝남`으로
    // 남아, 실패한 것처럼 보였다.
    if (stopping.delete(dir)) {
      logActivity(`실행 중지됨 — ${name} (사용자가 눌렀거나 앱이 닫혔습니다)`)
    } else if (!code) {
      // **조용히 끝나는 것도 남긴다.** 코드 0으로 죽으면 아무 줄도 안 적혔다 —
      // 실측(08-01 08:02:23 → 08:31:16)에서 `실행 준비됨`이 중지 없이 두 번 연달아
      // 찍혔는데, 그 사이에 서버가 스스로 끝난 사실이 기록 어디에도 없었다.
      logActivity(`실행이 스스로 끝났습니다 — ${name} (코드 0)`)
    } else {
      // **왜 죽었는지 같이 남긴다.** 예전에는 코드만 적고 그동안 모아 둔 출력을
      // 통째로 버렸다. 로그에도 화면에도 이유가 없어서 사용자가 알 방법이 없었다.
      const tail = (me?.lines ?? []).slice(-15)
      logRenderer(`실행이 코드 ${code}로 끝남 (${name})`, '실행')
      for (const line of tail) logRenderer(`    ${line}`, '실행')
      // 화면에도 띄운다 — logRenderer는 파일과 콘솔에만 쓴다.
      send('run:failed', { dir, code, lines: tail })
    }
    pumpStatusAll({ force: true })
  })
  child.on('error', (err) => {
    runners.delete(dir)
    logRenderer(`실행 실패(${path.basename(dir)}): ${err.message}`, '실행')
    pumpStatusAll({ force: true })
  })

  saveRunners()
  pumpStatusAll({ force: true })
  return { ok: true, ...runState(dir) }
}

/**
 * 실행을 멈춘다.
 *
 * `child.kill()`로는 부족하다 — `npm run dev`는 자기 밑에 진짜 서버(node)를 두고,
 * 껍데기만 죽이면 포트를 쥔 자식이 남는다. Windows에서는 taskkill로 트리를 끊는다.
 */
function stopRun(dir) {
  const r = runners.get(dir)
  if (!r) return { ok: true, already: true }
  const pid = r.child.pid
  // 이 뒤에 오는 exit는 실패가 아니라 우리가 끈 것이다. runners에서 바로 지우므로
  // (버튼이 즉시 바뀌어야 한다) 표시는 따로 둔다.
  stopping.add(dir)
  try {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {})
    else process.kill(-pid, 'SIGTERM')
  } catch (err) {
    stopping.delete(dir)
    return { ok: false, error: `중지 실패: ${err.message}` }
  }
  runners.delete(dir)
  saveRunners()
  pumpStatusAll({ force: true })
  return { ok: true }
}

ipcMain.handle('run:start', (_e, dir) => (loadProjects().includes(dir) ? startRun(dir) : { ok: false, error: '붙어 있지 않은 프로젝트입니다' }))
ipcMain.handle('run:stop', (_e, dir) => stopRun(dir))
ipcMain.handle('run:log', (_e, dir) => ({ ok: true, lines: runners.get(dir)?.lines ?? [] }))

// 앱을 닫으면 띄워 둔 서버도 같이 내린다. 안 그러면 포트를 쥔 프로세스가 남아
// 다음에 띄울 때 "포트가 이미 쓰이는 중"이 되고, 아무도 그 주인을 모른다.
app.on('before-quit', () => {
  for (const dir of [...runners.keys()]) stopRun(dir)
})

/**
 * 팀이 만든 파일을 탐색기에서 보여 준다.
 *
 * **붙여 놓은 프로젝트 안의 파일만** 연다. 결과물 목록은 이벤트 로그에서 읽은
 * 경로로 만들어지는데, 그 로그는 프로젝트 폴더에 있는 파일이라 사람이 손으로
 * 고칠 수 있다. 아무 경로나 받아 열어 주면 앱이 남의 심부름을 하게 된다.
 */
// 앱 로그를 탐색기에서 연다. 크래시·실행 기록이 여기 남는데 지금까지는 경로를
// 알려 주는 수밖에 없었다(%APPDATA% 안이라 찾아가기도 번거롭다).
ipcMain.handle('log:open', () => {
  const p = rendererLogPath()
  try {
    // 오류 파일을 고른 채로 연다. 평상시 기록(activity.log)은 같은 폴더에 나란히
    // 있으므로 필요하면 바로 보이지만, **먼저 눈에 들어와야 하는 것은 오류다.**
    for (const f of [activityLogPath(), p]) {
      if (!fs.existsSync(f)) fs.writeFileSync(f, '', 'utf8') // 아직 아무 일도 없었으면 빈 파일로
    }
    shell.showItemInFolder(p)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('file:reveal', (_e, target) => {
  const p = path.resolve(String(target ?? ''))
  const inProject = loadProjects().some((dir) => {
    const rel = path.relative(path.resolve(dir), p)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
  })
  if (!inProject) return { ok: false, error: '붙여 놓은 프로젝트 밖의 파일입니다' }
  if (!fs.existsSync(p)) return { ok: false, error: '파일이 없습니다 — 옮겼거나 지운 것 같습니다' }
  shell.showItemInFolder(p)
  return { ok: true }
})

// ---------------------------------------------------------------------------
// 회사
//
// 윤사무실은 **하나의 기업체**다. 앱이 켜져 있으면 회사가 문을 연 것이고, 앱에서 보낸
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
  // **사람이 멈춘 것과 일이 실패한 것을 구분한다.** 죽이면 종료코드가 0이 아니라서
  // 그동안 취소를 누를 때마다 "지시 실패"가 떴다. 실측: 중지를 눌렀는데 화면에는
  // 네 시간 전 오류가 실패 사유로 붙어 나왔다.
  child.teamviewCanceled = true
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

// 회사는 프로젝트마다 **세션 하나를 계속 이어 쓴다**(아래 sessionIdFor). 빠른 대신
// 이전 지시의 맥락이 그대로 남아 있어서, 그냥 두면 하던 일을 계속한다. 실제로
// "프로젝트 소개해줘"를 보냈는데 직전 세션에서 짜던 테스트 스위트를 계속 만들어
// 냈다. 그래서 매 지시를 **새 일감으로 못 박는 문장**을 앞에 붙인다.
const BOUNDARY =
  `[새 지시] 앞의 대화는 이미 끝난 일이다. **하던 일을 이어서 계속하지 마라.**` +
  // **"테스트"를 여기에 적어 둔 것이 사고였다.** 범위를 넘지 말라는 뜻이었는데, 뒤에서
  // qa-tester를 부르라고 해도 앞에서 테스트를 만들지 말라고 하니 서로 부딪힌다. 실측:
  // 116분 작업에서 QA가 0번 불렸고 테스트 파일도 0개였다. 검수는 범위 초과가 아니라
  // 일의 일부다 — 목록에서 뺀다.
  ` 이번 지시가 요구하는 것만 하고, 요청하지 않은 산출물(리팩터링·문서·부가 기능 등)은 만들지 마라.` +
  ` 다만 **끝내기 전 검수(qa-tester)는 범위 초과가 아니다** — 만든 것이 도는지 확인하는 것까지가 이번 지시다.` +
  ` 무엇을 할 것인지 한 줄로 밝히고 시작해라.\n\n`

// 결과를 **말로 답하고 끝내는 것**을 막는다.
//
// 팀원 넷이 5~8분씩 일하고도 파일이 하나도 안 남은 적이 있다. 도구를 한 번도 쓰지
// 않고 전부 텍스트로만 답했고, 그 텍스트는 대화창에만 남아 사라졌다. 기획안·화면
// 설계서를 Figma에 만들라고 에이전트 정의에 적어 뒀는데도 Figma 호출이 0건이었다.
//
// 에이전트 정의에만 적어 두면 리드가 팀원을 부를 때 그 조건이 전달되지 않는다.
// 지시 자체에 붙여야 리드가 넘길 때도 같이 넘어간다.
const DELIVERABLE =
  `\n\n[결과 남기기] **무언가를 만들라는 지시라면** 대화로만 답하고 끝내지 마라.` +
  ` 기획안·화면설계서·플로우는 Figma에 만든다(연결이 없으면 만들지 말고 그 사실을 보고).` +
  ` 코드·설정은 파일로 만든다.` +
  ` 팀원에게 넘길 때도 **이 조건을 그대로 전달**해라.` +
  ` 마지막에 무엇을 어디에 만들었는지 경로나 링크를 한 줄씩 밝혀라.` +
  // 산출물을 강제하는 문장이 **묻는 말에까지 적용돼** 사고가 났다. "쇼핑몰 어디까지
  // 진행됐어?"라는 질문 하나에 기획자가 전체를 감사하고 디자이너가 Figma 보고서를
  // 만들기 시작했다. 예외를 같은 자리에 못 박는다 — 떨어뜨려 두면 앞 문장만 읽는다.
  `\n\n[묻는 말은 예외] **질문에는 답이 곧 결과다.** 현황·상태·구조·이유를 묻는 말에는` +
  ` 파일도 Figma도 만들지 마라. 보고서로 남기지도 마라. 짧게 답하고 끝내라.` +
  // 프로젝트의 CLAUDE.md에도 같은 규칙을 적어 두지만, 그건 복사본이라 낡을 수 있다.
  // **매번 붙는 이 프롬프트가 최신이다.** 아래 셋은 실제로 사고가 났던 자리다.
  `\n\n[만드는 순서] 새 기능·화면을 만드는 지시면 구현부터 들어가지 마라.` +
  ` 기획(planner) → 화면설계(ux-designer, Figma) → 구현 → 리뷰(code-reviewer) → 검수(qa-tester) 순서다.` +
  ` 버그 수정·설정 변경·화면 없는 작업·이미 화면 구성까지 받은 경우는 앞 단계를 건너뛰어도 되지만,` +
  ` **건너뛰었다면 왜 건너뛰었는지 답변에 한 줄로 밝혀라.** 만든 사람이 자기 것을 확인한 건 리뷰가 아니다.` +
  // 실측: 파일 45개짜리 웹앱을 116분 만들면서 qa-tester를 한 번도 부르지 않았다. 지침에
  // "테스트가 필요한 규모면"이라고 적어 둔 탓이다 — 판단을 통째로 넘기면 매번 "아니다"가
  // 된다. **조건을 없애고 마지막 관문으로 못 박는다.**
  `\n\n[끝내기 전 검수] 코드를 만들거나 고쳤으면 **끝내기 전에 반드시 \`qa-tester\`를 불러라.**` +
  ` 리뷰는 코드를 읽는 것이고 검수는 실제로 돌려 보는 것이라 서로를 대신하지 못한다.` +
  ` 무엇을 만들었고 어떻게 돌려 보면 되는지 알려 주고, **통과 여부와 문제 목록**을 받아라.` +
  ` 돌려 볼 수단이 없는 프로젝트면 qa-tester가 그것부터 갖추게 해라 — 검수를 생략하는 이유가 되지 않는다.` +
  // 실측: QA가 검사 스크립트를 `tmp-check/fixtures/`에 만들고 그대로 두고 떠났다.
  // 다음 검수 때 처음부터 다시 만들게 되고, 프로젝트에는 정체 모를 폴더만 남는다.
  ` **검사한 것은 \`tests/\`에 남기게 해라**(이미 다른 규칙이 있으면 그 규칙을 따른다).` +
  ` 임시 폴더에 쓰고 버리면 다음에 또 처음부터 만든다. 명령 하나로 다시 돌아가게 연결해 둔다.` +
  // 실측: 지시에 "배포 준비까지 해 주세요"라고 적혀 있었는데 `release-manager`는
  // 0번 불렸고, 배포 파일도 하나 없었으며, **최종 보고에 언급조차 없었다.** QA 때와
  // 같은 원인이다 — 순서 규칙에 이름이 없으면 그 단계는 없는 것이 된다.
  `\n\n[배포까지 요구했으면] 지시에 배포·출시·CI·도커·실행 환경이 나오면 \`release-manager\`에게 맡겨라.` +
  ` 개발자가 곁다리로 처리하게 두지 마라 — 실제로 통째로 빠진 적이 있다.` +
  `\n\n[빠뜨린 것은 밝혀라] 지시에 적힌 요구 중 **하지 않은 것이 있으면 답변에 반드시 적어라.**` +
  ` 조용히 빠뜨리면 사람은 다 됐다고 믿는다. 못 한 이유와 함께 한 줄로 남겨라.` +
  `\n\n[문제가 나오면 되돌려 보낸다] 검수에서 나온 문제는 **네가 직접 고치지 말고 원래 자리로 돌려보내라** —` +
  ` 구현이 틀렸으면 그걸 만든 개발자에게, 요구사항·설계가 틀렸으면 planner나 ux-designer에게.` +
  ` 고친 뒤 **다시 qa-tester에게 확인받아라.** 두 번 돌려보내도 남는 문제가 있으면 거기서 멈추고` +
  ` **무엇이 왜 남았는지 답변에 적어라.** **검수를 통과하지 못한 것을 "완료"라고 하지 마라.**` +
  `\n\n[오래 사는 프로세스] dev 서버·watch·데몬은 **네가 띄우지 마라.**` +
  ` 지시가 끝나면 세션과 함께 죽어서 "실행 중"이라는 보고만 남고 실제로는 접속이 안 된다.` +
  ` 실행이 필요하면 윤사무실 상단의 \`▶ 실행\` 버튼을 쓰라고 안내해라 — 앱이 들고 있어서 지시가 끝나도 살아 있다.` +
  ` 잠깐 확인이 필요하면 확인 즉시 내리고, 띄워 둔 채로 보고하지 마라.` +
  // **큰 도구 결과 하나가 그 뒤 모든 호출에 곱해진다.** 한 번 컨텍스트에 들어온 것은
  // 그 세션이 끝날 때까지 매 호출마다 다시 실린다. 실측(daily 지시 하나):
  //   · 기획자가 받은 Figma 스크린샷 하나 270,148자 → 이후 호출 30여 번에 곱해져
  //     그 팀원 캐시 읽기 220만의 거의 전부를 차지했다
  //   · 디자이너의 Figma 응답 5건(합계 45만 자) → 캐시 읽기 309만
  //   · 전체 캐시 읽기 7,708만 중 상당 부분이 이런 큰 결과의 되풀이였다
  // 도구를 적게 쓰라는 말이 아니라 **한 번에 크게 받지 말라**는 말이다.
  `\n\n[크게 받지 마라] 도구 결과 하나가 크면 그 세션 내내 매 호출에 다시 실린다.` +
  ` **명령 출력은 잘라서 봐라**(\`| tail -40\`, \`--reporter=dot\` 같은 요약 옵션).` +
  ` 파일은 필요한 부분만 읽어라 — 통째로 읽고 한 줄만 쓰지 마라.` +
  ` **Figma 스크린샷은 꼭 필요할 때 한 번만 받아라.** 같은 화면을 다시 찍지 마라.` +
  ` 결과가 크면 파일로 남기고 필요한 곳만 다시 읽어라.` +
  `\n\n[지우는 명령] rm -rf·Remove-Item·git reset --hard·DROP TABLE은 대상을 정확히 적어라.` +
  ` 상위 폴더로 올라가 지우지 마라 — 옆에 다른 프로젝트가 있다. 임시 폴더는 프로젝트 안에 만들어라.` +
  // **이번 한 번으로 끝난다.** 이 세션은 `claude -p`라 답을 내놓는 순간 프로세스가 죽는다.
  // 실측: 리드가 "두 명이 병렬로 수정 중입니다. 완료되면 이어서 보고하겠습니다"라고 답하고
  // 턴을 끝냈는데, 그 2초 전까지 두 팀원이 파일을 고치고 있었다. 프로세스가 종료되며
  // 수정이 중간에 끊겼고, 앱은 그걸 '완료'로 보고 알림까지 띄웠다.
  `\n\n[이번 턴이 전부다] 네가 답을 내놓는 순간 이 세션은 끝난다. 뒤이어 도는 것은 없다.` +
  ` **"진행 중입니다" "완료되면 이어서 보고하겠습니다" 같은 답을 하지 마라** — 지킬 수 없는 약속이고,` +
  ` 사람은 다 끝난 줄 안다. 팀원에게 맡긴 일은 **결과를 받고 확인한 뒤에** 답해라.` +
  ` 정말 못 끝낼 분량이면 어디까지 했고 무엇이 남았는지 적어라 — 남은 일은 사람이 다시 시킨다.` +
  // 실측: 리드가 `SendMessage`로 QA를 **배경에 돌려놓고** 곧바로 "재검수를 이어서
  // 돌리고 있습니다. 결과를 받은 뒤 최종 보고하겠습니다"라고 답하며 턴을 끝냈다.
  // QA는 그 뒤로 10분을 더 일했고 최종 보고는 오지 않았다. 위 규칙은 "결과를 받고
  // 답해라"였는데, **배경으로 넘기는 도구**를 막지 않아 빠져나갔다.
  ` **배경으로 넘기고 끝내지 마라.** 팀원을 배경에서 이어 돌리는 도구(\`SendMessage\` 같은)로` +
  ` 일을 맡긴 채 답하지 마라 — 네가 답하는 순간 그 일도 함께 죽는다.` +
  ` 결과가 필요한 일은 **기다려서 받은 뒤에** 답해라.`

/**
 * 리드에게 **지금 이 회사에 실제로 있는 사람**을 알려주는 한 줄.
 *
 * CLAUDE.md의 배분표는 세팅할 때 복사된 것이라 해고를 모른다. 문서만 믿은 리드가
 * 없는 팀원을 부르면 그 자리에서 실패한다. 명단의 진실은 디스크이므로 매번 읽어 붙인다.
 * (CLAUDE.md는 사람 것이라 앱이 고치지 않는다.)
 */
function rosterLine(dir) {
  let ids = []
  try {
    ids = readTeam(dir).map((m) => m.id).filter((id) => id !== 'lead')
  } catch {
    return '' // 명단을 못 읽었다고 지시를 못 보낼 이유는 없다
  }
  if (!ids.length) {
    return (
      `\n\n[이 회사의 팀원] **부를 수 있는 서브에이전트가 하나도 없다.** 문서에 이름이 있어도 없는 사람이다.` +
      ` 위임하지 말고 네가 직접 처리하고, 팀원이 필요하면 그 사실을 답변에 한 줄로 밝혀라.`
    )
  }
  return (
    `\n\n[이 회사의 팀원] 지금 부를 수 있는 팀원은 ${ids.join(', ')}뿐이다.` +
    ` **문서(CLAUDE.md)에 있어도 이 목록에 없으면 없는 사람이다** — 부르면 실패한다.` +
    ` 목록에 없는 역할이 필요하면 가장 가까운 팀원에게 맡기거나 네가 처리하고, 무엇이 없어서 그랬는지 한 줄로 밝혀라.`
  )
}

function promptFor(cmd, dir) {
  const who = cmd.agent
  const body = String(cmd.text ?? '')
  const task =
    who && who !== 'lead'
      ? `다음 지시를 ${who} 서브에이전트에게 맡기려 해.${HANDOFF} 지시: ${body}`
      : `다음 지시를 읽고 성격에 맞는 서브에이전트에게 위임해서 처리해줘.` +
        ` 직접 처리하지 말고 Task 도구를 쓰고, 여러 파트가 걸리면 planner로 나눈 뒤 각자에게 넘겨줘.` +
        // "직접 하지 말고 위임하라"가 **묻는 말에까지** 적용돼 질문 하나에 팀이 통째로
        // 동원됐다. 조사는 scout 한 명이면 되고, 아는 것이면 그냥 답하면 된다.
        ` 다만 **묻는 말**(현황·상태·구조·이유)이라면 팀을 부르지 마라 —` +
        ` 이미 아는 것이면 바로 답하고, 확인이 필요하면 조사역(scout) 한 명에게만 맡겨라.` +
        ` 지시: ${body}`
  // 결과를 남기라는 조건은 **맨 뒤**에 둔다. 마지막에 읽은 것이 가장 강하게 남는다.
  return BOUNDARY + task + rosterLine(dir) + DELIVERABLE
}

/**
 * 이 프로젝트가 쓸 **고정 세션 id**. 없으면 만들어 설정에 적어 둔다.
 *
 * 예전에는 `--continue`를 썼다. 그건 "그 폴더의 **가장 최근** 대화를 잇는다"라서
 * 두 가지가 깨졌다. 첫째, 사람이 같은 폴더에서 따로 claude를 띄워 두면 **그 대화를
 * 물어 간다.** 둘째, 회사가 만든 세션이 여럿이면 어느 것을 잇는지 알 수 없다
 * (실제로 한 프로젝트에 세션 파일이 5개 쌓여 있었다).
 *
 * 프로젝트마다 id를 하나 고정하면 회사는 **자기 세션만** 잇는다.
 */
function sessionIdFor(dir) {
  const cfg = loadConfig()
  const map = cfg.sessions ?? {}
  if (!map[dir]) {
    map[dir] = crypto.randomUUID()
    saveConfig({ ...cfg, sessions: map })
  }
  return map[dir]
}

/**
 * 그 고정 세션이 이미 만들어졌는가. 있으면 `--resume`, 없으면 `--session-id`다.
 *
 * exit code로 판단하지 않는 이유: 작업이 중간에 끊기거나 오류로 끝나면 code가 0이
 * 아니고, 그러면 다음에도 '세션 없음'으로 봐서 처음부터 다시 시작했다. 세션은 이미
 * 있는데도 **매번 프로젝트 전체를 다시 읽었다**(README·package.json·src 전부).
 * 세션 파일이 있느냐가 사실이므로 그걸 본다.
 */
function sessionPath(dir, sessionId) {
  const enc = dir.replace(/[^a-zA-Z0-9]/g, '-')
  return path.join(app.getPath('home'), '.claude', 'projects', enc, `${sessionId}.jsonl`)
}

function sessionExists(dir, sessionId) {
  return fs.existsSync(sessionPath(dir, sessionId))
}

// ---------------------------------------------------------------------------
// 토큰 사용량
//
// **얼마나 썼는지 볼 방법이 앱 안에 없었다.** 한도에 걸려 일이 멈춘 뒤에야 알았고,
// 그때도 "토큰 사용량 한도"라는 실패 사유가 전부였다 — 오늘 얼마나 썼는지, 어느
// 팀원이 많이 썼는지는 어디에도 없었다.
//
// 기록은 두 곳에 나뉘어 있다. 리드는 `<세션>.jsonl`에, **팀원은 `<세션>/subagents/`
// 아래 따로** 쌓인다. 리드 것만 세면 실측에서 출력 22만인데, 팀원까지 합치면 75만이다
// — 3분의 1만 보고 있던 셈이다. 팀원 줄에는 `attributionAgent`가 있어 누가 썼는지도
// 알 수 있다.
//
// 파일이 10MB를 넘어가므로 **읽은 지점을 기억하고 새로 붙은 만큼만** 읽는다.
const usageState = new Map() // dir → { files, day, agent, total, mark }
const newTally = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })
const addTally = (t, o) => {
  t.input += o.input
  t.output += o.output
  t.cacheWrite += o.cacheWrite
  t.cacheRead += o.cacheRead
  return t
}
const subTally = (a, b) => ({
  input: a.input - b.input,
  output: a.output - b.output,
  cacheWrite: a.cacheWrite - b.cacheWrite,
  cacheRead: a.cacheRead - b.cacheRead,
})

/** 이 프로젝트의 기록 파일 전부 — 리드 세션과 팀원 세션. */
function usageFiles(dir) {
  const folder = path.dirname(sessionPath(dir, 'x'))
  const out = []
  try {
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(folder, e.name))
      else if (e.isDirectory()) {
        const sub = path.join(folder, e.name, 'subagents')
        try {
          for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) out.push(path.join(sub, f))
        } catch {
          /* 팀원을 부르지 않은 세션에는 없다 */
        }
      }
    }
  } catch {
    /* 아직 한 번도 안 돌린 프로젝트 */
  }
  return out
}

/** 새로 붙은 줄만 읽어 사용량을 누적한다. */
function readUsage(dir) {
  let st = usageState.get(dir)
  if (!st) {
    st = { files: new Map(), day: new Map(), agent: new Map(), total: newTally(), mark: null }
    usageState.set(dir, st)
  }
  for (const file of usageFiles(dir)) {
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      continue
    }
    let from = st.files.get(file) || 0
    if (size < from) from = 0 // 파일이 줄었으면 처음부터(세션을 새로 만든 경우)
    if (size <= from) continue
    let text
    try {
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(size - from)
      fs.readSync(fd, buf, 0, buf.length, from)
      fs.closeSync(fd)
      text = buf.toString('utf8')
    } catch {
      continue
    }
    // 마지막 줄이 잘려 있을 수 있다(쓰는 중). 거기까지만 읽은 것으로 표시한다.
    const cut = text.lastIndexOf('\n')
    if (cut < 0) continue
    st.files.set(file, from + Buffer.byteLength(text.slice(0, cut + 1), 'utf8'))
    for (const line of text.slice(0, cut).split('\n')) {
      if (!line.includes('"usage"')) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const u = rec?.message?.usage
      if (!u || typeof u !== 'object') continue
      const one = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      }
      addTally(st.total, one)
      const day = String(rec.timestamp || '').slice(0, 10)
      if (day) addTally(st.day.get(day) || st.day.set(day, newTally()).get(day), one)
      const who = rec.attributionAgent || 'lead'
      addTally(st.agent.get(who) || st.agent.set(who, newTally()).get(who), one)
    }
  }
  return st
}

/** 지금 이 지시가 시작된 지점을 표시해 둔다. 이후 사용량이 '이번 지시' 몫이다. */
function markUsage(dir) {
  const st = readUsage(dir)
  st.mark = { ...st.total }
}

/** 화면에 보낼 요약. */
function usageSummary(dir) {
  const st = readUsage(dir)
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const agents = [...st.agent.entries()]
    .map(([name, t]) => ({ name, ...t }))
    .sort((a, b) => b.output - a.output)
    .slice(0, 12)
  return {
    total: st.total,
    today: st.day.get(key) || newTally(),
    run: st.mark ? subTally(st.total, st.mark) : null,
    agents,
  }
}

// 자주 겪는 실패를 사람 말로 옮긴다. 원문은 영어로 오고, 무엇을 해야 하는지도 안 적혀 있다.
//
// `wait`는 **사용자가 손댈 것이 없는** 실패다. 기다리면 저절로 풀린다. 이걸 표시하지
// 않았더니 화면에는 고쳐야 할 실패와 똑같이 `코드 1`로만 떴다 — 무엇이 망가졌는지
// 찾아 나서게 되는데 망가진 것은 없다.
const FAILURE_KINDS = [
  {
    re: /session limit|usage limit|rate limit|quota|too many requests|\b429\b/i,
    label: '토큰 사용량 한도',
    wait: true,
    hint: '한도가 풀린 뒤 같은 지시를 다시 보내면 됩니다.',
  },
  { re: /overloaded|\b529\b|service unavailable|\b503\b/i, label: '서버 혼잡', wait: true, hint: '잠시 뒤 다시 보내 보세요.' },
  { re: /credit|billing|payment/i, label: '결제·크레딧 문제', hint: 'Claude 계정의 결제 상태를 확인하세요.' },
  { re: /authentication|unauthorized|\b401\b|logged out/i, label: '로그인 만료', hint: '상단 Claude 점을 눌러 다시 로그인하세요.' },
]

/**
 * 지시가 왜 실패했는지 **세션 기록에서** 읽어 온다.
 *
 * `claude`는 stderr로 아무것도 쓰지 않는다(실측: 완전히 비어 있었다). 실패 사유는
 * 세션 기록(`~/.claude/projects/…/<id>.jsonl`)의 `is_error` 항목에만 남는다.
 * 그래서 로그에는 "코드 1로 끝남"만 찍히고 **왜인지는 어디에도 없었다** —
 * 실제로 사용량 한도에 걸렸는데 원인 불명으로 보였다.
 */
// 기록의 시각과 앱의 시계가 몇 초 어긋나도 이번 실행의 오류를 놓치지 않게 둔 여유.
const CLOCK_SLACK_SEC = 10

/**
 * 한도가 언제 풀리는지. **문구에 이미 들어 있다 — 버리지 말고 보여 준다.**
 *
 * 실측으로 받은 문구들(renderer.log):
 *   "You've hit your session limit · resets 6:50pm (Asia/Seoul)"
 *   "Agent terminated early due to an API error: You've hit your session limit · resets 5:40pm (Asia/Seoul)"
 *
 * 지금까지는 이 시각이 로그 한 줄에만 묻혀 있었다. 사용자가 정말 알고 싶은 것은
 * "언제 다시 시켜도 되나"인데 화면에는 `코드 1`만 떴다.
 *
 * 못 찾으면 null. **없는 시각을 지어내지 않는다** — 그냥 기다리라고만 하는 편이 낫다.
 */
function resetTimeFrom(message) {
  const m = /resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:\(([^)]{1,40})\))?/i.exec(String(message ?? ''))
  if (!m) return null
  const at = m[1].replace(/\s+/g, '').toLowerCase()
  return m[2] ? `${at} (${m[2]})` : at
}

/**
 * 이번 실행이 실패했는가, 실패했다면 왜인가. 성공이면 `null`.
 *
 * **사유를 못 찾았다고 성공으로 보면 안 된다.** 사유를 이번 실행 것만 보도록 고친
 * 직후 실측에서 드러났다 — 코드 1로 끝났는데 세션 기록에 오류 블록이 없어 사유가
 * `null`이 됐고, 그러자 "작업이 끝났습니다" 알림이 떴다. 사용자는 다 된 줄 안다.
 * **판정은 종료코드가 하고, 사유는 있으면 붙이는 것이다.**
 */
/**
 * 이번 실행에서 **시작만 하고 끝나지 않은 팀원**. 리드가 결과를 안 받고 턴을 끝냈다는
 * 뜻이다.
 *
 * 실측: 리드가 `SendMessage`로 QA를 배경에 돌려놓고 "결과를 받은 뒤 최종 보고하겠습니다"
 * 라고 답하며 끝냈다. QA는 그 뒤 10분을 더 일했고 보고는 오지 않았는데, 종료코드가
 * 0이라 앱은 **"작업 종료"**라고 알렸다. 사람은 다 끝난 줄 안다.
 */
function unfinishedAgents(dir, since) {
  const started = []
  try {
    const lines = fs.readFileSync(eventsFileFor(dir), 'utf8').split('\n')
    for (const line of lines) {
      if (!line.includes('agent_')) continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (since && (e.ts || 0) < since - CLOCK_SLACK_SEC) continue
      if (e.type === 'agent_start' && e.agent) started.push(e.agent)
      else if (e.type === 'agent_stop' && e.agent) {
        const i = started.lastIndexOf(e.agent)
        if (i >= 0) started.splice(i, 1)
      }
    }
  } catch {
    return []
  }
  return [...new Set(started)]
}

function failureFor(dir, sessionId, since, code) {
  if (code === 0) {
    // **끝나지 않은 팀원이 남았으면 끝난 게 아니다.**
    const left = unfinishedAgents(dir, since)
    if (!left.length) return null
    return {
      message: `${left.join('·')}의 작업이 끝나기 전에 리드가 답을 내놓았습니다.`,
      label: '팀원 작업이 끊김',
      hint: '`계속진행해줘`로 이어서 시키면 중단된 지점부터 다시 합니다.',
      wait: false, // 이어서 시켜야 한다 — 기다린다고 풀리지 않는다
      resetAt: null,
    }
  }
  return (
    readSessionError(dir, sessionId, since) || {
      message: `실행이 코드 ${code}로 끝났습니다. 이유가 기록에 남지 않았습니다.`,
      label: null,
      hint: '같은 지시를 다시 보내 보시고, 되풀이되면 상단 `기록`에서 로그를 확인하세요.',
      // **모르는 것을 "기다리면 된다"고 하지 않는다.** 사유를 못 찾았을 뿐이다.
      wait: false,
      resetAt: null,
    }
  )
}

function readSessionError(dir, sessionId, since) {
  // **리드 기록만 보면 놓친다.** 실측: 한도에 걸려 죽었는데 그 메시지는 QA 팀원의
  // 기록에만 있었다. 리드 파일에는 아무것도 없어 "이유가 기록에 남지 않았습니다"가
  // 됐다. 팀원 기록까지 함께 본다.
  const files = usageFiles(dir)
  const mine = sessionPath(dir, sessionId)
  if (!files.includes(mine)) files.push(mine)

  const found = [] // [시각, 문구]
  for (const p of files) {
    let text
    try {
      text = fs.readFileSync(p, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      // 값싼 1차 거르기. 이 셋 중 하나도 없으면 파싱할 이유가 없다.
      if (!line.includes('is_error') && !line.includes('API error') && !line.includes('limit')) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      // **이번 실행 뒤에 적힌 것만 본다.** 기록은 지시마다 이어 붙는다. 시간을 안 보면
      // 지난 지시의 오류를 이번 실패 사유로 붙인다 — 실측: 사용자가 중지를 눌렀는데
      // 네 시간 전 사용량 한도 오류가 사유로 떴다(17:38 오류, 21:37 보고).
      const t = Date.parse(rec?.timestamp || '')
      if (since) {
        if (!Number.isFinite(t) || t / 1000 < since - CLOCK_SLACK_SEC) continue
      }
      const content = rec?.message?.content
      for (const blk of Array.isArray(content) ? content : []) {
        if (blk?.is_error && typeof blk.content === 'string') {
          found.push([t || 0, blk.content.trim()])
          continue
        }
        // **한도 메시지는 오류로 표시되지 않는다.** 그냥 답변 문장으로 남는다:
        // "You've hit your session limit · resets 3:50am (Asia/Seoul)". `is_error`만
        // 보던 탓에 이걸 통째로 놓쳤다. 아는 실패 유형에 걸릴 때만 받아들인다 —
        // 아무 문장이나 받으면 리뷰어가 "rate limit"을 논한 것까지 사유가 된다.
        if (blk?.type === 'text' && typeof blk.text === 'string' && blk.text.length < 400) {
          const hit = FAILURE_KINDS.find((k) => k.re.test(blk.text))
          if (hit) found.push([t || 0, blk.text.trim()])
        }
      }
    }
  }
  if (!found.length) return null
  found.sort((a, b) => a[0] - b[0])
  const message = found[found.length - 1][1].slice(0, 400)
  const kind = FAILURE_KINDS.find((k) => k.re.test(message))
  return {
    message,
    label: kind?.label ?? null,
    hint: kind?.hint ?? null,
    // 기다리면 되는 실패인가, 손봐야 하는 실패인가. 화면이 이 둘을 다르게 보여 준다.
    wait: !!kind?.wait,
    resetAt: kind?.wait ? resetTimeFrom(message) : null,
  }
}

// 권한을 묻지 않는다.
//
// **이건 안전장치를 내리는 설정이다.** 그래도 필요한 이유: 회사는 `claude -p`로
// 도는 비대화형 세션이라 권한을 물어볼 상대가 없다. 물으면 답이 없어 그냥 멈춘다.
//
// 처음에는 `acceptEdits`로 **파일 편집만** 열었다. 열 이유가 없는 것까지 열지 않으려
// 했는데, 실측해 보니 그걸로는 일이 끝나지 않았다. 팀원 넷이 5~8분씩 돌고도 산출물이
// 하나도 안 남았고, 리드의 마지막 답이 이랬다:
//
//   "결과물이 커서 시스템이 JSON 파일로 보관했고, 그 파일을 마크다운으로 옮기려면
//    셸 명령 승인이 필요합니다(방금 승인 대기로 막혔습니다)."
//
// `acceptEdits`는 Bash·MCP 도구를 열지 않는다. 그래서 결과를 옮기는 마지막 한 걸음과
// Figma 호출이 통째로 막혔다(그 작업에서 Figma 도구 호출은 0건이었다). 도구를 못 쓰는
// 팀원은 결국 **말로만 답하고 끝낸다.**
//
// 윤사무실에 보내는 지시는 애초에 "알아서 해줘"가 전제다. 반쯤 열어 두면 안전해지는 게
// 아니라 그냥 일이 안 된다. 대신 README에 **버전 관리가 되는 폴더에만 붙이라**고
// 못 박았다 — 되돌릴 수단은 권한이 아니라 git이 준다.
const PERMISSION_MODE = 'bypassPermissions'

/**
 * 지시 하나를 회사에 태운다.
 *
 * **고정 세션을 이어 쓴다.** 매번 새 세션이면 그때마다 프로젝트를 처음부터 다시
 * 읽는다 — 로그를 재보니 README·package.json·src 전부를 읽는 데만 매번 15초가
 * 들었고, 지시 사이에 아무것도 기억하지 못했다. 세션을 이으면 그 비용이 사라지고
 * "아까 그거 계속해줘"도 통한다.
 *
 * 다만 맥락이 남는 만큼 지시가 서로 섞일 수 있어 프롬프트 앞에 경계를 못 박는다(BOUNDARY).
 *
 * `TEAMVIEW_POLLER`는 훅이 "이 세션은 회사가 띄운 것"이라고 알아보는 표식이다.
 * 이게 있어야 그 세션의 활동이 화면에 기록되고, 취소 깃발을 훅이 함부로 내리지 않는다.
 */
function runCommand(c, cmd) {
  const dir = c.dir
  // **일을 시작하기 전에 돌아갈 지점을 남긴다.** git이 아니면 조용히 넘어간다
  // (그 경우 상단에 `⚠ 되돌리기 없음`이 이미 떠 있다).
  const snapRef = takeSnapshot(dir, cmd.text)
  // 실패 사유를 세션 기록에서 찾을 때 **이 시점 뒤에 적힌 것만** 본다. 기록은 지시마다
  // 이어 붙으므로, 시간을 안 보면 지난 지시의 오류가 이번 실패 사유로 붙는다.
  const startedAt = Date.now() / 1000
  // 여기서부터 쌓이는 토큰이 '이번 지시' 몫이다.
  markUsage(dir)
  const sid = sessionIdFor(dir)
  const args = ['-p', '--permission-mode', PERMISSION_MODE]
  // 이미 있는 세션이면 잇고, 처음이면 그 id로 새로 만든다.
  args.push(sessionExists(dir, sid) ? '--resume' : '--session-id', sid)

  let child
  try {
    child = spawn('claude', args, {
      cwd: dir,
      shell: true, // Windows에서 claude는 .cmd 래퍼라 셸이 필요하다
      // **프롬프트는 인자가 아니라 stdin으로 보낸다.** 셸을 거치면 인자가 공백마다
      // 쪼개지고 줄바꿈 뒤는 통째로 잘린다 — 실측으로 프롬프트 하나가 인자 35개가
      // 되고 정작 지시 내용("지시: ...")은 사라졌다. 그동안 리드가 엉뚱한 일을 한
      // 이유가 여기 있었다. stdin은 셸 파싱을 거치지 않으므로 그대로 도착한다.
      // **stderr는 받아 둔다.** 예전에는 버렸는데, 실행이 실패하면 코드만 남고
      // 이유가 어디에도 없었다("코드 1로 끝남"이 전부였다). 받아서 마지막 몇 줄만
      // 들고 있다가 실패했을 때 같이 보여 준다. stdout은 계속 흘려보낸다 —
      // 진행 상황은 훅이 이벤트로 남기므로 여기서 또 받을 이유가 없다.
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, TEAMVIEW_POLLER: String(process.pid) },
    })
    child.stdin.on('error', () => {}) // 자식이 먼저 죽으면 EPIPE가 난다 — 무시
    child.stdin.end(promptFor(cmd, dir), 'utf8')
  } catch (err) {
    logRenderer(`회사 실행 실패(${dir}): ${err.message}`, '지시')
    return
  }

  c.child = child
  // **지시를 집어갔다는 사실을 남긴다.**
  //
  // 훅은 회사가 큐를 맡고 있으면 큐에 손대지 않으므로 `command_taken`도 내지 않는다.
  // 그런데 회사도 안 냈다 — 그래서 화면의 "지시 1건 대기" 배지를 내릴 신호를 아무도
  // 보내지 않았다. 리드가 팀원을 부르지 않고 바로 답하는 경우(인사·질문)에는
  // agent_start조차 없어서 배지가 10분(QUEUE_STALE_SEC)씩 남아 있었다.
  try {
    appendJsonl(eventsFileFor(dir), {
      ts: Date.now() / 1000,
      type: 'command_taken',
      agent: cmd.agent || 'lead',
      // 이 지시가 어느 지점에서 출발했는지. 결과물 패널이 이걸로 되돌린다.
      snap: snapRef || undefined,
    })
  } catch {
    /* 기록 실패가 실행을 막지는 않는다 */
  }
  pumpStatusAll({ force: true })

  // stderr를 계속 비워 주지 않으면 파이프가 차서 자식이 멈춘다. 뒤쪽만 들고 있는다.
  const errLines = []
  child.stderr?.on('data', (b) => {
    errLines.push(...String(b).split(/\r?\n/).filter((l) => l.trim()))
    if (errLines.length > 60) errLines.splice(0, errLines.length - 60)
  })

  child.on('error', (err) => logRenderer(`claude 실행 실패(${dir}): ${err.message}`, '지시'))
  child.on('exit', (code) => {
    if (c.child === child) c.child = null
    if (code !== 0 && child.teamviewCanceled) {
      // 사람이 멈춘 것이다. 실패로 적으면 무엇이 잘못된 줄 알고 원인을 찾게 된다.
      logActivity(`중지로 끝남 (${path.basename(dir)})`)
    } else if (code !== 0) {
      const tail = errLines.slice(-12)
      // stderr는 대개 비어 있다 — claude는 실패 사유를 세션 기록에만 남긴다.
      const why = failureFor(dir, sid, startedAt, code)
      // **기다리면 되는 것은 실패라고 적지 않는다.** 실측(08-02 08:13:58):
      //     회사 실행이 코드 1로 끝남 (daily)
      //         토큰 사용량 한도: You've hit your session limit · resets 6:50pm (Asia/Seoul)
      // 사유는 바로 아랫줄에 있는데 결과는 `코드 1` — 고쳐야 할 실패와 똑같이 보인다.
      // 한도는 손댈 것이 없고 풀릴 때까지 기다리면 되는 일이다. 줄부터 다르게 적는다.
      if (why?.wait) {
        logRenderer(
          `회사 실행이 한도에 걸려 멈춤 (${path.basename(dir)}) — ${why.label}` +
            (why.resetAt ? ` · ${why.resetAt} 풀림` : ''),
          '지시',
        )
      } else {
        logRenderer(`회사 실행이 코드 ${code}로 끝남 (${path.basename(dir)})`, '지시')
      }
      if (why?.label) logRenderer(`    ${why.label}: ${why.message}`, '지시')
      else if (why) logRenderer(`    ${why.message}`, '지시')
      for (const l of tail) logRenderer(`    ${l}`, '지시')
      // **화면에도 띄운다.** logRenderer는 파일과 콘솔에만 쓴다 — 지시를 보냈는데
      // 아무 일도 안 일어난 것처럼 보이고, 왜인지 알 방법이 없었다.
      send('command:failed', { dir, code, lines: tail, why })
    }
    // 훅은 회사가 띄운 세션에서 취소 깃발을 **지우지 않는다**(지우면 곧바로 다음
    // 지시를 집어가 "취소했는데 계속 일한다"가 된다). 실행이 끝난 지금 회사가 내린다.
    try {
      fs.unlinkSync(path.join(dir, '.claude', CANCEL_NAME))
    } catch {
      /* 없으면 그만 */
    }
    pumpStatusAll({ force: true })
    // 뒤에 붙은 지시가 있으면 아직 끝난 게 아니다 — 그건 곧바로 이어서 돈다.
    // **실패도 사실대로 알린다.** 예전에는 코드 1로 끝나도 "작업이 끝났습니다"가
    // 떴다 — 사용량 한도에 걸려 아무것도 못 했는데 사용자는 다 된 줄 알았다.
    // 중지는 사람이 방금 누른 것이라 알릴 것이 없다.
    if (child.teamviewCanceled) return
    if (!pendingCount(dir)) notifyDone(dir, failureFor(dir, sid, startedAt, code))
  })
}

/**
 * 지시 하나가 끝났다고 알린다.
 *
 * 팀 작업은 20분에서 한 시간까지 간다. 그동안 이 창을 보고 있는 사람은 없다 —
 * 다른 일을 하다가 "끝났나?" 하고 가끔 들여다보게 되는데, 앱은 끝나도 아무 신호를
 * 주지 않았다. 창이 앞에 있으면 화면으로 이미 보이므로 그때는 조용히 있는다.
 */
function notifyDone(dir, failure) {
  const name = path.basename(dir)
  const done = !failure
  // 기다리면 풀리는 일(한도·혼잡)은 **고쳐야 할 실패와 구분해서** 부른다.
  const wait = !done && !!failure.wait
  const what = done ? '작업 종료' : wait ? '한도로 멈춤' : '지시 실패'
  // 정상 종료는 평상시 기록으로. 실패만 오류 파일에 남아야 묻히지 않는다.
  const note = done ? logActivity : (line) => logRenderer(line, '지시')
  if (!win || win.isDestroyed()) return
  // 창이 눈앞에 있으면 화면으로 이미 보인다 — 그때 깜빡이면 성가시기만 하다.
  if (winFocused) return note(`${what} — ${name} (창이 앞에 있어 알리지 않음)`)

  // 작업표시줄 깜빡임. 알림 배너를 꺼 둔 사람에게도 남는 신호다.
  try {
    win.flashFrame(true)
  } catch {
    /* 플랫폼이 지원하지 않으면 그만 */
  }
  try {
    if (!Notification.isSupported()) return note(`${what} — ${name} (깜빡임만)`)
    const n = new Notification({
      // **실패를 완료라고 하지 않는다.** 사용량 한도에 걸려 아무것도 못 했는데
      // "작업이 끝났습니다"가 뜨면 사용자는 다 된 줄 안다.
      //
      // **기다릴 일과 손볼 일도 가른다.** 한도는 사용자가 할 수 있는 게 없다 —
      // "처리하지 못했습니다"로 부르면 무엇이 망가졌는지 찾아 나서게 된다.
      // 풀리는 시각은 이미 문구 안에 있으니(`resets 6:50pm (Asia/Seoul)`) 그대로 보여 준다.
      title: done
        ? `${name} — 작업이 끝났습니다`
        : wait
          ? `${name} — ${failure.resetAt ? `${failure.resetAt}까지 기다려야 합니다` : '한도가 풀릴 때까지 기다려야 합니다'}`
          : `${name} — 지시를 처리하지 못했습니다`,
      body: done
        ? '눌러서 결과를 확인하세요'
        : (failure.label ? `${failure.label} — 눌러서 확인하세요` : '눌러서 이유를 확인하세요'),
    })
    // 알림을 누르면 그 프로젝트를 띄운 채로 창을 앞에 올린다. 세 개를 붙여 놓고
    // 다른 탭을 보던 중이면 끝난 쪽을 직접 찾아 들어가야 했다.
    n.on('click', () => {
      activate(dir)
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
    note(`${what} — ${name} (알림·깜빡임)`)
  } catch (err) {
    // 알림이 막혀 있어도 깜빡임은 이미 줬다. 다만 **조용히 넘기지는 않는다** —
    // 알림이 안 뜨는데 이유를 알 수 없으면 고칠 방법이 없다.
    logRenderer(`알림 실패(${name}): ${err.message} — 깜빡임만`)
  }
}

// 취소 깃발이 이보다 오래됐으면 무시하고 치운다. 훅의 CANCEL_TTL과 같은 값.
const CANCEL_TTL_S = 300

/** 그 회사의 대기열을 한 번 들여다본다. 회사는 **한 번에 한 건만** 처리한다. */
function pumpQueue(c) {
  if (!c || c.child) return
  const claudeDir = path.join(c.dir, '.claude')
  // 취소 직후에는 새 지시를 시작하지 않는다. 깃발은 실행이 끝나며 내려간다.
  //
  // **다만 실행이 없으면 내려갈 기회도 없다.** 큐가 빈 상태에서 취소를 누르면 깃발만
  // 남고, 그 뒤로 보내는 지시가 전부 여기서 막힌다(깃발을 지우는 곳이 실행 종료
  // 핸들러뿐이라 영원히 풀리지 않는다). 오래된 깃발은 치우고 진행한다.
  const flag = path.join(claudeDir, CANCEL_NAME)
  if (fs.existsSync(flag)) {
    if (flagAge(flag) <= CANCEL_TTL_S) return
    try {
      fs.unlinkSync(flag)
    } catch {
      return // 못 지웠으면 이번엔 넘어간다
    }
  }
  const cmd = takeOneCommand(claudeDir)
  if (cmd) runCommand(c, cmd)
}

/** 깃발이 세워진 지 몇 초 지났는지. 파일 안의 시각을 먼저 믿고, 없으면 mtime. */
function flagAge(file) {
  try {
    const v = Number(fs.readFileSync(file, 'utf8').trim())
    if (Number.isFinite(v) && v > 0) return Date.now() / 1000 - v
  } catch {
    /* 읽기 실패는 아래 mtime으로 */
  }
  try {
    return (Date.now() - fs.statSync(file).mtimeMs) / 1000
  } catch {
    return 0
  }
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
  const c = { dir, claimTimer: null, queueTimer: null, child: null }
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
    // 여기서 막히면 지시가 어디에도 남지 않는다. 무엇을 해야 하는지까지 알려준다.
    return { ok: false, error: '아직 세팅되지 않은 프로젝트입니다 — 상단 "세팅하기"를 누르세요' }
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
