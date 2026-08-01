// 렌더 루프 + 이벤트→행동 매핑 + 채팅(전체/개별 지시).
//
// 움직임 규칙:
//   활성 = 자기 책상 앞으로 걸어가 타이핑 / 비활성 = 통로 쪽에서 쉼
// **화면의 움직임은 전부 실제 이벤트에서 나온다.** 가짜 활동은 만들지 않는다.

import { POSES, drawSprite } from './sprites.js'
import { ROSTER, buildAgents, agentOrCreate, LEAD_ID } from './agents.js'
import { STAGE_W, STAGE_H, toScreen, depth, drawShadow } from './iso.js'
import {
  drawFloor,
  drawWalls,
  drawRug,
  drawWorkstation,
  drawChair,
  drawChairBack,
  drawChairArms,
  drawPartitions,
  drawInnerWall,
  drawDoorway,
  PROPS,
  propFootprints,
  workstationFootprint,
} from './room.js'
import { routeTo, interiorWallSegments, DOORWAYS, SPOTS, setObstacles } from './layout.js'

const canvas = document.getElementById('stage')
const ctx = canvas.getContext('2d')
const statusEl = document.getElementById('status')
const tabsEl = document.getElementById('tabs')
const addBtn = document.getElementById('add')
const welcomeEl = document.getElementById('welcome')
const stageWrapEl = document.getElementById('stage-wrap')
const welcomeAddEl = document.getElementById('welcome-add')
const setupBtn = document.getElementById('setup')
const overlay = document.getElementById('overlay')
const targetsEl = document.getElementById('targets')
// 대화에 딸린 조작들. 프로젝트가 없으면 함께 잠근다 — 쓰는 곳(updateComposer)이
// 파일 앞쪽이라 참조도 여기서 잡아 둔다.
const cancelBtnEl = document.getElementById('chat-cancel')
const toolsBtnEl = document.getElementById('toggle-tools')
const copyAllEl = document.getElementById('copy-all')
const messagesEl = document.getElementById('messages')
const inputEl = document.getElementById('chat-input')
const sendBtn = document.getElementById('chat-send')
const hintEl = document.getElementById('chat-hint')
const nowEl = document.getElementById('now')

const BUSY_MS = 2600
const IDLE_LEAVE_MS = 9000
const TALK_MS = 3200

// 도구를 손에서 놓은 지 이만큼 지나면 '생각 중'으로 본다.
//
// 도구 호출 사이의 공백은 **모델이 답을 만드는 시간**이다. 짧으면 그냥 다음 도구로
// 이어지지만 길어지면 사람은 멈춘 줄 안다. 실제로 "멈춘 것 같다"는 말을 들었고,
// 그때 팀원은 기획안을 쓰는 중이었다. 조용한 것이 정상이라는 사실을 화면에 적는다.
const THINKING_MS = 4000

// 이만큼 조용하면 '생각 중'이 아니라 **막힌 것**으로 본다.
//
// 답을 만드는 데 몇 분이 걸리는 일은 있지만, 도구를 한 번도 안 쓴 채 5분이 넘어가면
// 정상이 아닐 가능성이 크다. 실제로 팀원 하나가 12분 동안 CPU를 4초도 안 쓰고 멈춰
// 있었는데 화면은 계속 '작업 중'이었다 — 기다릴지 취소할지 판단할 근거가 없었다.
const STALL_MS = 300_000

/** 초를 사람이 읽는 단위로. 120초는 '120s'보다 '2m 0s'가 빨리 읽힌다. */
function fmtDur(sec) {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ${sec % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * 지금 이 팀원이 어떤 상태인지 한 덩어리로. 배지와 상단 요약이 같은 판단을 쓴다.
 * 둘이 따로 계산하면 화면 안에서 서로 다른 말을 하게 된다.
 */
function workState(a, now) {
  const sec = a.startedAt != null ? Math.floor((now - a.startedAt) / 1000) : 0
  const quietFor = Math.floor((now - a.lastEventAt) / 1000)
  const thinking = now - a.lastEventAt > THINKING_MS
  const stalled = now - a.lastEventAt > STALL_MS
  return {
    sec,
    quietFor,
    thinking,
    stalled,
    icon: stalled ? '⚠' : thinking ? '⋯' : (a.act?.icon ?? '◆'),
    word: stalled ? '응답 없음' : thinking ? '생각 중' : (a.act?.word ?? '작업'),
  }
}

const WALL_SEGMENTS = interiorWallSegments()

/**
 * 통행 격자를 채운다. 이걸 안 하면 경로 탐색이 가구를 모르고 **뚫고 지나간다.**
 * 자리 배치가 바뀌면(명단에 없는 팀원이 들어와 자리가 생기면) 다시 부른다.
 */
function refreshObstacles() {
  const rects = propFootprints()
  for (const a of agents.values()) rects.push(...workstationFootprint(a.desk.gx, a.desk.gy))
  setObstacles(rects)
  // 이미 잡아 둔 길은 옛 지도 기준이다. 다음 프레임에 다시 짜게 지운다.
  for (const a of agents.values()) {
    a.goal = null
    a.path = null
  }
}

// 카메라 — 드래그로 이동, Ctrl+휠/Ctrl+± 로 확대. fit은 창에 딱 맞는 기본 배율.
const cam = { zoom: 1, x: 0, y: 0 }
const ZOOM_MIN = 0.6
const ZOOM_MAX = 4
let fitScale = 3

/** 실제 그리기에 쓰는 배율. */
const eff = () => fitScale * cam.zoom

let scale = 3
let agents = buildAgents()
let target = 'all' // 채팅 대상: 'all' 또는 에이전트 id
let lastFrame = performance.now()
const nodes = new Map()
const lastChatAt = new Map() // 도구 이벤트가 채팅을 도배하지 않도록

// ---------- 여러 프로젝트 ----------
//
// 회사는 최대 3개가 동시에 돌지만 **사무실은 한 번에 하나만 그린다.** 셋을 나란히
// 놓으면 배율이 1/3로 떨어져 도트가 뭉개지고, 통행 격자(layout.js의 nav)도 사무실
// 마다 따로 들어야 한다. 그래서 화면은 활성 프로젝트 하나만 시뮬레이션한다.
//
// 탭을 옮기면 메인이 그 프로젝트를 처음부터 다시 읽어 보내 주므로(events:reset →
// replay) 지금 모습이 그대로 복원된다. 다만 **채팅만은 replay로 되살아나지 않는다** —
// 지난 기록으로 채팅을 다시 쓰면 켤 때마다 같은 줄이 쌓이기 때문에 일부러 막아 뒀다.
// 그래서 대화는 프로젝트별로 여기에 들고 있다가 탭을 옮길 때 다시 그린다.

let activeDir = null
let lastProjects = [] // 마지막으로 받은 프로젝트 상태(세팅 버튼이 참조한다)
const chatLogs = new Map() // dir -> [{ kind, who, text, tool }]
// 보관된 대화를 다시 그리는 중인지. 그때 저장하면 켤 때마다 두 배로 쌓인다.
let restoringChat = false
const chatLoaded = new Set() // 디스크에서 한 번 읽은 프로젝트

function logFor(dir) {
  if (!dir) return []
  if (!chatLogs.has(dir)) chatLogs.set(dir, [])
  return chatLogs.get(dir)
}

/**
 * 그 프로젝트에서 오갔던 대화를 디스크에서 되살린다. 프로젝트당 한 번만 읽는다 —
 * 그 뒤로는 메모리 쪽이 최신이다.
 */
async function restoreChat(dir) {
  if (!dir || chatLoaded.has(dir)) return
  chatLoaded.add(dir)
  const saved = await window.teamView.loadChat(dir)
  if (!saved?.length) return
  const log = logFor(dir)
  // 이미 이번 실행에서 쌓인 줄이 있으면 그 **앞에** 붙인다(지난 것이 먼저다).
  log.unshift(...saved)
  while (log.length > 200) log.shift()
  if (dir === activeDir) redrawChat(dir)
}

/** 경로에서 폴더 이름만. 탭이 좁아서 전체 경로는 title로 넘긴다. */
function baseName(dir) {
  const parts = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || dir
}

function resize() {
  const wrap = document.getElementById('left')
  const w = Math.max(320, wrap.clientWidth - 4)
  const h = Math.max(240, wrap.clientHeight - 4)
  // 캔버스는 남는 영역 전체를 채운다(팬·줌을 하려면 여백이 필요하다).
  canvas.width = w
  canvas.height = h
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  // 기본 배율은 도면이 창에 딱 들어오는 크기
  fitScale = Math.max(0.5, Math.min(w / STAGE_W, h / STAGE_H))
  scale = eff()
  centerCam() // 채팅 폭을 바꾸면 남는 쪽이 생긴다 — 거기서는 가운데로
  clampCam()
  ctx.imageSmoothingEnabled = false
}

/** 도면이 화면 밖으로 완전히 사라지지 않도록 이동 범위를 제한한다. */
/**
 * 사무실을 캔버스 가운데에 놓는다 — **남는 쪽만.**
 *
 * 카메라 기본값이 (0,0)이라 사무실이 늘 좌상단에 붙어 있었다. 창이 넓을 때는
 * 도면이 가로를 꽉 채워 티가 안 났는데, 채팅을 넓히자 캔버스가 좁고 길어지면서
 * 아래쪽이 크게 비고 사무실이 위로 몰렸다.
 *
 * 확대해서 도면이 캔버스보다 큰 축은 건드리지 않는다. 그 축은 사용자가 끌어서
 * 보던 위치가 있고, 가운데로 되돌리면 보던 자리를 빼앗는다.
 */
function centerCam() {
  const s = eff()
  const slackX = canvas.width - STAGE_W * s
  const slackY = canvas.height - STAGE_H * s
  if (slackX > 0) cam.x = slackX / 2
  if (slackY > 0) cam.y = slackY / 2
}

function clampCam() {
  const s = eff()
  const stageW = STAGE_W * s
  const stageH = STAGE_H * s
  const marginX = Math.min(240, canvas.width * 0.4)
  const marginY = Math.min(200, canvas.height * 0.4)
  cam.x = Math.min(canvas.width - marginX, Math.max(marginX - stageW, cam.x))
  cam.y = Math.min(canvas.height - marginY, Math.max(marginY - stageH, cam.y))
}

/** 화면 좌표를 기준으로 확대/축소한다(그 점이 제자리에 남는다). */
function zoomAt(px_, py_, factor) {
  const before = eff()
  cam.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.zoom * factor))
  const after = eff()
  const k = after / before
  cam.x = px_ - (px_ - cam.x) * k
  cam.y = py_ - (py_ - cam.y) * k
  scale = after
  clampCam()
}

// ── 마우스 드래그로 이동 ─────────────────────────────────────────────────
let dragging = null
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  dragging = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y, moved: false }
})
window.addEventListener('mousemove', (e) => {
  if (!dragging) return
  const dx = e.clientX - dragging.x
  const dy = e.clientY - dragging.y
  if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true
  cam.x = dragging.camX + dx
  cam.y = dragging.camY + dy
  clampCam()
  canvas.style.cursor = 'grabbing'
})
window.addEventListener('mouseup', () => {
  if (dragging) canvas.style.cursor = 'grab'
  // 드래그 직후의 click 이벤트는 무시해야 한다(끌었는데 캐릭터가 선택되면 곤란)
  setTimeout(() => {
    dragging = null
  }, 0)
})
canvas.style.cursor = 'grab'

/**
 * 그 자리에 있는 팀원. 없으면 null.
 *
 * 클릭 판정과 커서 모양이 **같은 규칙**을 써야 한다. 따로 두면 "손가락이 떴는데
 * 눌러도 안 잡히는" 자리가 생긴다.
 */
function agentAt(clientX, clientY) {
  const rect = canvas.getBoundingClientRect()
  const lx = (clientX - rect.left - cam.x) / scale
  const ly = (clientY - rect.top - cam.y) / scale
  let best = null
  let bestD = Infinity
  for (const a of agents.values()) {
    const { x, y } = toScreen(a.gx, a.gy)
    if (lx < x - 9 || lx > x + 9 || ly < y - 24 || ly > y + 5) continue
    const d = Math.abs(lx - x) + Math.abs(ly - y)
    if (d < bestD) {
      bestD = d
      best = a
    }
  }
  return best
}

// 캐릭터 위에서는 손가락으로 바꾼다. 안내문은 "캐릭터를 클릭하세요"라고 하는데
// 커서는 어디서나 손바닥(이동)이라, 누를 수 있는 자리인지 알 방법이 없었다.
canvas.addEventListener('mousemove', (e) => {
  if (dragging) return // 끄는 중에는 grabbing을 유지한다
  canvas.style.cursor = agentAt(e.clientX, e.clientY) ? 'pointer' : 'grab'
})

// ── Ctrl + 휠 / Ctrl + ± 로 줌 ───────────────────────────────────────────
canvas.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12)
  },
  { passive: false },
)
window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return
  const cx = canvas.width / 2
  const cy = canvas.height / 2
  if (e.key === '+' || e.key === '=') {
    e.preventDefault()
    zoomAt(cx, cy, 1.2)
  } else if (e.key === '-' || e.key === '_') {
    e.preventDefault()
    zoomAt(cx, cy, 1 / 1.2)
  } else if (e.key === '0') {
    e.preventDefault()
    cam.zoom = 1
    scale = eff()
    // 처음 크기로 되돌릴 때도 가운데에 놓는다. (0,0)으로 보내면 좌상단에 붙는다.
    centerCam()
    clampCam()
  }
})
window.addEventListener('resize', resize)

// ---------- 이벤트 → 상태 ----------

function shortPath(p) {
  if (!p) return ''
  const parts = String(p).replace(/\\/g, '/').split('/')
  return parts.slice(-2).join('/')
}

// 지금 무슨 **종류**의 일을 하는지. 말풍선은 6초 뒤 사라지지만 이건 작업이
// 끝날 때까지 이름표 옆에 남는다 — "누가 뭘 하는지 모르겠다"의 답이다.
const ACTIVITY = {
  Edit: { icon: '✎', word: '수정' },
  Write: { icon: '✎', word: '작성' },
  NotebookEdit: { icon: '✎', word: '수정' },
  Read: { icon: '▤', word: '읽는 중' },
  Grep: { icon: '⌕', word: '검색' },
  Glob: { icon: '⌕', word: '검색' },
  Bash: { icon: '▸', word: '실행' },
  // Windows에서는 Bash 대신 이쪽이 온다. 없으면 '◆ PowerShell'이라는 날것으로 보인다.
  PowerShell: { icon: '▸', word: '실행' },
  Task: { icon: '↗', word: '위임' },
  // **위임 도구 이름이 Task가 아니라 Agent로 오기도 한다**(훅의 DELEGATE_TOOLS도 둘 다
  // 처리한다). 여기 빠져 있어서, 팀원에게 일을 넘기는 중인 리드가 '↗ 위임'이 아니라
  // '◆ Agent'로 보였다. 화면에서 가장 중요한 순간이 가장 안 읽히는 표시로 나온 셈이다.
  Agent: { icon: '↗', word: '위임' },
  WebFetch: { icon: '⇩', word: '조회' },
  WebSearch: { icon: '⌕', word: '웹 검색' },
  TodoWrite: { icon: '☑', word: '계획 정리' },
}

// MCP 도구는 이름이 `mcp__<서버>__<도구>` 꼴로 온다. 그대로 두면 이름표에
// `◆ mcp__figma__create_new_file` 같은 날것이 뜬다 — 기획·화면설계를 Figma에
// 만들라고 해 놓고 정작 그 순간이 화면에서 가장 안 읽히는 표시가 된다.
const FIGMA_WORDS = {
  create_new_file: '파일 만드는 중',
  generate_figma_design: '화면 그리는 중',
  generate_diagram: '플로우 그리는 중',
  use_figma: '디자인 작업 중',
  get_screenshot: '결과 확인 중',
  get_design_context: '디자인 읽는 중',
  get_metadata: '구조 보는 중',
  whoami: '연결 확인 중',
}

function mcpActivity(tool) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool)
  if (!m) return null
  const [, server, name] = m
  if (server === 'figma') return { icon: '🎨', word: FIGMA_WORDS[name] ?? `Figma ${name}` }
  // 다른 MCP 서버는 서버 이름만 남긴다. 도구 이름을 통째로 보여 줘 봐야 안 읽힌다.
  return { icon: '◈', word: `${server} ${name.replace(/_/g, ' ')}` }
}

