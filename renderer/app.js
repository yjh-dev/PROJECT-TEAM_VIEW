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
const overlay = document.getElementById('overlay')
const targetsEl = document.getElementById('targets')
const messagesEl = document.getElementById('messages')
const inputEl = document.getElementById('chat-input')
const sendBtn = document.getElementById('chat-send')
const hintEl = document.getElementById('chat-hint')
const nowEl = document.getElementById('now')

const BUSY_MS = 2600
const IDLE_LEAVE_MS = 9000
const TALK_MS = 3200

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
const chatLogs = new Map() // dir -> [{ kind, who, text }]

function logFor(dir) {
  if (!dir) return []
  if (!chatLogs.has(dir)) chatLogs.set(dir, [])
  return chatLogs.get(dir)
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
  clampCam()
  ctx.imageSmoothingEnabled = false
}

/** 도면이 화면 밖으로 완전히 사라지지 않도록 이동 범위를 제한한다. */
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
    cam.x = 0
    cam.y = 0
    scale = eff()
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
  Task: { icon: '↗', word: '위임' },
  WebFetch: { icon: '⇩', word: '조회' },
  WebSearch: { icon: '⌕', word: '웹 검색' },
  TodoWrite: { icon: '☑', word: '계획 정리' },
}

function activityOf(ev) {
  if (ev.type === 'tool') return ACTIVITY[ev.tool] ?? { icon: '◆', word: ev.tool ?? '작업' }
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
      if (ev.tool === 'Task') return '팀원 부르는 중'
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

function applyEvent(ev) {
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
        }
      } else if (!history) {
        agent.active = true
        agent.busyUntil = now + BUSY_MS
      }
      break
    case 'reply':
      // 답변은 '일하는 상태'가 아니다. 말풍선만 띄우고 상태는 건드리지 않는다.
      agent.task = String(ev.detail ?? '').slice(0, 60)
      agent.lastEventAt = history ? now - IDLE_LEAVE_MS - 1000 : now
      if (!ev._replay) addMsg('agent', `${agent.label} · 답변`, String(ev.detail ?? ''))
      return
    default:
      if (ev.type === 'tool') agent.toolCount = (agent.toolCount ?? 0) + 1
      if (history) break
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

/**
 * 대화 한 줄을 **기록하고** 화면에 붙인다.
 * 기록해 두는 이유는 탭을 옮겼다 돌아왔을 때 대화가 사라지지 않게 하기 위해서다.
 */
function addMsg(kind, who, text) {
  const log = logFor(activeDir)
  log.push({ kind, who, text })
  while (log.length > 200) log.shift()
  renderMsg(kind, who, text)
}

/** 탭을 옮겼을 때 그 프로젝트의 대화를 되살린다. */
function redrawChat(dir) {
  messagesEl.replaceChildren()
  for (const m of logFor(dir)) renderMsg(m.kind, m.who, m.text)
  messagesEl.scrollTop = messagesEl.scrollHeight
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
    body.textContent = text
    // 복사 버튼 — 평소엔 숨어 있다가 말풍선에 올리면 나타난다
    const copy = document.createElement('button')
    copy.className = 'copy'
    copy.type = 'button'
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
  addMsg('agent', `${agent.label} · ${agent.id}`, describe(ev))
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
  queuedFor.push({ id: to, at: Date.now() / 1000 })
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
    const working = a.active && now < a.busyUntil
    a.working = working
    const quiet = now - a.lastEventAt > IDLE_LEAVE_MS
    if (a.plan && (now >= a.plan.until || working)) a.plan = null

    // 일이 없으면 rest(=자기 의자)로 돌아간다. 유휴 행동이 있을 때만 자리를 뜬다.
    const goal = working || (a.active && !quiet) ? a.work : a.plan ? a.plan.dest : a.rest

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
    nowEl.textContent = waiting ? `지시 ${waiting}건 대기 중` : '조용합니다 — 진행 중인 작업 없음'
    nowEl.className = waiting ? 'queued' : ''
    return
  }
  nowEl.className = 'busy'
  nowEl.textContent =
    '작업 중 · ' +
    busy
      .sort((p, q) => (p.startedAt ?? 0) - (q.startedAt ?? 0))
      .map((a) => {
        const sec = a.startedAt ? Math.floor((now - a.startedAt) / 1000) : 0
        return `${a.label}(${a.act ? a.act.word + ' ' : ''}${sec}s)`
      })
      .join(' · ')
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
      const sec = a.startedAt ? Math.floor((now - a.startedAt) / 1000) : 0
      const act = a.act ? `${a.act.icon} ${a.act.word} · ` : ''
      meta.textContent = ` ${act}${sec}s · 🛠 ${a.toolCount ?? 0}`
    } else {
      meta.textContent = ''
    }

    let text = null
    let kind = ''
    if (a.queued > 0) {
      text = `지시 ${a.queued}건 대기`
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
  const rect = canvas.getBoundingClientRect()
  const lx = (e.clientX - rect.left - cam.x) / scale
  const ly = (e.clientY - rect.top - cam.y) / scale
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
  target = best ? best.id : 'all'
  renderTargets()
  inputEl.focus()
})

