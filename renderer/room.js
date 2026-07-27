// 밝은 사무실. 전부 도형으로 그린다(에셋 없음).
//
// 두 가지 원칙:
// 1) **벽은 한 덩어리로 그린다.** 타일마다 조각을 그리면 위쪽 모서리가 톱니가 된다.
// 2) **벽·화면에 붙는 것은 그 면에 눕힌다.** 화면에 정면으로 그리면 그 물건만
//    카메라를 쳐다보는 것처럼 보여 아이소메트릭이 깨진다.

import {
  GRID,
  TILE_H,
  TILE_W,
  toScreen,
  fillTile,
  drawBox,
  wallQuad,
  wallBase,
  wallStep,
  faceQuad,
  drawAO,
} from './iso.js'

// ── 팔레트 ────────────────────────────────────────────────────────────────
const FLOOR_A = { top: '#e6d0af', side: '#c0a37e' }
const FLOOR_B = { top: '#dfc7a3', side: '#b99b76' }

const WALL_NW_UP = '#efe9de' // 왼쪽 벽(광원 반대편이라 살짝 어둡게)
const WALL_NW_LOW = '#ddd4c4'
const WALL_NE_UP = '#f7f3ec' // 오른쪽 벽(빛을 받는 면)
const WALL_NE_LOW = '#e5ded1'
const WALL_TRIM = '#cabfa9'

const DESK_TOP = { top: '#f0e0c4', left: '#c4ad87', right: '#dcc7a3' }
const DESK_LEG = { top: '#b39a75', left: '#8a7659', right: '#a08c6c' }
const DRAWER = { top: '#e6d6ba', left: '#b9a27d', right: '#d0bb96' }

const CHAIR_SEAT = { top: '#63708c', left: '#3c4457', right: '#4e5a72' }
const CHAIR_BACK = { top: '#6f7d9b', left: '#414b60', right: '#5a6780' }

const BEZEL = { top: '#39404e', left: '#232935', right: '#2e3542' }
const STAND = { top: '#4a5262', left: '#2f3644', right: '#3d4453' }

// ── 바닥 ─────────────────────────────────────────────────────────────────
export function drawFloor(ctx, s) {
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const c = (gx + gy) % 2 === 0 ? FLOOR_A : FLOOR_B
      fillTile(ctx, s, gx, gy, c.top, c.side)
      drawPlankLines(ctx, s, gx, gy)
    }
  }
}

function drawPlankLines(ctx, s, gx, gy) {
  const { x, y } = toScreen(gx, gy)
  ctx.save()
  ctx.globalAlpha = 0.14
  ctx.strokeStyle = '#8a6f4d'
  ctx.lineWidth = Math.max(1, s * 0.5)
  for (const f of [-0.3, 0.25]) {
    ctx.beginPath()
    ctx.moveTo((x - TILE_W / 2) * s, (y + f * TILE_H) * s)
    ctx.lineTo(x * s, (y + f * TILE_H + TILE_H / 2) * s)
    ctx.stroke()
  }
  ctx.restore()
}

export function drawRug(ctx, s, gx, gy, w = 3, d = 3) {
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < d; j++) {
      const edge = i === 0 || j === 0 || i === w - 1 || j === d - 1
      fillTile(ctx, s, gx + i, gy + j, edge ? '#cfdce9' : '#e2ecf5', null)
    }
  }
}

// ── 벽 (한 덩어리) ────────────────────────────────────────────────────────
const WALL_H = 56
const WAINSCOT = 19

