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
} from './room.js'
import { routeTo, interiorWallSegments, DOORWAYS, SPOTS } from './layout.js'

const canvas = document.getElementById('stage')
const ctx = canvas.getContext('2d')
const statusEl = document.getElementById('status')
const projectEl = document.getElementById('project')
const pickBtn = document.getElementById('pick')
const overlay = document.getElementById('overlay')
const targetsEl = document.getElementById('targets')
const messagesEl = document.getElementById('messages')
const inputEl = document.getElementById('chat-input')
const sendBtn = document.getElementById('chat-send')
const spawnEl = document.getElementById('chat-spawn')
const hintEl = document.getElementById('chat-hint')

const BUSY_MS = 2600
const IDLE_LEAVE_MS = 9000
const TALK_MS = 3200

const WALL_SEGMENTS = interiorWallSegments()

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

function applyEvent(ev) {
  const now = performance.now()
  const agent = agentOrCreate(agents, ev.agent || LEAD_ID)

  switch (ev.type) {
    case 'agent_start': {
      agent.active = true
      agent.busyUntil = now + BUSY_MS
      agent.startedAt = now
      agent.toolCount = 0
      if (agent.queued > 0) agent.queued--
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
      break
    case 'error': {
      // 화면만 봐도 문제를 알아채는 것이 목적이다. 당사자에게 느낌표를 띄우고
      // 디버거를 그 자리로 보낸다(실제로 디버거가 호출되지 않아도 '봐야 할 곳'을 가리킨다).
      agent.active = true
      agent.busyUntil = now + BUSY_MS
      agent.errorUntil = now + 12000
      agent.errorCount = (agent.errorCount ?? 0) + 1
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
      if (ev.state === 'idle') {
        for (const a of agents.values()) {
          a.active = false
          a.busyUntil = 0
        }
      } else {
        agent.active = true
        agent.busyUntil = now + BUSY_MS
      }
      break
    case 'reply':
      // 답변은 '일하는 상태'가 아니다. 말풍선만 띄우고 상태는 건드리지 않는다.
      agent.task = String(ev.detail ?? '').slice(0, 60)
      agent.lastEventAt = now
      if (!ev._replay) addMsg('agent', `${agent.label} · 답변`, String(ev.detail ?? ''))
      return
    default:
      agent.active = true
      agent.busyUntil = now + BUSY_MS
      if (ev.type === 'tool') agent.toolCount = (agent.toolCount ?? 0) + 1
  }

  agent.task = describe(ev)
  agent.lastEventAt = now
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

function addMsg(kind, who, text) {
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
      target = id
      renderTargets()
      inputEl.focus()
    })
    targetsEl.append(b)
  }
  mk('all', '전체', null)
  for (const r of ROSTER) mk(r.id, r.label, r.shirt)
}

