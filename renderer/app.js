// 렌더 루프 + 이벤트 → 행동 매핑.
//
// 규칙은 단순하다:
//   에이전트가 활성 = 자기 책상으로 걸어가 앉아서 타이핑
//   최근 도구 이벤트가 없으면 = 자리에서 쉬거나(idle) 라운지로 돌아감
// 즉 **화면의 움직임은 전부 실제 훅 이벤트에서 나온다.** 가짜 활동은 만들지 않는다.

import { POSES, drawSprite } from './sprites.js'
import { STAGE_W, STAGE_H, buildAgents, agentOrCreate, LEAD_ID } from './agents.js'
import { drawRoom, drawDesk, drawMonitor } from './room.js'

const canvas = document.getElementById('stage')
const ctx = canvas.getContext('2d')
const statusEl = document.getElementById('status')
const projectEl = document.getElementById('project')
const pickBtn = document.getElementById('pick')
const logEl = document.getElementById('log')

const BUSY_MS = 2600 // 도구 이벤트 하나가 만드는 "일하는 중" 지속시간
const IDLE_LEAVE_MS = 9000 // 이만큼 조용하면 자리에서 일어난다

let scale = 3
let agents = buildAgents()
let lastFrame = performance.now()
const logLines = []

function resize() {
  const pad = 16
  const availW = window.innerWidth - pad * 2
  const availH = window.innerHeight - document.getElementById('bar').offsetHeight - pad * 2
  scale = Math.max(1, Math.floor(Math.min(availW / STAGE_W, availH / STAGE_H)))
  canvas.width = STAGE_W * scale
  canvas.height = STAGE_H * scale
  canvas.style.width = `${STAGE_W * scale}px`
  canvas.style.height = `${STAGE_H * scale}px`
  ctx.imageSmoothingEnabled = false
}
window.addEventListener('resize', resize)

// ---------- 이벤트 처리 ----------

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
    case 'tool': {
      const d = shortPath(ev.detail)
      if (ev.tool === 'Edit' || ev.tool === 'Write') return `${d || '파일'} 수정`
      if (ev.tool === 'Read') return `${d || '파일'} 읽는 중`
      if (ev.tool === 'Bash') return ev.detail ? `$ ${String(ev.detail).slice(0, 28)}` : '명령 실행'
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
  logLines.unshift(`${hh}:${mm}  ${agent.label}  ${describe(ev)}`)
  if (logLines.length > 8) logLines.pop()
  logEl.textContent = logLines.join('\n')
}

function applyEvent(ev) {
  const now = performance.now()
  const id = ev.agent || LEAD_ID
  const agent = agentOrCreate(agents, id)

  switch (ev.type) {
    case 'agent_start':
      agent.active = true
      agent.busyUntil = now + BUSY_MS
      break
    case 'agent_stop':
      agent.active = false
      agent.busyUntil = 0
      agent.task = '완료'
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

// ---------- 시뮬레이션 ----------

function update(dt, now) {
  for (const a of agents.values()) {
    const working = a.active && now < a.busyUntil
    const quiet = now - a.lastEventAt > IDLE_LEAVE_MS

    // 목적지: 일하는 중이면 책상 앞, 아니면 자리 아래 라운지
    const target = working || (a.active && !quiet) ? a.seat : { x: a.seat.x, y: a.seat.y + 16 }
    a.tx = target.x
    a.ty = target.y

    const dx = a.tx - a.x
    const dy = a.ty - a.y
    const dist = Math.hypot(dx, dy)

    if (dist > 0.6) {
      const speed = 26 // 논리픽셀/초
      const step = Math.min(dist, (speed * dt) / 1000)
      a.x += (dx / dist) * step
      a.y += (dy / dist) * step
      a.pose = 'walk'
      if (Math.abs(dx) > 0.2) a.flip = dx < 0
    } else {
      a.x = a.tx
      a.y = a.ty
      a.pose = working ? 'type' : 'idle'
    }
  }
}

function frameIndex(pose, t) {
  const speed = pose === 'walk' ? 160 : pose === 'type' ? 130 : 700
  return Math.floor(t / speed) % 2
}

function drawBubble(a, t) {
  if (!a.task) return
  const text = a.task
  const px = 4 // 논리 픽셀 폰트 크기
  ctx.font = `${px * scale}px "Consolas", monospace`
  const w = Math.min(ctx.measureText(text).width / scale + 6, 90)
  const h = 9
  const bx = Math.round(a.x - w / 2)
  const by = Math.round(a.y - 22 - h)

  ctx.fillStyle = 'rgba(16,20,28,0.92)'
  ctx.fillRect(bx * scale, by * scale, w * scale, h * scale)
  ctx.fillStyle = '#39415a'
  ctx.fillRect(bx * scale, by * scale, w * scale, scale)
  ctx.fillRect(bx * scale, (by + h - 1) * scale, w * scale, scale)
  ctx.fillStyle = '#dfe6f5'
  ctx.textBaseline = 'top'
  ctx.fillText(text, (bx + 3) * scale, (by + 2) * scale)
}

function draw(t) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  drawRoom(ctx, scale, t)

  const list = [...agents.values()]

  // 책상·모니터를 먼저(캐릭터 뒤에) 깔고, 캐릭터는 y순으로 그려 앞뒤를 맞춘다
  for (const a of list) {
    drawDesk(ctx, scale, a.seat)
    drawMonitor(ctx, scale, a.seat, a.pose === 'type', t)
  }

  list.sort((p, q) => p.y - q.y)
  for (const a of list) {
    const frames = POSES[a.pose] ?? POSES.idle
    const f = frames[frameIndex(a.pose, t)]
    // 앉은 자세는 책상 뒤에 있으므로 살짝 위로 올려 그린다
    const yOff = a.pose === 'type' ? -2 : 0
    drawSprite(ctx, f, a.palette, a.x, a.y + yOff, scale, a.flip)

    // 이름표
    ctx.font = `${3 * scale}px "Consolas", monospace`
    ctx.fillStyle = a.active ? '#cfe3ff' : '#6f7688'
    ctx.textBaseline = 'top'
    const tw = ctx.measureText(a.label).width
    ctx.fillText(a.label, Math.round(a.x * scale - tw / 2), Math.round((a.y + 2) * scale))
  }

  // 말풍선은 항상 맨 위
  for (const a of list) {
    if (a.active && performance.now() - a.lastEventAt < 6000) drawBubble(a, t)
  }
}

function loop(now) {
  const dt = Math.min(now - lastFrame, 100)
  lastFrame = now
  update(dt, now)
  draw(now)
  requestAnimationFrame(loop)
}

// ---------- 배선 ----------

window.teamView.onEvents((events) => events.forEach(applyEvent))
window.teamView.onReset(() => {
  agents = buildAgents()
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