export function drawWalls(ctx, s, t) {
  // 왼쪽 벽 — gy = -1 라인을 따라 0..GRID 까지 한 번에
  wallQuad(ctx, s, 'nw', 0, GRID, WAINSCOT, WALL_H, WALL_NW_UP)
  wallQuad(ctx, s, 'nw', 0, GRID, 0, WAINSCOT, WALL_NW_LOW)
  wallQuad(ctx, s, 'nw', 0, GRID, WAINSCOT - 1.5, WAINSCOT, WALL_TRIM)

  // 오른쪽 벽
  wallQuad(ctx, s, 'ne', 0, GRID, WAINSCOT, WALL_H, WALL_NE_UP)
  wallQuad(ctx, s, 'ne', 0, GRID, 0, WAINSCOT, WALL_NE_LOW)
  wallQuad(ctx, s, 'ne', 0, GRID, WAINSCOT - 1.5, WAINSCOT, WALL_TRIM)

  // 벽이 만나는 모서리 기둥 — 두 면 사이에 경계를 준다
  const c = toScreen(-1, -1)
  ctx.fillStyle = '#e0d8c8'
  ctx.fillRect((c.x - 1) * s, (c.y - WALL_H) * s, 2 * s, WALL_H * s)

  drawWindow(ctx, s, 'ne', 1.2, t)
  drawWindow(ctx, s, 'ne', 5.2, t)
  drawWindow(ctx, s, 'nw', 6.2, t)
  drawWhiteboard(ctx, s, 'nw', 1.4)
  drawClock(ctx, s, 'ne', 3.9, t)
}

/** 창문 — 벽면에 눕혀 그린다. */
function drawWindow(ctx, s, side, g, t) {
  const gLen = 2.2
  const low = 24
  const high = 46

  wallQuad(ctx, s, side, g - 0.12, gLen + 0.24, low - 1.5, high + 1.5, '#ffffff')
  wallQuad(ctx, s, side, g, gLen, low, high, '#a9d9f4')
  wallQuad(ctx, s, side, g, gLen, (low + high) / 2, high, '#c6e9fb') // 위쪽이 더 밝은 하늘

  // 구름 — 창 안에서 천천히 흐른다
  const drift = ((t / 4000) % 1) * gLen
  wallQuad(ctx, s, side, g + drift * 0.7, 0.5, high - 12, high - 8, 'rgba(255,255,255,0.95)')
  wallQuad(ctx, s, side, g + ((drift + 1.1) % gLen), 0.35, low + 5, low + 8, 'rgba(255,255,255,0.8)')

  // 창살
  wallQuad(ctx, s, side, g, gLen, (low + high) / 2 - 0.8, (low + high) / 2 + 0.8, '#ffffff')
  wallQuad(ctx, s, side, g + gLen / 2 - 0.04, 0.08, low, high, '#ffffff')

  // 창턱
  wallQuad(ctx, s, side, g - 0.2, gLen + 0.4, low - 3.5, low - 1.5, '#e9e2d4')
}

function drawWhiteboard(ctx, s, side, g) {
  const gLen = 2.6
  const low = 24
  const high = 44

  wallQuad(ctx, s, side, g - 0.1, gLen + 0.2, low - 1, high + 1, '#aeb6c4')
  wallQuad(ctx, s, side, g, gLen, low, high, '#fbfcfe')

  // 낙서 — 상자 두 개와 밑줄
  wallQuad(ctx, s, side, g + 0.3, 0.7, high - 8, high - 4, '#4a7fd4')
  wallQuad(ctx, s, side, g + 1.3, 0.7, high - 8, high - 4, '#4a7fd4')
  wallQuad(ctx, s, side, g + 1.05, 0.25, high - 6.5, high - 5.5, '#7b8494')
  wallQuad(ctx, s, side, g + 0.3, 1.6, low + 5, low + 6, '#e05c5c')
  wallQuad(ctx, s, side, g + 0.3, 1.0, low + 2.5, low + 3.5, '#e05c5c')

  // 마커 받침
  wallQuad(ctx, s, side, g, gLen, low - 1.5, low, '#cfd6e0')
}

