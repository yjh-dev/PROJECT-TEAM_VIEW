// 렌더 루프 + 이벤트→행동 매핑 + 채팅(전체/개별 지시).
//
// 움직임 규칙:
//   활성 = 자기 책상 앞으로 걸어가 타이핑 / 비활성 = 통로 쪽에서 쉼
// **화면의 움직임은 전부 실제 이벤트에서 나온다.** 가짜 활동은 만들지 않는다.

import { POSES, drawSprite } from './sprites.js'
import { ROSTER, buildAgents, agentOrCreate, LEAD_ID } from './agents.js'
import { STAGE_W, STAGE_H, toScreen, depth, drawShadow } from './iso.js'
import { drawFloor, drawWalls, drawRug, drawWorkstation, PROPS } from './room.js'

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
  const availW = wrap.clientWidth - 8
  const availH = wrap.clientHeight - 8
  scale = Math.max(1, Math.floor(Math.min(availW / STAGE_W, availH / STAGE_H)))
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

// ---------- 움직임 ----------

function facingFlip(a, other) {
  const me = toScreen(a.gx, a.gy)
  const you = toScreen(other.gx, other.gy)
  return you.x < me.x
}

function update(dt, now) {
  for (const a of agents.values()) {
    const working = a.active && now < a.busyUntil
    const quiet = now - a.lastEventAt > IDLE_LEAVE_MS
    const dest = working || (a.active && !quiet) ? a.work : a.rest

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
      a.pose = working ? 'type' : 'idle'
      // 대화 중이면 상대를 바라본다
      if (a.faceTarget && now < (a.talkUntil ?? 0)) {
        const other = agents.get(a.faceTarget)
        if (other) a.flip = facingFlip(a, other)
      }
    }
  }
}

function frameIndex(pose, t) {
  const speed = pose === 'walk' ? 150 : pose === 'type' ? 130 : 700
  return Math.floor(t / speed) % 2
}

// ---------- 이름표·말풍선(DOM) ----------

function nodesFor(a) {
  let n = nodes.get(a.id)
  if (n) return n
  const tag = document.createElement('div')
  tag.className = 'tag'
  tag.innerHTML = '<span class="name"></span><span class="role"></span>'
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

    tag.style.left = `${x * scale}px`
    tag.style.top = `${(y + 7) * scale}px`
    tag.classList.toggle('on', a.active)
    tag.querySelector('.name').textContent = a.label
    tag.querySelector('.role').textContent = a.id === a.label ? '' : a.id

    let text = null
    let queued = false
    if (a.queued > 0) {
      text = `지시 ${a.queued}건 대기`
      queued = true
    } else if (a.task && (now - a.lastEventAt < 6000 || now < (a.talkUntil ?? 0))) {
      text = a.task
    }
    if (text) {
      bubble.hidden = false
      bubble.textContent = text
      bubble.classList.toggle('queued', queued)
      bubble.style.left = `${x * scale}px`
      bubble.style.top = `${(y - 28) * scale}px`
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
  drawRug(ctx, scale, 4.5, 4.5, 3, 3)

  const items = []
  for (const a of agents.values()) {
    items.push({ kind: 'desk', d: depth(a.desk.gx, a.desk.gy), a })
    items.push({ kind: 'agent', d: depth(a.gx, a.gy), a })
  }
  for (const p of PROPS) items.push({ kind: 'prop', d: depth(p.gx, p.gy), p })
  items.sort((p, q) => p.d - q.d)

  for (const it of items) {
    if (it.kind === 'prop') {
      it.p.draw(ctx, scale, it.p.gx, it.p.gy, t)
      continue
    }
    const a = it.a
    if (it.kind === 'desk') {
      drawWorkstation(ctx, scale, a.desk.gx, a.desk.gy, a.pose === 'type', t)
      continue
    }

    drawShadow(ctx, scale, a.gx, a.gy)
    const { x, y } = toScreen(a.gx, a.gy)
    const frames = POSES[a.pose] ?? POSES.idle
    drawSprite(ctx, frames[frameIndex(a.pose, t)], a.palette, x, y, scale, a.flip)

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
