// 렌더 루프 + 이벤트→행동 매핑 + 개별 지시 전달.
//
// 움직임 규칙:
//   활성 = 자기 책상 앞으로 걸어가 타이핑 / 비활성 = 자리 옆에서 쉼
// **화면의 움직임은 전부 실제 이벤트에서 나온다.** 가짜 활동은 만들지 않는다.

import { POSES, drawSprite } from './sprites.js'
import { buildAgents, agentOrCreate, LEAD_ID } from './agents.js'
import { STAGE_W, STAGE_H, toScreen, toGrid, depth, drawShadow } from './iso.js'
import { drawFloor, drawWalls, drawDesk, drawPlant } from './room.js'

const canvas = document.getElementById('stage')
const ctx = canvas.getContext('2d')
const statusEl = document.getElementById('status')
const projectEl = document.getElementById('project')
const pickBtn = document.getElementById('pick')
const logEl = document.getElementById('log')
const panel = document.getElementById('panel')
const panelName = document.getElementById('panel-name')
const panelInput = document.getElementById('panel-input')
const panelSend = document.getElementById('panel-send')
const panelClose = document.getElementById('panel-close')
const panelHint = document.getElementById('panel-hint')

const BUSY_MS = 2600
const IDLE_LEAVE_MS = 9000

let scale = 3
let agents = buildAgents()
let selected = null
let lastFrame = performance.now()
const logLines = []

function resize() {
  const bar = document.getElementById('bar').offsetHeight
  const logH = logEl.offsetHeight
  const availW = window.innerWidth - 24
  const availH = window.innerHeight - bar - logH - 36
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
      return '작업 시작'
    case 'agent_stop':
      return '완료'
    case 'command':
      return `지시 받음: ${String(ev.detail ?? '').slice(0, 24)}`
    case 'tool': {
      const d = shortPath(ev.detail)
      if (ev.tool === 'Edit' || ev.tool === 'Write') return `${d || '파일'} 수정`
      if (ev.tool === 'Read') return `${d || '파일'} 읽는 중`
      if (ev.tool === 'Bash') return ev.detail ? `$ ${String(ev.detail).slice(0, 26)}` : '명령 실행'
      if (ev.tool === 'Grep' || ev.tool === 'Glob') return '코드 검색'
      if (ev.tool === 'Task') return '팀원 호출'
      return ev.tool || '작업 중'
    }
    case 'prompt':
      return '지시 받는 중'
    case 'session':
      return ev.state === 'idle' ? '대기' : '세션 시작'
    default:
      return ev.type
  }
}

function pushLog(ev, agent) {
  const time = new Date(ev.ts ? ev.ts * 1000 : Date.now())
  const hh = String(time.getHours()).padStart(2, '0')
  const mm = String(time.getMinutes()).padStart(2, '0')
  logLines.unshift(`${hh}:${mm}  ${agent.label.padEnd(4, ' ')}  ${describe(ev)}`)
  if (logLines.length > 7) logLines.pop()
  logEl.textContent = logLines.join('\n')
}

function applyEvent(ev) {
  const now = performance.now()
  const agent = agentOrCreate(agents, ev.agent || LEAD_ID)

  switch (ev.type) {
    case 'agent_start':
      agent.active = true
      agent.busyUntil = now + BUSY_MS
      if (agent.queued > 0) agent.queued--
      break
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
  if (!ev._replay) pushLog(ev, agent)
}

// ---------- 움직임 ----------

function update(dt, now) {
  for (const a of agents.values()) {
    const working = a.active && now < a.busyUntil
    const quiet = now - a.lastEventAt > IDLE_LEAVE_MS
    const target = working || (a.active && !quiet) ? a.work : a.rest

    const dx = target.gx - a.gx
    const dy = target.gy - a.gy
    const dist = Math.hypot(dx, dy)

    if (dist > 0.03) {
      const speed = 1.6 // 칸/초
      const step = Math.min(dist, (speed * dt) / 1000)
      a.gx += (dx / dist) * step
      a.gy += (dy / dist) * step
      a.pose = 'walk'
      // 화면상 왼쪽으로 가는지로 방향을 정한다(아이소라 gx-gy가 기준)
      const screenDir = dx - dy
      if (Math.abs(screenDir) > 0.01) a.flip = screenDir < 0
    } else {
      a.gx = target.gx
      a.gy = target.gy
      a.pose = working ? 'type' : 'idle'
    }
  }
}

function frameIndex(pose, t) {
  const speed = pose === 'walk' ? 150 : pose === 'type' ? 130 : 700
  return Math.floor(t / speed) % 2
}

// ---------- 그리기 ----------

// 이름표·말풍선은 DOM 노드로 관리한다. 캐릭터마다 한 번 만들고 위치만 갱신한다.
const overlay = document.getElementById('overlay')
const nodes = new Map() // id -> { tag, bubble }

function nodesFor(a) {
  let n = nodes.get(a.id)
  if (n) return n
  const tag = document.createElement('div')
  tag.className = 'tag'
  tag.innerHTML = `<span class="name"></span><span class="role"></span>`
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
    tag.style.top = `${(y + 6) * scale}px`
    tag.classList.toggle('on', a.active)
    tag.querySelector('.name').textContent = a.label
    tag.querySelector('.role').textContent = a.id === a.label ? '' : a.id

    let text = null
    let queued = false
    if (a.queued > 0) {
      text = `지시 ${a.queued}건 대기`
      queued = true
    } else if (a.active && now - a.lastEventAt < 6000 && a.task) {
      text = a.task
    }
    if (text) {
      bubble.hidden = false
      bubble.textContent = text
      bubble.classList.toggle('queued', queued)
      bubble.style.left = `${x * scale}px`
      bubble.style.top = `${(y - 26) * scale}px`
    } else {
      bubble.hidden = true
    }
  }
}

