// 렌더 루프 + 이벤트→행동 매핑 + 채팅(전체/개별 지시).
//
// 움직임 규칙:
//   활성 = 자기 책상 앞으로 걸어가 타이핑 / 비활성 = 통로 쪽에서 쉼
// **화면의 움직임은 전부 실제 이벤트에서 나온다.** 가짜 활동은 만들지 않는다.

import { POSES, drawSprite } from './sprites.js'
import { buildAgents, applyTeam, agentOrCreate, labelOf, LEAD_ID, PRESET_SEATS, SEAT_COUNT } from './agents.js'
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
import {
  routeTo,
  interiorWallSegments,
  DOORWAYS,
  SPOTS,
  setObstacles,
  DOOR_LOUNGE_GX,
  WALL_LOUNGE_Y,
} from './layout.js'
// 첫 실행 설치 마법사. **로직은 전부 wizard.js에 있다** — 이 파일은 이미 4천 줄이고,
// 여기서 하는 일은 여닫는 진입점과 "떠 있는 동안 배너가 자리를 비우는 것"뿐이다.
import { initWizard, wizardIsOpen, openWizard } from './wizard.js'

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
  // **리드가 조용한 것은 대개 멈춘 게 아니라 기다리는 것이다.**
  //
  // 리드는 자기가 도구를 쓸 때만 이벤트를 낸다. 팀원에게 일을 맡긴 동안에는
  // 결과를 기다리기만 하므로 아무것도 남지 않는다. 팀원 하나가 30분씩 도는
  // 이 앱에서 5분 기준은 거의 항상 걸린다.
  //
  // 실측(daily, 지시 하나 109분): 리드가 5분 넘게 조용한 구간이 다섯 번,
  // 합계 102분 — 전체의 93%. 그리고 **다섯 번 모두 팀원이 일하는 중**이었다.
  // 한 번도 진짜로 멈춘 적이 없는데 화면에는 내내 `⚠ 응답 없음`이 떠 있었다.
  //
  // 정말 문제인 경우는 **아무도 일하지 않는데** 리드가 조용할 때뿐이다.
  const waitingOn = a.id === LEAD_ID ? teammatesWorking() : []
  const stalled = now - a.lastEventAt > STALL_MS && !waitingOn.length
  const waiting = a.id === LEAD_ID && waitingOn.length > 0 && thinking
  return {
    sec,
    quietFor,
    thinking,
    stalled,
    waitingOn,
    icon: stalled ? '⚠' : waiting ? '⏳' : thinking ? '⋯' : (a.act?.icon ?? '◆'),
    word: stalled ? '응답 없음' : waiting ? '기다리는 중' : thinking ? '생각 중' : (a.act?.word ?? '작업'),
  }
}