function activityOf(ev) {
  if (ev.type === 'tool') {
    return ACTIVITY[ev.tool] ?? mcpActivity(String(ev.tool ?? '')) ?? { icon: '◆', word: ev.tool ?? '작업' }
  }
  if (ev.type === 'agent_start') return { icon: '▶', word: '시작' }
  if (ev.type === 'error') return { icon: '❗', word: '실패' }
  if (ev.type === 'prompt') return { icon: '☞', word: '지시 확인' }
  return null
}

function describe(ev) {
  switch (ev.type) {
    case 'agent_start':
      return '작업 시작할게요'
    case 'agent_stop':
      return '끝냈습니다'
    case 'command':
      return `지시 받음: ${String(ev.detail ?? '').slice(0, 40)}`
    case 'error':
      return `실패: ${String(ev.detail ?? ev.tool ?? '').slice(0, 44)}`
    case 'reply':
      return String(ev.detail ?? '')
    case 'tool': {
      const d = shortPath(ev.detail)
      if (ev.tool === 'Edit' || ev.tool === 'Write') return `${d || '파일'} 고치는 중`
      if (ev.tool === 'Read') return `${d || '파일'} 읽는 중`
      if (ev.tool === 'Bash') return ev.detail ? `$ ${String(ev.detail).slice(0, 34)}` : '명령 실행 중'
      if (ev.tool === 'Grep' || ev.tool === 'Glob') return '코드 찾는 중'
      if (ev.tool === 'Task' || ev.tool === 'Agent') return '팀원 부르는 중'
      // MCP 도구는 이름을 그대로 쓰면 `mcp__figma__create_new_file 실행 중`이 된다.
      const mcp = mcpActivity(String(ev.tool ?? ''))
      if (mcp) return mcp.word
      return `${ev.tool} 실행 중`
    }
    case 'prompt':
      return '지시 확인 중'
    case 'session':
      return ev.state === 'idle' ? '대기 중입니다' : '세션 시작'
    default:
      return ev.type
  }
}

// 다시 읽는 기록 중 **지금 일어난 일로 볼 수 있는 시간**(초).
//
// 앱을 켜면 그동안 쌓인 로그가 통째로 흘러 들어온다. 그걸 방금 일어난 일처럼
// 처리하면 타이머가 전부 '지금'을 기준으로 걸린다. 몇 시간 전 실패 하나 때문에
// **앱을 켤 때마다 그 팀원이 빨갛게 켜지고** 디버거가 그리로 걸어갔다.
// 이벤트가 제 시각(ts)을 갖고 있으니 나이를 보고 가른다.
const LIVE_WINDOW_SEC = 60

/** 이미 지나간 일인가. 지난 일은 '마지막으로 뭘 했는지'만 남기고 연출하지 않는다. */
function isHistory(ev) {
  if (!ev._replay) return false
  const age = Date.now() / 1000 - Number(ev.ts ?? 0)
  return !(age >= -5 && age < LIVE_WINDOW_SEC)
}

// ---------- 인계 ----------
//
// 앱에서 "프론트에게" 보낸 일이라도 리드가 읽어 보고 역할에 안 맞으면 다른 팀원에게
// 넘긴다(그 판단은 세션 쪽에서 한다). 그러면 화면에서는 **엉뚱한 사람이 시작**하고,
// 원래 지목된 사람 머리 위에는 "지시 1건 대기"가 영영 남았다.
//
// 앱이 아는 사실은 둘뿐이다: (1) 내가 누구에게 보냈다 (2) 실제로 누가 시작했다.
// 둘이 다르면 넘어간 것이다 — 지어낸 연출이 아니라 실제로 일어난 일이다.

const queuedFor = [] // 앱이 보낸 지시 { id: 담당, at: 보낸 시각(epoch 초) }, 보낸 순서대로

/**
 * 대기열에서 그 팀원 몫 하나를 뺀다. 그 팀원 것이 없으면 **가장 오래된 것** 하나.
 * 뺀 항목을 돌려준다(없으면 null). 배지 카운터도 같이 줄인다.
 */
function takeQueued(id) {
  const mine = queuedFor.findIndex((q) => q.id === id)
  const [item] = queuedFor.splice(mine >= 0 ? mine : 0, 1)
  if (!item) return null
  const a = agents.get(item.id)
  if (a && a.queued > 0) a.queued--
  return item
}

/**
 * 시작한 팀원이 대기 중인 지시를 가져간다.
 * 지목된 사람이 아니라 다른 사람이 가져갔으면 **원래 지목됐던 팀원**을 돌려준다.
 */
function claimQueued(agent) {
  const item = takeQueued(agent.id)
  if (!item || item.id === agent.id) return null
  const from = agents.get(item.id)
  return from && from !== agent ? from : null
}

// 대기 지시를 이만큼(초) 붙들고 있으면 배지를 강제로 내린다.
// 훅이 안 깔렸거나 세션이 안 떠 있으면 command_taken조차 오지 않는다. 실제로 훅이
// 죽어서 3시간 동안 지시가 전혀 전달되지 않았는데, 화면은 그냥 조용한 것과 구분이
// 되지 않았다. 그래서 조용히 지우지 않고 채팅에 실패를 드러낸다.
const QUEUE_STALE_SEC = 600

function sweepStaleQueued() {
  if (!queuedFor.length) return
  const nowSec = Date.now() / 1000
  for (let i = queuedFor.length - 1; i >= 0; i--) {
    const q = queuedFor[i]
    if (nowSec - Number(q.at ?? nowSec) < QUEUE_STALE_SEC) continue
    queuedFor.splice(i, 1)
    const a = agents.get(q.id)
    if (a && a.queued > 0) a.queued--
    addMsg(
      'sys',
      '',
      `— ${a?.label ?? q.id}에게 보낸 지시가 10분째 응답이 없습니다. 세션이 열려 있는지 확인하세요 —`,
    )
  }
}

/** 넘긴 사람이 맡을 사람에게 걸어가서 알린다. */
function showHandoff(from, to, now) {
  from.plan = {
    kind: 'handoff',
    dest: { gx: to.chair.gx + 0.8, gy: to.chair.gy + 0.6 },
    until: now + 9000,
    bubble: `이건 ${to.label} 쪽이 맞겠어요`,
    faceId: to.id,
  }
  to.faceTarget = from.id
  to.talkUntil = now + TALK_MS
  addMsg('sys', '', `— ${from.label}에게 보냈지만 ${to.label}이(가) 맡았습니다 —`)
}

/**
 * 놀던 팀원이 **일을 시작하는 순간**을 찍는다. 이미 일하는 중이면 아무것도 하지 않는다.
 *
 * 서브에이전트는 `agent_start`가 오지만 **리드는 오지 않는다** — 훅은 서브에이전트에게만
 * 시작을 낸다(team_events.py의 note_start가 name == "lead"를 걸러낸다). 그래서 리드의
 * startedAt이 영영 비어 있었고, 경과 시간이 `0s`로 굳었다. 도구를 107번 쓴 리드가
 * `🛠 107 · 0s`로 보이는 모순이 그래서 생겼다.
 */
function beginWork(agent, now) {
  if (agent.active) return
  agent.startedAt = now
  agent.toolCount = 0
}

function applyEvent(ev) {
  collectOutput(ev) // 결과물 패널은 지난 기록에서도 쌓는다 — 켤 때마다 다시 세워야 한다
  const now = performance.now()
  const known = agents.size
  const agent = agentOrCreate(agents, ev.agent || LEAD_ID)
  // 명단에 없던 팀원이면 자리(책상·파티션)가 새로 생긴다 — 통행 격자를 다시 만든다
  if (agents.size !== known) refreshObstacles()

  const history = isHistory(ev)

  switch (ev.type) {
    case 'agent_start': {
      agent.toolCount = 0
      const handed = claimQueued(agent)
      if (history) break // 지난 호출로 지금 일하는 것처럼 보이게 하지 않는다
      if (handed) showHandoff(handed, agent, now)
      agent.active = true
      agent.busyUntil = now + BUSY_MS
      agent.startedAt = now
      // 리드가 팀원을 부르는 연출: 서로 마주본다
      const lead = agents.get(LEAD_ID)
      if (lead && agent.id !== LEAD_ID) {
        lead.faceTarget = agent.id
        lead.talkUntil = now + TALK_MS
        lead.task = `@${agent.label} 부탁해요`
        lead.lastEventAt = now
        agent.faceTarget = LEAD_ID
        agent.talkUntil = now + TALK_MS
      }
      break
    }
    case 'agent_stop':
      agent.active = false
      agent.busyUntil = 0
      agent.act = null
      break
    case 'command_taken':
      // 훅이 대기열을 세션에 밀어 넣었다는 사실. 지금까지는 agent_start로만 배지를
      // 내렸는데, 리드가 위임 없이 직접 처리하면(인사·단순 질문) agent_start가 없어
      // "지시 1건 대기"가 영영 남았다. 가져간 건 사실이므로 여기서 내린다.
      // **상태 정리는 다시 읽는 기록에서도 해야 한다** — 안 그러면 앱을 켤 때마다
      // 옛 지시가 대기 중으로 되살아난다. 대신 채팅 줄은 남기지 않는다.
      takeQueued(ev.agent || LEAD_ID)
      return
    case 'cancel':
      // 취소는 팀 전체에 걸린다. 하던 표시를 걷고 대기열 배지도 지운다.
      queuedFor.length = 0
      for (const a of agents.values()) {
        a.active = false
        a.busyUntil = 0
        a.queued = 0
        a.act = null
        a.task = null
      }
      // 지난 기록을 다시 읽는 중이면 채팅에 또 쓰지 않는다(켤 때마다 쌓인다)
      if (!ev._replay) addMsg('sys', '', `— ${ev.detail ?? '취소했습니다'} —`)
      return
    case 'error': {
      // 지난 실패는 **켜지 않는다.** 로그에 남은 옛 실패 하나 때문에 앱을 켤 때마다
      // 그 팀원이 빨갛게 살아났다(느낌표 12초 + 디버거 출동). 이미 끝난 일이다.
      if (history) break
      // 화면만 봐도 문제를 알아채는 것이 목적이다. 당사자에게 느낌표를 띄우고
      // 디버거를 그 자리로 보낸다(실제로 디버거가 호출되지 않아도 '봐야 할 곳'을 가리킨다).
      beginWork(agent, now)
      agent.active = true
      agent.busyUntil = now + BUSY_MS
      agent.errorUntil = now + 12000
      const dbg = agents.get('debugger')
      if (dbg && dbg.id !== agent.id && !dbg.active) {
        dbg.plan = {
          kind: 'inspect',
          dest: { gx: agent.chair.gx + 0.7, gy: agent.chair.gy + 0.5 },
          until: now + 12000,
          bubble: `${agent.label} 쪽 확인할게요`,
          faceId: agent.id,
        }
      }
      break
    }
    case 'session':
      // '쉬는 중'은 지난 기록이어도 그대로 반영한다 — 끄는 쪽은 틀릴 일이 없다.
      if (ev.state === 'idle') {
        for (const a of agents.values()) {
          a.active = false
          a.busyUntil = 0
          a.startedAt = null // 다음 작업은 그때부터 새로 잰다
        }
      } else if (!history) {
        beginWork(agent, now)
        agent.active = true
        agent.busyUntil = now + BUSY_MS
      }
      break
    case 'reply':
      // 답변은 '일하는 상태'가 아니다. 말풍선만 띄우고 상태는 건드리지 않는다.
      agent.task = String(ev.detail ?? '').slice(0, 60)
      agent.lastEventAt = history ? now - IDLE_LEAVE_MS - 1000 : now
      if (!ev._replay) addMsg('agent', `${agent.label} · 답변`, String(ev.detail ?? ''), { agent: agent.id })
      return
    default:
      if (history) {
        if (ev.type === 'tool') agent.toolCount = (agent.toolCount ?? 0) + 1
        break
      }
      // 시계와 카운터를 먼저 세운 뒤 이번 도구를 센다(순서가 바뀌면 첫 도구가 빠진다).
      beginWork(agent, now)
      if (ev.type === 'tool') agent.toolCount = (agent.toolCount ?? 0) + 1
      agent.active = true
      agent.busyUntil = now + BUSY_MS
  }

  agent.task = describe(ev)
  agent.act = activityOf(ev) ?? agent.act
  // 지난 일은 말풍선을 띄우지 않는다. 마지막으로 뭘 했는지는 남겨 두어
  // 그 팀원을 클릭하면 볼 수 있다(흐린 말풍선).
  agent.lastEventAt = history ? now - IDLE_LEAVE_MS - 1000 : now
  if (!ev._replay) chatFromEvent(ev, agent)
}

// ---------- 결과물 ----------
//
// 한 시간짜리 작업이 끝나고 **무엇이 만들어졌는지** 보려면 도구 로그 100줄을
// 거슬러 올라가야 했다. 지난 작업에서 파일 18개와 Figma 4개가 나왔는데 그걸
// 확인할 방법이 채팅 스크롤뿐이었다.
//
// 이벤트에 이미 다 들어 있다 — `{type:'tool', tool:'Write', detail:'<경로>', agent}`.
// 새로 기록할 것은 없고 모아서 보여 주기만 하면 된다.

// 되돌릴 수 없는 명령. 훅의 DESTRUCTIVE와 짝이다 — 훅은 자르지 않고 남기고,
// 여기서는 솎아내지 않고 눈에 띄게 보여 준다.
const DESTRUCTIVE_CMD =
  /\brm\s+-[a-zA-Z]*[rf]|\brmdir\b|\bdel\s+\/|\bRemove-Item\b|\bMove-Item\b|\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fdx]|checkout\s+--|push\s+.*--force)|\bDROP\s+(TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\b|\bmigrate\s+reset\b/i

function isDestructive(ev) {
  return (ev.tool === 'Bash' || ev.tool === 'PowerShell') && DESTRUCTIVE_CMD.test(String(ev.detail ?? ''))
}

const FILE_TOOLS = { Write: '작성', Edit: '수정', MultiEdit: '수정', NotebookEdit: '수정' }
const FIGMA_URL = /https:\/\/(?:www\.)?figma\.com\/[^\s)>\]"']+/g

// 지시 한 건 = 묶음 하나. 최근 것이 앞에 온다.
let runs = []

/** 결과물 수집. 지시(command)마다 새 묶음을 열고, 그 뒤 파일·링크를 담는다. */
function collectOutput(ev) {
  if (!ev || typeof ev !== 'object') return

  if (ev.type === 'command') {
    runs.unshift({ text: String(ev.detail ?? '').trim(), ts: ev.ts, files: new Map(), figma: new Map() })
    if (runs.length > 30) runs.length = 30 // 오래된 것까지 들고 있을 이유는 없다
    return
  }

  // 회사가 지시를 집어가며 남긴 '출발 지점'. 이게 있어야 되돌릴 수 있다.
  if (ev.type === 'command_taken' && ev.snap && runs.length) {
    runs[0].snap = ev.snap
    return
  }

  // 지시 기록보다 앞선 활동도 있다(앱 밖에서 시작한 세션). 받아 줄 묶음을 만들어 둔다.
  if (!runs.length) runs.unshift({ text: '', ts: ev.ts, files: new Map(), figma: new Map() })
  const run = runs[0]

  if (ev.type === 'tool') {
    const kind = FILE_TOOLS[ev.tool]
    if (kind && ev.detail) {
      const p = String(ev.detail)
      const prev = run.files.get(p)
      // 같은 파일을 여러 번 고치면 한 줄로 접고 횟수만 센다. 안 그러면 한 파일이
      // 목록을 열 줄씩 차지한다(실제로 마이그레이션 파일 하나가 그랬다).
      if (prev) {
        prev.count += 1
        prev.ts = ev.ts
        // 만들어 놓고 고친 것은 '작성'으로 남긴다 — 새로 생긴 파일인지가 더 중요하다.
        if (kind === '작성') prev.kind = '작성'
      } else {
        run.files.set(p, { path: p, kind, agent: ev.agent || LEAD_ID, ts: ev.ts, count: 1 })
      }
    }
  }

  // Figma 주소는 도구 이벤트에 없다 — 만들고 나서 답변에 적어 준다. 거기서 줍는다.
  const text = ev.type === 'reply' || ev.type === 'command' ? String(ev.detail ?? '') : ''
  for (const url of text.match(FIGMA_URL) ?? []) {
    const clean = url.replace(/[.,)]+$/, '')
    if (!run.figma.has(clean)) run.figma.set(clean, { url: clean, ts: ev.ts, agent: ev.agent || LEAD_ID })
  }
}