function drawClock(ctx, s, side, g, t) {
  const base = wallBase(side, g)
  const step = wallStep(side)
  const cx = base.x + step.dx * 0.35
  const cy = base.y + step.dy * 0.35 - 49
  const r = 5

  ctx.save()
  // 벽 기울기에 맞춰 살짝 눌러 그린다(정면 원이면 벽에서 떠 보인다)
  ctx.translate(cx * s, cy * s)
  ctx.scale(1, 0.86)
  ctx.fillStyle = '#454d5c'
  ctx.beginPath()
  ctx.arc(0, 0, (r + 1) * s, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fdfdfd'
  ctx.beginPath()
  ctx.arc(0, 0, r * s, 0, Math.PI * 2)
  ctx.fill()

  const sec = (t / 1000) % 60
  ctx.strokeStyle = '#454d5c'
  ctx.lineWidth = Math.max(1, s * 0.5)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(Math.sin((sec / 60) * Math.PI * 2) * r * 0.8 * s, -Math.cos((sec / 60) * Math.PI * 2) * r * 0.8 * s)
  ctx.stroke()
  ctx.restore()
}

// ── 업무 자리 ─────────────────────────────────────────────────────────────
const DESK_H = 11

export function drawWorkstation(ctx, s, gx, gy, screenOn, t) {
  drawAO(ctx, s, gx, gy, 22, 11, 0.2)

  for (const [ox, oy] of [
    [-0.34, -0.34],
    [0.34, -0.34],
    [-0.34, 0.34],
    [0.34, 0.34],
  ]) {
    drawBox(ctx, s, gx + ox, gy + oy, 0.1, 0.1, DESK_H, DESK_LEG)
  }
  drawBox(ctx, s, gx, gy, 1.05, 1.05, 2, DESK_TOP, DESK_H - 2)
  drawBox(ctx, s, gx + 0.3, gy + 0.3, 0.36, 0.36, DESK_H - 3, DRAWER)

  // 서랍 손잡이 — 서랍 앞면에 눕혀 붙인다
  faceQuad(ctx, s, gx + 0.3, gy + 0.48, 'right', 0.22, DESK_H - 6, DESK_H - 5.2, '#8a7659')
  faceQuad(ctx, s, gx + 0.3, gy + 0.48, 'right', 0.22, DESK_H - 9, DESK_H - 8.2, '#8a7659')

  drawMonitor(ctx, s, gx - 0.22, gy - 0.22, screenOn, t)
  drawKeyboard(ctx, s, gx + 0.1, gy + 0.1)
  drawMug(ctx, s, gx + 0.42, gy - 0.3)
  drawPapers(ctx, s, gx - 0.44, gy + 0.32)
}

/** 의자. 캐릭터가 앉는 자리이므로 캐릭터보다 **먼저** 그린다. */
export function drawChair(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 9, 4.5, 0.16)
  drawBox(ctx, s, gx, gy, 0.1, 0.1, 5, CHAIR_SEAT)
  drawBox(ctx, s, gx, gy, 0.52, 0.52, 1.6, CHAIR_SEAT, 5)
  const p = toScreen(gx, gy)
  ctx.fillStyle = '#3c4658'
  for (const dx of [-6, 0, 6]) ctx.fillRect((p.x + dx - 1) * s, (p.y - 1) * s, 2.5 * s, 1.5 * s)
}

/** 의자 등받이는 캐릭터 **뒤**에 있으므로 따로 그린다. */
export function drawChairBack(ctx, s, gx, gy) {
  drawBox(ctx, s, gx - 0.24, gy - 0.24, 0.46, 0.14, 11, CHAIR_BACK, 6.6)
}

