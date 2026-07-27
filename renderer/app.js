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
  drawPartitions,
  PROPS,
} from './room.js'

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

let scale = 3
let agents = buildAgents()
let target = 'all' // 채팅 대상: 'all' 또는 에이전트 id
let lastFrame = performance.now()
const nodes = new Map()
const lastChatAt = new Map() // 도구 이벤트가 채팅을 도배하지 않도록

function resize() {
  const wrap = document.getElementById('left')
  const availW = wrap.clientWidth - 4
  const availH = wrap.clientHeight - 4
  // 정수 배율을 고집하면 창의 절반이 빈 여백으로 남는다. 소수 배율을 쓰되
  // 스프라이트는 픽셀 좌표를 반올림해 찍으므로 도트가 흐려지지 않는다.
  scale = Math.max(1, Math.min(availW / STAGE_W, availH / STAGE_H))
  canvas.width = STAGE_W * scale
  canvas.height = STAGE_H * scale
  canvas.style.width = `${STAGE_W * scale}px`
  canvas.style.height = `${STAGE_H * scale}px`
  ctx.imageSmoothingEnabled = false
}
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
    default:
      agent.active = true
      agent.busyUntil = now + BUSY_MS
  }

  agent.task = describe(ev)
  agent.lastEventAt = now
  if (!ev._replay) chatFromEvent(ev, agent)
}

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
    el.append(w, document.createTextNode(text))
  }
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
  const to = target === 'all' ? LEAD_ID : target
  const label = target === 'all' ? '전체' : (agents.get(to)?.label ?? to)

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

const COFFEE = { gx: 5.5, gy: 3.7 }
const MEETING = [
  { gx: 1.3, gy: 5.5 },
  { gx: 3.7, gy: 5.5 },
  { gx: 2.5, gy: 6.7 },
]
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

  const roll = Math.random()
  if (roll < 0.3) {
    // 커피
    const a = pick(free)
    a.plan = { dest: COFFEE, until: now + 7000, bubble: '커피 한 잔 하고 올게요' }
  } else if (roll < 0.72) {
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

    const dest =
      working || (a.active && !quiet) ? a.work : a.plan ? a.plan.dest : a.rest

    const dx = dest.gx - a.gx
    const dy = dest.gy - a.gy
    const dist = Math.hypot(dx, dy)

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
  tag.textContent = a.label // 한글 역할명만. 영문 id는 채팅 쪽에서 확인한다.
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
    tag.style.left = `${x * scale}px`
    tag.style.top = `${headY * scale}px`
    tag.classList.toggle('on', a.active)
    tag.classList.toggle('sel', target === a.id)

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
      bubble.style.left = `${x * scale}px`
      bubble.style.top = `${(headY - 9) * scale}px`
    } else {
      bubble.hidden = true
    }
  }
}

// ---------- 그리기 ----------

function draw(t) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  drawWalls(ctx, scale, t)
  drawFloor(ctx, scale)
  drawRug(ctx, scale, 1.5, 4.5, 3, 3) // 회의 구역

  // 깊이 정렬. **각 물건을 자기 위치의 깊이로** 넣는다 — 파티션·의자를 책상과
  // 같은 깊이로 묶으면(예전 방식) 파티션 앞을 지나가는 캐릭터가 파티션에 가린다.
  // 깊이가 같을 때는 rank로 순서를 고정한다: 파티션 → 책상 → 의자 → 사람.
  const RANK = { partition: 0, prop: 1, desk: 2, chair: 3, agent: 4 }
  const items = []
  for (const a of agents.values()) {
    const d = a.desk
    // 두 패널 모두 실제로는 책상보다 0.55만큼 뒤에 있다(서쪽/북쪽으로 각각 0.55).
    items.push({ kind: 'partition', d: depth(d.gx, d.gy) - 0.55, a })
    items.push({ kind: 'desk', d: depth(d.gx, d.gy), a })
    items.push({ kind: 'chair', d: depth(a.chair.gx, a.chair.gy), a })
    items.push({ kind: 'agent', d: depth(a.gx, a.gy), a })
  }
  for (const p of PROPS) items.push({ kind: 'prop', d: depth(p.gx, p.gy), p })
  items.sort((p, q) => p.d - q.d || RANK[p.kind] - RANK[q.kind])

  for (const it of items) {
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
      drawWorkstation(ctx, scale, a.desk.gx, a.desk.gy, a.pose === 'sit', t)
      continue
    }
    if (it.kind === 'chair') {
      // 좌판과 등받이는 앉은 캐릭터보다 **먼저** 그린다(같은 깊이면 rank가 보장).
      drawChair(ctx, scale, a.chair.gx, a.chair.gy)
      drawChairBack(ctx, scale, a.chair.gx, a.chair.gy)
      continue
    }

    const sitting = a.pose === 'sit'
    if (!sitting) drawShadow(ctx, scale, a.gx, a.gy)
    const { x, y } = toScreen(a.gx, a.gy)
    const frames = POSES[a.pose] ?? POSES.idle
    // 앉으면 좌판 높이만큼 올라앉는다
    drawSprite(ctx, frames[frameIndex(a.pose, t)], a.palette, x, y, scale, a.flip, sitting ? -5 : 0)

    if (target === a.id) {
      ctx.strokeStyle = '#4a90d9'
      ctx.lineWidth = Math.max(2, scale / 2)
      ctx.beginPath()
      ctx.ellipse(x * scale, y * scale, 11 * scale, 5.5 * scale, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}

function loop(now) {
  const dt = Math.min(now - lastFrame, 100)
  lastFrame = now
  update(dt, now)
  draw(now)
  syncOverlay(now)
  requestAnimationFrame(loop)
}

// ---------- 클릭 → 대화 상대 선택 ----------

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect()
  const lx = (e.clientX - rect.left) / scale
  const ly = (e.clientY - rect.top) / scale
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

renderTargets()
addMsg('sys', '', '캐릭터를 클릭하거나 위 칩으로 대상을 고르고 지시를 보내세요.')
resize()
requestAnimationFrame(loop)