/** 이 프로젝트에서 나온 결과물 수(파일 + Figma). 탭 배지에 쓴다. */
function outputCount() {
  let n = 0
  for (const r of runs) n += r.files.size + r.figma.size
  return n
}

/** 프로젝트 폴더를 기준으로 줄인 경로. 절대경로는 길어서 목록에서 읽히지 않는다. */
function relPath(p, dir) {
  const a = String(p).replace(/\\/g, '/')
  const b = String(dir ?? '').replace(/\\/g, '/')
  if (b && a.toLowerCase().startsWith(b.toLowerCase() + '/')) return a.slice(b.length + 1)
  return a
}

// ---------- 담당 배정 ----------
//
// '전체'로 보낸 지시를 리드가 혼자 처리하면 화면에서 팀이 놀고, 실제로도 분업이
// 안 된다. 지시 내용을 보고 **담당 파트를 먼저 정해서** 보낸다. 그러면 지시가
// "<담당> 서브에이전트로: ..." 형태로 세션에 들어가 실제로 그 팀원이 움직인다.

// ---------- 담당 배정 ----------
//
// **여기서 규칙으로 나누지 않는다.** 정규식으로 낱말을 세어 배정했더니 세 번을
// 고쳐도 계속 샜다("기획안에서 상품 상세 화면 부분 수정"이 '화면' 때문에 프론트로
// 갔다). 문장의 뜻을 읽는 일은 규칙의 몫이 아니다.
//
// 그래서 '전체'로 보낸 지시는 그대로 리드에게 넘기고, **리드가 읽고 판단해서**
// 담당 팀원에게 위임한다(그 지침은 Stop 훅이 지시와 함께 넣어 준다). 배정 결과는
// 실제로 그 팀원이 호출될 때 화면에 나타나므로, 앱이 미리 짐작해 표시할 필요도 없다.
//
// 특정 팀원을 콕 집고 싶으면 위 칩이나 캐릭터 클릭으로 직접 고르면 된다.

// ---------- 채팅 ----------

// 도구 활동을 채팅에 흘릴지. **지우는 게 아니라 접는다** — 한 작업에서 도구가
// 120건 나온 적이 있는데, 그게 다 흐르면 정작 지시와 답변이 묻힌다. 반대로 아예
// 없애면 무슨 파일을 만졌는지 알 수 없다. 보고 싶을 때 펴는 쪽이 맞다.
let showTools = true

/**
 * 대화 한 줄을 **기록하고** 화면에 붙인다.
 * 기록해 두는 이유는 탭을 옮겼다 돌아왔을 때 대화가 사라지지 않게 하기 위해서다.
 */
function addMsg(kind, who, text, opts = {}) {
  const log = logFor(activeDir)
  // **누구의 줄인지 id로 남긴다.** 예전에는 화면에 쓰는 이름(`who`)만 있었는데
  // 그건 "리드 · 답변"처럼 꾸며진 문자열이라 나중에 걸러 내기가 어렵다.
  const item = { kind, who, text, tool: Boolean(opts.tool), agent: opts.agent }
  log.push(item)
  while (log.length > 200) log.shift()
  // 디스크에도 남긴다 — 앱을 끄면 사라지던 것을 이어 볼 수 있게. 지난 대화를 다시
  // 그리는 중(replaying)에는 저장하지 않는다. 안 그러면 켤 때마다 두 배로 쌓인다.
  if (activeDir && !restoringChat) window.teamView.appendChat(activeDir, item)
  if (!visibleInChat(item)) return // 기록은 남기고 화면에만 안 띄운다
  renderMsg(kind, who, text)
}

/**
 * 이 줄을 지금 화면에 띄울 것인가.
 *
 * 두 가지로 거른다 — '도구 활동' 토글, 그리고 **골라 둔 팀원**. 칩을 누르면 그
 * 사람에게 보내는 것까지만 되고 대화는 전체가 그대로 보여서, 골라 놓고도 그
 * 사람이 무슨 말을 했는지 찾으려면 스크롤을 뒤져야 했다.
 */
function visibleInChat(m) {
  if (m.tool && !showTools) return false
  if (target === 'all') return true
  // 내가 그 사람에게 보낸 줄은 함께 남긴다 — 답만 있고 질문이 없으면 읽히지 않는다.
  if (m.kind === 'me') return String(m.who ?? '').includes(labelFor(target))
  if (m.kind === 'sys') return false // 세션 시작/대기 같은 공용 알림은 뺀다
  if (m.agent) return m.agent === target
  // 예전에 저장된 대화에는 id가 없다. 이름으로라도 맞춰 본다.
  return String(m.who ?? '').startsWith(labelFor(target))
}

/** 탭을 옮겼을 때(또는 도구 활동을 접었다 펼 때) 그 프로젝트의 대화를 다시 그린다. */
function redrawChat(dir) {
  restoringChat = true
  messagesEl.replaceChildren()
  let shown = 0
  for (const m of logFor(dir)) {
    if (!visibleInChat(m)) continue
    renderMsg(m.kind, m.who, m.text)
    shown++
  }
  // 걸러서 아무것도 안 남으면 화면이 텅 빈다. 고장인지 없는 건지 알려 준다.
  if (!shown && target !== 'all') {
    renderMsg('sys', '', `${labelFor(target)}의 대화가 아직 없습니다 — 칩을 다시 누르면 전체를 봅니다`)
  }
  messagesEl.scrollTop = messagesEl.scrollHeight
  restoringChat = false
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g

/** 글에 섞인 URL을 눌러서 열 수 있게 만든다. 나머지는 그대로 텍스트다. */
/**
 * 답변을 **구조를 살려서** 그린다.
 *
 * 예전에는 마크다운 기호를 걷어내 한 덩어리 글로 만들었다. 그런데 팀이 내놓는
 * 답은 표와 소제목이 섞인 보고서다 — 표를 가운뎃점으로 이어 붙이면
 * `1 · UTF-16 BOM 경로로 바이너리가 통과 · txtToPdf.ts:106` 처럼 읽다 걸린다.
 * 실측한 답변 하나에 파이프가 20개, 소제목이 3개였다.
 *
 * innerHTML은 쓰지 않는다 — 답변은 모델이 쓴 글이고, 그대로 HTML로 넣으면
 * 화면이 남의 마크업을 실행하게 된다. 노드로 직접 만든다.
 */
function renderRich(parent, text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l)
  const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l)
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

  let i = 0
  let para = []
  const flushPara = () => {
    if (!para.length) return
    const p = document.createElement('div')
    p.className = 'md-p'
    inline(p, para.join('\n'))
    parent.append(p)
    para = []
  }

  while (i < lines.length) {
    const line = lines[i]

    // 표 — 연속된 행을 한 덩어리로 모은다
    if (isRow(line) && (isRow(lines[i + 1] ?? '') || isSep(lines[i + 1] ?? ''))) {
      flushPara()
      const rows = []
      while (i < lines.length && isRow(lines[i])) {
        if (!isSep(lines[i])) rows.push(cells(lines[i]))
        i++
      }
      const table = document.createElement('table')
      table.className = 'md-table'
      rows.forEach((r, ri) => {
        const tr = document.createElement('tr')
        for (const c of r) {
          const td = document.createElement(ri === 0 ? 'th' : 'td')
          inline(td, c)
          tr.append(td)
        }
        table.append(tr)
      })
      // 좁은 패널에서 표가 넘치면 가로로 밀어 볼 수 있게 감싼다
      const wrap = document.createElement('div')
      wrap.className = 'md-table-wrap'
      wrap.append(table)
      parent.append(wrap)
      continue
    }

    // 소제목
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      const el = document.createElement('div')
      el.className = 'md-h'
      inline(el, h[2])
      parent.append(el)
      i++
      continue
    }

    // 목록
    if (/^\s*([-*·]|\d+\.)\s+/.test(line)) {
      flushPara()
      const ul = document.createElement('ul')
      ul.className = 'md-list'
      while (i < lines.length && /^\s*([-*·]|\d+\.)\s+/.test(lines[i])) {
        const li = document.createElement('li')
        inline(li, lines[i].replace(/^\s*([-*·]|\d+\.)\s+/, ''))
        ul.append(li)
        i++
      }
      parent.append(ul)
      continue
    }

    if (!line.trim()) {
      flushPara()
      i++
      continue
    }
    para.push(line)
    i++
  }
  flushPara()
}

/** 한 줄 안의 **굵게**·`코드`·링크를 노드로 바꾼다. */
function inline(parent, text) {
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g
  let last = 0
  for (const m of String(text).matchAll(re)) {
    if (m.index > last) appendWithLinks(parent, text.slice(last, m.index))
    const el = document.createElement(m[1] !== undefined ? 'strong' : 'code')
    el.textContent = m[1] ?? m[2]
    parent.append(el)
    last = m.index + m[0].length
  }
  if (last < text.length) appendWithLinks(parent, text.slice(last))
}

function appendWithLinks(parent, text) {
  let last = 0
  for (const m of String(text).matchAll(URL_RE)) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)))
    const a = document.createElement('a')
    a.className = 'link'
    a.textContent = m[0]
    a.title = `${m[0]}\n(눌러서 브라우저로 열기)`
    a.addEventListener('click', (e) => {
      e.preventDefault()
      window.teamView.openExternal(m[0])
    })
    parent.append(a)
    last = m.index + m[0].length
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)))
}

function renderMsg(kind, who, text) {
  const el = document.createElement('div')
  el.className = `msg ${kind}`
  if (kind === 'sys') {
    el.textContent = text
  } else {
    const w = document.createElement('span')
    w.className = 'who'
    w.textContent = who
    const body = document.createElement('span')
    body.className = 'body'
    // 답변은 세션 기록에서 퍼 온 글이라 마크다운이 섞여 있다. 표·소제목은 구조를
    // 살려 그리고, 결과물 링크는 눌러서 열 수 있게 한다 — 그러지 않으면 손으로
    // 옮겨 적어야 한다.
    if (kind === 'agent') renderRich(body, text)
    else appendWithLinks(body, String(text))
    // 복사 버튼 — 평소엔 숨어 있다가 말풍선에 올리면 나타난다
    const copy = document.createElement('button')
    copy.className = 'copy'
    copy.type = 'button'
    // **Tab 순서에서 뺀다.** 메시지마다 하나씩 붙어서, 대화가 길면 입력창에 닿기까지
    // 복사 버튼을 200번 지나야 했다(실측: 10개 메시지에 이미 10개). 마우스를 올려야
    // 보이는 보조 버튼이고, 키보드 쪽에는 '전체 복사'와 글자 선택이 따로 있다.
    copy.tabIndex = -1
    copy.title = '이 메시지 복사'
    copy.textContent = '⧉'
    copy.addEventListener('click', (e) => {
      e.stopPropagation()
      window.teamView.copyText(text)
      copy.textContent = '✓'
      copy.classList.add('done')
      setTimeout(() => {
        copy.textContent = '⧉'
        copy.classList.remove('done')
      }, 1200)
    })
    el.append(w, body, copy)
  }
  el.dataset.plain = kind === 'sys' ? text : `${who}: ${text}`
  messagesEl.append(el)
  while (messagesEl.children.length > 200) messagesEl.firstChild.remove()
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function chatFromEvent(ev, agent) {
  // **지우는 명령은 줄이지도 접지도 않는다.**
  //
  // 도구 줄은 시끄러워서 2.5초에 한 줄로 솎고 '도구 활동'을 끄면 아예 감춘다.
  // 그런데 그 규칙에 `rm -rf`까지 걸려서, 무엇을 지웠는지가 화면에서 통째로
  // 사라질 수 있었다. 회사는 권한을 묻지 않고 지운다 — 이것만은 항상 남긴다.
  if (ev.type === 'tool' && isDestructive(ev)) {
    addMsg('warn', agent.label, `⚠ ${ev.detail}`, { agent: agent.id })
    return
  }
  // 도구 이벤트는 시끄러우므로 에이전트당 2.5초에 한 줄로 줄인다
  if (ev.type === 'tool') {
    const last = lastChatAt.get(agent.id) ?? 0
    if (performance.now() - last < 2500) return
    lastChatAt.set(agent.id, performance.now())
  }
  if (ev.type === 'command') return // 내가 보낸 건 이미 표시했다
  if (ev.type === 'session') {
    addMsg('sys', '', ev.state === 'idle' ? '— 세션이 대기 상태입니다 —' : '— 세션 시작 —')
    return
  }
  // 끝났다는 말만으로는 무엇을 한 건지 알 수 없다. **얼마나 걸렸고 몇 번 손댔는지**를
  // 같이 남긴다 — 이게 없으면 한 시간짜리 작업의 흔적이 "끝냈습니다" 한 줄이다.
  if (ev.type === 'agent_stop') {
    const sec = agent.startedAt != null ? Math.floor((performance.now() - agent.startedAt) / 1000) : 0
    const detail = sec > 0 ? `끝냈습니다 · ${fmtDur(sec)} · 도구 ${agent.toolCount ?? 0}회` : '끝냈습니다'
    addMsg('agent', agent.label, detail, { agent: agent.id })
    return
  }
  // id(`backend-dev`)까지 붙이면 380px 칸에서 이름이 잘린다("백엔드 · backend-d").
  // 이름표와 캐릭터 색으로 이미 누구인지 알 수 있다.
  addMsg('agent', agent.label, describe(ev), { tool: ev.type === 'tool', agent: agent.id })
}

function renderTargets() {
  targetsEl.replaceChildren()
  const mk = (id, label, color) => {
    const b = document.createElement('button')
    b.className = `target${target === id ? ' sel' : ''}`
    b.type = 'button'
    if (color) {
      const dot = document.createElement('span')
      dot.className = 'dot'
      dot.style.background = color
      b.append(dot)
    }
    b.append(document.createTextNode(label))
    b.addEventListener('click', () => {
      // 고른 사람을 다시 누르면 전체로 돌아간다. 한 번 고르면 풀 방법이 없어서
      // **그 뒤 지시가 전부 그 사람에게 갔다** — 프론트가 기획안을 고치던 원인이다.
      target = target === id ? 'all' : id
      renderTargets()
      // 고른 사람의 대화만 보여 준다. 고르는 것과 보는 것이 따로 놀면, 골라 놓고도
      // 그 사람이 무슨 말을 했는지 찾으려고 스크롤을 뒤져야 한다.
      redrawChat(activeDir)
      inputEl.focus()
    })
    targetsEl.append(b)
  }
  mk('all', '전체', null)
  for (const r of ROSTER) mk(r.id, r.label, r.shirt)
  updateComposer()
}

/**
 * 지금 **누구에게** 보내는지 입력창과 버튼에 그대로 적는다.
 * 캐릭터를 클릭하면 대화 상대가 바뀌는데, 그걸 위쪽 칩 색으로만 알렸더니
 * 보는 사람은 모른 채 계속 그 팀원에게 보내고 있었다.
 */
function updateComposer() {
  // 붙인 프로젝트가 없으면 **보낼 곳이 없다.** 그런데도 버튼이 살아 있어서, 눌러 보고
  // 실패 메시지를 읽은 뒤에야 그 사실을 알게 된다. 먼저 할 일을 입력창에 적어 준다.
  // 프로젝트가 없으면 **대화에 딸린 조작이 전부 할 일이 없다.** 취소할 작업도,
  // 복사할 대화도, 접을 도구 활동도, 보낼 상대도 없다. 그런데 전부 눌려서
  // 눌러 보고 아무 일도 안 일어나는 것을 겪어야 알 수 있었다.
  const idle = !activeDir
  cancelBtnEl.disabled = idle
  copyAllEl.disabled = idle
  toolsBtnEl.disabled = idle
  for (const chip of targetsEl.querySelectorAll('.target')) chip.disabled = idle

  if (idle) {
    sendBtn.disabled = true
    sendBtn.textContent = '보내기'
    inputEl.disabled = true
    inputEl.placeholder = '먼저 위의 "+ 프로젝트"로 작업할 폴더를 붙이세요.'
    return
  }
  sendBtn.disabled = false
  inputEl.disabled = false
  const label = target === 'all' ? '전체' : (agents.get(target)?.label ?? target)
  sendBtn.textContent = `${label}에게 보내기`
  inputEl.placeholder =
    target === 'all'
      ? '전체에게 지시 — 담당은 리드가 정합니다. Enter 전송 · Shift+Enter 줄바꿈'
      : `${label}에게 지시 — 역할에 안 맞으면 다른 팀원에게 넘어갑니다. 칩을 다시 눌러 전체로`
}

async function send() {
  const text = inputEl.value.trim()
  if (!text) return
  // '전체'면 내용을 보고 담당을 배정한다(못 고르면 리드에게).
  const to = target === 'all' ? LEAD_ID : target
  const label = target === 'all' ? '전체 (담당은 리드가 배정)' : (agents.get(to)?.label ?? to)

  sendBtn.disabled = true
  hintEl.textContent = '보내는 중…'
  // 지시는 **지금 보고 있는 프로젝트**로 간다. 다른 탭의 회사는 자기 대기열만 본다.
  const res = await window.teamView.sendCommand({
    dir: activeDir,
    agent: to,
    text,
    broadcast: target === 'all',
  })
  sendBtn.disabled = false

  if (!res?.ok) {
    hintEl.textContent = `실패: ${res?.error ?? '알 수 없는 오류'}`
    return
  }
  addMsg('me', `나 → ${label}`, text)
  // 무엇을 기다리는지 알 수 있게 **내용도 함께** 들고 있는다. 지금까지는 담당과
  // 시각만 저장해서 화면에 "지시 1건 대기"라고만 뜨고, 그게 무슨 지시인지 볼 방법이
  // 없었다.
  queuedFor.push({ id: to, at: Date.now() / 1000, text })
  const a = agents.get(to)
  if (a) a.queued++
  // 회사가 닫혀 있으면 지시는 파일에 남을 뿐 아무도 집어가지 않는다. 그걸 숨기면
  // "보냈는데 아무 일도 안 일어나는" 상태를 화면에서 알아챌 수 없다.
  hintEl.textContent = !res.companyOpen
    ? '회사가 닫혀 있습니다 — 훅이 설치된 프로젝트인지 확인하세요'
    : res.busy
      ? '대기열에 넣었습니다 — 앞 작업이 끝나면 이어서 처리합니다'
      : '회사가 받았습니다 — 곧 팀이 움직입니다'
  inputEl.value = ''
}

sendBtn.addEventListener('click', send)
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
})