async function send() {
  const text = inputEl.value.trim()
  if (!text) return
  // '전체'면 내용을 보고 담당을 배정한다(못 고르면 리드에게).
  const to = target === 'all' ? LEAD_ID : target
  const label = target === 'all' ? '전체 (담당은 리드가 배정)' : (agents.get(to)?.label ?? to)

  sendBtn.disabled = true
  hintEl.textContent = '보내는 중…'
  const res = await window.teamView.sendCommand({
    agent: to,
    text: target === 'all' ? text : text,
    broadcast: target === 'all',
    spawn: spawnEl.checked,
  })
  sendBtn.disabled = false

  if (!res?.ok) {
    hintEl.textContent = `실패: ${res?.error ?? '알 수 없는 오류'}`
    return
  }
  addMsg('me', `나 → ${label}`, text)
  const a = agents.get(to)
  if (a) a.queued++
  hintEl.textContent = res.spawned
    ? 'Claude Code를 새로 띄워 실행 중입니다'
    : '전달했습니다 — 열려 있는 세션이 다음 턴에 받습니다'
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
const COFFEE = SPOTS.coffee
const TRASH = SPOTS.trash
const MEETING = SPOTS.meeting
const LOUNGE = SPOTS.lounge
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

let nextIdleAt = 0

function scheduleIdle(now) {
  if (now < nextIdleAt) return
  nextIdleAt = now + 3500 + Math.random() * 4000

  const free = [...agents.values()].filter(
    (a) => !a.active && !(a.plan && now < a.plan.until) && a.queued === 0,
  )
  if (free.length < 2) return
  // 절반쯤은 아무 일도 일어나지 않는다. 계속 북적이면 오히려 가짜처럼 보인다.
  if (Math.random() < 0.45) return

  // 컵이 쌓였으면 먼저 치우러 간다(쌓인 채로 계속 커피를 뽑지 않도록)
  const messy = free.filter((a) => a.cups >= 3)
  if (messy.length && Math.random() < 0.55) {
    const a = pick(messy)
    a.plan = { kind: 'trash', dest: TRASH, until: now + 9000, bubble: '컵 좀 버리고 올게요' }
    return
  }

  const roll = Math.random()
  if (roll < 0.26) {
    // 커피 — 탕비실까지 걸어가서 한 잔 받아 온다
    const a = pick(free)
    a.plan = { kind: 'coffee', dest: COFFEE, until: now + 9000, bubble: '커피 한 잔 하고 올게요' }
  } else if (roll < 0.42) {
    // 휴게실에서 잠깐 쉰다
    const n = 1 + (Math.random() < 0.5 ? 1 : 0)
    const chosen = free.slice().sort(() => Math.random() - 0.5).slice(0, n)
    chosen.forEach((a, i) => {
      a.plan = {
        kind: 'lounge',
        dest: LOUNGE[(i + Math.floor(Math.random() * LOUNGE.length)) % LOUNGE.length],
        until: now + 13000,
        bubble: i === 0 ? '잠깐 쉬었다 올게요' : null,
        faceId: chosen[(i + 1) % chosen.length]?.id,
      }
    })
  } else if (roll < 0.75) {
    // 둘이 마주보고 잡담
    const a = pick(free)
    const b = pick(free.filter((x) => x !== a))
    if (!b) return
    const mid = { gx: (a.rest.gx + b.rest.gx) / 2, gy: (a.rest.gy + b.rest.gy) / 2 }
    const talk = pick(SMALL_TALK)
    a.plan = { dest: { gx: mid.gx - 0.35, gy: mid.gy }, until: now + 8000, bubble: talk, faceId: b.id }
    b.plan = { dest: { gx: mid.gx + 0.35, gy: mid.gy }, until: now + 8000, bubble: null, faceId: a.id }
    // 상대는 잠시 뒤에 대답한다
    setTimeout(() => {
      if (b.plan && performance.now() < b.plan.until) b.plan.bubble = pick(SMALL_TALK)
    }, 2600)
  } else {
    // 회의 테이블에 두세 명이 모인다
    const n = 2 + (Math.random() < 0.4 ? 1 : 0)
    const chosen = free.slice().sort(() => Math.random() - 0.5).slice(0, n)
    chosen.forEach((a, i) => {
      a.plan = {
        dest: MEETING[i % MEETING.length],
        until: now + 11000,
        bubble: i === 0 ? '잠깐 모여서 정리할까요?' : null,
        faceId: chosen[(i + 1) % chosen.length]?.id,
      }
    })
  }
}

// ---------- 움직임 ----------

function facingFlip(a, other) {
  const me = toScreen(a.gx, a.gy)
  const you = toScreen(other.gx, other.gy)
  return you.x < me.x
}

function update(dt, now) {
  scheduleIdle(now)

  for (const a of agents.values()) {
    const working = a.active && now < a.busyUntil
    const quiet = now - a.lastEventAt > IDLE_LEAVE_MS
    if (a.plan && (now >= a.plan.until || working)) a.plan = null

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
      const screenDir = dx - dy
      if (Math.abs(screenDir) > 0.01) a.flip = screenDir < 0
    } else {
      a.gx = dest.gx
      a.gy = dest.gy
      a.pose = working ? 'sit' : 'idle'
      // 대화 중이면 상대를 바라본다 (리드의 호출 연출 또는 유휴 잡담)
      const faceId = (now < (a.talkUntil ?? 0) && a.faceTarget) || a.plan?.faceId
      if (faceId) {
        const other = agents.get(faceId)
        if (other) a.flip = facingFlip(a, other)
      }
    }
  }
}

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