// ---------- 배선 ----------

// 이벤트에는 어느 프로젝트 것인지가 실려 온다. 보고 있는 사무실 것만 그린다 —
// 메인도 비활성 프로젝트는 아예 파싱하지 않으므로 여기까지 오지도 않지만,
// 탭을 막 옮긴 순간의 이전 프로젝트 이벤트가 뒤늦게 닿을 수 있어 한 번 더 거른다.
window.teamView.onEvents(({ dir, events }) => {
  if (dir !== activeDir) return
  events.forEach(applyEvent)
})

/**
 * 사무실을 비운다. 탭을 옮겼을 때와 로그가 잘렸을 때 온다.
 *
 * 시뮬레이션 상태(팀원·대기 배지·이름표)는 지우지만 **채팅은 지우지 않는다** —
 * 그 프로젝트에서 오간 대화를 다시 그려 준다. 탭을 옮길 때마다 대화가 사라지면
 * 무엇을 시켰는지 알 수 없다.
 */
window.teamView.onReset(({ dir } = {}) => {
  if (dir) activeDir = dir
  queuedFor.length = 0
  agents = buildAgents()
  refreshObstacles()
  nodes.clear()
  overlay.replaceChildren()
  lastChatAt.clear()
  target = 'all'
  renderTargets()
  redrawChat(activeDir)
})

window.teamView.onStatus(({ projects, activeDir: active, max }) => {
  activeDir = active
  renderTabs(projects, active, max)

  const me = projects.find((p) => p.dir === active)
  const trouble = me ? diagnose(me) : { text: '프로젝트를 추가하세요', warn: true }
  statusEl.textContent = trouble.text
  statusEl.className = trouble.warn ? 'warn' : 'ok'
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

    tab.append(nm, st, x)
    tab.addEventListener('click', () => {
      if (p.dir === activeDir) return
      window.teamView.activateProject(p.dir)
    })
    tabsEl.append(tab)
  }
  addBtn.disabled = projects.length >= max
  addBtn.title = addBtn.disabled
    ? `동시에 붙일 수 있는 프로젝트는 ${max}개까지입니다`
    : `프로젝트를 하나 더 붙입니다 (최대 ${max}개)`
}

addBtn.addEventListener('click', async () => {
  const res = await window.teamView.addProject()
  if (!res?.ok) {
    if (!res?.canceled && res?.error) hintEl.textContent = res.error
    return
  }
  // 붙인 직후에 빠진 것을 한 줄로 알린다. 안 움직이는 걸 나중에 발견하는 것보다 낫다.
  const h = res.health ?? {}
  const missing = []
  if (!h.hooks) missing.push('훅 미등록')
  if (!h.agents) missing.push('팀원 없음')
  if (!h.guide) missing.push('CLAUDE.md 없음')
  hintEl.textContent = missing.length
    ? `${baseName(res.dir)} — ${missing.join(' · ')} (탭에 마우스를 올리면 자세히 보입니다)`
    : `${baseName(res.dir)} 붙였습니다 — 팀원 ${h.agents}명`
})

// ---------- 작업 취소 ----------
//
// 취소할 수 있는 건 **앱이 만든 것**뿐이다: 아직 안 집어간 대기열과, 앱이 띄운
// claude 프로세스. 이미 세션 안에서 돌고 있는 작업은 앱이 손댈 수 없다 —
// 그건 그 터미널에서 Esc로 멈춰야 한다. 그래서 결과를 사실대로 적어 준다.
document.getElementById('chat-cancel').addEventListener('click', async (e) => {
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

renderTargets()
addMsg('sys', '', '캐릭터를 클릭하거나 위 칩으로 대상을 고르고 지시를 보내세요.')
refreshObstacles()
resize()
requestAnimationFrame(loop)