// ---------- 유휴 상호작용 ----------
//
// 아무 작업도 없을 때 팀원들이 커피를 마시러 가거나 잡담을 한다.
// **이건 실제 작업이 아니다.** 그래서 채팅 로그에는 남기지 않고, 말풍선도
// 회색 작은 스타일(.small)로 구분한다. 진짜 활동은 이벤트에서만 나온다.

// 목적지는 layout.js가 방과 함께 정의한다.
const MAX_CUPS = 6
const SMALL_TALK = [
  '커피 한 잔 하고 올게요',
  '잠깐 스트레칭…',
  '이번 스프린트 일정 어떻게 돼요?',
  '점심 뭐 드셨어요?',
  '그 버그 결국 캐시 문제였대요',
  '리팩터링 한번 해야 하는데',
  '오늘 배포 있나요?',
  '창밖 날씨 좋네요',
  '리뷰 남은 거 있으면 주세요',
  '새 디자인 시안 봤어요?',
]

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const shuffled = (arr) => arr.slice().sort(() => Math.random() - 0.5)

/** 이미 누가 쓰고 있는 자리는 빼고 고른다(한 소파에 둘이 겹쳐 앉지 않도록). */
function freeSpots(list, now) {
  const taken = new Set()
  for (const a of agents.values()) {
    if (a.plan && now < a.plan.until) taken.add(`${a.plan.dest.gx},${a.plan.dest.gy}`)
  }
  return list.filter((p) => !taken.has(`${p.gx},${p.gy}`))
}

// 혼자 하는 행동들. 자리를 뜨는 이유가 커피 하나뿐이면 사무실이 심심하다.
const SOLO = [
  { kind: 'coffee', spot: () => SPOTS.coffee, ms: 9000, say: ['커피 한 잔 하고 올게요', '카페인 충전…'] },
  { kind: 'water', spot: () => SPOTS.water, ms: 7000, say: ['물 좀 뜨고 올게요'] },
  { kind: 'vending', spot: () => SPOTS.vending, ms: 8000, say: ['간식 좀 사올게요', '당 떨어졌어요'] },
  { kind: 'book', spot: () => SPOTS.bookshelf, ms: 9000, say: ['자료 좀 찾아볼게요', '이 책 어디 있더라'] },
  { kind: 'window', spot: (n) => pick(freeSpots(SPOTS.window, n)), ms: 8000, say: ['잠깐 바람 좀…', '창밖 날씨 좋네요'] },
  { kind: 'sofa', spot: (n) => pick(freeSpots(SPOTS.sofa, n)), ms: 14000, say: ['잠깐 쉬었다 올게요'] },
  { kind: 'beanbag', spot: (n) => pick(freeSpots(SPOTS.beanbag, n)), ms: 15000, say: ['5분만 늘어져 있을게요'] },
  { kind: 'wander', spot: (n) => pick(freeSpots(SPOTS.wander, n)), ms: 7000, say: [null, null, '잠깐 스트레칭…'] },
  { kind: 'stretch', spot: (n, a) => a.stand, ms: 5000, say: ['으-. 어깨가…', '잠깐 일어날게요'] },
]

let nextIdleAt = 0

function scheduleIdle(now) {
  // **붙인 프로젝트가 없으면 사무실은 조용하다.**
  //
  // 유휴 연출(커피·잡담)은 "일이 없는 팀"을 보여주는 것이지 "아직 출근하지 않은 팀"이
  // 아니다. 프로젝트를 하나도 안 붙인 첫 화면에서 캐릭터들이 "이번 스프린트 일정
  // 어떻게 돼요?"라고 떠들면, 무엇을 해야 하는지(프로젝트 추가) 알려 주는 대신
  // 이미 굴러가는 것처럼 보인다.
  if (!activeDir) return
  if (now < nextIdleAt) return
  nextIdleAt = now + 2200 + Math.random() * 2800

  const free = [...agents.values()].filter(
    (a) => !a.active && !(a.plan && now < a.plan.until) && a.queued === 0,
  )
  if (!free.length) return
  // 한 번씩은 아무 일도 일어나지 않는다. 쉼 없이 북적이면 오히려 가짜처럼 보인다.
  if (Math.random() < 0.25) return

  // 컵이 쌓였으면 먼저 치우러 간다(쌓인 채로 계속 커피를 뽑지 않도록)
  const messy = free.filter((a) => a.cups >= 3)
  if (messy.length && Math.random() < 0.5) {
    const a = pick(messy)
    a.plan = { kind: 'trash', dest: SPOTS.trash, until: now + 9000, bubble: '컵 좀 버리고 올게요' }
    return
  }

  const roll = Math.random()

  // 둘 이상이 놀고 있을 때만 되는 것들(잡담·회의)을 먼저 굴린다
  if (free.length >= 2 && roll < 0.24) {
    const [a, b] = shuffled(free)
    const mid = { gx: (a.chair.gx + b.chair.gx) / 2, gy: (a.chair.gy + b.chair.gy) / 2 }
    const talk = pick(SMALL_TALK)
    a.plan = { kind: 'chat', dest: { gx: mid.gx - 0.35, gy: mid.gy }, until: now + 8000, bubble: talk, faceId: b.id }
    b.plan = { kind: 'chat', dest: { gx: mid.gx + 0.35, gy: mid.gy }, until: now + 8000, bubble: null, faceId: a.id }
    setTimeout(() => {
      if (b.plan && performance.now() < b.plan.until) b.plan.bubble = pick(SMALL_TALK)
    }, 2600)
    return
  }

  if (free.length >= 2 && roll < 0.38) {
    // 회의실 또는 휴게실 소파에 둘러앉는다
    const toSofa = Math.random() < 0.45
    const seats = freeSpots(toSofa ? SPOTS.sofa : SPOTS.meeting, now)
    if (seats.length >= 2) {
      const n = Math.min(seats.length, 2 + (Math.random() < 0.4 ? 1 : 0))
      const chosen = shuffled(free).slice(0, n)
      chosen.forEach((a, i) => {
        a.plan = {
          kind: toSofa ? 'sofa' : 'meeting',
          dest: seats[i],
          until: now + (toSofa ? 14000 : 11000),
          bubble: i === 0 ? (toSofa ? '커피 마시면서 얘기해요' : '잠깐 모여서 정리할까요?') : null,
          faceId: chosen[(i + 1) % chosen.length]?.id,
        }
      })
      return
    }
  }

  // 나머지는 혼자 하는 행동. 한 번에 한두 명씩 움직인다.
  const movers = shuffled(free).slice(0, 1 + (free.length > 3 && Math.random() < 0.4 ? 1 : 0))
  for (const a of movers) {
    const b = pick(SOLO)
    const dest = b.spot(now, a)
    if (!dest) continue // 그 자리는 이미 누가 쓰는 중
    a.plan = { kind: b.kind, dest, until: now + b.ms, bubble: pick(b.say) }
  }
}

// ---------- 움직임 ----------

function facingFlip(a, other) {
  const me = toScreen(a.gx, a.gy)
  const you = toScreen(other.gx, other.gy)
  return you.x < me.x
}

function update(dt, now) {
  sweepStaleQueued()
  scheduleIdle(now)

  for (const a of agents.values()) {
    // **일하는 중인지는 이벤트 간격이 아니라 상태로 판단한다.**
    //
    // 예전에는 "마지막 이벤트 + 2.6초" 안에 있어야 일하는 중이었다. 그런데 긴 답을
    // 만드는 동안에는 도구 호출이 아예 없다 — 기획안을 쓰던 팀원이 2분 넘게 조용한
    // 적이 있고, 그동안 화면에서는 **모니터가 꺼진 채 앉아 있어** 멈춘 것처럼 보였다.
    // 시작(agent_start)과 끝(agent_stop) 사이면 일하는 중이 맞다. 리드는 시작
    // 이벤트가 없지만 첫 도구에서 active가 되고 세션이 쉬면 풀린다.
    const working = a.active
    a.working = working
    if (a.plan && (now >= a.plan.until || working)) a.plan = null

    // 일이 없으면 rest(=자기 의자)로 돌아간다. 유휴 행동이 있을 때만 자리를 뜬다.
    const goal = working ? a.work : a.plan ? a.plan.dest : a.rest

    // 목적지가 바뀌면 경로를 다시 짠다. 방이 나뉘어 있으므로 문을 거쳐야 한다 —
    // 직선으로 가면 벽을 뚫고 지나간다.
    if (!a.goal || a.goal.gx !== goal.gx || a.goal.gy !== goal.gy) {
      a.goal = goal
      a.path = routeTo({ gx: a.gx, gy: a.gy }, goal)
    }
    if (!a.path || a.path.length === 0) a.path = [goal]

    const dest = a.path[0]
    const dx = dest.gx - a.gx
    const dy = dest.gy - a.gy
    const dist = Math.hypot(dx, dy)

    // 경유지에 닿으면 다음 지점으로
    if (dist <= 0.08 && a.path.length > 1) {
      a.path.shift()
      continue
    }

    // 목적지 도착 판정 — 커피는 한 잔 늘고, 분리수거는 쌓인 컵을 비운다.
    if (dist <= 0.25 && a.plan && !a.plan.done && a.path.length === 1) {
      a.plan.done = true
      if (a.plan.kind === 'coffee') {
        a.cups = Math.min(MAX_CUPS, a.cups + 1)
        a.plan.bubble = a.cups >= MAX_CUPS ? '책상에 컵이 너무 많네…' : '한 잔 받았습니다'
      } else if (a.plan.kind === 'trash') {
        a.cups = 0
        a.plan.bubble = '분리수거 완료'
      }
    }

    if (dist > 0.03) {
      const speed = 1.7
      const step = Math.min(dist, (speed * dt) / 1000)
      a.gx += (dx / dist) * step
      a.gy += (dy / dist) * step
      a.pose = 'walk'
      a.seat = null
      const screenDir = dx - dy
      if (Math.abs(screenDir) > 0.01) a.flip = screenDir < 0
    } else {
      a.gx = dest.gx
      a.gy = dest.gy
      // 어디에 도착했느냐가 자세를 정한다. 유휴 목적지에 sit이 붙어 있으면
      // 소파·빈백·회의 의자에 앉고, 아무 계획이 없으면 자기 의자에 앉아 있다.
      a.seat = a.plan ? (a.plan.dest.sit ?? null) : 'desk'
      a.pose = a.seat ? 'sit' : 'idle'
      // 대화 중이면 상대를 바라본다 (리드의 호출 연출 또는 유휴 잡담)
      const faceId = (now < (a.talkUntil ?? 0) && a.faceTarget) || a.plan?.faceId
      if (faceId) {
        const other = agents.get(faceId)
        if (other) a.flip = facingFlip(a, other)
      }
    }
  }
}

// 앉는 물건별 높이 보정(픽셀).
//
// 앉은 스프라이트는 **허벅지 밑면이 아래에서 5px** 위치에 있다. 그러니
//   lift = 4 − (좌판 윗면 높이)
// 로 두면 엉덩이가 정확히 좌판에 닿고 발은 바닥 근처에 온다.
// 예전 값(-6.5)은 몸 전체를 좌판보다 6.5px 위로 띄워서, 등받이에 걸터앉은 것처럼 보였다.
//   의자 좌판 윗면 5.2 (furniture.js SEAT_H 3.4 + 쿠션 1.8)
//   소파 5.4 (좌석 4 + 쿠션 1.4) · 빈백은 푹 꺼지므로 조금 더 내린다
const SEAT_LIFT = { desk: -1.2, meeting: -1.2, sofa: -1.4, beanbag: -1 }

function frameIndex(pose, t) {
  const speed = pose === 'walk' ? 150 : pose === 'sit' ? 150 : 700
  return Math.floor(t / speed) % 2
}

// ---------- 이름표·말풍선(DOM) ----------

function nodesFor(a) {
  let n = nodes.get(a.id)
  if (n) return n
  const tag = document.createElement('div')
  tag.className = 'tag'
  tag.innerHTML = '<span class="nm"></span><span class="meta"></span>' 
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.hidden = true
  overlay.append(tag, bubble)
  n = { tag, bubble }
  nodes.set(a.id, n)
  return n
}

/** 상단 요약 — 지금 일하는 사람과 하는 일. 캐릭터를 쫓지 않아도 보이게. */
function renderNow(now) {
  const busy = [...agents.values()].filter((a) => a.active)
  if (!busy.length) {
    const waiting = [...agents.values()].reduce((n, a) => n + a.queued, 0)
    // 상단에도 내용을 적는다. 여기가 캐릭터를 쫓지 않고 상태를 보는 자리다.
    const head = queuedFor.find((q) => q.text)?.text?.replace(/\s+/g, ' ').trim()
    nowEl.textContent = !waiting
      ? '조용합니다 — 진행 중인 작업 없음'
      : head
        ? `대기 중: ${head.slice(0, 30)}${head.length > 30 ? '…' : ''}${waiting > 1 ? ` 외 ${waiting - 1}건` : ''}`
        : `지시 ${waiting}건 대기 중`
    nowEl.title = waiting ? queuedFor.filter((q) => q.text).map((q) => `· ${q.text}`).join('\n') : ''
    nowEl.className = waiting ? 'queued' : ''
    return
  }
  // 하나라도 막혀 있으면 상단 줄부터 색이 바뀐다. 캐릭터를 일일이 볼 필요 없이
  // "지금 봐야 할 것이 있다"는 신호가 먼저 온다.
  const stuck = busy.filter((a) => workState(a, now).stalled)
  nowEl.className = stuck.length ? 'queued' : 'busy'
  nowEl.textContent =
    (stuck.length ? `⚠ ${stuck.map((a) => a.label).join('·')} 응답 없음 — ` : '작업 중 · ') +
    busy
      .sort((p, q) => (p.startedAt ?? 0) - (q.startedAt ?? 0))
      .map((a) => {
        const w = workState(a, now)
        return `${a.label}(${w.word} ${fmtDur(w.sec)})`
      })
      .join(' · ')
  // 자리가 모자라면 말줄임으로 잘린다(실측 30px 넘침). 잘린 뒤쪽을 볼 방법이
  // 없으면 "누가 더 일하는지"를 알 수 없으므로 마우스를 올리면 전부 보이게 둔다.
  nowEl.title = nowEl.textContent
}