/** 지금 실제로 일하고 있는 팀원(리드 제외). 리드가 무엇을 기다리는지 알려면 필요하다. */
function teammatesWorking() {
  const out = []
  for (const a of agents.values()) {
    if (a.id === LEAD_ID || !a.active) continue
    out.push(a.label)
  }
  return out
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
  // 나가는 중인 사람도 같이 — 자기 책상이 사라진 지도를 들고 걷고 있다.
  for (const a of onStage()) {
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

// 해고돼서 **문으로 걸어 나가는 중**인 사람들. 명단(agents)에서는 이미 빠졌지만
// 화면에서는 아직 걷고 있다. 팝 하고 사라지면 무슨 일이 일어났는지 알 수 없다.
const leaving = new Map()

/** 지금 화면에 그려야 할 사람 전부(명단 + 나가는 중). */
const onStage = () => (leaving.size ? [...agents.values(), ...leaving.values()] : [...agents.values()])

// 사무실 출입문. 고용된 사람이 들어오고 해고된 사람이 나가는 자리다.
// 좌표를 여기 적지 않고 도면(layout.js)에서 가져온다 — 두 군데 적으면 어긋난다.
const DOOR = { gx: DOOR_LOUNGE_GX, gy: WALL_LOUNGE_Y }

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
// 프로젝트별 팀 명단 [{ id, scope, seat }]. **탭을 옮길 때 그 회사의 명단으로**
// 사무실을 세우려면 들고 있어야 한다 — 명단은 프로젝트마다 다르다.
const teamByDir = new Map()
// 메인의 CHAT_KEEP과 같은 값. 한 시간짜리 작업의 앞부분도 볼 수 있어야 한다.
const CHAT_KEEP = 1000

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
  while (log.length > CHAT_KEEP) log.shift()
  // **되살린 대화에 나온 사람도 칩에 나와야 한다.** 칩은 새로 말할 때만 다시
  // 그렸는데, 지난 대화를 불러오는 이 자리는 거기에 걸리지 않는다 — 실측: 901줄을
  // 되살렸는데 칩은 `전체 +11`뿐이었다(백엔드 305줄, 프론트 221줄이 들어 있었다).
  if (dir === activeDir) renderTargets()
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

// 지난 기록에만 남아 있는 이름을 담아 두는 곳. 명단에 없으므로 **화면에는 그리지
// 않지만**, 이벤트 처리는 그대로 돌려야 결과물·집계가 맞는다.
const ghosts = new Map()

/**
 * 이 이벤트의 주인공. 명단에 없으면 새로 만들어 앉히지만, **다시 읽는 기록이면
 * 만들지 않는다.**
 *
 * 해고한 팀원은 파일에서 사라져도 로그에는 그대로 남아 있다. 탭을 옮길 때마다
 * 그 기록이 통째로 재생되므로, 여기서 걸러 내지 않으면 **해고한 사람이 자리를 잡고
 * 되살아난다.** 지금 없는 사람을 그리는 것은 이 앱이 하지 않기로 한 일이다.
 * 반대로 실시간 이벤트는 그대로 만든다 — 진짜 일하고 있는 사람을 숨기면 안 된다.
 */
function actorFor(ev) {
  const id = ev.agent || LEAD_ID
  if (!ev._replay || agents.has(id)) {
    const known = agents.size
    const a = agentOrCreate(agents, id)
    // 명단에 없던 팀원이면 자리(책상·파티션)가 새로 생긴다 — 통행 격자를 다시 만든다
    if (agents.size !== known) refreshObstacles()
    return a
  }
  if (!ghosts.has(id)) ghosts.set(id, agentOrCreate(new Map(), id))
  return ghosts.get(id)
}

function applyEvent(ev) {
  collectOutput(ev) // 결과물 패널은 지난 기록에서도 쌓는다 — 켤 때마다 다시 세워야 한다
  const now = performance.now()
  // 인사 이벤트는 **일이 아니다.** 캐릭터를 만들지도, 작업 배지를 붙이지도 않는다.
  // 들어오고 나가는 연출은 명단(projects:status의 team)이 바뀔 때 한다 —
  // 그래야 앱에서 누른 경우와 밖에서 파일을 고친 경우가 같게 보인다.
  if (ev.type === 'hire' || ev.type === 'fire') {
    applyHireFire(ev)
    return
  }
  const agent = actorFor(ev)

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

// ---------- 고용·해고 ----------
//
// 명단이 바뀌는 길은 둘이다: 이 앱의 [팀원 관리]와, 사람이 직접 `.claude/agents/`를
// 고치는 것. **둘이 같게 보여야 한다** — 그래서 캐릭터가 들고 나는 연출은 명단
// (projects:status의 team)이 바뀔 때 하고, 이벤트는 채팅 한 줄만 맡는다.

// 방금 이 앱에서 처리한 인사. 같은 내용이 이벤트로 한 번 더 오므로 채팅에 두 줄이
// 되는 것을 막는다(앱에서 누른 쪽이 경로까지 적어 주므로 그쪽을 남긴다).
const selfActs = new Map()
const SELF_ACT_MS = 15_000

// 명단을 이미 세운 프로젝트. 첫 명단과 그 뒤의 변화를 가르는 표시다.
let teamAppliedFor = null

function notedSelf(type, id) {
  selfActs.set(`${type}:${id}`, Date.now())
}

function wasSelf(type, id) {
  const at = selfActs.get(`${type}:${id}`)
  return at != null && Date.now() - at < SELF_ACT_MS
}

/** 해고된 사람에게 보낸 대기 지시를 걷는다. 받을 사람이 없는 지시가 남으면 안 된다. */
function dropQueuedFor(id) {
  let n = 0
  for (let i = queuedFor.length - 1; i >= 0; i--) {
    if (queuedFor[i].id !== id) continue
    queuedFor.splice(i, 1)
    n++
  }
  const a = agents.get(id)
  if (a) a.queued = 0
  return n
}

function applyHireFire(ev) {
  const id = ev.agent
  if (!id) return
  if (ev.type === 'fire') dropQueuedFor(id)
  // 지난 기록을 다시 읽는 중이면 채팅에 또 쓰지 않는다(켤 때마다 쌓인다)
  if (ev._replay || wasSelf(ev.type, id)) return
  addMsg(
    'sys',
    '',
    ev.type === 'hire'
      ? `— ${nameWithId(id)} 합류 — 다음 지시부터 함께 일합니다 —`
      : `— ${nameWithId(id)} 해고 — 이 사람 앞으로 온 대기 지시는 리드가 받습니다 —`,
  )
}

/** 고용된 사람이 문으로 들어와 제 자리로 걸어간다. 자리에서 솟아나면 안 된다. */
function enterFromDoor(a, now) {
  a.gx = DOOR.gx
  a.gy = DOOR.gy
  a.pose = 'walk'
  a.seat = null
  a.goal = null
  a.path = null
  // **작업 배지는 붙이지 않는다** — 들어온 것은 일이 아니다. 배지(meta)는 active일
  // 때만 나오므로, 말풍선만 잠깐 띄우는 이 방법이 그 규칙을 그대로 지킨다.
  a.task = '오늘부터 함께합니다'
  a.lastEventAt = now
}

/** 해고된 사람이 자리에서 일어나 문으로 걸어 나간다. 팝 하고 사라지면 안 된다. */
function leaveThroughDoor(a, now) {
  a.active = false
  a.working = false
  a.queued = 0
  a.task = null
  a.act = null
  a.goal = null
  a.path = null
  a.plan = { kind: 'leave', dest: DOOR, until: now + 30_000, bubble: '그동안 감사했습니다' }
  leaving.set(a.id, a)
}

/** 나가는 사람을 화면에서 지운다. 이름표·말풍선도 같이 걷는다. */
function removeFromStage(a) {
  leaving.delete(a.id)
  const n = nodes.get(a.id)
  if (n) {
    n.tag.remove()
    n.bubble.remove()
    nodes.delete(a.id)
  }
  if (target === a.id) {
    // 없는 사람에게 지시를 보내고 있으면 안 된다.
    target = 'all'
    renderTargets()
  }
}

/**
 * 새 명단을 화면에 반영한다. **있는 사람은 객체를 살려 둔다** — 통째로 다시
 * 만들면 걸어가던 애니메이션도 말풍선도 대기 배지도 다 날아간다.
 */
function syncTeam(list) {
  if (!Array.isArray(list)) return
  const now = performance.now()

  // **처음 받은 명단은 인사가 아니다.** 앱은 명단을 알기 전까지 기본 팀을 세워 두는데,
  // 그것과 실제 명단의 차이를 고용·해고로 연출하면 켜자마자 없던 사람이 문으로
  // 걸어 나간다(실측: 켤 때마다 모바일·디버거가 퇴사했다). 그 회사의 첫 명단은
  // 그냥 그 회사의 모습이다 — 통째로 세우고 연출하지 않는다.
  if (teamAppliedFor !== activeDir) {
    teamAppliedFor = activeDir
    agents = buildAgents(list)
    leaving.clear()
    nodes.clear()
    overlay.replaceChildren()
    refreshObstacles()
    renderTargets()
    refreshTeam()
    return
  }

  const { added, removed } = applyTeam(agents, list)
  if (!added.length && !removed.length) return
  for (const a of added) enterFromDoor(a, now)
  for (const a of removed) {
    dropQueuedFor(a.id)
    leaveThroughDoor(a, now)
  }
  refreshObstacles() // 책상이 생기고 사라졌다 — 통행 격자를 다시 만든다
  renderTargets()
  refreshTeam() // 요약 줄(팀원 N명 · 자리 M칸)과 열려 있는 목록도 따라간다
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
  while (log.length > CHAT_KEEP) log.shift()
  // 처음 말하는 사람이면 칩에 자리를 내준다.
  if (item.agent && !chipIds.has(item.agent)) renderTargets()
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
  // 화면에 붙여 두는 줄. **기록은 CHAT_KEEP만큼 들고 있어도 여기서 잘리면 소용없다** —
  // 실측: 901줄이 저장돼 있는데 화면에는 200줄만 올라왔다.
  while (messagesEl.children.length > CHAT_KEEP) messagesEl.firstChild.remove()
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

// 접어 둔 팀원을 폈는지. 한 번 펴면 그 세션 동안은 계속 보인다.
let targetsOpen = false
// 지금 칩으로 나와 있는 팀원. 새로 말한 사람이 생기면 칩을 다시 그린다 —
// 칩을 시작할 때 한 번만 그렸더니 **아무도 안 나타났다**(실측: 전원이 접힘).
let chipIds = new Set()

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
      if (id === '__more') return // 접힌 팀원을 펴는 칩 — 고르는 칩이 아니다
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
    return b
  }
  mk('all', '전체', null)
  // **전원을 늘어놓지 않는다.** 열한 개가 두 줄을 차지해 대화를 밀어냈고, 그중
  // 여덟 명은 이 프로젝트에서 한 번도 말한 적이 없어 눌러도 빈 화면만 나왔다.
  // 말한 적 있는 사람과 지금 고른 사람만 두고, 나머지는 접는다.
  // 누구의 줄인지는 `agent`(id)에 있다. `who`는 "리드 · 답변"처럼 꾸며진 이름이라
  // 그대로 맞춰 보면 아무도 못 찾는다 — 실측에서 열한 명이 전부 접혔다.
  //
  // 명단은 **지금 회사에 있는 사람**이다. 고정 표(ROSTER)를 쓰면 해고한 사람이
  // 칩으로 남고, 새로 고용한 사람은 칩이 없어 고를 수 없다.
  const log = logFor(activeDir)
  const spoke = new Set(log.map((m) => m.agent).filter(Boolean))
  const named = (r) => log.some((m) => String(m.who ?? '').startsWith(r.label))
  const roster = [...agents.values()]
  const shown = roster.filter((r) => spoke.has(r.id) || named(r) || target === r.id)
  chipIds = new Set(shown.map((r) => r.id))
  const rest = roster.filter((r) => !shown.includes(r))
  for (const r of shown) mk(r.id, r.label, r.shirt)
  if (rest.length && !targetsOpen) {
    const more = mk('__more', `+${rest.length}`, null)
    more.classList.remove('sel')
    more.title = `아직 말하지 않은 팀원 ${rest.length}명을 폅니다`
    more.addEventListener('click', (e) => {
      e.stopPropagation()
      targetsOpen = true
      renderTargets()
    })
  } else if (rest.length) {
    for (const r of rest) mk(r.id, r.label, r.shirt)
  }
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

  // 나가는 중인 사람도 함께 움직인다. 명단에서는 이미 빠졌지만 아직 걷고 있다.
  for (const a of onStage()) {
    // **일하는 중인지는 이벤트 간격이 아니라 상태로 판단한다.**
    //
    // 예전에는 "마지막 이벤트 + 2.6초" 안에 있어야 일하는 중이었다. 그런데 긴 답을
    // 만드는 동안에는 도구 호출이 아예 없다 — 기획안을 쓰던 팀원이 2분 넘게 조용한
    // 적이 있고, 그동안 화면에서는 **모니터가 꺼진 채 앉아 있어** 멈춘 것처럼 보였다.
    // 시작(agent_start)과 끝(agent_stop) 사이면 일하는 중이 맞다. 리드는 시작
    // 이벤트가 없지만 첫 도구에서 active가 되고 세션이 쉬면 풀린다.
    const working = a.active
    a.working = working
    // 나가는 사람의 계획은 지우지 않는다 — 그 계획이 문까지 가는 길이다.
    // 다만 길이 막혀 시간이 다 되면 그때는 그냥 내보낸다(영원히 서 있지 않게).
    if (a.plan?.kind === 'leave') {
      if (now >= a.plan.until) removeFromStage(a)
    } else if (a.plan && (now >= a.plan.until || working)) {
      a.plan = null
    }

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
      if (a.plan.kind === 'leave') {
        removeFromStage(a) // 문에 닿았다 — 여기서 화면을 떠난다
        continue
      } else if (a.plan.kind === 'coffee') {
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
        // 리드가 기다리는 중이면 **무엇을 기다리는지** 적는다. "기다리는 중"만
        // 있으면 여전히 뭔가 잘못된 것처럼 읽힌다.
        if (w.waitingOn?.length) return `${a.label}(${w.waitingOn.join('·')} 결과 기다리는 중)`
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
  for (const a of onStage()) {
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
    // 앞(아래)에 선 사람일수록 위로. 선택한 팀원은 무조건 맨 위.
    // **작은 수로 충분하다** — `#overlay`가 쌓임 맥락을 만들어(styles.css) 이 숫자는
    // 사무실 안에서만 겨룬다. 예전의 100~9999는 밖으로 새어 나가 마법사를 뚫었다.
    it.tag.style.zIndex = String(target === it.a.id ? order.length + 1 : order.length - i)
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
  // 나가는 사람은 **사람만** 그린다. 자리는 이미 비었으므로 책상·의자는 없다.
  for (const a of leaving.values()) items.push({ kind: 'agent', d: depth(a.gx, a.gy), a })
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
  // **그 프로젝트의 명단으로** 세운다. 프로젝트마다 팀원이 다르므로 기본 팀으로
  // 세우면 탭을 옮기는 순간 해고한 사람이 잠깐 되살아난다.
  agents = buildAgents(teamByDir.get(dir))
  leaving.clear()
  ghosts.clear()
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
// ---------------------------------------------------------------------------
// 토큰 사용량
//
// **얼마나 썼는지 볼 방법이 없었다.** 한도에 걸려 일이 멈춘 뒤에야 알았고, 그때도
// "토큰 사용량 한도"가 전부였다. 오늘 얼마나 썼는지, 누가 많이 썼는지는 어디에도
// 없었다.
//
// 네 가지를 **합쳐서 하나로 보여 주지 않는다.** 실측에서 캐시 읽기가 1.25억,
// 출력이 75만이었다 — 다 더하면 "1억 3천만"이 되어 겁만 주고 실제와 어긋난다.
// 캐시 읽기는 같은 내용을 다시 보내지 않으려고 재사용한 양이라 성격이 다르다.
const usageSec = document.getElementById('usage-sec')
const usageBody = document.getElementById('usage-body')

/** 사람이 읽는 단위. 10,000 미만은 그대로, 그 위는 만·억으로. */
function fmtTokens(n) {
  const v = Math.max(0, Math.round(n || 0))
  if (v < 10_000) return v.toLocaleString('ko-KR')
  if (v < 100_000_000) return `${(v / 10_000).toFixed(v < 100_000 ? 1 : 0)}만`
  return `${(v / 100_000_000).toFixed(2)}억`
}

const USAGE_ROWS = [
  ['output', '출력', '팀이 써 낸 양'],
  ['input', '새 입력', '이번에 새로 보낸 양'],
  ['cacheWrite', '캐시 기록', '다음에 다시 쓰려고 저장한 양'],
  ['cacheRead', '캐시 읽기', '저장해 둔 것을 재사용한 양 — 새로 보낸 것이 아닙니다'],
]

let lastUsage = null

function renderUsage(usage) {
  lastUsage = usage
  const has = usage && (usage.total.output || usage.total.input || usage.total.cacheRead)
  usageSec.hidden = !has
  // 메뉴가 닫혀 있으면 다시 그릴 이유가 없다 — 300ms마다 표를 새로 만들 뻔했다.
  if (has && !menuPop.hidden) fillUsage()
}

function fillUsage() {
  const u = lastUsage
  usageBody.replaceChildren()
  if (!u) return

  const table = document.createElement('table')
  const head = document.createElement('tr')
  for (const t of ['', '이번 지시', '오늘', '전체']) {
    const th = document.createElement('th')
    th.textContent = t
    head.append(th)
  }
  table.append(head)
  for (const [key, label, why] of USAGE_ROWS) {
    const tr = document.createElement('tr')
    const name = document.createElement('td')
    name.textContent = label
    name.title = why
    tr.append(name)
    for (const src of [u.run, u.today, u.total]) {
      const td = document.createElement('td')
      td.className = 'num'
      td.textContent = src ? fmtTokens(src[key]) : '—'
      tr.append(td)
    }
    table.append(tr)
  }
  usageBody.append(table)

  if (u.agents?.length) {
    const h2 = document.createElement('h5')
    h2.textContent = '팀원별 (출력 기준, 전체)'
    usageBody.append(h2)
    const list = document.createElement('table')
    for (const a of u.agents) {
      if (!a.output) continue
      const tr = document.createElement('tr')
      const n = document.createElement('td')
      n.textContent = labelFor(a.name)
      const v = document.createElement('td')
      v.className = 'num'
      v.textContent = fmtTokens(a.output)
      tr.append(n, v)
      list.append(tr)
    }
    usageBody.append(list)
  }

  const note = document.createElement('p')
  note.textContent =
    '캐시 읽기는 같은 내용을 다시 보내지 않으려고 재사용한 양입니다. 새로 보낸 양과 성격이 달라 따로 셉니다.'
  usageBody.append(note)
}

// ---------------------------------------------------------------------------
// ☰ 메뉴
//
// 상단 바에 버튼 여섯 개와 상태 넷이 한 줄로 늘어서 있었다. 그중 매 순간 봐야 하는
// 것은 **탭·실행·지금 누가 일하는지** 셋뿐인데, 나머지가 그 사이에 끼어 정작 그
// 셋이 눈에 안 들어왔다. 자주 쓰지 않는 것을 여기로 옮긴다.
//
// **숨겼다고 놓치면 안 되는 것들이 있다** — 세팅이 빠졌거나, 되돌릴 수단이 없거나,
// Claude 연결이 끊긴 경우다. 그때는 ☰에 점을 붙여 열어 보게 만든다.
const menuBtn = document.getElementById('menu')
const menuPop = document.getElementById('menu-pop')
const menuDot = document.getElementById('menu-dot')

function toggleMenu(show) {
  const next = show ?? menuPop.hidden
  menuPop.hidden = !next
  menuBtn.setAttribute('aria-expanded', String(next))
  if (!next) return
  // 둘이 겹치면 뒤에 있는 것을 읽을 수 없다. ☰를 열면 팀원 패널은 자리를 비운다
  // (팀원 패널은 ☰ 안에서 열리므로 반대 방향은 서로를 부르는 길이다).
  toggleTeamPop(false)
  // 사용량 화면도 같은 이유로 자리를 내준다. ☰ 버튼은 바깥 클릭을 멈춰 세우므로
  // (stopPropagation) 사용량 쪽 바깥 클릭 감시로는 이 경우가 닫히지 않는다.
  toggleUsagePop(false)
  fillUsage()
  refreshTeam() // 요약 줄은 메뉴를 여는 순간이 가장 정확해야 한다
  // 지난번에 띄운 소식(오류·시간 초과)을 다음에 열 때까지 들고 있지 않는다.
  // 처리 중인지도 여는 순간이 가장 정확하다.
  showConnMsg('')
  renderConn(lastEnv)
  // 버튼 오른쪽 끝에 맞춰 아래로. 화면 밖으로 나가지 않게 민다.
  const r = menuBtn.getBoundingClientRect()
  menuPop.style.top = `${Math.round(r.bottom + 6)}px`
  const w = menuPop.offsetWidth || 320
  menuPop.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)))}px`
}

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  toggleMenu()
})
document.addEventListener('click', (e) => {
  if (!menuPop.hidden && !menuPop.contains(e.target)) toggleMenu(false)
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menuPop.hidden) {
    toggleMenu(false)
    menuBtn.focus()
  }
})

/** ☰에 점을 붙일 일이 있는가. 숨긴 것 중 **손봐야 하는 것**만 센다. */
function refreshMenuDot() {
  const need =
    !document.getElementById('setup').hidden ||
    !document.getElementById('gitinit').hidden ||
    !!envBlocker(lastEnv)
  menuDot.hidden = !need
  menuBtn.title = need ? '설정·상태·기록 — 손볼 것이 있습니다' : '설정·상태·기록'
}

// ---------------------------------------------------------------------------
// 상단 사용량 — 얼마나 남았나가 아니라 **무엇이 토큰을 먹었나**
//
// 여기에는 한때 게이지가 있었다. 실측 평균에서 임의로 뽑은 눈금(하루 1.5M / 주간 20M)을
// 분모로 세우고 '예산의 N%'라고 적었는데, 실제 Claude 화면과 맞대 보니 **재는 것 자체가
// 달랐다**:
//   기간   Claude는 5시간 롤링 세션 + 목요일 리셋 주간, 우리는 달력 하루 + 최근 7일
//   분모   Claude는 진짜 플랜 한도, 우리는 우리가 만들어 낸 눈금
//   대상   같은 날 실측이 출력 1.34M / 캐시 읽기 298.74M(223배)인데 우리는 출력만 셌다
// 그래서 세션 55%인 계정에 "일간 90%"가 떴다. 누가 봐도 한도 임박으로 읽힌다.
//
// 한도가 아닌 것을 한도처럼 보이게 만드는 것 — 이 앱이 하지 않기로 한 그것이다.
// 그래서 분모를 통째로 버렸다. 앱은 **센 값만** 주고(main.js에도 예산이 없다), 화면은
// 그 값을 숫자로 적는다. **퍼센트는 쓰지 않는다** — 분모 없는 퍼센트는 전부 한도로 읽힌다.
//
// 대신 Claude 화면에 **없는** 것을 준다: 캐시 읽기가 출력의 몇 배인가. 사용량을 줄이는
// 데 실제로 쓸모 있는 숫자는 그것 하나다(대화가 길수록 매 턴 다시 읽는 양이 불어난다).
//
// 값이 없으면(ready:false이거나 null) **0으로 그리지 않는다.** 0은 "안 썼다"는 거짓말이고,
// 그 거짓말이 제일 비싸다.
const usageBtnEl = document.getElementById('usage-btn')
const usageSumEl = document.getElementById('usage-sum')
const usageDotEl = document.getElementById('usage-dot')
const usagePopEl = document.getElementById('usage-pop')
const usagePlanEl = document.getElementById('usage-plan')
const usageStateEl = document.getElementById('usage-state')
const usageLimitEl = document.getElementById('usage-limit')
const usageNowEl = document.getElementById('usage-now')
const usageCacheEl = document.getElementById('usage-cache')
const usageCacheNoteEl = document.getElementById('usage-cache-note')
const usageSparkEl = document.getElementById('usage-spark')
const usageTrendNoteEl = document.getElementById('usage-trend-note')

// 사용량은 따로 묻는다. 상태(300ms)에 얹으면 그 주기로 디스크를 뒤지게 된다.
const USAGE_POLL_MS = 15_000

// 표에 세울 줄. **합계를 내지 않는다** — 캐시 읽기까지 더한 수는 겁만 주고 실제와 어긋난다.
const USAGE_NOW_ROWS = [
  ['output', '출력', '팀이 새로 써 낸 양'],
  ['cacheRead', '캐시 읽기', '앞의 대화를 매 턴 다시 읽어 들인 양 — 새로 보낸 것이 아닙니다'],
  ['msgs', '응답', '팀이 답한 횟수'],
]

let usageStats = null // 마지막으로 받은 getUsageStats 결과 (못 받았으면 null)

/** 숫자인가. null·undefined·NaN은 **0이 아니라 '모른다'**이다. */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 건수는 토큰이 아니다 — 만·억으로 줄이지 않고 자리수 그대로 적는다(1,114건). */
function fmtCount(n) {
  const v = num(n)
  return v === null ? '—' : Math.max(0, Math.round(v)).toLocaleString('ko-KR')
}

/** 남이 준 시각 문자열을 사람이 읽는 꼴로. 못 읽으면 null — 지어내지 않는다. */
function fmtWhen(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 'max' → 'Max'. 플랜 이름은 앱이 준 글자를 그대로 쓴다(사전에서 지어내지 않는다). */
function planLabel(plan) {
  const s = String(plan)
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** 캐시 읽기가 출력의 몇 배인가. 출력이 0이면 **배수는 없다**(나눌 수 없다). */
function cacheTimes(b) {
  const read = num(b?.cacheRead)
  const out = num(b?.output)
  if (read === null || out === null || out <= 0) return null
  return Math.round(read / out)
}

/**
 * 사용량을 다시 읽는다. **없는 통로여도 화면이 죽지 않는다** — preload가 화면보다 낡을
 * 수 있다(설치본을 덮어쓰다 만 경우). 값이 없으면 자리 자체를 비운다 — 빈 상자는
 * 정보가 아니라 잡음이다.
 */
async function refreshUsageStats() {
  const fn = window.teamView?.getUsageStats
  if (typeof fn !== 'function') {
    usageStats = null
    renderUsageBtn()
    return
  }
  try {
    const res = await fn()
    usageStats = res && typeof res === 'object' ? res : null
  } catch (err) {
    // 삼키지는 않되 상단 바에 오류를 띄우지도 않는다 — 사용량은 곁다리 정보라,
    // 못 읽었으면 자리를 비우는 편이 조용하고 정직하다.
    usageStats = null
    console.warn('[사용량] 읽지 못했습니다:', err?.message ?? err)
  }
  renderUsageBtn()
}

/** 상단 요약 한 줄. **막대도 퍼센트도 없다** — 오늘 쓴 양을 숫자로만 적는다. */
function renderUsageBtn() {
  const u = usageStats
  // 앱은 어떤 경우에도 사용량 객체를 준다(기록을 못 봤으면 `ready:false`). 그러니
  // 여기가 비는 것은 **통로가 없거나 못 읽었을 때뿐**이고, 그때는 자리를 비운다.
  usageBtnEl.hidden = !u
  if (!u) {
    if (!usagePopEl.hidden) toggleUsagePop(false)
    return
  }
  const out = u.ready ? num(u.today?.output) : null
  usageBtnEl.classList.toggle('pending', out === null)
  usageSumEl.textContent = out === null ? '집계 중' : `오늘 출력 ${fmtTokens(out)}`
  usageDotEl.hidden = !u.limitHit
  usageBtnEl.title = usageTitle(u)
  if (!usagePopEl.hidden) fillUsagePop()
}

/** 눌러 보기 전에 알아야 할 것을 툴팁에 담는다. **여기에도 한도라고 쓰지 않는다.** */
function usageTitle(u) {
  if (!u.ready) return '사용 기록을 아직 다 보지 못했습니다(집계 중) — 덜 센 숫자는 실제보다 적게 보여 비워 둡니다'
  const parts = []
  const out = num(u.today?.output)
  const read = num(u.today?.cacheRead)
  parts.push(out === null ? '오늘 얼마나 썼는지 아직 알 수 없습니다' : `오늘 출력 ${fmtTokens(out)}`)
  if (read !== null) parts.push(`캐시 읽기 ${fmtTokens(read)}`)
  parts.push('이 컴퓨터에 남은 기록을 세어 더한 값입니다 — 남은 한도가 아닙니다. 눌러서 자세히 보세요')
  if (u.limitHit) parts.push('전에 한도에 걸려 멈춘 기록이 있습니다')
  return parts.join(' · ')
}

/** 펼친 화면 전체. 여는 순간과 15초마다 다시 그린다. */
function fillUsagePop() {
  const u = usageStats
  if (!u) return

  usagePlanEl.hidden = !u.plan
  usagePlanEl.textContent = u.plan ? planLabel(u.plan) : ''

  usageStateEl.hidden = Boolean(u.ready)
  usageStateEl.textContent =
    '사용 기록을 아직 다 보지 못했습니다(집계 중). 덜 센 숫자를 보여 주면 실제보다 적게 보이므로 비워 둡니다.'

  const limit = limitText(u.limitHit)
  usageLimitEl.hidden = !limit
  usageLimitEl.textContent = limit

  fillUsageNow(u)
  fillUsageCache(u)
  fillUsageSpark(u)
}

/**
 * 얼마나 썼나 — **센 값 그대로**. 기간 이름을 정확히 적는다:
 * '오늘'은 달력 하루이고 '최근 7일'은 굴러가는 7일 합계다. Claude의 5시간 세션이나
 * 목요일 리셋 주간과는 다른 기간이라, 같은 이름을 쓰면 같은 것으로 읽힌다.
 */
function fillUsageNow(u) {
  usageNowEl.replaceChildren()
  const cols = [
    ['오늘', u.ready ? u.today : null, '달력으로 오늘 하루(자정~자정) 동안의 합계입니다'],
    ['최근 7일', u.ready ? u.week : null, '오늘을 포함해 굴러가는 7일 합계입니다 — 정해진 요일에 리셋되지 않습니다'],
  ]

  const table = document.createElement('table')
  const head = document.createElement('tr')
  head.append(document.createElement('th'))
  for (const [label, , why] of cols) {
    const th = document.createElement('th')
    th.textContent = label
    th.title = why
    head.append(th)
  }
  table.append(head)

  for (const [key, label, why] of USAGE_NOW_ROWS) {
    const tr = document.createElement('tr')
    const name = document.createElement('td')
    name.textContent = label
    name.title = why
    tr.append(name)
    for (const [, src] of cols) {
      const td = document.createElement('td')
      td.className = 'num'
      const v = num(src?.[key])
      // 모르는 값은 0이 아니라 '—'다. 0을 적으면 "안 썼다"가 된다.
      td.textContent = v === null ? '—' : key === 'msgs' ? `${fmtCount(v)}건` : fmtTokens(v)
      tr.append(td)
    }
    table.append(tr)
  }
  usageNowEl.append(table)
}

/**
 * 무엇이 토큰을 먹었나. **Claude 화면에 없는 숫자이고, 줄이는 데 유일하게 쓸모 있다.**
 * 실측에서 오늘 캐시 읽기가 출력의 223배였다 — "왜 이렇게 많이 썼지"의 답이 거기 있다.
 */
function fillUsageCache(u) {
  const b = u.ready ? u.today : null
  const read = num(b?.cacheRead)
  const times = cacheTimes(b)

  if (read === null) {
    usageCacheEl.hidden = true
    usageCacheEl.textContent = ''
    usageCacheNoteEl.textContent = '아직 세는 중입니다 — 다 세면 무엇이 토큰을 먹었는지 여기에 나옵니다.'
    return
  }
  usageCacheEl.hidden = false
  if (times !== null) {
    usageCacheEl.textContent =
      `캐시 읽기 ${fmtTokens(read)} — 오늘 새로 써 낸 출력(${fmtTokens(b.output)})의 ${times.toLocaleString('ko-KR')}배`
  } else if (read > 0) {
    usageCacheEl.textContent = `캐시 읽기 ${fmtTokens(read)} — 오늘 새로 써 낸 출력이 없어 견줄 수가 없습니다`
  } else {
    usageCacheEl.textContent = '오늘 오간 것이 아직 없습니다'
  }
  usageCacheNoteEl.textContent =
    read > 0
      ? '캐시 읽기는 대화가 길어질수록 매 턴 앞의 내용을 다시 읽어 들이는 양입니다. 새로 써 낸 양(출력)과는 성격이 다르지만, 실제로 오간 토큰의 대부분이 여기입니다. 줄이려면 대화를 새로 시작하거나 지시를 짧게 끊으세요.'
      : '대화를 시작하면 무엇이 토큰을 먹었는지 여기에 나옵니다.'
}

/** 한도에 걸렸던 기록. **없는 시각은 지어내지 않는다** — 못 읽으면 그 부분만 뺀다. */
function limitText(hit) {
  if (!hit) return ''
  const at = fmtWhen(hit.at)
  const reset = fmtWhen(hit.resetAt)
  const head = at ? `${at}에 사용 한도에 걸려 멈춘 적이 있습니다` : '사용 한도에 걸려 멈춘 적이 있습니다'
  if (!reset) return `${head}. 언제 풀리는지는 앱이 알지 못합니다.`
  const done = new Date(hit.resetAt).getTime() <= Date.now()
  return `${head} — ${reset}에 ${done ? '풀렸습니다' : '풀립니다'}.`
}

/** 그 날의 출력을 **아는가**. `partial`이거나 값이 null이면 모르는 날이다.
 *  0은 아는 날이다 — "안 썼다"는 어엿한 정보다. */
function dayKnown(d) {
  return Boolean(d) && d.partial !== true && num(d.output) !== null
}

/**
 * 최근 14일 추이. **오늘이 평소보다 많은지만 알면 된다** — 눈금과 숫자를 다 그리면
 * 좁은 팝오버에서 아무것도 안 읽힌다. 외부 차트 라이브러리는 쓰지 않는다.
 *
 * 이 차트의 규칙 하나: **0과 '모른다'를 같게 그리지 않는다.** 앱은 오래된 파일을 아예
 * 열지 않으므로 창 밖의 날은 안 쓴 것이 아니라 못 본 것이고(`partial`), 그 자리를 바닥
 * 막대로 그리면 "그 주에 놀았다"는 거짓 그림이 된다. 평균에도 넣지 않는다 — 가짜 0이
 * 섞이면 "평소의 2.4배" 같은 틀린 문장이 나온다.
 *
 * 기둥의 높이는 **그 기간에서 가장 많은 날**에 맞춘다. 견줄 분모(예산·한도)는 없다 —
 * 있는 척하려고 그은 선이 이 화면의 이전 판을 망쳤다.
 */
function fillUsageSpark(u) {
  usageSparkEl.replaceChildren()
  const days = u.ready && Array.isArray(u.days) ? u.days : []
  const known = days.filter(dayKnown)
  if (!days.length || !known.length) {
    usageSparkEl.removeAttribute('aria-label')
    usageTrendNoteEl.textContent = u.ready
      ? days.length
        ? '최근 기록을 아직 다 보지 못해 추이를 그릴 수 없습니다.'
        : '아직 쌓인 기록이 없습니다.'
      : '집계 중입니다 — 다 세면 여기에 추이가 나옵니다.'
    return
  }

  const vals = known.map((d) => num(d.output))
  const max = Math.max(...vals, 1)

  // 못 본 구간과 본 구간의 경계. **여기부터 기록을 다 보았다**는 표시가 없으면
  // 빈칸이 그저 "안 썼다"로 읽힌다.
  const firstKnown = days.findIndex(dayKnown)
  const unknownCount = days.length - known.length
  days.forEach((d, i) => {
    if (i === firstKnown && firstKnown > 0) {
      const edge = document.createElement('span')
      edge.className = 'usage-edge'
      edge.title = '여기부터는 기록을 다 보았습니다. 왼쪽은 앱이 열어 보지 않은 범위입니다.'
      edge.setAttribute('aria-hidden', 'true')
      usageSparkEl.append(edge)
    }
    const col = document.createElement('span')
    col.className = 'usage-day'
    if (!dayKnown(d)) {
      // 빈칸(빗금)이다. 0 높이 막대로 그리면 "안 썼다"가 된다.
      col.classList.add('unknown')
      col.title = `${d?.date ?? ''} 기록을 다 보지 못한 날입니다 — 얼마나 썼는지 알 수 없습니다`
      usageSparkEl.append(col)
      return
    }
    const v = num(d.output)
    if (i === days.length - 1) col.classList.add('today')
    col.style.height = `${Math.max(2, (v / max) * 100)}%`
    const msgs = num(d.msgs)
    col.title = `${d.date ?? ''} 출력 ${fmtTokens(v)}${msgs === null ? '' : ` · ${fmtCount(msgs)}건`}`
    usageSparkEl.append(col)
  })

  const lastDay = days[days.length - 1]
  const today = dayKnown(lastDay) ? num(lastDay.output) : null
  const past = vals.slice(0, today === null ? vals.length : -1)
  const unknownWord = unknownCount ? `, ${unknownCount}일은 기록을 다 보지 못해 비움` : ''
  usageSparkEl.setAttribute(
    'aria-label',
    `최근 ${days.length}일 출력 토큰 — 가장 많은 날 ${fmtTokens(Math.max(...vals))}` +
      (today === null ? '' : `, 오늘 ${fmtTokens(today)}`) +
      unknownWord,
  )

  const tail = unknownCount
    ? ` 앞의 ${unknownCount}일은 앱이 열어 보지 않은 범위라 비워 뒀습니다 — 안 쓴 것이 아니라 모르는 것입니다.`
    : ''
  if (today === null) {
    usageTrendNoteEl.textContent = `오늘 얼마나 썼는지는 아직 알 수 없습니다.${tail}`
    return
  }
  const avg = past.length ? past.reduce((a, b) => a + b, 0) / past.length : null
  if (avg === null || avg <= 0) {
    usageTrendNoteEl.textContent = `오늘 ${fmtTokens(today)} — 견줄 지난 기록이 아직 없습니다.${tail}`
    return
  }
  const ratio = today / avg
  const how = ratio >= 1.15 ? `평소의 ${ratio.toFixed(1)}배입니다` : ratio <= 0.85 ? '평소보다 적습니다' : '평소와 비슷합니다'
  // 평균은 **아는 날만** 센다. 그래서 "지난 13일"이 아니라 실제로 본 날 수를 적는다.
  usageTrendNoteEl.textContent =
    `오늘 ${fmtTokens(today)} · 기록을 본 지난 ${past.length}일 평균 ${fmtTokens(Math.round(avg))} — ${how}.${tail}`
}

function toggleUsagePop(show) {
  const next = show ?? usagePopEl.hidden
  // 볼 것이 없으면 열지 않는다 — 빈 상자가 뜨면 고장으로 보인다.
  usagePopEl.hidden = !next || !usageStats
  usageBtnEl.setAttribute('aria-expanded', String(!usagePopEl.hidden))
  if (usagePopEl.hidden) return
  // 겹치면 뒤에 있는 것을 읽을 수 없다. 둘 다 자리를 내준다.
  toggleMenu(false)
  toggleTeamPop(false)
  fillUsagePop()
  placeUsagePop()
  refreshUsageStats() // 여는 순간이 가장 정확해야 한다
  refreshSessionCost() // 지금 대화의 무게도 같은 순간의 것이어야 한다
}

/** 단추 오른쪽 끝에 맞춰 아래로. 화면 밖으로 나가지 않게 민다(☰와 같은 규칙). */
function placeUsagePop() {
  const r = usageBtnEl.getBoundingClientRect()
  usagePopEl.style.top = `${Math.round(r.bottom + 6)}px`
  const w = usagePopEl.offsetWidth || 340
  usagePopEl.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)))}px`
}

usageBtnEl.addEventListener('click', (e) => {
  e.stopPropagation() // 바깥 클릭으로 곧바로 닫히지 않게
  toggleUsagePop()
})

document.getElementById('usage-close').addEventListener('click', () => {
  toggleUsagePop(false)
  usageBtnEl.focus()
})

document.addEventListener('click', (e) => {
  if (!usagePopEl.hidden && !usagePopEl.contains(e.target)) toggleUsagePop(false)
})

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || usagePopEl.hidden) return
  toggleUsagePop(false)
  usageBtnEl.focus()
})