function drawMonitor(ctx, s, gx, gy, on, t) {
  drawBox(ctx, s, gx, gy, 0.3, 0.3, 2, STAND, DESK_H)
  drawBox(ctx, s, gx, gy, 0.08, 0.08, 6, STAND, DESK_H + 2)

  // 모니터 몸통을 상자로 세우고, 화면은 그 앞면에 눕힌다
  const top = DESK_H + 8
  drawBox(ctx, s, gx, gy, 0.62, 0.16, 14, BEZEL, top)

  const yLow = top + 1.5
  const yHigh = top + 12.5
  if (on) {
    faceQuad(ctx, s, gx, gy + 0.09, 'right', 0.56, yLow, yHigh, '#1d2939')
    const colors = ['#7fd1ff', '#a5e887', '#ffd479', '#ff9ec4']
    for (let i = 0; i < 5; i++) {
      const y0 = yLow + 1.2 + i * 2
      const off = ((i * 3 + Math.floor(t / 240)) % 5) * 0.05
      ctx.globalAlpha = 0.95
      faceQuad(
        ctx,
        s,
        gx - 0.2 + off + (i % 2) * 0.06,
        gy + 0.09,
        'right',
        0.12 + ((i * 7) % 20) / 100,
        y0,
        y0 + 1.1,
        colors[(i + Math.floor(t / 800)) % colors.length],
      )
      ctx.globalAlpha = 1
    }
  } else {
    faceQuad(ctx, s, gx, gy + 0.09, 'right', 0.56, yLow, yHigh, '#c9d6e4')
    faceQuad(ctx, s, gx, gy + 0.09, 'right', 0.56, (yLow + yHigh) / 2, yHigh, '#dbe6f1')
  }

  // 전원 램프
  faceQuad(ctx, s, gx + 0.2, gy + 0.09, 'right', 0.06, top + 0.4, top + 1.1, on ? '#7ee08a' : '#8b93a1')
}

function drawKeyboard(ctx, s, gx, gy) {
  const p = toScreen(gx, gy)
  const w = 17
  const d = 6
  ctx.fillStyle = '#edf1f6'
  ctx.beginPath()
  ctx.moveTo(p.x * s, (p.y - DESK_H - d / 2) * s)
  ctx.lineTo((p.x + w / 2) * s, (p.y - DESK_H) * s)
  ctx.lineTo(p.x * s, (p.y - DESK_H + d / 2) * s)
  ctx.lineTo((p.x - w / 2) * s, (p.y - DESK_H) * s)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#c3cad6'
  for (let r = -1; r <= 1; r++) {
    for (let i = -2; i <= 2; i++) {
      ctx.fillRect((p.x + i * 2.6 + r * 1.2) * s, (p.y - DESK_H + r * 1.4 - 0.6) * s, 1.6 * s, 1.1 * s)
    }
  }
  ctx.fillStyle = '#edf1f6'
  ctx.beginPath()
  ctx.ellipse((p.x + 12) * s, (p.y - DESK_H + 1.5) * s, 2.2 * s, 1.5 * s, 0, 0, Math.PI * 2)
  ctx.fill()
}

function drawMug(ctx, s, gx, gy) {
  drawBox(ctx, s, gx, gy, 0.12, 0.12, 5, { top: '#ffffff', left: '#cfd6e0', right: '#eef2f7' }, DESK_H)
  const p = toScreen(gx, gy)
  ctx.fillStyle = '#6b4a2f'
  ctx.beginPath()
  ctx.ellipse(p.x * s, (p.y - DESK_H - 5) * s, 2.4 * s, 1.2 * s, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#e05c5c'
  faceQuad(ctx, s, gx, gy + 0.06, 'right', 0.11, DESK_H + 1.5, DESK_H + 3, '#e05c5c')
}

function drawPapers(ctx, s, gx, gy) {
  const p = toScreen(gx, gy)
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i === 2 ? '#ffffff' : '#f1f1ec'
    ctx.beginPath()
    ctx.moveTo((p.x + i * 0.6) * s, (p.y - DESK_H - i * 0.7 - 2.2) * s)
    ctx.lineTo((p.x + 5.5 + i * 0.6) * s, (p.y - DESK_H - i * 0.7) * s)
    ctx.lineTo((p.x + i * 0.6) * s, (p.y - DESK_H - i * 0.7 + 2.2) * s)
    ctx.lineTo((p.x - 5.5 + i * 0.6) * s, (p.y - DESK_H - i * 0.7) * s)
    ctx.closePath()
    ctx.fill()
  }
}