function syncOverlay(now) {
  renderNow(now)

  // 1단계 — 내용과 기준 위치를 채운다. 위치 보정은 크기를 잰 뒤에 한다.
  const items = []
  for (const a of agents.values()) {
    const { tag, bubble } = nodesFor(a)
    const { x, y } = toScreen(a.gx, a.gy)

    // 이름표는 **머리 위**에. 스프라이트 맨 윗줄이 머리 꼭대기이므로
    // 서 있으면 y-20, 앉으면 그 자리에서 lift만큼 내려간 곳이 머리 꼭대기다.
    const headY = a.seat ? y + (SEAT_LIFT[a.seat] ?? 0) - 20 : y - 21
    tag.classList.toggle('on', a.active)
    tag.classList.toggle('sel', target === a.id)
    const erroring = now < (a.errorUntil ?? 0)
    tag.classList.toggle('err', erroring)
    // 이름 + **지금 뭘 하는지**. 말풍선은 곧 사라지지만 이 배지는 작업이 끝날
    // 때까지 남는다. 경과 초·도구 호출 수도 같이 붙여 진행 중임을 보여 준다.
    tag.querySelector('.nm').textContent = (erroring ? '❗ ' : '') + a.label
    const meta = tag.querySelector('.meta')
    if (a.active) {
      const w = workState(a, now)
      // 생각 중일 때는 **얼마나 조용했는지**를 같이 적는다. 그래야 "정상적으로 답을
      // 만드는 중"과 "뭔가 잘못돼 멈춤"을 사람이 구분할 수 있다.
      const tail = w.thinking ? ` · 조용 ${fmtDur(w.quietFor)}` : ''
      meta.textContent = ` ${w.icon} ${w.word} · ${fmtDur(w.sec)} · 🛠 ${a.toolCount ?? 0}${tail}`
      tag.classList.toggle('thinking', w.thinking && !w.stalled)
      tag.classList.toggle('stalled', w.stalled)
    } else {
      meta.textContent = ''
      tag.classList.remove('thinking', 'stalled')
    }

    let text = null
    let kind = ''
    if (a.queued > 0) {
      // **무엇을 기다리는지** 보여 준다. 건수만 적어 두면 "1건 대기"가 무슨 지시인지
      // 확인할 방법이 없었다. 말풍선은 좁으니 앞부분만, 전문은 마우스를 올리면 나온다.
      const mine = queuedFor.filter((q) => q.id === a.id && q.text)
      const head = mine[0]?.text?.replace(/\s+/g, ' ').trim()
      text = head
        ? `대기: ${head.slice(0, 24)}${head.length > 24 ? '…' : ''}${a.queued > 1 ? ` 외 ${a.queued - 1}건` : ''}`
        : `지시 ${a.queued}건 대기`
      bubble.title = mine.length ? mine.map((q) => `· ${q.text}`).join('\n') : ''
      kind = 'queued'
    } else if (a.task && (a.active || now - a.lastEventAt < 6000 || now < (a.talkUntil ?? 0))) {
      // 일하는 동안에는 말풍선을 **끄지 않는다**. 6초 뒤 사라지게 두었더니
      // 오래 걸리는 작업에서 "누가 뭘 하는지 모르겠다"는 상태가 됐다.
      text = a.task
    } else if (a.plan?.bubble && now < a.plan.until) {
      text = a.plan.bubble
      kind = 'small' // 잡담: 실제 작업이 아니라는 걸 눈에 띄게 구분한다
    } else if (target === a.id && a.task) {
      // 클릭해서 고른 팀원은 **마지막으로 한 일**을 계속 보여 준다. 지어낸 게
      // 아니라 실제 마지막 이벤트라, 흐린 스타일로 지난 일임을 표시한다.
      text = a.task
      kind = 'stale'
    }
    if (text) {
      bubble.hidden = false
      if (bubble.textContent !== text) bubble.textContent = text
      bubble.className = `bubble${kind ? ' ' + kind : ''}${target === a.id ? ' sel' : ''}`
    } else {
      bubble.hidden = true
    }
    items.push({ a, tag, bubble, x: x * scale + cam.x, anchor: headY * scale + cam.y })
  }

  layoutOverlay(items)
}

// ---------- 말풍선 겹침 정리 ----------
//
// 자리가 붙어 있으면 이름표와 말풍선이 서로를 덮어 아무것도 못 읽는다.
// 화면 **앞쪽(아래)** 사람부터 자리를 잡고, 뒤에 오는 사람이 겹치면 위로 밀어 올린다.
// 선택한 팀원은 맨 먼저 자리를 잡고 z-index를 최대로 줘서 무조건 위로 올린다.

const GAP = 3

function layoutOverlay(items) {
  // 2단계 — 크기를 **한 번에** 읽는다. 읽기와 쓰기를 번갈아 하면 요소마다
  // 레이아웃이 다시 계산돼 프레임이 느려진다.
  for (const it of items) {
    it.tw = it.tag.offsetWidth
    it.th = it.tag.offsetHeight
    it.bw = it.bubble.hidden ? 0 : it.bubble.offsetWidth
    it.bh = it.bubble.hidden ? 0 : it.bubble.offsetHeight
    it.w = Math.max(it.tw, it.bw)
    it.h = it.th + (it.bh ? it.bh + GAP : 0)
  }

  // 3단계 — 자리 잡는 순서. 선택 > 작업 중 > 화면 아래쪽(앞)
  const order = items.slice().sort((p, q) => {
    const sp = target === p.a.id ? 1 : 0
    const sq = target === q.a.id ? 1 : 0
    if (sp !== sq) return sq - sp
    if (p.a.active !== q.a.active) return p.a.active ? -1 : 1
    return q.anchor - p.anchor
  })

  const placed = []
  order.forEach((it, i) => {
    // 화면 밖으로 밀려나지 않게 가로 위치를 먼저 가둔다(전에는 왼쪽 벽에서 잘렸다)
    const half = it.w / 2
    const x = Math.min(canvas.width - half - 4, Math.max(half + 4, it.x))
    let bottom = it.anchor

    // 이미 놓인 것과 겹치면 그 위로 올린다
    for (let guard = 0; guard < 24; guard++) {
      const hit = placed.find(
        (p) =>
          x - half < p.right && x + half > p.left && bottom - it.h < p.bottom && bottom > p.bottom - p.h,
      )
      if (!hit) break
      bottom = hit.bottom - hit.h - GAP
    }
    // 위쪽으로도 넘치지 않게
    bottom = Math.max(it.h + 4, bottom)

    placed.push({ left: x - half, right: x + half, bottom, h: it.h })

    it.tag.style.left = `${x}px`
    it.tag.style.top = `${bottom}px`
    it.tag.style.zIndex = String(target === it.a.id ? 9999 : 100 + (order.length - i))
    if (!it.bubble.hidden) {
      it.bubble.style.left = `${x}px`
      it.bubble.style.top = `${bottom - it.th - GAP}px`
      it.bubble.style.zIndex = it.tag.style.zIndex
    }
  })
}

// ---------- 그리기 ----------