function draw(t) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  drawWalls(ctx, scale, t)
  drawFloor(ctx, scale)
  drawPlant(ctx, scale, -0.6, 5.6)
  drawPlant(ctx, scale, 6.6, -0.4)

  // 책상과 캐릭터를 깊이순으로 섞어 그린다(뒤에 있는 것부터)
  const items = []
  for (const a of agents.values()) {
    items.push({ kind: 'desk', d: depth(a.desk.gx, a.desk.gy), a })
    items.push({ kind: 'agent', d: depth(a.gx, a.gy), a })
  }
  items.sort((p, q) => p.d - q.d)

  for (const it of items) {
    const a = it.a
    if (it.kind === 'desk') {
      drawDesk(ctx, scale, a.desk.gx, a.desk.gy, a.pose === 'type', t)
      continue
    }

    drawShadow(ctx, scale, a.gx, a.gy)

    const { x, y } = toScreen(a.gx, a.gy)
    const frames = POSES[a.pose] ?? POSES.idle
    drawSprite(ctx, frames[frameIndex(a.pose, t)], a.palette, x, y, scale, a.flip)

    // 선택 표시
    if (selected === a.id) {
      ctx.strokeStyle = '#7dcfff'
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

// ---------- 클릭 → 개별 지시 ----------

function hitTest(px, py) {
  // 화면 좌표를 논리 좌표로 되돌린 뒤, 캐릭터 발밑 기준 사각형으로 판정한다
  const lx = px / scale
  const ly = py / scale
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

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect()
  const a = hitTest(e.clientX - rect.left, e.clientY - rect.top)
  if (!a) {
    closePanel()
    return
  }
  selected = a.id
  panelName.textContent = `${a.label} (${a.id})`
  panelHint.textContent = ''
  panel.hidden = false
  panelInput.focus()
})

function closePanel() {
  selected = null
  panel.hidden = true
  panelInput.value = ''
}

panelClose.addEventListener('click', closePanel)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePanel()
})

async function sendCommand() {
  const text = panelInput.value.trim()
  if (!text || !selected) return
  panelSend.disabled = true
  panelHint.textContent = '보내는 중…'
  const res = await window.teamView.sendCommand({
    agent: selected,
    text,
    spawn: document.getElementById('panel-spawn').checked,
  })
  panelSend.disabled = false

  if (!res?.ok) {
    panelHint.textContent = `실패: ${res?.error ?? '알 수 없는 오류'}`
    return
  }
  const a = agents.get(selected)
  if (a) a.queued++
  panelHint.textContent = res.spawned
    ? 'Claude Code를 새로 띄워 실행 중입니다'
    : '대기열에 넣었습니다 (다음 턴에 전달됩니다)'
  panelInput.value = ''
}

panelSend.addEventListener('click', sendCommand)
panelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendCommand()
  }
})

// ---------- 배선 ----------

window.teamView.onEvents((events) => events.forEach(applyEvent))
window.teamView.onReset(() => {
  agents = buildAgents()
  nodes.clear()
  overlay.replaceChildren()
  logLines.length = 0
  logEl.textContent = ''
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

resize()
requestAnimationFrame(loop)