refreshUsageStats()
setInterval(() => {
  refreshUsageStats()
  // 대화 무게는 펼친 화면 안에서만 보인다. 닫혀 있는데 15초마다 물으면
  // 아무도 안 보는 숫자 때문에 앱이 기록을 계속 뒤지게 된다.
  if (!usagePopEl.hidden) refreshSessionCost()
}, USAGE_POLL_MS)

// ---------------------------------------------------------------------------
// 지금 대화가 얼마나 무거운가 · 새 대화로 갈아타기
//
// 프로젝트마다 대화(세션)가 **영구 고정**이었다. 갈아탈 길이 코드에 아예 없었고, 대화는
// 길어질수록 매 턴 앞 내용을 전부 다시 읽는다 — 즉 **같은 질문이 점점 비싸진다.**
// 실측(이 PC의 실제 세션):
//
//     insta-filter  198턴 · 첫 턴 0.02M → 마지막 턴 0.29M (14배)
//     shop           71턴 · 0.02M → 0.23M (11배)
//     같은 날 계정 전체: 출력 1.34M vs 캐시 읽기 298.74M
//
// 그래서 화면이 두 가지를 한다. **지금 대화가 얼마나 무거운지 보여 주고**, 무거우면
// **새로 시작할 길을 준다.** 위의 숫자들(오늘·최근 7일)은 이미 쓴 값이라 손쓸 수 없지만
// 이것 하나는 사용자가 지금 바꿀 수 있는 것이다.
//
// 규칙은 이 화면의 나머지와 같다:
//   · **퍼센트를 쓰지 않는다.** 분모 없는 퍼센트는 전부 한도로 읽힌다 — 배수(14배)로 적는다.
//   · **없는 숫자를 지어내지 않는다.** 기록이 없으면(null) 0으로 그리지 않고 없다고 적고,
//     첫 턴 값이 없으면(firstRead null) 배수 자체를 적지 않는다(0으로 나눌 수 없다).
//   · **묻지 않고 갈아타지 않는다.** 맥락이 끊기는 일이라 무엇이 끊기고 무엇이 남는지
//     먼저 보여 준다. 특히 옛 대화 기록 파일은 앱이 그대로 보관한다 — 그 사실을 모르면
//     아무도 이 버튼을 누르지 않는다.
//
// 앱이 주는 것(계약): { turns, firstRead, lastRead, growth, heavy, sizeBytes } | null
//   firstRead·lastRead·growth는 **null일 수 있다**(첫 턴이 0이면 잴 수 없다).
//   기록이 하나도 없으면 값 자체가 null이다.
const sesSecEl = document.getElementById('usage-ses-sec')
const sesLineEl = document.getElementById('usage-ses')
const sesNoteEl = document.getElementById('usage-ses-note')
const sesNewEl = document.getElementById('usage-ses-new')
const sesConfirmEl = document.getElementById('ses-confirm')
const sesWhyEl = document.getElementById('ses-why')
const sesHandoffEl = document.getElementById('ses-handoff')
const sesErrEl = document.getElementById('ses-err')
const sesGoEl = document.getElementById('ses-go')
const sesCancelEl = document.getElementById('ses-cancel')