function draw(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  scale = eff()
  ctx.setTransform(1, 0, 0, 1, cam.x, cam.y) // 카메라 이동
  drawWalls(ctx, scale, t)
  drawFloor(ctx, scale)
  drawRug(ctx, scale, 9, 1, 3, 3) // 회의실 러그

  // 깊이 정렬. **각 물건을 자기 위치의 깊이로** 넣는다 — 파티션·의자를 책상과
  // 같은 깊이로 묶으면(예전 방식) 파티션 앞을 지나가는 캐릭터가 파티션에 가린다.
  // 깊이가 같을 때는 rank로 순서를 고정한다: 파티션 → 책상 → 의자 → 사람.
  const RANK = { wall: 0, partition: 1, prop: 2, desk: 3, chair: 4, agent: 5, arms: 6 }
  const items = []
  // 내벽도 한 칸씩 깊이 정렬에 넣는다. 통짜로 그리면 방 안 캐릭터가 벽에 가린다.
  for (const w of WALL_SEGMENTS) items.push({ kind: 'wall', d: depth(w.gx, w.gy), w })
  for (const dw of DOORWAYS) items.push({ kind: 'wall', d: depth(dw.gx, dw.gy), w: dw, door: true })
  for (const a of agents.values()) {
    const d = a.desk
    // 두 패널 모두 실제로는 책상보다 0.55만큼 뒤에 있다(서쪽/북쪽으로 각각 0.55).
    items.push({ kind: 'partition', d: depth(d.gx, d.gy) - 0.55, a })
    items.push({ kind: 'desk', d: depth(d.gx, d.gy), a })
    items.push({ kind: 'chair', d: depth(a.chair.gx, a.chair.gy), a })
    items.push({ kind: 'agent', d: depth(a.gx, a.gy), a })
    // 팔걸이는 앉은 캐릭터 **앞**에 그려야 팔을 걸친 것처럼 보인다
    items.push({ kind: 'arms', d: depth(a.chair.gx, a.chair.gy), a })
  }
  for (const p of PROPS) items.push({ kind: 'prop', d: depth(p.gx, p.gy), p })
  items.sort((p, q) => p.d - q.d || RANK[p.kind] - RANK[q.kind])

  for (const it of items) {
    if (it.kind === 'wall') {
      if (it.door) drawDoorway(ctx, scale, it.w.gx, it.w.gy, it.w.dir)
      else drawInnerWall(ctx, scale, it.w.gx, it.w.gy, it.w.dir)
      continue
    }
    if (it.kind === 'prop') {
      it.p.draw(ctx, scale, it.p.gx, it.p.gy, t)
      continue
    }
    const a = it.a
    if (it.kind === 'partition') {
      drawPartitions(ctx, scale, a.desk.gx, a.desk.gy)
      continue
    }
    if (it.kind === 'desk') {
      // 모니터는 **일할 때만** 켜진다. 이제 기본이 앉아 있는 상태라 자세로는
      // 일하는지 알 수 없다 — 켜진 화면이 그 구분을 대신한다.
      drawWorkstation(ctx, scale, a.desk.gx, a.desk.gy, a.working, t, a.cups)
      continue
    }
    if (it.kind === 'chair') {
      // 좌판과 등받이는 앉은 캐릭터보다 **먼저**(뒤에) 그린다.
      drawChair(ctx, scale, a.chair.gx, a.chair.gy)
      drawChairBack(ctx, scale, a.chair.gx, a.chair.gy)
      continue
    }
    if (it.kind === 'arms') {
      // 팔걸이는 **자기 책상 의자에 앉아 있을 때만**. 소파에 가 있는데 빈 의자에
      // 팔걸이를 얹으면 아무도 없는 자리에 팔이 떠 있다.
      if (a.seat === 'desk') drawChairArms(ctx, scale, a.chair.gx, a.chair.gy)
      continue
    }

    const sitting = a.pose === 'sit'
    if (!sitting) drawShadow(ctx, scale, a.gx, a.gy)
    const { x, y } = toScreen(a.gx, a.gy)
    const frames = POSES[a.pose] ?? POSES.idle
    // 앉는 높이는 앉는 물건마다 다르다. 빈백은 거의 바닥이다.
    drawSprite(ctx, frames[frameIndex(a.pose, t)], a.palette, x, y, scale, a.flip, SEAT_LIFT[a.seat] ?? 0)

    if (target === a.id) {
      ctx.strokeStyle = '#4a90d9'
      ctx.lineWidth = Math.max(2, scale / 2)
      ctx.beginPath()
      ctx.ellipse(x * scale, y * scale, 11 * scale, 5.5 * scale, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}

let renderError = null

function loop(now) {
  const dt = Math.min(now - lastFrame, 100)
  lastFrame = now
  try {
    update(dt, now)
    draw(now)
    syncOverlay(now)
  } catch (err) {
    // 그리다 한 번 던지면 그 뒤 순서(가구·캐릭터)가 통째로 사라진다. 조용히
    // 사라지는 게 최악이므로 화면 상태줄에 드러내고 루프는 계속 돌린다.
    if (renderError !== String(err)) {
      renderError = String(err)
      console.error('[team-view] 렌더 오류:', err)
      statusEl.textContent = `렌더 오류: ${renderError.slice(0, 60)}`
      statusEl.className = 'warn'
    }
  }
  requestAnimationFrame(loop)
}

// ---------- 클릭 → 대화 상대 선택 ----------

canvas.addEventListener('click', (e) => {
  if (dragging?.moved) return // 화면을 끌던 중이면 선택하지 않는다
  const best = agentAt(e.clientX, e.clientY)
  target = best ? best.id : 'all'
  renderTargets()
  // 칩으로 고를 때와 똑같이 대화도 그 사람 것만 남긴다. 두 길이 다르게 동작하면
  // "칩은 걸러지는데 캐릭터는 안 걸러진다"가 된다.
  redrawChat(activeDir)
  inputEl.focus()
})

// ---------- 배선 ----------

/**
 * 메인에서 오는 소식을 받는다. **없는 통로면 조용히 넘어간다.**
 *
 * 통로 하나를 붙이는 곳이 파일 맨 바깥이라, 그게 없으면 그 줄에서 예외가 나고
 * **모듈 평가가 통째로 멈춘다.** 뒤쪽 `const`가 초기화되지 않아 화면이 까맣게
 * 뜨고, 로그에는 엉뚱한 `Cannot access ... before initialization`만 남는다.
 * 실제로 preload에 함수 하나를 늦게 추가했다가 그렇게 됐다.
 *
 * 앱과 preload 버전이 어긋나는 일(설치본을 덮어쓰다 만 경우 등)은 언제든 생긴다.
 * 소식 하나를 못 받는 것과 화면 전체가 죽는 것은 크기가 다르다.
 */
function on(name, handler) {
  const fn = window.teamView?.[name]
  if (typeof fn !== 'function') {
    console.warn(`[teamView] ${name} 통로가 없습니다 — 그 소식은 받지 않습니다`)
    return
  }
  fn(handler)
}

// 이벤트에는 어느 프로젝트 것인지가 실려 온다. 보고 있는 사무실 것만 그린다 —
// 메인도 비활성 프로젝트는 아예 파싱하지 않으므로 여기까지 오지도 않지만,
// 탭을 막 옮긴 순간의 이전 프로젝트 이벤트가 뒤늦게 닿을 수 있어 한 번 더 거른다.
on('onEvents', ({ dir, events }) => {
  if (dir !== activeDir) return
  events.forEach(applyEvent)
  refreshOutCount() // 묶음 단위로 한 번만 — 이벤트마다 다시 그리면 목록이 깜빡인다
})

/**
 * 사무실을 비운다. 탭을 옮겼을 때와 로그가 잘렸을 때 온다.
 *
 * 시뮬레이션 상태(팀원·대기 배지·이름표)는 지우지만 **채팅은 지우지 않는다** —
 * 그 프로젝트에서 오간 대화를 다시 그려 준다. 탭을 옮길 때마다 대화가 사라지면
 * 무엇을 시켰는지 알 수 없다.
 */
on('onReset', ({ dir } = {}) => {
  if (dir) activeDir = dir
  restoreChat(dir) // 지난 대화를 되살린다(프로젝트당 한 번)
  queuedFor.length = 0
  agents = buildAgents()
  refreshObstacles()
  nodes.clear()
  overlay.replaceChildren()
  lastChatAt.clear()
  // 결과물은 **프로젝트마다 다르다.** 탭을 옮기면 비우고, 이어서 들어오는 재생
  // 기록으로 그 프로젝트 것을 다시 세운다.
  runs = []
  refreshOutCount()
  target = 'all'
  renderTargets()
  redrawChat(activeDir)
})

let seeded = false // 첫 안내를 한 번만 띄우기 위한 표시
let widthApplied = false // 기억해 둔 채팅 폭은 한 번만 적용한다(끄는 중에 덮어쓰면 안 된다)
on('onStatus', ({ projects, activeDir: active, max, chatWidth }) => {
  if (!widthApplied && chatWidth) {
    widthApplied = true
    setChatWidth(chatWidth, { save: false }) // 방금 읽은 값을 도로 저장할 이유가 없다
  }
  activeDir = active
  lastProjects = projects
  renderTabs(projects, active, max)

  updateComposer() // 프로젝트가 붙고 떨어질 때마다 입력창이 따라가야 한다
  const me = projects.find((p) => p.dir === active)
  const trouble = me ? diagnose(me) : { text: '프로젝트를 추가하세요', warn: true }
  statusEl.textContent = trouble.text
  statusEl.className = trouble.warn ? 'warn' : 'ok'
  // 구성이 빠졌을 때만 '세팅하기'를 드러낸다. 회사가 남에게 점유된 것 같은 문제는
  // 세팅으로 풀리지 않으므로 버튼을 띄우지 않는다.
  renderStack(me?.health?.stack)
  const parts = me ? missingParts(me.health) : []
  setupBtn.hidden = !parts.length
  // 빠진 것을 채우는 것과 낡은 것을 갱신하는 것은 다른 일이다. 버튼이 무엇을 할지
  // 이름으로 밝힌다 — 같은 이름이면 눌러 보고 나서야 알게 된다.
  setupBtn.textContent = parts.some((p) => p.update) ? '팀 갱신' : '세팅하기'

  renderRun(me)
  renderGit(me)

  // 첫 안내는 **프로젝트가 있는지 알고 난 뒤에** 띄운다. 예전에는 시작하자마자
  // "캐릭터를 클릭하고 지시를 보내세요"라고 했는데, 보낼 프로젝트가 없을 때도
  // 똑같이 나와서 화면 한가운데의 안내와 어긋났다.
  if (!seeded) {
    seeded = true
    // 화면에만 띄우고 **기록에는 남기지 않는다.** 켤 때마다 저장돼 대화 기록에
    // 같은 안내가 쌓이고 있었다(실측: 452줄 중 3줄이 이 안내였다).
    if (me) renderMsg('sys', '', '캐릭터를 클릭하거나 위 칩으로 대상을 고르고 지시를 보내세요.')
  }
})

const stackEl = document.getElementById('stack')

/**
 * 이 프로젝트가 무엇으로 만들어져 있는지 한 줄로.
 *
 * 며칠 만에 다시 열면 무슨 스택이었는지 기억나지 않는다. CLAUDE.md에 적어 두면
 * 좋지만 비어 있는 경우가 많아서, 앱이 실제 파일(package.json·설정 파일)에서
 * 읽어 낸 것을 보여 준다. **감지된 것이 없으면 아예 띄우지 않는다** — 빈 줄이
 * 자리를 차지하면 팀원 칩만 밀린다.
 */
function renderStack(stack) {
  const list = Array.isArray(stack) ? stack : []
  stackEl.hidden = !list.length
  if (!list.length) return
  stackEl.replaceChildren()
  const label = document.createElement('span')
  label.className = 'st-label'
  label.textContent = '스택'
  stackEl.append(label)
  for (const s of list) {
    const el = document.createElement('span')
    el.className = 'st'
    el.textContent = s
    stackEl.append(el)
  }
  stackEl.title = `이 프로젝트에서 감지된 기술: ${list.join(', ')}\n(package.json과 설정 파일에서 읽었습니다)`
}

/** 이 프로젝트에 빠진 구성. 순서는 치명적인 것부터. */
function missingParts(health) {
  const h = health ?? {}
  const out = []
  if (!h.hooks) out.push({ key: 'hooks', label: '훅 — 팀 활동을 화면에 기록합니다' })
  if (!h.agents) out.push({ key: 'agents', label: '팀원 — 없으면 리드가 혼자 일합니다' })
  if (!h.guide) out.push({ key: 'guide', label: 'CLAUDE.md — 어떤 일이 누구 몫인지 알려줍니다' })
  // 빠진 건 없지만 **팀원 정의가 앱보다 낡은** 경우. 팀뷰를 고쳐도 이미 세팅된
  // 프로젝트는 옛 규칙 그대로라, 알려 주지 않으면 왜 다르게 도는지 알 수 없다.
  if (!out.length && h.stale > 0) {
    out.push({
      key: 'agents',
      update: true,
      label: `팀원 정의 ${h.stale}개가 앱보다 낡았습니다 — 갱신하면 최신 규칙으로 일합니다`,
    })
  }
  // 훅이 낡으면 **화면에 찍히는 내용 자체가 옛 규칙**이다. 지우는 명령이 잘려
  // 나오던 문제를 고쳐도 옛 훅을 쓰는 프로젝트에는 닿지 않는다.
  if (!out.some((p) => p.key === 'hooks') && h.hookStale) {
    out.push({
      key: 'hooks',
      update: true,
      label: '훅이 앱보다 낡았습니다 — 갱신하면 지우는 명령이 잘리지 않고 기록됩니다',
    })
  }
  // 지침도 마찬가지다. **팀원 정의만 세고 있었더니 CLAUDE.md의 팀 규칙이 옛것으로
  // 남았다** — 팀원을 갱신하고 나면 버튼이 사라져, 정작 규칙은 낡은 채로 굳었다.
  if (!out.some((p) => p.key === 'guide') && h.guideStale) {
    out.push({
      key: 'guide',
      update: true,
      label: '팀 규칙(CLAUDE.md)이 앱보다 낡았습니다 — 개요·스택은 그대로 두고 규칙만 바꿉니다',
    })
  }
  return out
}

/**
 * 빠진 구성을 채운다. **묻지 않고 넣지 않는다** — 남의 폴더에 파일을 쓰는 일이다.
 * 무엇이 들어가는지 먼저 보여주고, 이미 있는 파일은 건드리지 않는다고 밝힌다.
 */
async function runSetup(dir, health) {
  const parts = missingParts(health)
  if (!parts.length) return
  const isUpdate = parts.some((p) => p.update)
  const list = parts.map((p) => `  · ${p.label}`).join('\n')
  // **무엇을 덮어쓰는지 정확히 말한다.** 예전에는 "CLAUDE.md는 건드리지 않습니다"가
  // 항상 붙어 있었는데, 지침 갱신이 생기면서 그게 거짓말이 될 뻔했다.
  const touching = []
  if (parts.some((p) => p.key === 'agents' && p.update)) {
    touching.push('· 팀원 파일(.claude/agents/*.md)을 앱이 들고 있는 것으로 덮어씁니다')
  }
  if (parts.some((p) => p.key === 'hooks' && p.update)) {
    touching.push('· 훅 파일(.claude/hooks/team_events.py)을 최신으로 바꿉니다')
  }
  if (parts.some((p) => p.key === 'guide' && p.update)) {
    touching.push(
      '· CLAUDE.md의 “팀으로 일합니다” 아래만 바꿉니다 — 개요·기술 스택·주요 명령어는 그대로입니다',
      '· 바꾸기 전 CLAUDE.md.bak으로 지금 내용을 남깁니다',
    )
  }
  touching.push('· 직접 고쳐 두신 부분이 있다면 그 내용은 사라집니다')
  const ok = confirm(
    isUpdate
      ? `${baseName(dir)}의 팀 설정을 최신으로 갱신할까요?\n\n${list}\n\n${touching.join('\n')}`
      : `${baseName(dir)}에 다음이 없습니다.\n\n${list}\n\n` +
          `지금 넣을까요?\n` +
          `· 기존 settings.json은 덮어쓰지 않고 훅만 덧붙입니다\n` +
          `· 이미 있는 파일은 그대로 둡니다`,
  )
  if (!ok) return
  hintEl.textContent = isUpdate ? '갱신 중…' : '세팅 중…'
  const opts = Object.fromEntries(parts.map((p) => [p.key, true]))
  if (isUpdate) opts.update = true
  const res = await window.teamView.setupProject(dir, opts)
  hintEl.textContent = res?.ok
    ? `${baseName(dir)} 세팅 완료 — ${res.done.join(' · ')}`
    : `세팅 실패: ${res?.error ?? '알 수 없는 오류'}`
}

setupBtn.addEventListener('click', () => {
  const p = lastProjects.find((x) => x.dir === activeDir)
  if (p) runSetup(p.dir, p.health)
})

/**
 * 이 프로젝트가 지금 왜 그 상태인지 한 줄로.
 *
 * 회사가 닫혀 있거나 구성이 빠져 있으면 보낸 지시가 원하는 대로 처리되지 않는데,
 * 화면상으로는 **그냥 조용한 것과 똑같다.** 지시가 안 먹히는 걸 세 시간 동안
 * 못 알아챈 적이 있고, 팀원이 없어 리드가 혼자 일하는 것도 이벤트 로그를
 * 집계하고 나서야 알았다. 둘 다 여기서 먼저 말해 줬어야 하는 일이다.
 *
 * 순서는 **치명적인 것부터**다: 아예 안 도는 것 → 혼자 일하는 것 → 배분이 없는 것.
 */
function diagnose(p) {
  const h = p.health ?? {}
  if (p.company === 'foreign') return { text: '다른 창이 이 프로젝트를 맡고 있습니다', warn: true }
  if (p.company === 'closed')
    return { text: '회사가 닫혀 있습니다 — 보낸 지시가 처리되지 않습니다', warn: true }
  if (!h.hooks)
    return { text: '훅이 등록되지 않았습니다 — 팀 활동이 화면에 나오지 않습니다', warn: true }
  if (!h.agents)
    return { text: '팀원이 없습니다(.claude/agents) — 리드가 혼자 일합니다', warn: true }
  if (!h.guide)
    return { text: 'CLAUDE.md가 없습니다 — 어떤 일이 누구 몫인지 리드가 모릅니다', warn: true }
  if (p.company === 'busy') return { text: '회사 운영 중 — 지시 처리 중', warn: false }
  return { text: `회사 운영 중 — 대기 · 팀원 ${h.agents}명`, warn: false }
}

// ---------- 프로젝트 탭 ----------
//
// 탭은 '보기 전환'인 동시에 **다른 회사가 지금 일하는지 알려주는 계기판**이다.
// 사무실이 하나만 보이므로, 배지가 없으면 나머지 둘이 도는지 멈췄는지 알 수 없다.

function renderTabs(projects, active, max) {
  tabsEl.replaceChildren()
  for (const p of projects) {
    const h = p.health ?? {}
    const tab = document.createElement('div')
    tab.className = `tab${p.dir === active ? ' sel' : ''}`
    // 마우스를 올리면 진단이 통째로 보인다. 배지 한 칸에는 하나밖에 못 담는다.
    tab.title = [
      p.dir,
      `훅: ${h.hooks ? '등록됨' : '없음 — 활동이 기록되지 않습니다'}`,
      `팀원: ${h.agents ? `${h.agents}명` : '없음 — 리드가 혼자 일합니다'}`,
      `CLAUDE.md: ${h.guide ? '있음' : '없음 — 담당 배분을 리드가 모릅니다'}`,
      `이벤트: ${p.exists ? '기록 중' : '아직 없음'}`,
    ].join('\n')

    const nm = document.createElement('span')
    nm.className = 'nm'
    nm.textContent = baseName(p.dir)

    // 다른 탭에서 서버가 돌고 있으면 여기서만 알 수 있다. 사무실은 한 번에 하나만
    // 보이므로, 옮겨 가 보지 않고는 무엇이 떠 있는지 알 방법이 없었다.
    const running = p.run?.running ? document.createElement('span') : null
    if (running) {
      running.className = 'st run'
      running.textContent = '▶'
      running.title = p.run.url ? `실행 중 — ${p.run.url}` : '실행 중 (주소 확인 중)'
    }

    // 배지 하나에 무엇을 담을지: **진행 중이면 진행을, 조용하면 왜 조용한지**를 보여준다.
    // 일하고 있는데 '팀원 없음'이 떠 있으면 지금 상태를 가린다.
    const st = document.createElement('span')
    const shut = p.company === 'closed' || p.company === 'foreign'
    const missing = !h.hooks ? '훅 없음' : !h.agents ? '팀원 없음' : !h.guide ? '지침 없음' : null
    if (shut) {
      st.className = 'st shut'
      st.textContent = p.company === 'foreign' ? '점유됨' : '닫힘'
    } else if (p.company === 'busy') {
      st.className = 'st busy'
      st.textContent = p.queued ? `처리 중 +${p.queued}` : '처리 중'
    } else if (p.queued) {
      st.className = 'st queued'
      st.textContent = `대기 ${p.queued}건`
    } else if (missing) {
      st.className = 'st shut'
      st.textContent = missing
    } else {
      st.className = 'st'
      st.textContent = '대기'
    }

    const x = document.createElement('button')
    x.className = 'x'
    x.type = 'button'
    x.title = '이 프로젝트를 뗍니다 (진행 중인 작업은 중단됩니다)'
    x.textContent = '×'
    x.addEventListener('click', async (e) => {
      e.stopPropagation() // 떼려다 탭이 선택되면 곤란하다
      // 진행 중인 작업이 죽는 동작이라 한 번 물어본다. 되돌릴 방법이 없다.
      if (p.company === 'busy' && !confirm(`${baseName(p.dir)}에서 작업이 돌고 있습니다. 떼면 중단됩니다. 계속할까요?`)) return
      chatLogs.delete(p.dir)
      await window.teamView.removeProject(p.dir)
    })

    tab.append(nm, ...(running ? [running] : []), st, x)
    // 탭은 div라서 그냥 두면 **키보드로 프로젝트를 바꿀 수 없다.** 버튼처럼 만든다.
    tab.tabIndex = 0
    tab.setAttribute('role', 'button')
    tab.setAttribute('aria-current', p.dir === active ? 'true' : 'false')
    const go = () => {
      if (p.dir === activeDir) return
      window.teamView.activateProject(p.dir)
    }
    tab.addEventListener('click', go)
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      go()
    })
    tabsEl.append(tab)
  }
  addBtn.disabled = projects.length >= max
  addBtn.title = addBtn.disabled
    ? `동시에 붙일 수 있는 프로젝트는 ${max}개까지입니다`
    : `프로젝트를 하나 더 붙입니다 (최대 ${max}개)`

  // 붙인 것이 하나도 없으면 사무실 대신 안내를 보여 준다. 상단 구석의 작은 배지와
  // 버튼만으로는 처음 여는 사람이 다음 걸음을 찾지 못했다.
  welcomeEl.hidden = projects.length > 0
  // 이름표까지 같이 떠 있으면 안내문 위로 흰 딱지 열한 개가 겹친다. 보낼 곳도 없는
  // 이름들이라 지금은 알려 줄 것이 없다.
  stageWrapEl.classList.toggle('empty', projects.length === 0)
}

async function attachProject() {
  const res = await window.teamView.addProject()
  if (!res?.ok) {
    if (!res?.canceled && res?.error) hintEl.textContent = res.error
    return
  }
  // **붙이는 자리에서 바로 갖추게 한다.** 예전에는 여기서 "빠졌습니다"라고 알리기만
  // 했고, 그러면 사람이 손으로 훅을 깔고 팀원을 넣어야 했다. 빈 폴더를 붙였다가
  // "지시를 보내도 아무 일도 안 일어난다"가 된 적이 있다.
  if (missingParts(res.health).length) await runSetup(res.dir, res.health)
  else hintEl.textContent = `${baseName(res.dir)} 붙였습니다 — 팀원 ${res.health.agents}명`
  // **되돌릴 수단은 붙이는 자리에서 묻는다.** 나중에 상단 버튼으로도 만들 수 있지만,
  // 첫 지시를 보내기 전이 아니면 이미 파일이 바뀐 뒤다.
  if (res.health?.git === false) await makeGit(res.dir, { fromAttach: true })
}

addBtn.addEventListener('click', attachProject)
welcomeAddEl.addEventListener('click', attachProject)

// ---------- 작업 취소 ----------
//
// 취소할 수 있는 건 **앱이 만든 것**뿐이다: 아직 안 집어간 대기열과, 앱이 띄운
// claude 프로세스. 이미 세션 안에서 돌고 있는 작업은 앱이 손댈 수 없다 —
// 그건 그 터미널에서 Esc로 멈춰야 한다. 그래서 결과를 사실대로 적어 준다.
cancelBtnEl.addEventListener('click', async (e) => {
  const btn = e.currentTarget
  btn.disabled = true
  // **이 프로젝트만** 취소한다. 다른 탭에서 돌고 있는 작업은 건드리지 않는다.
  const res = await window.teamView.cancelAll(activeDir)
  btn.disabled = false
  if (!res?.ok) {
    hintEl.textContent = `취소 실패: ${res?.error ?? '알 수 없는 오류'}`
    return
  }
  queuedFor.length = 0
  for (const a of agents.values()) a.queued = 0
  hintEl.textContent =
    res.queued || res.killed
      ? `취소됨 — 대기 ${res.queued}건${res.killed ? ` · 실행 ${res.killed}건 중단` : ''}`
      : '취소할 대기·실행이 없습니다 (이미 도는 세션은 그 터미널에서 Esc)'
  addMsg('sys', '', `— ${hintEl.textContent} —`)
})

// 도구 활동 접기/펴기 — 기록은 그대로 두고 보이는 것만 바꾼다.
document.getElementById('toggle-tools').addEventListener('click', (e) => {
  showTools = !showTools
  e.currentTarget.classList.toggle('on', showTools)
  e.currentTarget.title = showTools
    ? '파일 읽기·명령 실행 같은 도구 활동을 접습니다'
    : '도구 활동을 다시 폅니다 (기록은 지워지지 않았습니다)'
  redrawChat(activeDir)
})

// 앱 기록 열기 — 프로젝트가 없어도 쓸 수 있어야 한다(크래시는 그때도 난다).
document.getElementById('open-log').addEventListener('click', async () => {
  const res = await window.teamView.openLog()
  if (!res?.ok) hintEl.textContent = res?.error ?? '기록 파일을 열지 못했습니다'
})

// 대화 전체 복사 — 화면에 보이는 순서 그대로 텍스트로 뽑는다
document.getElementById('copy-all').addEventListener('click', (e) => {
  const lines = [...messagesEl.children].map((el) => el.dataset.plain ?? el.textContent)
  window.teamView.copyText(lines.join('\n'))
  const btn = e.currentTarget
  const before = btn.textContent
  btn.textContent = '복사됨'
  setTimeout(() => {
    btn.textContent = before
  }, 1200)
})

// ---------- 채팅 폭 조절 ----------
//
// 사무실을 크게 보고 싶을 때와 긴 답변을 읽을 때 필요한 폭이 다르다. 손잡이를
// 끌어서 바꾸고, 그 폭을 기억한다.

const chatEl = document.getElementById('chat')
const splitterEl = document.getElementById('splitter')
const CHAT_W_MIN = 280 // 이보다 좁으면 팀원 칩과 보내기 버튼이 겹친다
const CHAT_W_DEFAULT = 380

/** 창 크기에 맞춘 최대 폭. 사무실이 사라질 만큼 넓히지는 못하게 한다. */
function chatMax() {
  return Math.max(CHAT_W_MIN, Math.round(window.innerWidth * 0.7))
}

function setChatWidth(px, { save = true } = {}) {
  const w = Math.round(Math.min(chatMax(), Math.max(CHAT_W_MIN, px)))
  chatEl.style.flex = `0 0 ${w}px`
  chatEl.style.width = `${w}px`
  splitterEl.setAttribute('aria-valuenow', String(w))
  // 캔버스는 남는 자리를 채우므로 폭이 바뀌면 다시 잡아야 한다.
  resize()
  if (save) window.teamView.setChatWidth(w)
  return w
}

let dragFrom = null

splitterEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  dragFrom = { x: e.clientX, w: chatEl.getBoundingClientRect().width }
  // 포인터를 손잡이에 묶어 둔다. 안 그러면 빨리 끌 때 커서가 손잡이를 벗어나며
  // 드래그가 끊긴다. 붙잡지 못해도(이미 놓인 포인터 등) 드래그 자체는 되게 둔다 —
  // 여기서 예외가 나면 손잡이가 통째로 죽는다.
  try {
    splitterEl.setPointerCapture(e.pointerId)
  } catch {
    /* 못 붙잡아도 pointermove는 온다 */
  }
  splitterEl.classList.add('dragging')
  document.body.classList.add('resizing')
  e.preventDefault()
})