function syncOverlay(now) {
  for (const a of agents.values()) {
    const { tag, bubble } = nodesFor(a)
    const { x, y } = toScreen(a.gx, a.gy)

    // 이름표는 **머리 위**에. 앉으면 머리가 내려가므로 그만큼 함께 내린다.
    const headY = y - (a.pose === 'sit' ? 19 : 21)
    tag.style.left = `${x * scale + cam.x}px`
    tag.style.top = `${headY * scale + cam.y}px`
    tag.classList.toggle('on', a.active)
    tag.classList.toggle('sel', target === a.id)
    const erroring = now < (a.errorUntil ?? 0)
    tag.classList.toggle('err', erroring)
    // 이름 + 진행 정보(경과 초·도구 호출 수). 일하는 중일 때만 붙인다.
    tag.querySelector('.nm').textContent = (erroring ? '❗ ' : '') + a.label
    const meta = tag.querySelector('.meta')
    if (a.active && a.startedAt) {
      const sec = Math.floor((now - a.startedAt) / 1000)
      meta.textContent = ` ${sec}s · ${a.toolCount ?? 0}`
    } else {
      meta.textContent = ''
    }

    let text = null
    let kind = ''
    if (a.queued > 0) {
      text = `지시 ${a.queued}건 대기`
      kind = 'queued'
    } else if (a.task && (now - a.lastEventAt < 6000 || now < (a.talkUntil ?? 0))) {
      text = a.task
    } else if (a.plan?.bubble && now < a.plan.until) {
      text = a.plan.bubble
      kind = 'small' // 잡담: 실제 작업이 아니라는 걸 눈에 띄게 구분한다
    }
    if (text) {
      bubble.hidden = false
      bubble.textContent = text
      bubble.className = `bubble${kind ? ' ' + kind : ''}`
      bubble.style.left = `${x * scale + cam.x}px`
      bubble.style.top = `${(headY - 9) * scale + cam.y}px`
    } else {
      bubble.hidden = true
    }
  }
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
      drawWorkstation(ctx, scale, a.desk.gx, a.desk.gy, a.pose === 'sit', t, a.cups)
      continue
    }
    if (it.kind === 'chair') {
      // 좌판과 등받이는 앉은 캐릭터보다 **먼저**(뒤에) 그린다.
      drawChair(ctx, scale, a.chair.gx, a.chair.gy)
      drawChairBack(ctx, scale, a.chair.gx, a.chair.gy)
      continue
    }
    if (it.kind === 'arms') {
      if (a.pose === 'sit') drawChairArms(ctx, scale, a.chair.gx, a.chair.gy)
      continue
    }

    const sitting = a.pose === 'sit'
    if (!sitting) drawShadow(ctx, scale, a.gx, a.gy)
    const { x, y } = toScreen(a.gx, a.gy)
    const frames = POSES[a.pose] ?? POSES.idle
    // 앉으면 좌판 높이만큼 올라앉는다
    drawSprite(ctx, frames[frameIndex(a.pose, t)], a.palette, x, y, scale, a.flip, sitting ? -6.5 : 0)

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

window.teamView.onEvents((events) => events.forEach(applyEvent))
window.teamView.onReset(() => {
  agents = buildAgents()
  nodes.clear()
  overlay.replaceChildren()
  messagesEl.replaceChildren()
})
window.teamView.onStatus(({ projectDir, exists }) => {
  projectEl.textContent = projectDir ?? '(선택 안 됨)'
  statusEl.textContent = !projectDir
    ? '프로젝트를 선택하세요'
    : exists
      ? '이벤트 감시 중'
      : '훅 설치 대기 중 — .claude/team-events.jsonl 없음'
  statusEl.className = !projectDir || !exists ? 'warn' : 'ok'
})

pickBtn.addEventListener('click', () => window.teamView.pickProject())

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
resize()
requestAnimationFrame(loop)