let sessionCost = null // 마지막으로 받은 getSessionCost 결과 (기록이 없으면 null)
let sessionKnown = false // 한 번이라도 물어서 답을 받았는가 (통로가 없으면 영영 false)
let sessionSwitching = false // 갈아타는 중 — 두 번 누르면 세션이 두 번 갈린다

/** 파일 크기. "기록은 지워지지 않는다"는 말에 무게를 싣는 숫자라 사람이 읽는 꼴로 적는다. */
function fmtBytes(n) {
  const v = num(n)
  if (v === null || v < 0) return null
  if (v < 1024) return `${Math.round(v)}B`
  if (v < 1024 * 1024) return `${Math.round(v / 1024).toLocaleString('ko-KR')}KB`
  return `${(v / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * 대화 무게를 다시 읽는다. **없는 통로여도 화면이 죽지 않는다**(사용량과 같은 규칙) —
 * 못 읽었으면 자리를 통째로 비운다. 빈 상자는 정보가 아니라 잡음이다.
 */
async function refreshSessionCost() {
  const fn = window.teamView?.getSessionCost
  if (typeof fn !== 'function') {
    sessionKnown = false
    sessionCost = null
    renderSession()
    return
  }
  try {
    const res = await fn()
    // **null과 객체는 다른 뜻이다.** null은 "기록이 없다"이고, 여기서 0을 지어내면
    // "안 썼다"가 된다. 객체가 아닌 것이 오면 모르는 것으로 본다.
    sessionCost = res && typeof res === 'object' ? res : null
    sessionKnown = true
  } catch (err) {
    sessionKnown = false
    sessionCost = null
    console.warn('[대화 무게] 읽지 못했습니다:', err?.message ?? err)
  }
  renderSession()
}

function renderSession() {
  sesSecEl.hidden = !sessionKnown
  if (!sessionKnown) return
  const c = sessionCost
  // 무거우면 **눈에 띄어야 한다.** 흐린 한 줄로 두면 정작 갈아타야 할 사람이 못 본다.
  sesSecEl.classList.toggle('heavy', Boolean(c?.heavy))
  sesNewEl.classList.toggle('ses-primary', Boolean(c?.heavy))
  sesLineEl.textContent = sessionLine(c)
  const note = sessionNote(c)
  sesNoteEl.textContent = note
  sesNoteEl.hidden = !note
  // 지금 못 하는 것은 감추지 않고 죽인다 — 이유는 위의 한 줄(note)에 이미 적혀 있다.
  const block = newSessionBlocker()
  sesNewEl.disabled = Boolean(block)
  sesNewEl.title = block || '이 프로젝트의 대화를 새로 시작합니다 — 누르면 무엇이 끊기고 무엇이 남는지 먼저 보여 드립니다'
}

/** 한 줄 요약. **모르는 값은 적지 않는다** — 빠진 자리에 0을 넣으면 거짓말이 된다. */
function sessionLine(c) {
  if (!c) return '아직 기록이 없습니다 — 이 프로젝트에서 오간 대화를 아직 보지 못했습니다.'
  const parts = []
  const turns = num(c.turns)
  const last = num(c.lastRead)
  if (turns !== null) parts.push(`응답 ${fmtCount(turns)}개`)
  if (last !== null) parts.push(`질문 하나에 ${fmtTokens(last)}씩 다시 읽습니다${growthText(c)}`)
  if (!parts.length) return '이 대화가 얼마나 무거운지는 아직 알 수 없습니다.'
  return `이 대화: ${parts.join(' · ')}`
}

/**
 * 처음의 몇 배인가. **첫 턴 값이 없으면 배수도 없다** — 0으로는 나눌 수 없고,
 * 나눈 척하면 화면에 Infinity나 NaN이 그대로 뜬다. 퍼센트가 아니라 배수로 적는다.
 */
function growthText(c) {
  const g = num(c.growth)
  const first = num(c.firstRead)
  if (g === null || g <= 0 || first === null || first <= 0) return ''
  return ` (처음의 ${g >= 10 ? Math.round(g).toLocaleString('ko-KR') : g.toFixed(1)}배)`
}

/** 그 아래 한 줄. 지금 못 하는 이유가 있으면 **누르기 전에** 그것부터 적는다. */
function sessionNote(c) {
  const block = newSessionBlocker()
  if (block) return block
  if (c?.heavy) {
    return '이 대화는 이미 무겁습니다 — 새 대화를 시작하면 다시 읽는 양이 처음 값으로 줄어듭니다. 옛 대화 기록은 지워지지 않습니다.'
  }
  return '대화가 길어지면 매 턴 앞 내용을 다시 읽어 같은 질문이 점점 비싸집니다. 그때 새로 시작하면 그 양이 처음으로 돌아갑니다.'
}

/**
 * 지금 새로 시작할 수 없는 이유. **돌고 있는 작업은 여기서 막지 않는다** — 막을지는
 * 앱이 정하고(거절하면 이유를 준다), 화면이 미리 짐작해서 막으면 앱과 다른 말을 하게 된다.
 */
function newSessionBlocker() {
  if (!activeDir) return '붙인 프로젝트가 없어 시작할 대화가 없습니다.'
  if (!sessionCost) return '아직 새로 시작할 대화가 없습니다 — 첫 지시를 보내면 여기에 무게가 나옵니다.'
  if (sessionSwitching) return '새 대화를 시작하는 중입니다…'
  return ''
}

/** 확인 창을 연다. **여는 것으로는 아무 일도 일어나지 않는다** — 고르는 것은 사람이다. */
function openSesConfirm() {
  if (sesNewEl.disabled) return
  // 뒤에 겹쳐 두면 뒤엣것을 읽을 수 없다. 사용량 화면이 자리를 내준다(☰와 같은 규칙).
  toggleUsagePop(false)
  sesWhyEl.textContent = sesWhyText()
  sesErrEl.textContent = ''
  sesErrEl.hidden = true
  sesGoEl.disabled = false
  sesCancelEl.disabled = false
  sesGoEl.textContent = '새 대화 시작'
  sesConfirmEl.hidden = false
  sesHandoffEl.focus()
}

function closeSesConfirm() {
  if (sessionSwitching) return // 갈아타는 중에 닫으면 어디까지 됐는지 알 수 없다
  sesConfirmEl.hidden = true
  // 왔던 자리로 돌려놓는다 — 이 창은 사용량 화면 안에서 열렸다. 그냥 닫아 버리면
  // 무엇을 보다가 눌렀는지 사라져서, 갈아탄 뒤의 무게(또는 거절)도 확인할 수 없다.
  usageBtnEl.focus()
  toggleUsagePop(true)
}

/** 무엇을 갈아타는지 · 지금이 얼마나 무거운지 · **기록은 그대로 남는지.** */
function sesWhyText() {
  const who = activeDir ? baseName(activeDir) : '이 프로젝트'
  const now = sessionCost ? ` 지금 ${sessionLine(sessionCost).replace(/^이 대화: /, '')}.` : ''
  const size = fmtBytes(sessionCost?.sizeBytes)
  const keep = size ? ` 지금까지 쌓인 기록 ${size}는 지워지지 않고 그대로 남습니다.` : ''
  return `${who}의 대화를 새로 시작합니다.${now}${keep}`
}

/**
 * 실제로 갈아탄다. 여기까지 오는 길은 **확인 창의 [새 대화 시작] 하나뿐이다.**
 *
 * 거절당하면(`{ok:false, reason}`) 앱이 준 이유를 **그대로** 적고 창을 닫지 않는다 —
 * 적어 둔 메모까지 사라지면 다시 쓰라는 말이 된다.
 */
async function startNewSession() {
  if (sessionSwitching) return
  const handoff = sesHandoffEl.value.trim()
  sessionSwitching = true
  sesGoEl.disabled = true
  sesCancelEl.disabled = true
  sesGoEl.textContent = '시작하는 중…'
  sesErrEl.hidden = true

  const res = await callBridge('startNewSession', { handoff })

  sessionSwitching = false
  sesGoEl.disabled = false
  sesCancelEl.disabled = false
  sesGoEl.textContent = '새 대화 시작'

  if (!res?.ok) {
    // 문구는 앱이 준 것을 그대로. 우리가 보태는 것은 "그래서 지금 어떻게 되는지"뿐이다.
    const why = res?.reason || res?.error || '새 대화를 시작하지 못했습니다'
    sesErrEl.textContent = `${why} — 지금 대화는 그대로입니다. 나중에 다시 눌러 보세요.`
    sesErrEl.hidden = false
    return
  }

  closeSesConfirm()
  // 기록에는 **메모 내용을 적지 않는다** — 사람이 쓴 글이고 채팅 기록은 파일로 남는다.
  addMsg('sys', '', handoff ? '— 새 대화를 시작했습니다 (인수인계 메모를 넘겼습니다) —' : '— 새 대화를 시작했습니다 —')
  sesHandoffEl.value = ''
  refreshSessionCost()
}

sesNewEl.addEventListener('click', openSesConfirm)
sesCancelEl.addEventListener('click', closeSesConfirm)
sesGoEl.addEventListener('click', startNewSession)

// 이 창은 화면 맨 위에 뜬다. 안에서 누른 것이 **아래 화면의 '바깥 클릭' 감시에 닿으면**
// 안 된다 — 확인 창을 닫으며 되돌려 놓은 사용량 화면이 그 클릭에 곧바로 다시 닫힌다.
sesConfirmEl.addEventListener('click', (e) => e.stopPropagation())

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || sesConfirmEl.hidden) return
  closeSesConfirm()
})

// ---------------------------------------------------------------------------
// 팀원 관리 (고용·해고)
//
// 명단은 `.claude/agents/*.md` 파일 그 자체다. 고용은 정의를 그 폴더에 놓는 것이고
// 해고는 **지우는 게 아니라 옮기는 것**이다 — 사람이 고쳐 둔 정의가 사라지면
// 되살릴 수단이 없다. 그래서 해고는 물어보고, 고용은 묻지 않는다(되돌리기 쉽다).
//
// 조작은 전부 ☰ 안에서 한다. 상단 바와 사무실 화면은 "지금 누가 일하는지"를 보는
// 자리라 인사 기능이 낄 곳이 아니다.

const teamSumEl = document.getElementById('team-sum')
const teamManageEl = document.getElementById('team-manage')
const teamPop = document.getElementById('team-pop')
const teamDirEl = document.getElementById('team-dir')
const teamBusyEl = document.getElementById('team-busy')
const teamNowEl = document.getElementById('team-now')
const teamNowHeadEl = document.getElementById('team-now-h')
const teamAvailEl = document.getElementById('team-avail')
const teamAvailHeadEl = document.getElementById('team-avail-h')
const teamNewBtn = document.getElementById('team-new')
const teamFormEl = document.getElementById('team-form')

// 해고한 정의를 보관하는 곳. **메인의 FIRED_DIRNAME과 같아야 한다** — 확인 창에
// 어디로 옮기는지 적기 위해서만 쓴다(실제 경로는 처리한 뒤 응답에서 받아 적는다).
const FIRED_DIR_HINT = '.claude/team-fired/'

let teamInfo = null // 마지막으로 읽은 listTeam 결과
let teamErr = '' // 명단을 못 읽었을 때의 이유
let teamLoadedFor = null // 명단을 읽어 둔 프로젝트(같은 것을 300ms마다 다시 읽지 않게)
let teamBusySeen = false // 마지막으로 그린 '처리 중' 상태

/**
 * 메인 통로를 부른다. **없는 통로여도 화면이 죽지 않는다** — preload가 앱보다 낡을 수
 * 있고(설치본을 덮어쓰다 만 경우, 메인이 아직 그 통로를 안 만든 경우), 그때 예외가
 * 나면 여기서 화면이 통째로 멈춘다.
 */
async function callBridge(name, ...args) {
  const fn = window.teamView?.[name]
  if (typeof fn !== 'function') {
    return { ok: false, error: '이 기능은 앱을 다시 켠 뒤에 쓸 수 있습니다 (연결 통로가 없습니다)' }
  }
  try {
    return (await fn(...args)) ?? { ok: false, error: '응답이 없습니다' }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/** 이름과 id를 같이 적는다. 이름이 곧 id면 한 번만. */
function nameWithId(id) {
  const label = labelFor(id)
  return label === id ? id : `${label}(${id})`
}

async function refreshTeam() {
  if (!activeDir) {
    teamInfo = null
    teamErr = ''
    renderTeamUi()
    return
  }
  const res = await callBridge('listTeam', activeDir)
  teamInfo = res?.ok ? res : null
  teamErr = res?.ok ? '' : (res?.error ?? '명단을 읽지 못했습니다')
  renderTeamUi()
}

function renderTeamUi() {
  renderTeamSummary()
  renderWelcomeCount()
  renderTeamPanel()
}

/**
 * 첫 화면의 "팀원 N명". 손으로 적어 두면 명단이 바뀌는 지금은 금방 거짓말이 된다.
 *
 * 여기서 세는 것은 **세팅이 넣어 주는 기본 팀원 수**다. 카탈로그를 쓰지 않는 이유가
 * 둘 있다: 이 안내는 프로젝트가 하나도 없을 때만 뜨므로 그때는 카탈로그가 아예 없고,
 * 카탈로그에는 해고자와 그 프로젝트에서 직접 만든 팀원까지 섞여 있어 "새 폴더에
 * 넣어 줄 사람 수"와 다르다(실측: 카탈로그 14 · 실제 템플릿 10).
 */
function renderWelcomeCount() {
  document.getElementById('welcome-n').textContent = String(PRESET_SEATS.length)
}

/** 자리를 차지하는 사람들. 리드는 자기 자리가 따로라 여기 세지 않는다. */
function seatedMembers() {
  return (teamInfo?.members ?? []).filter((m) => m.id !== LEAD_ID)
}

function freeSeats() {
  if (!teamInfo) return null
  if (Number.isInteger(teamInfo.free)) return teamInfo.free
  return Math.max(0, (teamInfo.capacity ?? SEAT_COUNT) - seatedMembers().length)
}

/** ☰ 안의 한 줄 요약. 여기까지가 평소에 보이는 전부다. */
function renderTeamSummary() {
  teamManageEl.disabled = !activeDir
  if (!activeDir) {
    teamSumEl.textContent = '프로젝트를 붙이면 팀원을 고용할 수 있습니다'
    return
  }
  if (!teamInfo) {
    teamSumEl.textContent = teamErr || '명단을 읽는 중…'
    return
  }
  const free = freeSeats()
  teamSumEl.textContent = `팀원 ${seatedMembers().length}명 · 자리 ${free}칸 남음`
}

/** 팝오버 위치 — ☰ 버튼 아래, 오른쪽 끝에 맞춰. 화면 밖으로 나가지 않게 민다. */
function placeTeamPop() {
  const r = menuBtn.getBoundingClientRect()
  teamPop.style.top = `${Math.round(r.bottom + 6)}px`
  const w = teamPop.offsetWidth || 400
  teamPop.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)))}px`
}

function toggleTeamPop(show) {
  const next = show ?? teamPop.hidden
  teamPop.hidden = !next
  teamManageEl.setAttribute('aria-expanded', String(next))
  if (!next) return
  placeTeamPop()
  refreshTeam()
}

teamManageEl.addEventListener('click', (e) => {
  e.stopPropagation() // 바깥 클릭으로 곧바로 닫히지 않게
  toggleMenu(false) // ☰는 자리를 내준다 — 둘이 겹치면 뒤에 있는 것을 읽을 수 없다
  toggleTeamPop(true)
})

document.getElementById('team-close').addEventListener('click', () => {
  toggleTeamPop(false)
  teamManageEl.focus()
})

document.addEventListener('click', (e) => {
  if (!teamPop.hidden && !teamPop.contains(e.target)) toggleTeamPop(false)
})

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || teamPop.hidden) return
  toggleTeamPop(false)
  teamManageEl.focus()
})

/** 이 프로젝트가 지금 지시를 처리하는 중인가. 탭 배지와 같은 값을 본다. */
function teamBusyNow() {
  return Boolean(teamInfo?.busy) || lastProjects.find((p) => p.dir === activeDir)?.company === 'busy'
}

/** 지금 팀 구성을 바꿀 수 없는 이유. 없으면 빈 문자열. */
function teamBlockReason() {
  if (!activeDir) return '프로젝트를 먼저 붙이세요'
  if (!teamInfo) return teamErr
  // 처리 중에 팀원 파일이 바뀌면 그 세션이 무엇을 들고 있는지 알 수 없게 된다.
  if (teamBusyNow()) return '지금 지시가 돌고 있습니다 — 끝나거나 취소한 뒤에'
  return ''
}

function renderTeamPanel() {
  if (teamPop.hidden) return // 닫혀 있으면 다시 그릴 이유가 없다
  teamDirEl.textContent = activeDir ? baseName(activeDir) : ''
  teamDirEl.title = activeDir ?? ''

  const blocked = teamBlockReason()
  teamBusyEl.hidden = !blocked
  teamBusyEl.textContent = blocked

  const members = seatedMembers()
  const free = freeSeats()
  teamNowHeadEl.textContent = `지금 일하는 사람 (${members.length})`
  teamAvailHeadEl.textContent =
    free === 0 ? '고용할 수 있는 사람 — 자리가 없습니다' : '고용할 수 있는 사람'

  teamNowEl.replaceChildren()
  if (!members.length) {
    teamNowEl.append(teamNote(teamInfo ? '팀원이 없습니다 — 리드가 혼자 일합니다' : '명단을 읽지 못했습니다'))
  }
  for (const m of members) teamNowEl.append(memberRow(m, blocked))

  // 이미 팀에 있는 사람은 뺀다 — 위 목록과 같은 줄이 두 번 보이면 헷갈린다.
  const pool = (teamInfo?.catalog ?? []).filter((c) => c.state !== 'employed')
  teamAvailEl.replaceChildren()
  if (!pool.length) {
    teamAvailEl.append(teamNote('더 부를 사람이 없습니다 — 아래에서 직접 만들 수 있습니다'))
  }
  for (const c of pool) teamAvailEl.append(catalogRow(c, blocked, free))

  // 자리가 없으면 만들기도 막힌다. 이유는 버튼 옆이 아니라 머리에 이미 적혀 있다.
  document.getElementById('ta-make').disabled = Boolean(blocked) || free === 0
  teamNewBtn.disabled = Boolean(blocked) || free === 0
}

function teamNote(text) {
  const p = document.createElement('p')
  p.className = 'team-empty'
  p.textContent = text
  return p
}

/** 목록 한 줄의 뼈대. 서버·파일에서 온 값은 전부 textContent로만 넣는다. */
function teamRow({ mark, id, desc, on = false }) {
  const row = document.createElement('div')
  row.className = `team-row${on ? ' on' : ''}`

  const mk = document.createElement('span')
  mk.className = 'mk'
  mk.textContent = mark
  mk.setAttribute('aria-hidden', 'true')

  const who = document.createElement('span')
  who.className = 'who'
  const nm = document.createElement('span')
  nm.className = 'nm'
  nm.textContent = labelFor(id)
  const idEl = document.createElement('span')
  idEl.className = 'id'
  idEl.textContent = id
  who.append(nm, idEl)

  const d = document.createElement('p')
  d.className = 'desc'
  d.textContent = desc

  row.append(mk, who, d)
  return row
}

function memberRow(m, blocked) {
  const live = agents.get(m.id)
  const row = teamRow({
    mark: live?.active ? '●' : '○',
    id: m.id,
    desc: m.fireable
      ? m.desc || '(설명이 없는 팀원 정의입니다)'
      : `${m.desc || ''}${m.desc ? ' · ' : ''}전역 팀원 — 여기서는 해고할 수 없습니다`.trim(),
    on: Boolean(live?.active),
  })
  if (!m.fireable) return row // 전역 팀원: 이 프로젝트 밖의 것이라 여기서 건드리지 않는다

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'act'
  btn.textContent = '해고'
  btn.title = blocked || `${m.id} 정의를 보관함으로 옮깁니다 (지우지 않습니다)`
  btn.disabled = Boolean(blocked)
  btn.addEventListener('click', () => doFire(m))
  row.append(btn)
  return row
}

function catalogRow(c, blocked, free) {
  const back = c.state === 'fired'
  const bits = []
  if (c.desc) bits.push(c.desc)
  // 도구 목록이 비어 있는 것은 **"도구 없음"이 아니라 "제한 없음"**이다
  // (정의에 tools를 안 쓰면 전부 물려받는다). 없다고 적으면 거짓말이 된다.
  bits.push(c.tools?.length ? c.tools.join(', ') : '도구 제한 없음')
  if (back) bits.push('해고한 사람 — 그때 파일 그대로 돌아옵니다')
  const row = teamRow({ mark: back ? '↩' : '+', id: c.id, desc: bits.join(' · ') })

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'act'
  btn.textContent = back ? '복직' : '고용'
  btn.disabled = Boolean(blocked) || free === 0
  btn.title = blocked || (free === 0 ? '자리가 없습니다 — 먼저 누군가를 해고하세요' : `${c.id}을(를) 팀에 넣습니다`)
  btn.addEventListener('click', () => doHire(c))
  row.append(btn)
  return row
}

/** 고용은 **묻지 않는다** — 파일 한 장이 생길 뿐이고 해고로 곧바로 되돌릴 수 있다. */
async function doHire(c) {
  const res = await callBridge('hireAgent', activeDir, c.id)
  if (!res?.ok) {
    teamBusyEl.hidden = false
    teamBusyEl.textContent = res?.error ?? '고용하지 못했습니다'
    if (res?.busy || res?.full) refreshTeam()
    return
  }
  notedSelf('hire', res.id)
  addMsg(
    'sys',
    '',
    `— ${nameWithId(res.id)} ${res.from === 'fired' ? '복직' : '고용'} — ${res.path}` +
      `${res.from === 'fired' ? ' (해고 전 정의 그대로입니다)' : ''} · 다음 지시부터 함께 일합니다 —`,
  )
  refreshTeam()
}

/**
 * 해고는 **묻고 나서** 한다. 파일을 옮기는 일이고, 사람이 고쳐 둔 정의가 걸려 있다.
 * 무엇이 어디로 가는지·되돌리면 어떻게 되는지·보낸 지시는 어떻게 되는지를 그대로 적는다.
 */
async function doFire(m) {
  const waiting = queuedFor.filter((q) => q.id === m.id).length
  const ok = confirm(
    `${nameWithId(m.id)}을(를) 해고합니다.\n\n` +
      `  지금 파일   ${m.file ?? `${activeDir}\\.claude\\agents\\${m.id}.md`}\n` +
      `  옮길 곳     ${activeDir}\\${FIRED_DIR_HINT.replace(/\//g, '\\')}${m.id}.md\n\n` +
      `· 지우지 않고 옮기기만 합니다 — 복직하면 이 파일이 그대로 돌아옵니다.\n` +
      // **취소가 아니라 리드에게 넘기는 것**이다(메인의 requeueToLead). 실제 동작과
      // 다른 말을 확인 창에 적으면, 그 자리에서 사용자가 잘못된 판단을 하게 된다.
      `· 이 사람 앞으로 온 대기 지시는 취소되지 않고 리드가 받습니다` +
      `${waiting ? ` (앱에서 보낸 것 ${waiting}건)` : ''}.\n` +
      `· 이미 돌고 있는 지시는 건드리지 않습니다. 바뀐 명단은 다음 지시부터 반영됩니다.`,
  )
  if (!ok) return
  const res = await callBridge('fireAgent', activeDir, m.id)
  if (!res?.ok) {
    teamBusyEl.hidden = false
    teamBusyEl.textContent = res?.error ?? '해고하지 못했습니다'
    if (res?.busy) refreshTeam()
    return
  }
  notedSelf('fire', res.id)
  dropQueuedFor(res.id)
  addMsg(
    'sys',
    '',
    `— ${nameWithId(res.id)} 해고 — ${res.movedTo}로 옮겼습니다` +
      // 몇 건이 넘어갔는지는 **메인이 실제로 고쳐 쓴 수**(requeued)를 그대로 적는다.
      `${res.requeued ? ` · 이 사람 앞으로 온 대기 지시 ${res.requeued}건은 리드가 받습니다` : ''}` +
      ` · 복직하면 이 파일이 그대로 돌아옵니다 —`,
  )
  refreshTeam()
}