splitterEl.addEventListener('pointermove', (e) => {
  if (!dragFrom) return
  // 손잡이는 채팅 **왼쪽**에 있으므로 왼쪽으로 끌수록 채팅이 넓어진다.
  setChatWidth(dragFrom.w + (dragFrom.x - e.clientX), { save: false })
})

function endDrag(e) {
  if (!dragFrom) return
  dragFrom = null
  splitterEl.classList.remove('dragging')
  document.body.classList.remove('resizing')
  try {
    splitterEl.releasePointerCapture(e.pointerId)
  } catch {
    /* 이미 풀렸으면 그만 */
  }
  // 끄는 내내 저장하면 디스크를 계속 두드린다. 놓을 때 한 번만 남긴다.
  window.teamView.setChatWidth(Math.round(chatEl.getBoundingClientRect().width))
}

splitterEl.addEventListener('pointerup', endDrag)
splitterEl.addEventListener('pointercancel', endDrag)

// 더블클릭하면 기본 폭으로. 끌다가 이상해졌을 때 되돌릴 길이 있어야 한다.
splitterEl.addEventListener('dblclick', () => setChatWidth(CHAT_W_DEFAULT))

// 키보드로도 조절한다. 마우스로만 되는 조작은 못 쓰는 사람이 생긴다.
splitterEl.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 40 : 10
  const now = chatEl.getBoundingClientRect().width
  if (e.key === 'ArrowLeft') setChatWidth(now + step)
  else if (e.key === 'ArrowRight') setChatWidth(now - step)
  else if (e.key === 'Home') setChatWidth(CHAT_W_DEFAULT)
  else return
  e.preventDefault()
})

// 창이 좁아지면 채팅이 화면을 다 먹을 수 있다. 최대치를 다시 적용한다.
window.addEventListener('resize', () => {
  const now = chatEl.getBoundingClientRect().width
  if (now > chatMax()) setChatWidth(now)
})

// ---------- 되돌릴 수단 ----------
//
// 회사는 확인 없이 파일을 고치고 지운다(`bypassPermissions`). 한 작업에서 `rm -rf`가
// 여러 번 돌았다. git이 아니면 되돌릴 방법이 없는데, 그동안 앱은 확인조차 하지
// 않았다 — README에만 적혀 있었고 정작 붙여 둔 프로젝트 둘 다 git이 아니었다.

const gitBtn = document.getElementById('gitinit')

function renderGit(p) {
  gitBtn.hidden = !p || p.health?.git !== false
}

async function makeGit(dir, { fromAttach = false } = {}) {
  const name = baseName(dir)
  const ok = confirm(
    `${name}은(는) git 저장소가 아닙니다.\n\n` +
      `팀은 확인을 묻지 않고 파일을 만들고 고치고 지웁니다. 지금은 잘못돼도 되돌릴 방법이 없습니다.\n\n` +
      `git 저장소로 만들고 지금 상태를 첫 커밋으로 남길까요?\n` +
      `(.gitignore가 없으면 node_modules·.env를 제외하는 기본 파일을 함께 만듭니다)`,
  )
  if (!ok) {
    hintEl.textContent = fromAttach
      ? `${name}을 되돌릴 수단 없이 씁니다 — 상단 "⚠ 되돌릴 수 없음"에서 나중에 만들 수 있습니다`
      : ''
    return
  }
  gitBtn.disabled = true
  hintEl.textContent = 'git 저장소를 만드는 중…'
  const res = await window.teamView.gitInit(dir)
  gitBtn.disabled = false
  hintEl.textContent = res?.ok
    ? `${name} — ${(res.done ?? []).join(' · ')}`
    : `git 만들기 실패: ${res?.error ?? '알 수 없는 오류'}`
}

gitBtn.addEventListener('click', () => activeDir && makeGit(activeDir))

// ---------- 로컬 실행 ----------
//
// **앱이 서버를 든다.** 팀원에게 "실행시켜줘"라고 하면 그 세션 안에서 띄우는데,
// 지시가 끝나면 세션과 함께 죽는다(실측). 화면에서 켜고 끄면 그런 일이 없다.

const runBtn = document.getElementById('run')
const runUrlEl = document.getElementById('run-url')

function renderRun(p) {
  const r = p?.run
  // 띄우는 방법을 모르는 프로젝트(package.json에 dev·start가 없음)면 버튼도 없다.
  if (!r?.script) {
    runBtn.hidden = true
    runUrlEl.hidden = true
    return
  }
  runBtn.hidden = false
  runBtn.className = r.running ? 'on' : ''
  runBtn.textContent = r.running ? '■ 실행 중지' : `▶ 실행`
  runBtn.title = r.running
    ? `npm run ${r.script} 를 멈춥니다 · 오른쪽 클릭하면 실행 로그를 봅니다`
    : `npm run ${r.script} 로 띄웁니다 (앱이 관리하므로 지시가 끝나도 살아 있습니다)`

  // 주소는 자식이 뱉는 줄에서 주워 온다 — 포트를 우리가 정하지 않기 때문이다.
  const ready = r.running && r.url
  runUrlEl.hidden = !ready
  if (ready) {
    runUrlEl.textContent = r.url.replace(/^https?:\/\//, '')
    runUrlEl.title = `${r.url} 를 브라우저에서 엽니다`
  } else if (r.running) {
    runUrlEl.hidden = false
    runUrlEl.textContent = '준비 중…'
    runUrlEl.removeAttribute('title')
  }
  runUrlEl.dataset.url = ready ? r.url : ''
}

runBtn.addEventListener('click', async () => {
  const me = lastProjects.find((p) => p.dir === activeDir)
  if (!me) return
  runBtn.disabled = true
  const res = me.run?.running
    ? await window.teamView.runStop(activeDir)
    : await window.teamView.runStart(activeDir)
  runBtn.disabled = false
  if (!res?.ok) hintEl.textContent = res?.error ?? '실행에 실패했습니다'
})

// 실행이 죽으면 **화면에 이유를 띄운다.**
//
// 예전에는 코드만 로그 파일에 적고 모아 둔 출력을 통째로 버렸다. 앱에는 아무것도
// 뜨지 않아서, 버튼을 눌렀는데 아무 일도 안 일어난 것처럼 보였다.
// 지시를 처리하던 세션이 비정상 종료했을 때. 예전에는 로그 파일에만 남아서
// "보냈는데 아무 일도 안 일어났다"로만 보였다.
on('onCommandFailed', ({ dir, code, lines, why }) => {
  if (dir !== activeDir) return
  // **왜 실패했는지를 맨 앞에 크게 적는다.** 예전에는 "코드 1로 끝남"만 남아서,
  // 사용량 한도에 걸린 것을 세션 기록을 직접 뒤져야 알 수 있었다.
  const head = why?.label
    ? `⚠ 지시를 처리하지 못했습니다 — ${why.label}`
    : `⚠ 지시 처리가 코드 ${code}로 끝났습니다`
  const parts = [head]
  if (why?.message) parts.push(why.message)
  if (why?.hint) parts.push(why.hint)
  const tail = (lines ?? []).filter(Boolean).slice(-6).join('\n')
  if (tail) parts.push(tail)
  addMsg('warn', '실행', parts.join('\n\n'))
  hintEl.textContent = why?.label
    ? `${why.label} — 대화를 확인하세요`
    : '지시 처리가 실패했습니다 — 대화에 이유가 남았습니다'
})

on('onRunFailed', ({ dir, code, lines }) => {
  if (dir !== activeDir) return
  const tail = (lines ?? []).filter(Boolean).slice(-8).join('\n')
  addMsg('warn', '실행', `실행이 코드 ${code}로 끝났습니다${tail ? `\n\n${tail}` : ''}`)
  hintEl.textContent = '실행이 실패했습니다 — 대화에 이유가 남았습니다'
})

// 돌고 있는 서버의 출력을 본다. 실패했을 때는 대화에 뜨지만, **잘 돌고 있을 때의
// 로그**를 볼 방법이 없었다 — 컴파일 경고나 요청 기록은 여기에만 나온다.
// (IPC는 진작 만들어 두고 화면에서 한 번도 쓰지 않았다.)
runBtn.addEventListener('contextmenu', async (e) => {
  e.preventDefault()
  const me = lastProjects.find((p) => p.dir === activeDir)
  if (!me?.run?.running) return
  const res = await window.teamView.runLog(activeDir)
  const lines = (res?.lines ?? []).slice(-40)
  addMsg('sys', '', lines.length ? `— 실행 로그 (마지막 ${lines.length}줄) —\n${lines.join('\n')}` : '— 실행 로그가 비어 있습니다 —')
})

runUrlEl.addEventListener('click', (e) => {
  e.preventDefault()
  const u = runUrlEl.dataset.url
  if (u) window.teamView.openExternal(u)
})

// ---------- 결과물 패널 그리기 ----------

const outputsEl = document.getElementById('outputs')
const tabChatEl = document.getElementById('tab-chat')
const tabOutEl = document.getElementById('tab-out')
const outCountEl = document.getElementById('out-count')
let outView = false // 결과물 탭을 보고 있는가

function showPanel(out) {
  outView = out
  messagesEl.hidden = out
  outputsEl.hidden = !out
  tabChatEl.classList.toggle('sel', !out)
  tabOutEl.classList.toggle('sel', out)
  tabChatEl.setAttribute('aria-selected', String(!out))
  tabOutEl.setAttribute('aria-selected', String(out))
  // 도구 활동·전체 복사는 대화에만 걸리는 기능이다. 결과물을 보는 동안 눌러 봐야
  // 아무 일도 안 일어나므로 감춘다.
  toolsBtnEl.hidden = out
  copyAllEl.hidden = out
  if (out) renderOutputs()
}

tabChatEl.addEventListener('click', () => showPanel(false))
tabOutEl.addEventListener('click', () => showPanel(true))

/** 탭 배지 — 결과물이 몇 개 쌓였는지. 대화를 보는 중에도 알 수 있어야 한다. */
function refreshOutCount() {
  const n = outputCount()
  outCountEl.hidden = !n
  outCountEl.textContent = n ? ` ${n}` : ''
  if (outView) renderOutputs()
}

function renderOutputs() {
  outputsEl.replaceChildren()

  if (!activeDir) return outputsEl.append(emptyNote('프로젝트를 붙이면 여기에 결과가 쌓입니다.'))
  const live = runs.filter((r) => r.files.size || r.figma.size)
  if (!live.length) {
    return outputsEl.append(
      emptyNote('아직 만들어진 것이 없습니다. 지시를 보내면 팀이 만든 파일과 Figma 링크가 여기 모입니다.'),
    )
  }

  live.forEach((run, i) => {
    const box = document.createElement('section')
    box.className = 'out-run'

    const head = document.createElement('button')
    head.type = 'button'
    head.className = 'out-head'
    // 가장 최근 것만 펼쳐 둔다. 전부 펼치면 스크롤이 감당이 안 된다.
    let open = i === 0
    const caret = document.createElement('span')
    caret.className = 'caret'
    const title = document.createElement('span')
    title.className = 'out-title'
    title.textContent = run.text ? firstLine(run.text) : '(앱 밖에서 시작한 작업)'
    const meta = document.createElement('span')
    meta.className = 'out-meta'
    const bits = []
    if (run.files.size) bits.push(`파일 ${run.files.size}`)
    if (run.figma.size) bits.push(`Figma ${run.figma.size}`)
    meta.textContent = bits.join(' · ')
    head.append(caret, title, meta)

    // 이 지시가 시작되기 전 지점이 남아 있으면 되돌릴 수 있다.
    if (run.snap) head.append(undoBtn(run))

    const body = document.createElement('div')
    body.className = 'out-body'

    // 새로 만든 것을 위로. "뭐가 생겼나"가 "뭐가 바뀌었나"보다 먼저 궁금하다.
    const files = [...run.files.values()].sort(
      (a, b) => (a.kind === b.kind ? b.ts - a.ts : a.kind === '작성' ? -1 : 1),
    )
    for (const f of files) body.append(fileRow(f))
    for (const g of run.figma.values()) body.append(figmaRow(g))

    const sync = () => {
      body.hidden = !open
      caret.textContent = open ? '▾' : '▸'
      head.setAttribute('aria-expanded', String(open))
    }
    head.addEventListener('click', () => {
      open = !open
      sync()
    })
    sync()

    box.append(head, body)
    outputsEl.append(box)
  })
}

/**
 * 이 지시를 통째로 되돌리는 버튼.
 *
 * **무엇이 사라지는지 먼저 보여 준다.** 되돌리기가 오히려 작업을 날리면 최악이다 —
 * 지시 이후에 사람이 손으로 고친 것까지 함께 사라질 수 있다.
 */
function undoBtn(run) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'out-undo'
  b.textContent = '되돌리기'
  b.title = '이 지시를 시작하기 전 상태로 파일을 되돌립니다'
  b.addEventListener('click', async (e) => {
    e.stopPropagation() // 묶음이 접히지 않게
    b.disabled = true
    const dir = activeDir
    const d = await window.teamView.snapshotDiff(dir, run.snap)
    if (!d?.ok) {
      b.disabled = false
      hintEl.textContent = d?.error ?? '변경 내용을 읽지 못했습니다'
      return
    }
    if (!d.items.length) {
      b.disabled = false
      hintEl.textContent = '이 지시 이후 바뀐 파일이 없습니다'
      return
    }
    const add = d.items.filter((i) => i.status === 'A')
    const other = d.items.filter((i) => i.status !== 'A')
    const list = d.items.slice(0, 20).map((i) => `  ${i.status === 'A' ? '삭제됨' : '되돌림'}  ${i.path}`)
    const more = d.items.length > 20 ? `\n  … 외 ${d.items.length - 20}개` : ''
    const ok = confirm(
      `이 지시를 시작하기 전으로 되돌립니다.\n\n` +
        `새로 만들어진 ${add.length}개는 지워지고, 고쳐지거나 지워진 ${other.length}개는 되살아납니다.\n\n` +
        list.join('\n') +
        more +
        `\n\n지시 이후에 직접 고치신 내용이 있다면 그것도 함께 사라집니다. 계속할까요?`,
    )
    if (!ok) {
      b.disabled = false
      return
    }
    const res = await window.teamView.snapshotRestore(dir, run.snap)
    b.disabled = false
    hintEl.textContent = res?.ok
      ? `되돌렸습니다 — ${res.removed}개 삭제 · ${res.restored}개 복구 (되돌리기 직전 상태도 남겨 두었습니다)`
      : `일부 되돌리지 못했습니다: ${(res?.failed ?? []).slice(0, 3).join(', ')}`
    addMsg('sys', '', `— 되돌림: ${run.text ? firstLine(run.text) : '이전 지시'} —`)
  })
  return b
}