// ── 소품 ─────────────────────────────────────────────────────────────────
export function drawMeetingTable(ctx, s, gx, gy) {
  const H = 11
  drawAO(ctx, s, gx, gy, 34, 17, 0.2)
  for (const [ox, oy] of [
    [-0.6, -0.6],
    [0.6, -0.6],
    [-0.6, 0.6],
    [0.6, 0.6],
  ]) {
    drawBox(ctx, s, gx + ox, gy + oy, 0.12, 0.12, H, DESK_LEG)
  }
  drawBox(ctx, s, gx, gy, 1.9, 1.9, 2.4, DESK_TOP, H - 2.4)

  // 노트북 두 대 — 화면을 면에 눕힌다
  for (const ox of [-0.45, 0.45]) {
    drawBox(ctx, s, gx + ox, gy, 0.34, 0.26, 1, { top: '#dfe5ec', left: '#b3bac6', right: '#cdd4de' }, H)
    drawBox(ctx, s, gx + ox, gy - 0.16, 0.34, 0.06, 6, BEZEL, H + 1)
    faceQuad(ctx, s, gx + ox, gy - 0.13, 'right', 0.3, H + 2, H + 6.4, '#5ca9d6')
  }
  drawBox(ctx, s, gx, gy + 0.5, 0.1, 0.1, 4, { top: '#ffffff', left: '#cfd6e0', right: '#eef2f7' }, H)

  drawChair(ctx, s, gx - 1.15, gy)
  drawChairBack(ctx, s, gx - 1.15, gy)
  drawChair(ctx, s, gx + 1.15, gy)
  drawChairBack(ctx, s, gx + 1.15, gy)
  drawChair(ctx, s, gx, gy + 1.15)
  drawChairBack(ctx, s, gx, gy + 1.15)
}

export function drawCoffeeCorner(ctx, s, gx, gy) {
  const H = 12
  drawAO(ctx, s, gx, gy, 20, 10, 0.2)
  drawBox(ctx, s, gx, gy, 1.15, 0.75, H, { top: '#f0e8d9', left: '#b5a48a', right: '#d8caaf' })

  // 커피머신 — 상자로 세우고 앞면에 버튼/노즐을 붙인다
  drawBox(ctx, s, gx - 0.18, gy - 0.1, 0.42, 0.32, 15, { top: '#454c5b', left: '#2b303b', right: '#3a4150' }, H)
  faceQuad(ctx, s, gx - 0.18, gy + 0.06, 'right', 0.36, H + 9, H + 13, '#2b303b')
  faceQuad(ctx, s, gx - 0.28, gy + 0.06, 'right', 0.08, H + 10.5, H + 12, '#e05c5c')
  faceQuad(ctx, s, gx - 0.1, gy + 0.06, 'right', 0.05, H + 4, H + 7, '#9aa2b1')

  // 물통
  drawBox(ctx, s, gx + 0.3, gy - 0.1, 0.16, 0.16, 12, { top: '#dff0fa', left: '#a9c4d4', right: '#c8e0ee' }, H)

  // 컵 두 개
  for (const ox of [0.12, 0.3]) {
    drawBox(ctx, s, gx + ox, gy + 0.28, 0.09, 0.09, 3.2, { top: '#ffffff', left: '#cfd6e0', right: '#eef2f7' }, H)
  }
}

export function drawPlant(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 10, 5, 0.18)
  drawBox(ctx, s, gx, gy, 0.44, 0.44, 7, { top: '#e08a63', left: '#a05a3a', right: '#c9714b' })
  const p = toScreen(gx, gy)
  const leaves = [
    [0, -16, 7.5, 5, '#4f9152'],
    [-5.5, -13, 6, 4, '#5aa85d'],
    [5.5, -13, 6, 4, '#44814a'],
    [-2, -21, 5, 4, '#63b566'],
    [3, -20, 5, 3.5, '#4f9455'],
  ]
  for (const [dx, dy, rx, ry, color] of leaves) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.ellipse((p.x + dx) * s, (p.y + dy) * s, rx * s, ry * s, 0, 0, Math.PI * 2)
    ctx.fill()
  }
}

export const PROPS = [
  { gx: 2.5, gy: 5.5, draw: drawMeetingTable },
  { gx: 5.5, gy: 2.5, draw: drawCoffeeCorner },
  { gx: 8.6, gy: 5.5, draw: drawPlant },
  { gx: 5.5, gy: 8.6, draw: drawPlant },
]