// ---------- 직접 만들기 ----------
//
// 카탈로그에 없는 팀원을 이 프로젝트에만 둔다. 파일 이름이 되는 값이라 id는
// 소문자·숫자·하이픈만 받고, **틀린 값은 그 입력 바로 아래에** 적는다 —
// 화면을 옮겨 가며 무엇이 틀렸는지 찾게 하지 않는다.

const TA_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const taFields = {
  id: document.getElementById('ta-id'),
  label: document.getElementById('ta-label'),
  desc: document.getElementById('ta-desc'),
}

function taError(which, text) {
  const el = document.getElementById(which === 'form' ? 'ta-err' : `ta-${which}-err`)
  el.hidden = !text
  el.textContent = text ?? ''
}

function clearTaErrors() {
  for (const which of ['id', 'label', 'desc', 'form']) taError(which, '')
}

/**
 * 서버가 준 한 줄짜리 이유를 **가장 그럴듯한 입력 아래로** 보낸다.
 * 응답에는 어느 칸이 틀렸는지가 없다(이유 한 줄뿐이다). 이유가 방금 적은 id를
 * 그대로 부르는 경우가 많아서(`data-analyst은(는) 이미 팀에 있습니다`) 그것도 본다.
 */
function showCreateError(msg, id) {
  const text = String(msg ?? '만들지 못했습니다')
  if (/\bid\b/i.test(text) || (id && text.includes(id))) return taError('id', text)
  if (/설명|무슨 일/.test(text)) return taError('desc', text)
  taError('form', text)
}