function emptyNote(text) {
  const p = document.createElement('p')
  p.className = 'out-empty'
  p.textContent = text
  return p
}

function firstLine(text) {
  const s = String(text).split('\n').find((l) => l.trim()) ?? ''
  return s.length > 64 ? s.slice(0, 64) + '…' : s
}

function fileRow(f) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'out-file'
  // 눌러서 무슨 일이 일어나는지 미리 밝힌다. 파일을 여는 줄 알고 눌렀다가
  // 탐색기가 뜨면 당황한다.
  row.title = `${f.path}\n눌러서 탐색기에서 보기`

  const mark = document.createElement('span')
  mark.className = `out-kind ${f.kind === '작성' ? 'new' : 'mod'}`
  mark.textContent = f.kind

  const name = pathCell(relPath(f.path, activeDir))

  const who = document.createElement('span')
  who.className = 'out-who'
  who.textContent = labelFor(f.agent) + (f.count > 1 ? ` · ${f.count}회` : '')

  row.append(mark, name, who)
  row.addEventListener('click', async () => {
    const res = await window.teamView.revealFile(f.path)
    // 팀이 만든 뒤 사람이 지웠거나 옮겼을 수 있다. 조용히 아무 일도 안 일어나면
    // 앱이 고장 난 것처럼 보인다.
    if (!res?.ok) hintEl.textContent = res?.error ?? '파일을 찾지 못했습니다'
  })
  return row
}

/** 경로를 폴더/이름으로 나눠 담는다. 좁아지면 폴더 쪽만 줄어든다. */
function pathCell(rel) {
  const cell = document.createElement('span')
  cell.className = 'out-path'
  const i = rel.lastIndexOf('/')
  if (i >= 0) {
    const dir = document.createElement('span')
    dir.className = 'out-dir'
    dir.textContent = rel.slice(0, i + 1)
    cell.append(dir)
  }
  const base = document.createElement('span')
  base.className = 'out-base'
  base.textContent = i >= 0 ? rel.slice(i + 1) : rel
  cell.append(base)
  return cell
}

function figmaRow(g) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'out-file figma'
  row.title = `${g.url}\n눌러서 브라우저에서 열기`

  const mark = document.createElement('span')
  mark.className = 'out-kind fig'
  mark.textContent = '🎨'

  const name = pathCell(g.url.replace(/^https:\/\/(www\.)?figma\.com\//, 'figma.com/'))

  const who = document.createElement('span')
  who.className = 'out-who'
  who.textContent = labelFor(g.agent)

  row.append(mark, name, who)
  row.addEventListener('click', () => window.teamView.openExternal(g.url))
  return row
}

/** 팀원 id를 화면에 쓰는 이름으로. 명단에 없으면 id를 그대로 쓴다. */
function labelFor(id) {
  return ROSTER.find((r) => r.id === id)?.label ?? String(id ?? '')
}

// ---------- 실행 환경 ----------
//
// 팀뷰는 Claude Code 위에서 도는 앱이다. claude가 없거나 로그인이 안 돼 있으면
// 지시를 보내도 **아무 일도 일어나지 않는다.** 그런데 화면상으로는 그냥 조용한
// 것과 구분되지 않아서 앱이 고장 난 줄 안다. 맨 위에서 먼저 말해 준다.
//
// 기획·화면설계는 Figma에 만들므로 Figma 연결도 같은 급으로 본다.

const envEl = document.getElementById('env')
const envMsgEl = document.getElementById('env-msg')
const envActEl = document.getElementById('env-act')
const envAgainEl = document.getElementById('env-again')
const connEl = document.getElementById('conn')

let lastEnv = null
// 확인 주기. 메인이 결과를 캐시하므로 대부분은 캐시가 답한다 —
// `claude mcp list`가 서버마다 헬스 체크를 해서 실제로 부를 때마다 몇 초 걸린다.
const ENV_POLL_MS = 60_000

/** 지금 가장 먼저 막고 있는 것 하나. 여러 개면 순서대로 하나씩 푼다. */
function envBlocker(env) {
  if (!env) return null
  if (!env.claude.installed) {
    return {
      msg: 'Claude Code가 설치되어 있지 않습니다 — 팀원이 일할 수 없습니다.',
      action: null, // 설치까지 앱이 대신하지는 않는다
      hint: 'npm i -g @anthropic-ai/claude-code',
    }
  }
  if (!env.claude.loggedIn) {
    return {
      msg: 'Claude에 로그인되어 있지 않습니다 — 지시를 보내도 처리되지 않습니다.',
      action: { what: 'claude', label: 'Claude 로그인' },
    }
  }
  if (!env.figma.connected) {
    return {
      msg: env.figma.present
        ? 'Figma 연결이 끊겼습니다 — 기획안·화면설계서를 만들 수 없습니다.'
        : 'Figma가 연결되지 않았습니다 — 기획안·화면설계서는 Figma에 만듭니다.',
      action: { what: 'figma', label: 'Figma 연결' },
    }
  }
  return null
}

/**
 * 연결 상태 두 줄. 배너와 달리 **문제가 없어도 보인다.**
 *
 * 배너만 두면 "지금 연결돼 있다"는 확인을 할 수 없다. 지시를 보내기 전에 눈으로
 * 확인하고 싶은 것이 바로 이 둘이라, 상단에 계속 켜 둔다.
 */
function connItems(env) {
  const c = env?.claude ?? {}
  const f = env?.figma ?? {}
  const claude = !c.installed
    ? { state: 'bad', text: 'Claude 미설치', title: 'claude CLI가 없습니다 — npm i -g @anthropic-ai/claude-code' }
    : !c.loggedIn
      ? { state: 'bad', text: 'Claude 로그아웃', title: '로그인해야 팀원이 일할 수 있습니다 (눌러서 로그인)' }
      : {
          state: 'ok',
          text: 'Claude',
          title: `로그인됨 — ${c.email ?? '계정 정보 없음'}${c.plan ? ` (${c.plan})` : ''}\n눌러서 상태를 다시 확인합니다`,
        }
  const figma = f.connected
    ? { state: 'ok', text: 'Figma', title: '연결됨 — 기획안·화면설계서를 만들 수 있습니다\n눌러서 상태를 다시 확인합니다' }
    : !c.loggedIn
      ? { state: 'off', text: 'Figma', title: 'Claude 로그인 후 확인할 수 있습니다' }
      : {
          state: 'warn',
          text: f.present ? 'Figma 인증 필요' : 'Figma 미연결',
          title: '기획안·화면설계서는 Figma에 만듭니다 (눌러서 연결)',
        }
  return [
    { key: 'claude', ...claude },
    { key: 'figma', ...figma },
  ]
}

function renderConn(env) {
  connEl.replaceChildren()
  for (const it of connItems(env)) {
    const el = document.createElement('span')
    el.className = `conn-item ${it.state}`
    el.title = it.title
    const led = document.createElement('span')
    led.className = 'led'
    el.append(led, document.createTextNode(it.text))
    // 문제가 있으면 누르는 순간 그걸 푸는 절차로, 정상이면 다시 확인으로 간다.
    const act = () => {
      if (it.state === 'ok' || it.state === 'off') recheckEnv()
      else startLogin(it.key)
    }
    // span이라 키보드로는 닿지 않았다. 상태를 확인하고 로그인까지 가는 통로라 열어 둔다.
    el.tabIndex = 0
    el.setAttribute('role', 'button')
    el.addEventListener('click', act)
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      act()
    })
    connEl.append(el)
  }
}

function renderEnv(env) {
  lastEnv = env
  renderConn(env)
  const block = envBlocker(env)
  // **설치 안내가 떠 있으면 배너를 겹쳐 띄우지 않는다.**
  //
  // claude가 없으면 설치 안내(무엇을 깔아야 하는지)와 이 배너(로그인하라)가 같은 말을
  // 두 번 하게 된다. 상태 점까지 세면 세 번이다. 실측하니 그 상태에서 화면 위쪽
  // 311px가 경고로만 채워졌다. 설치가 먼저이므로 그쪽에 자리를 내준다.
  const needShown = !needEl.hidden
  envEl.hidden = !block || needShown
  if (!block || needShown) return
  envMsgEl.textContent = block.hint ? `${block.msg}  (${block.hint})` : block.msg
  envActEl.hidden = !block.action
  if (block.action) {
    envActEl.textContent = block.action.label
    envActEl.dataset.what = block.action.what
  }
}

/** 상태를 다시 잰다. 재는 동안 점이 깜빡여 '멈춤'과 구분된다. */
async function recheckEnv() {
  for (const el of connEl.children) el.classList.add('checking')
  renderEnv(await window.teamView.checkEnv({ force: true }))
  // 설치를 마치고 돌아오는 길목이기도 하다 — 같이 다시 본다.
  recheckNeeds()
}

/**
 * 로그인/연결을 시작한다. 브라우저에서 사람이 마쳐야 하므로 앱은 창을 띄우고
 * **끝났는지 지켜본다** — 다 하고 나서 다시 눌러 보라고 하면 어디까지 됐는지 모른다.
 */
async function startLogin(what) {
  envActEl.disabled = true
  envAgainEl.disabled = true
  for (const el of connEl.children) el.classList.add('checking')
  envEl.hidden = false
  envMsgEl.textContent = '새 창이 열렸습니다 — 브라우저에서 로그인을 마치면 자동으로 이어집니다…'
  const res = await window.teamView.login(what)
  envActEl.disabled = false
  envAgainEl.disabled = false
  if (res?.ok) {
    renderEnv(res.env)
    hintEl.textContent = what === 'figma' ? 'Figma가 연결됐습니다' : 'Claude에 로그인했습니다'
    return
  }
  if (res?.manual) {
    renderEnv(lastEnv)
    envEl.hidden = false
    envMsgEl.textContent = `터미널에서 직접 실행하세요: ${res.manual}`
    return
  }
  renderEnv(res?.env)
  if (res?.timeout) {
    envEl.hidden = false
    envMsgEl.textContent += '  (아직 완료되지 않았습니다 — 끝났으면 "다시 확인")'
  }
}

envActEl.addEventListener('click', () => startLogin(envActEl.dataset.what))
envAgainEl.addEventListener('click', recheckEnv)

// ---------- 설치 안내 ----------
//
// 팀뷰는 앱만 있어서는 동작하지 않는다. claude CLI를 띄우고, 그 활동은 python 훅이
// 기록한다. 다른 PC에 exe만 옮기면 **화면은 뜨지만 아무 일도 일어나지 않는데**
// 무엇이 없어서인지 알 방법이 없다. 시작할 때 먼저 확인하고 설치를 돕는다.
//
// 설치는 남의 컴퓨터를 건드리는 일이라 **반드시 동의를 받는다.** 확인 창은 메인
// 프로세스가 띄우고(네이티브), 무엇을 왜 넣는지·어떤 명령이 도는지 그대로 보여 준다.

const needEl = document.getElementById('need')
const needListEl = document.getElementById('need-list')

function renderNeeds(reqs) {
  const missing = reqs.filter((r) => !r.installed)
  // 없는 게 없으면 아예 띄우지 않는다. 잘 돌 때 잔소리를 하지 않는다.
  if (!missing.length) {
    needEl.hidden = true
    return
  }
  needEl.hidden = false
  needListEl.replaceChildren()
  for (const r of reqs) {
    const row = document.createElement('div')
    row.className = 'need-row'

    const nm = document.createElement('span')
    nm.className = 'nm'
    nm.textContent = r.label

    const why = document.createElement('span')
    why.className = 'why'
    why.textContent = r.why
    if (r.optional) {
      const o = document.createElement('span')
      o.className = 'opt'
      o.textContent = '  (없어도 동작은 합니다)'
      why.append(o)
    }

    row.append(nm, why)
    if (r.installed) {
      const ok = document.createElement('span')
      ok.className = 'done'
      ok.textContent = `✔ ${r.version ?? '설치됨'}`
      row.append(ok)
    } else {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = r.canInstall ? '설치하기' : '다운로드'
      btn.addEventListener('click', async () => {
        btn.disabled = true
        const res = await window.teamView.install(r.key)
        btn.disabled = false
        if (res?.canceled) return
        if (!res?.ok) {
          hintEl.textContent = res?.manual
            ? `터미널에서 직접 실행하세요: ${res.manual}`
            : `설치를 시작하지 못했습니다: ${res?.error ?? '알 수 없는 오류'}`
          return
        }
        hintEl.textContent = res.started
          ? `새 창에서 설치 중입니다: ${res.cmd} — 끝나면 "다시 확인"`
          : '다운로드 페이지를 열었습니다 — 설치 후 "다시 확인"'
      })
      row.append(btn)
    }
    needListEl.append(row)
  }
}

document.getElementById('need-close').addEventListener('click', () => {
  needEl.hidden = true
})

async function recheckNeeds() {
  renderNeeds(await window.teamView.checkRequirements())
  // 안내가 사라졌다면 그동안 눌러 뒀던 배너가 다시 나올 자리다.
  if (lastEnv) renderEnv(lastEnv)
}

on('onEnv', renderEnv)
window.teamView.checkEnv().then(renderEnv)
recheckNeeds()
// 로그인이 풀리거나 Figma 연결이 끊기는 일은 앱 밖에서도 일어난다. 계속 지켜본다.
setInterval(() => window.teamView.checkEnv().then(renderEnv), ENV_POLL_MS)

renderTargets()
refreshObstacles()
resize()
requestAnimationFrame(loop)

// ---------- 죽었을 때를 대비해 ----------
//
// 화면이 죽으면 메인은 `crashed` 한 단어밖에 알 수 없다. 실제로 한 번 그렇게 남았고
// 아무것도 알아낼 수 없었다. **살아 있는 동안** 상태를 흘려 보내 둔다.

let eventsSeen = 0
let lastEventLabel = null
on('onEvents', ({ events }) => {
  eventsSeen += events?.length ?? 0
  const last = events?.[events.length - 1]
  if (last) lastEventLabel = `${last.type}${last.tool ? `/${last.tool}` : ''} · ${last.agent ?? '-'}`
})

const VITALS_MS = 20_000
setInterval(() => {
  window.teamView.vitals({
    messages: messagesEl.children.length,
    agents: agents.size,
    outputs: outputCount(),
    events: eventsSeen,
    lastEvent: lastEventLabel,
    // 크래시 원인이 메모리면 여기가 먼저 부푼다. 브라우저가 안 주면 없는 대로 둔다.
    heap: performance.memory?.usedJSHeapSize ?? null,
  })
}, VITALS_MS)

// 잡히지 않은 예외를 메인 로그로 보낸다. console-message로도 오지만 인자 형식이
// 버전마다 달라 예전에 통째로 놓친 적이 있다 — 두 길로 남긴다.
window.addEventListener('error', (e) => {
  window.teamView.reportError({
    message: e.message,
    source: e.filename,
    line: e.lineno,
    stack: e.error?.stack,
  })
})
window.addEventListener('unhandledrejection', (e) => {
  window.teamView.reportError({
    message: `처리되지 않은 거부: ${e.reason?.message ?? e.reason}`,
    stack: e.reason?.stack,
  })
})