teamNewBtn.addEventListener('click', () => {
  const open = teamFormEl.hidden
  teamFormEl.hidden = !open
  teamNewBtn.setAttribute('aria-expanded', String(open))
  if (open) taFields.id.focus()
})

teamFormEl.addEventListener('submit', async (e) => {
  e.preventDefault()
  clearTaErrors()
  const id = taFields.id.value.trim().toLowerCase()
  const label = taFields.label.value.trim()
  const description = taFields.desc.value.trim()
  // 서버도 같은 것을 검사하지만(그쪽이 진짜다), 여기서 먼저 걸러야 어느 칸이
  // 틀렸는지 알려 줄 수 있다 — 서버 응답에는 이유 한 줄만 온다.
  if (!id) return taError('id', 'id를 적어주세요')
  if (!TA_ID_RE.test(id)) return taError('id', '영문 소문자·숫자·하이픈만 쓸 수 있습니다 (예: data-analyst)')
  if (!description) return taError('desc', '무슨 일을 하는 팀원인지 한 줄로 적어주세요')

  const tools = [...teamFormEl.querySelectorAll('#ta-tools input:checked')].map((el) => el.value)
  const btn = document.getElementById('ta-make')
  btn.disabled = true
  const res = await callBridge('createAgent', activeDir, { id, label, description, tools })
  btn.disabled = false
  if (!res?.ok) {
    if (res?.code === 'VALIDATION') showCreateError(res.error, id)
    else taError('form', res?.error ?? '만들지 못했습니다')
    if (res?.busy || res?.full) refreshTeam()
    return
  }
  notedSelf('hire', res.id)
  addMsg(
    'sys',
    '',
    `— ${label || res.id}(${res.id}) 합류 — ${res.path}` +
      `${res.basedOn ? ` (${res.basedOn} 정의를 본으로 삼았습니다)` : ''} · 역할에 맞게 그 파일을 고쳐 쓰면 됩니다 —`,
  )
  teamFormEl.reset()
  teamFormEl.hidden = true
  teamNewBtn.setAttribute('aria-expanded', 'false')
  refreshTeam()
})

on('onStatus', ({ projects, activeDir: active, max, chatWidth, usage, team }) => {
  renderUsage(usage)
  if (!widthApplied && chatWidth) {
    widthApplied = true
    setChatWidth(chatWidth, { save: false }) // 방금 읽은 값을 도로 저장할 이유가 없다
  }
  activeDir = active
  lastProjects = projects
  renderTabs(projects, active, max)

  // 명단은 **활성 프로젝트 것만** 온다. 못 받았으면(옛 메인) 지금 명단을 그대로 둔다.
  if (Array.isArray(team) && active) {
    teamByDir.set(active, team)
    syncTeam(team)
  }
  // 프로젝트를 처음 보거나 옮겼을 때 한 번만 읽는다. 상태는 300ms마다 오므로
  // 그때마다 디스크를 뒤지게 하면 안 된다.
  if (active && teamLoadedFor !== active) {
    teamLoadedFor = active
    refreshTeam()
  }
  // 처리 중이 되고 풀리는 것은 **열려 있는 목록의 버튼을 살리고 죽인다.**
  if (teamPop.hidden) teamBusySeen = teamBusyNow()
  else if (teamBusySeen !== teamBusyNow()) {
    teamBusySeen = teamBusyNow()
    renderTeamPanel()
  }
  // 계정 바꾸기도 같다 — 작업이 시작되면 죽고, 끝나면 살아나야 한다.
  refreshConnBusy()

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
  refreshMenuDot() // 숨긴 것 중 손볼 게 생겼는지 ☰에 알린다
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
  // 빠진 건 없지만 **팀원 정의가 앱보다 낡은** 경우. 윤사무실을 고쳐도 이미 세팅된
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
      // 여기서도 주소만 보고 "돌고 있다"고 하지 않는다 — 살아 있는지 확인된 뒤에만.
      running.title = p.run.dead
        ? '실행 중이지만 서버가 죽었습니다'
        : p.run.ready && p.run.url
          ? `실행 중 — ${p.run.url}`
          : '실행 중 (주소 확인 중)'
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

  refreshWelcome()
}

/**
 * 붙인 것이 하나도 없으면 사무실 대신 안내를 보여 준다. 상단 구석의 작은 배지와
 * 버튼만으로는 처음 여는 사람이 다음 걸음을 찾지 못했다.
 *
 * **설치 마법사가 떠 있는 동안만 자리를 비운다** — 지우지는 않는다. 마법사를
 * 건너뛴 사람과 이미 쓰던 사람에게는 이 길이 그대로 남아 있어야 한다.
 */
function refreshWelcome() {
  const none = lastProjects.length === 0
  welcomeEl.hidden = !none || wizardIsOpen()
  // 이름표까지 같이 떠 있으면 안내문 위로 흰 딱지 열한 개가 겹친다. 보낼 곳도 없는
  // 이름들이라 지금은 알려 줄 것이 없다.
  stageWrapEl.classList.toggle('empty', none)
}

/** 폴더를 골라 붙인다. **붙였는지 여부를 돌려준다** — 마법사가 그걸 보고 다음으로 넘어간다. */
async function attachProject() {
  const res = await window.teamView.addProject()
  if (!res?.ok) {
    if (!res?.canceled && res?.error) hintEl.textContent = res.error
    return false
  }
  // **붙이는 자리에서 바로 갖추게 한다.** 예전에는 여기서 "빠졌습니다"라고 알리기만
  // 했고, 그러면 사람이 손으로 훅을 깔고 팀원을 넣어야 했다. 빈 폴더를 붙였다가
  // "지시를 보내도 아무 일도 안 일어난다"가 된 적이 있다.
  if (missingParts(res.health).length) await runSetup(res.dir, res.health)
  else hintEl.textContent = `${baseName(res.dir)} 붙였습니다 — 팀원 ${res.health.agents}명`
  // **되돌릴 수단은 붙이는 자리에서 묻는다.** 나중에 상단 버튼으로도 만들 수 있지만,
  // 첫 지시를 보내기 전이 아니면 이미 파일이 바뀐 뒤다.
  if (res.health?.git === false) await makeGit(res.dir, { fromAttach: true })
  return true
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
  refreshMenuDot()
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
  //
  // **주소를 본 것과 서버가 사는 것은 다르다.** 예전에는 주소가 보이는 순간 링크를
  // 내줬는데, 실측(08-02 12:52:47)에서 vite가 주소를 찍고 곧바로 죽었다. 앱은 그
  // 4분 25초 동안 눌러도 열리지 않는 링크를 "실행 준비됨"으로 들고 있었다.
  // 이제 메인이 짧게 지켜본 뒤에만 `ready`를 준다.
  const ready = r.running && r.url && r.ready
  runUrlEl.hidden = !r.running
  if (ready) {
    runUrlEl.className = ''
    runUrlEl.textContent = r.url.replace(/^https?:\/\//, '')
    runUrlEl.title = `${r.url} 를 브라우저에서 엽니다`
  } else if (r.running && r.dead) {
    // 확인되지 않은 것을 확인된 것처럼 보여 주지 않는다. 프로세스는 남아 있어도
    // 서버가 죽었으면 그렇게 적는다.
    runUrlEl.className = 'dead'
    runUrlEl.textContent = '서버가 죽었습니다'
    runUrlEl.title = '주소를 내놓은 뒤 죽었습니다 — 오른쪽 클릭으로 실행 로그를 보세요'
  } else if (r.running && r.url) {
    runUrlEl.className = ''
    runUrlEl.textContent = '확인 중…'
    runUrlEl.title = `${r.url} 을 찾았습니다 — 살아 있는지 확인하는 중입니다`
  } else if (r.running) {
    runUrlEl.className = ''
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
  //
  // **기다릴 일과 손볼 일을 가른다.** 실측(08-02 08:13:58): 사유는 로그에
  // `토큰 사용량 한도: … resets 6:50pm (Asia/Seoul)`로 남았는데 결과는 `코드 1`이었다.
  // 고쳐야 하는 실패와 똑같이 보여서, 망가진 것이 없는데도 원인을 찾아 나서게 된다.
  // 풀리는 시각은 그 문구 안에 이미 있다 — 사용자가 정말 알고 싶은 값이다.
  const head = why?.wait
    ? `⏳ 지금은 처리할 수 없습니다 — ${why.label}` +
      (why.resetAt ? `\n${why.resetAt}에 풀립니다. 그때 다시 보내세요.` : '')
    : why?.label
      ? `⚠ 지시를 처리하지 못했습니다 — ${why.label}`
      : `⚠ 지시 처리가 코드 ${code}로 끝났습니다`
  const parts = [head]
  if (why?.message) parts.push(why.message)
  if (why?.hint) parts.push(why.hint)
  const tail = (lines ?? []).filter(Boolean).slice(-6).join('\n')
  if (tail) parts.push(tail)
  // 기다리면 되는 일은 경고가 아니다 — 빨간 줄로 남기면 매번 무엇이 터진 줄 안다.
  addMsg(why?.wait ? 'sys' : 'warn', '실행', parts.join('\n\n'))
  hintEl.textContent = why?.wait
    ? `${why.label}${why.resetAt ? ` — ${why.resetAt}에 풀립니다` : ' — 풀린 뒤 다시 보내세요'}`
    : why?.label
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

/** 팀원 id를 화면에 쓰는 이름으로. 지금 명단에 있으면 그 이름, 없으면 사전(→id). */
function labelFor(id) {
  return agents.get(id)?.label ?? labelOf(id)
}

// ---------- 실행 환경 ----------
//
// 윤사무실은 Claude Code 위에서 도는 앱이다. claude가 없거나 로그인이 안 돼 있으면
// 지시를 보내도 **아무 일도 일어나지 않는다.** 그런데 화면상으로는 그냥 조용한
// 것과 구분되지 않아서 앱이 고장 난 줄 안다. 맨 위에서 먼저 말해 준다.
//
// 기획·화면설계는 Figma에 만들므로 Figma 연결도 같은 급으로 본다.

const envEl = document.getElementById('env')
const envMsgEl = document.getElementById('env-msg')
const envActEl = document.getElementById('env-act')
const envAgainEl = document.getElementById('env-again')
const connEl = document.getElementById('conn')
const connNoteEl = document.getElementById('conn-note')
const connCopyEl = document.getElementById('conn-copy')
const connRecheckEl = document.getElementById('conn-recheck')

let lastEnv = null
// 계정 줄에 붙는 한 줄 소식(바꾸는 중 생긴 오류·시간 초과). 상태가 60초마다 다시
// 그려지므로 화면 밖에 들고 있어야 살아남는다. 메뉴를 다시 열면 지운다.
let connMsg = ''
let connCmd = '' // 사람이 직접 쳐야 하는 명령(manual)
// 지금 바꾸는 중인 것. 메인은 중복 실행을 막지 않는다 — 두 번 누르면 로그아웃이
// 두 번 돌고 창이 두 개 뜬다. 막는 것은 화면 몫이다.
let switching = ''
// 확인 주기. 메인이 결과를 캐시하므로 대부분은 캐시가 답한다 —
// `claude mcp list`가 서버마다 헬스 체크를 해서 실제로 부를 때마다 몇 초 걸린다.
const ENV_POLL_MS = 60_000

/**
 * 성공했다고 **말해도 되는가.**
 *
 * 사용자가 한 화면에서 서로 다른 두 말을 봤다:
 *   · 상단 배너 `Figma 연결이 끊겼습니다` + [Figma 연결]  ← 맞는 말
 *   · 채팅 `— Figma를 다시 연결했습니다 —`                 ← 거짓말
 * (대화 기록에 그대로 남아 있다.) 그때 실제 상태는 `! Needs authentication`이었고
 * 저장된 accessToken은 길이 0이었다.
 *
 * 갈라진 이유는 **근거가 달랐기** 때문이다. 배너는 `env.figma.connected`를 보는데
 * 채팅은 메인이 준 `res.ok`만 봤다. 그래서 메인이 한 번이라도 ok를 잘못 내면
 * 화면 두 곳이 서로 다른 말을 한다. 이제 둘 다 **같은 env**를 본다 —
 * 확인되지 않으면 확인되지 않았다고 말한다.
 */
function envConfirms(what, env) {
  if (!env) return false
  return what === 'figma' ? env.figma?.connected === true : env.claude?.loggedIn === true
}

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
 * 연결 두 줄. 배너와 달리 **문제가 없어도 보인다.**
 *
 * 배너만 두면 "지금 연결돼 있다"는 확인을 할 수 없다. 지시를 보내기 전에 눈으로
 * 확인하고 싶은 것이 바로 이 둘이라 ☰ 안에 계속 켜 둔다.
 *
 * 여기서 **누구로 로그인돼 있는지**까지 적는다. 회사 계정과 개인 계정을 오가면
 * 지금 어느 쪽으로 일하고 있는지가 결과를 가르는데, 화면에는 점 두 개뿐이었다.
 *
 * 줄마다 버튼은 **하나**다. 줄 전체를 누르게 하면 그 안의 버튼과 겹쳐서
 * 어디를 누른 것인지 알 수 없게 된다.
 */
function connRows(env) {
  const c = env?.claude ?? {}
  const f = env?.figma ?? {}
  // 처리 중이면 바꾸기를 **누르기 전에** 막는다. 메인도 거절하지만, 누르고 나서
  // 거절당하는 것과 애초에 죽어 있는 것은 다른 경험이다.
  const block = busyCompanies()
  const blockWhy = block.length ? busyReason(block) : ''
  const rows = []

  if (!c.installed) {
    rows.push({
      key: 'claude',
      state: 'bad',
      name: 'Claude',
      who: '설치 안 됨',
      sub: 'npm i -g @anthropic-ai/claude-code',
      title: 'claude CLI가 없습니다 — 팀원이 일할 수 없습니다',
      act: { kind: 'recheck', label: '다시 확인' },
    })
  } else if (!c.loggedIn) {
    rows.push({
      key: 'claude',
      state: 'off',
      name: 'Claude',
      who: '로그인 필요',
      sub: '로그인해야 팀원이 일할 수 있습니다',
      title: '새 창에서 로그인을 마치면 자동으로 이어집니다',
      act: { kind: 'login', label: '연결하기' },
    })
  } else {
    // 구독 등급. 메인은 새 이름(subscriptionType)과 옛 이름(plan)을 **둘 다** 준다 —
    // 같은 값이라 한 번만 적는다. 옛 메인은 plan만 주므로 그쪽으로 떨어진다.
    const grade = c.subscriptionType ?? c.plan
    rows.push({
      key: 'claude',
      state: 'ok',
      name: 'Claude',
      // 이메일이 주된 정보다. **구버전 메인은 이메일을 주지 않는다** — 그때도
      // 줄이 비어 보이지 않게 상태만이라도 적는다.
      who: c.email || '로그인됨 (계정 정보 없음)',
      // 구독 등급·조직은 보조다. 둘 다 없으면 줄 자체를 만들지 않는다.
      sub: [grade, c.orgName].filter(Boolean).join(' · '),
      // 인증 방식은 보조 줄까지 차지할 값은 아니라 마우스를 올렸을 때만 보인다.
      // 등급 자리에 이미 같은 값이 올라와 있으면(옛 메인의 plan) 두 번 적지 않는다.
      title: c.authMethod && c.authMethod !== grade ? `인증 방식: ${c.authMethod}` : '로그인됨',
      act: switchAct('계정 바꾸기', 'claude', blockWhy),
    })
  }

  if (f.connected) {
    rows.push({
      key: 'figma',
      state: 'ok',
      name: 'Figma',
      // Figma 쪽에는 계정 정보가 없다. 연결됐는지만 안다.
      who: '연결됨',
      sub: '',
      title: '다른 Figma 계정으로 바꾸려면 — 지금 인증을 지우고 새 창에서 다시 인증합니다',
      act: switchAct('다시 연결', 'figma', blockWhy),
    })
  } else if (!c.loggedIn) {
    // Claude에 로그인하지 않으면 Figma 연결 상태를 물어볼 수단이 없다. 여기서
    // 버튼을 주면 눌러도 아무 일이 없다 — 그래서 아예 두지 않는다.
    rows.push({
      key: 'figma',
      state: 'off',
      name: 'Figma',
      who: '연결 안 됨',
      sub: 'Claude에 로그인한 뒤 확인할 수 있습니다',
      title: '',
      act: null,
    })
  } else if (f.present) {
    // **이미 등록돼 있는데 인증만 풀린 상태다.** 등록(`mcp add`)은 이미 끝났으니 남은
    // 것은 인증뿐이다 — 지난 자격증명을 지우고 다시 인증하는 길로 보낸다.
    rows.push({
      key: 'figma',
      state: 'warn',
      name: 'Figma',
      who: '인증 필요',
      sub: '기획안·화면설계서는 Figma에 만듭니다',
      title: '등록은 돼 있고 인증만 남았습니다 — 새 창에서 브라우저 인증을 마치면 됩니다',
      act: switchAct('다시 연결', 'figma', blockWhy),
    })
  } else {
    rows.push({
      key: 'figma',
      state: 'warn',
      name: 'Figma',
      who: '연결 안 됨',
      sub: '기획안·화면설계서는 Figma에 만듭니다',
      title: '',
      act: { kind: 'login', label: '연결하기' },
    })
  }
  return rows
}

/**
 * 바꾸기 버튼 하나. **한 번에 하나만 돌 수 있다** — 메인은 중복 실행을 막지 않아서,
 * 빠르게 두 번 누르면 `auth logout`이 두 번 돌고 창이 두 개 뜬다. 응답이 올 때까지
 * 버튼을 죽여 두는 것이 유일한 방어선이라, 그 상태를 **다시 그려도 살아남게** 여기
 * 둔다(60초마다 오는 상태 갱신이 버튼을 새로 만든다).
 */
function switchAct(label, key, blockWhy) {
  if (switching) {
    return {
      kind: 'switch',
      label: switching === key ? '바꾸는 중…' : label,
      block: '바꾸는 중입니다 — 새 창에서 마치거나 끝날 때까지 기다려 주세요',
    }
  }
  return { kind: 'switch', label, block: blockWhy }
}

/** 한 줄을 그린다. 값은 전부 textContent로만 넣는다(이메일·조직명은 남의 글자다). */
function connRow(r) {
  const row = document.createElement('div')
  row.className = `conn-row ${r.state}`
  if (r.title) row.title = r.title

  const led = document.createElement('span')
  led.className = 'led'
  led.setAttribute('aria-hidden', 'true')

  const who = document.createElement('span')
  who.className = 'conn-who'
  const nm = document.createElement('span')
  nm.className = 'conn-nm'
  nm.textContent = r.name
  const acct = document.createElement('span')
  acct.className = 'conn-acct'
  acct.textContent = r.who
  who.append(nm, acct)

  row.append(led, who)

  if (r.act) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'conn-act'
    btn.textContent = r.act.label
    // 지금 못 하는 것은 **감추지 않고 죽인다.** 이유는 아래 줄에 이미 적혀 있다.
    btn.disabled = Boolean(r.act.block)
    if (r.act.block) btn.title = r.act.block
    btn.addEventListener('click', (e) => {
      // **누르는 순간 이 줄은 다시 그려진다.** 그러면 이 버튼은 DOM에서 떨어져 나가고,
      // 바깥 클릭을 보는 쪽에서는 "메뉴 밖을 눌렀다"로 보여 ☰가 통째로 닫혔다 —
      // 결과 문구가 뜨는 자리가 같이 사라졌다. 여기서 멈춘다.
      e.stopPropagation()
      if (r.act.kind === 'recheck') return recheckEnv()
      if (r.act.kind === 'login') return startLogin(r.key)
      switchAccount(r.key)
    })
    row.append(btn)
  }

  if (r.sub) {
    const sub = document.createElement('p')
    sub.className = 'conn-sub'
    sub.textContent = r.sub
    row.append(sub)
  }
  return row
}

function renderConn(env) {
  const rows = connRows(env)
  connEl.replaceChildren()
  for (const r of rows) connEl.append(connRow(r))
  // 바꾸다 생긴 소식이 있으면 그것을, 없으면 지금 왜 못 바꾸는지를 적는다.
  // 처리 중 안내는 **바꿀 수 있는 줄이 있을 때만** 뜻이 있다.
  const block = busyCompanies()
  const canSwitch = rows.some((r) => r.act?.kind === 'switch')
  const note = connMsg || (canSwitch && block.length ? busyReason(block) : '')
  connNoteEl.hidden = !note
  connNoteEl.textContent = note
}

/** 지금 지시를 처리 중인 회사 이름들. 계정을 바꾸면 그 세션이 인증을 잃는다. */
function busyCompanies() {
  return lastProjects.filter((p) => p.company === 'busy').map((p) => baseName(p.dir))
}

// 마지막으로 그린 '처리 중' 목록. 상태는 300ms마다 오므로 바뀌었을 때만 다시 그린다.
let connBusySeen = ''

/** 작업이 시작되고 끝나는 것을 열려 있는 연결 줄에 반영한다. */
function refreshConnBusy() {
  const now = busyCompanies().join('|')
  if (now === connBusySeen) return
  connBusySeen = now
  if (!menuPop.hidden) renderConn(lastEnv)
}

/**
 * 이름 뒤 주격 조사. 회사 이름은 사람이 지은 폴더 이름이라 받침이 제각각이다
 * (`ConvertFlow가` / `사무실이`). 한글이 아니면 열린 소리로 읽어 '가'로 둔다.
 */
function subjectParticle(name) {
  const last = String(name).slice(-1).charCodeAt(0)
  if (last < 0xac00 || last > 0xd7a3) return '가'
  return (last - 0xac00) % 28 === 0 ? '가' : '이'
}

function busyReason(names) {
  const who = names.join(', ')
  const tail = names.length > 1 ? '에서' : subjectParticle(who)
  return `${who}${tail} 지시를 처리 중입니다 — 지금 계정을 바꾸면 그 작업이 인증을 잃고 실패합니다`
}

/**
 * 계정 줄에 붙는 한 줄 소식. 다시 그려도 남고, 메뉴를 닫으면 사라진다.
 * `cmd`는 사람이 직접 쳐야 하는 명령 — 화면 글자는 집어 갈 수 없어 복사 버튼을 낸다.
 */
function showConnMsg(text, cmd = '') {
  connMsg = text
  connCmd = cmd
  connNoteEl.hidden = !text
  connNoteEl.textContent = text
  connCopyEl.hidden = !cmd
  connCopyEl.textContent = cmd ? `명령 복사: ${cmd}` : ''
}

connCopyEl.addEventListener('click', async () => {
  if (!connCmd) return
  await window.teamView.copyText(connCmd)
  // 눌렀는데 아무 일도 안 일어난 것처럼 보이면 또 누른다. 복사됐다는 것만 알린다.
  connCopyEl.textContent = '복사했습니다 — 터미널에 붙여넣으세요'
})

/**
 * 로그인 계정을 바꾼다.
 *
 * **되돌리기 쉬운 일이 아니다** — 먼저 로그아웃하고, 마지막은 브라우저에서 사람이
 * 마쳐야 끝난다. 중간에 그만두면 아무 계정으로도 로그인되지 않은 상태로 남는다.
 * 그래서 무엇이 일어나는지 적고 물어본 뒤에 한다.
 *
 * 실패 문구는 **메인이 준 것을 그대로** 쓴다. 여기서 새로 지어내면 실제로 무엇이
 * 막혔는지와 화면의 말이 어긋난다. 우리가 보태는 것은 "그래서 뭘 하면 되는지"뿐이다.
 */
async function switchAccount(what) {
  if (switching) return // 두 번 누르면 로그아웃이 두 번 돈다
  const block = busyCompanies()
  // 돌고 있는 작업이 있으면 **묻지 않는다.** 물어서 될 일이 아니라 지금은 안 되는 일이다.
  if (block.length) {
    showConnMsg(busyReason(block))
    renderConn(lastEnv)
    return
  }
  if (!confirm(switchPrompt(what, lastEnv?.claude?.email))) return

  switching = what
  showConnMsg('')
  renderConn(lastEnv) // 버튼이 '바꾸는 중…'으로 죽는다
  const res = await callBridge('switchAccount', what)
  switching = ''

  // **`ok`만으로 성공을 적지 않는다.** 배너와 같은 근거(env)로 한 번 더 확인한다 —
  // 이 줄은 채팅 기록 파일에 남아서, 틀리면 틀린 채로 남는다.
  if (res?.ok && envConfirms(what, res.env)) {
    // 채팅 기록에는 **누구로 바뀌었는지 적지 않는다** — 이메일·조직은 남의 정보고
    // 기록은 파일로 남는다. 무슨 일이 있었는지만 한 줄.
    addMsg('sys', '', what === 'figma' ? '— Figma를 다시 연결했습니다 —' : '— Claude 계정을 바꿨습니다 —')
    renderEnv(res.env ?? lastEnv)
    return
  }
  if (res?.busy) {
    // 메인이 거절했다. 어느 회사가 잡고 있는지는 응답이 알려 준다(우리가 본 것보다 정확하다).
    const names = Array.isArray(res.running) && res.running.length ? res.running : busyCompanies()
    showConnMsg(names.length ? busyReason(names) : res.error || '지금은 바꿀 수 없습니다 — 돌고 있는 작업이 있습니다')
  } else if (res?.manual) {
    // 창을 띄울 수 없는 컴퓨터. 명령을 사람이 직접 쳐야 한다.
    showConnMsg(`${res.error || '앱이 창을 띄우지 못했습니다'} — 터미널에서 직접 실행하세요.`, res.manual)
  } else if (res?.timeout || res?.ok) {
    // **실패로 단정하지 않는다.** 로그인 창은 아직 열려 있을 수 있고, 거기서
    // 마치면 실제로는 성공이다. 메인이 준 문구가 이미 그 말을 하고 있으므로
    // 그대로 쓴다 — 여기서 덧붙이면 같은 말이 두 번 된다.
    //
    // `res.ok`인데 여기까지 왔다면 **메인은 됐다는데 env가 그렇다고 말해 주지 않는
    // 경우**다. 그것도 "모른다"이지 "됐다"가 아니다 — 같은 문구로 처리한다.
    showConnMsg(res.error || '시간이 지났습니다 — 창에서 로그인을 마쳤는지 확인하고 [상태 다시 확인]을 누르세요')
  } else {
    showConnMsg(res?.error || '계정을 바꾸지 못했습니다')
  }
  // 실패해도 상태는 달라져 있을 수 있다(로그아웃까지는 됐을 수 있다). 받은 것을 쓴다.
  renderEnv(res?.env ?? lastEnv)
}

/** 확인 창 문구. 지금 계정·새 창이 뜬다는 것·돌고 있는 작업이 있으면 실패한다는 것. */
function switchPrompt(what, email) {
  if (what === 'figma') {
    return (
      'Figma를 다시 인증합니다.\n\n' +
      '· 지금 저장된 Figma 인증을 지우고 새로 인증합니다(등록은 그대로 둡니다).\n' +
      '· 새 창이 열립니다 — 거기서 브라우저 인증을 마쳐야 끝납니다.\n' +
      '· 돌고 있는 작업이 있으면 인증을 잃어 실패합니다.'
    )
  }
  return (
    'Claude 계정을 바꿉니다.\n\n' +
    `  지금 계정   ${email || '(계정 정보 없음)'}\n\n` +
    '· 먼저 로그아웃하고 새 로그인 창이 열립니다 — 거기서 로그인을 마쳐야 끝납니다.\n' +
    '· 돌고 있는 작업이 있으면 인증을 잃어 실패합니다.\n' +
    '· 로그아웃은 이 앱에서 되돌릴 수 없습니다(다시 로그인해야 합니다).'
  )
}

function renderEnv(env) {
  lastEnv = env
  refreshMenuDot()
  renderConn(env)
  const block = envBlocker(env)
  // **설치 안내가 떠 있으면 배너를 겹쳐 띄우지 않는다.**
  //
  // claude가 없으면 설치 안내(무엇을 깔아야 하는지)와 이 배너(로그인하라)가 같은 말을
  // 두 번 하게 된다. 상태 점까지 세면 세 번이다. 실측하니 그 상태에서 화면 위쪽
  // 311px가 경고로만 채워졌다. 설치가 먼저이므로 그쪽에 자리를 내준다.
  // 설치 마법사가 떠 있는 동안에도 겹치지 않는다 — 같은 말을 두 곳에서 하게 된다.
  const needShown = !needEl.hidden
  const covered = needShown || wizardIsOpen()
  envEl.hidden = !block || covered
  if (!block || covered) return
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
  connRecheckEl.disabled = true
  renderEnv(await window.teamView.checkEnv({ force: true }))
  connRecheckEl.disabled = false
  // 설치를 마치고 돌아오는 길목이기도 하다 — 같이 다시 본다.
  recheckNeeds()
}

connRecheckEl.addEventListener('click', recheckEnv)

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
  // 성공 문구는 **배너와 같은 근거로만** 낸다. `ok`만 믿었더니 배너는 "끊겼습니다",
  // 채팅은 "연결됐습니다"가 한 화면에 같이 떴다.
  if (res?.ok && envConfirms(what, res.env)) {
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
  renderEnv(res?.env ?? lastEnv)
  // `ok`인데 env가 확인해 주지 않은 경우도 여기로 온다. 아직 안 끝난 것과 같게 말한다.
  if (res?.timeout || res?.ok) {
    envEl.hidden = false
    envMsgEl.textContent += '  (아직 완료되지 않았습니다 — 끝났으면 "다시 확인")'
  }
}

envActEl.addEventListener('click', () => startLogin(envActEl.dataset.what))
envAgainEl.addEventListener('click', recheckEnv)

// ---------- 설치 안내 ----------
//
// 윤사무실은 앱만 있어서는 동작하지 않는다. claude CLI를 띄우고, 그 활동은 python 훅이
// 기록한다. 다른 PC에 exe만 옮기면 **화면은 뜨지만 아무 일도 일어나지 않는데**
// 무엇이 없어서인지 알 방법이 없다. 시작할 때 먼저 확인하고 설치를 돕는다.
//
// 설치는 남의 컴퓨터를 건드리는 일이라 **반드시 동의를 받는다.** 확인 창은 메인
// 프로세스가 띄우고(네이티브), 무엇을 왜 넣는지·어떤 명령이 도는지 그대로 보여 준다.

const needEl = document.getElementById('need')
const needListEl = document.getElementById('need-list')
// 지금 빠진 것이 있는가. 마법사가 닫힐 때 배너를 원래대로 되돌리려면 화면 밖에
// 들고 있어야 한다(마법사가 떠 있는 동안에는 hidden이라 요소만으로는 알 수 없다).
let needMissing = false

/** 배너를 띄울지. **마법사가 떠 있는 동안만 자리를 비운다** — 지우지는 않는다. */
function refreshNeedBanner() {
  needEl.hidden = !needMissing || wizardIsOpen()
}

function renderNeeds(reqs) {
  const missing = reqs.filter((r) => !r.installed)
  needMissing = missing.length > 0
  // 없는 게 없으면 아예 띄우지 않는다. 잘 돌 때 잔소리를 하지 않는다.
  if (!missing.length) {
    refreshNeedBanner()
    return
  }
  refreshNeedBanner()
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

// ---------- 첫 실행 설치 마법사 (진입점) ----------
//
// 여는 조건·단계·설치 진행은 전부 wizard.js가 판단한다. 여기서 주는 것은
// **떠 있는 동안 기존 배너가 자리를 비우는 것**과 기존 폴더 붙이기 경로뿐이다.
initWizard({
  onToggle: () => {
    refreshNeedBanner()
    refreshWelcome()
    renderEnv(lastEnv)
  },
  onClosed: (finished) => {
    // 마쳤으면 곧바로 시킬 수 있게 입력창으로 보낸다. 여기까지 온 사람이 다음에
    // 할 일은 지시를 적는 것 하나뿐이다.
    recheckNeeds()
    if (finished) inputEl.focus()
  },
  addExistingProject: attachProject,
})

document.getElementById('wz-open').addEventListener('click', (e) => {
  e.stopPropagation() // 바깥 클릭으로 ☰가 닫히기 전에 우리가 먼저 닫는다
  toggleMenu(false)
  openWizard()
})
// 로그인이 풀리거나 Figma 연결이 끊기는 일은 앱 밖에서도 일어난다. 계속 지켜본다.
setInterval(() => window.teamView.checkEnv().then(renderEnv), ENV_POLL_MS)

renderTargets()
renderTeamUi() // 요약 줄과 첫 화면의 팀원 수를 채워 둔다(명단은 상태가 오면 다시 읽는다)
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
