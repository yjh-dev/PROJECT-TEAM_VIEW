// 밝은 사무실. 전부 도형으로 그린다(에셋 없음).
//
// 지켜야 할 것 셋:
// 1) **벽은 바닥 가장자리에 딱 붙여** 한 덩어리로 그린다(틈·톱니 방지).
// 2) **벽·상자에 붙는 것은 그 면에 눕힌다**(정면 직사각형은 아이소를 깬다).
// 3) **비율**: 캐릭터가 20단위다. 책상 10, 모니터는 책상 위 10 남짓 — 사람보다
//    커지면 장난감처럼 보인다.

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
  px,
  topSeam,
} from './iso.js'

// ── 팔레트 ────────────────────────────────────────────────────────────────
const FLOOR_A = { top: '#e8d3b4', side: '#c2a582' }
const FLOOR_B = { top: '#e1c9a8', side: '#bb9d7a' }

const WALL_NW_UP = '#efe9de'
const WALL_NW_LOW = '#ddd4c4'
const WALL_NE_UP = '#f8f4ed'
const WALL_NE_LOW = '#e6dfd2'
const WALL_TRIM = '#cabfa9'

const DESK_TOP = { top: '#f2e4cb', left: '#c4ad87', right: '#ddc9a6' }
const DESK_LEG = { top: '#b39a75', left: '#8a7659', right: '#a08c6c' }
const DRAWER = { top: '#e8d9be', left: '#b9a27d', right: '#d2be99' }

const CHAIR = { top: '#66738f', left: '#3c4457', right: '#4f5b74' }
const CHAIR_BACK = { top: '#71809d', left: '#414b60', right: '#5c6982' }

const PART_FABRIC = { top: '#c3ccd8', left: '#93a0b2', right: '#aeb9c8' }
const PART_RAIL = { top: '#e7ecf2', left: '#b6c0cd', right: '#d2dae4' }

const BEZEL = { top: '#3b4351', left: '#232935', right: '#2f3644' }
const METAL = { top: '#9aa3b2', left: '#6d7686', right: '#828c9c' }

const DESK_H = 10

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
  ctx.globalAlpha = 0.12
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
      fillTile(ctx, s, gx + i, gy + j, edge ? '#cdd9e7' : '#e3ecf5', null)
    }
  }
}

// ── 벽 ───────────────────────────────────────────────────────────────────
const WALL_H = 54
const WAINSCOT = 18

export function drawWalls(ctx, s, t) {
  wallQuad(ctx, s, 'nw', 0, GRID, WAINSCOT, WALL_H, WALL_NW_UP)
  wallQuad(ctx, s, 'nw', 0, GRID, 0, WAINSCOT, WALL_NW_LOW)
  wallQuad(ctx, s, 'nw', 0, GRID, WAINSCOT - 1.4, WAINSCOT, WALL_TRIM)

  wallQuad(ctx, s, 'ne', 0, GRID, WAINSCOT, WALL_H, WALL_NE_UP)
  wallQuad(ctx, s, 'ne', 0, GRID, 0, WAINSCOT, WALL_NE_LOW)
  wallQuad(ctx, s, 'ne', 0, GRID, WAINSCOT - 1.4, WAINSCOT, WALL_TRIM)

  // 두 벽이 만나는 모서리
  const c = wallBase('nw', 0)
  ctx.fillStyle = '#e3dbcb'
  ctx.fillRect((c.x - 0.8) * s, (c.y - WALL_H) * s, 1.6 * s, WALL_H * s)

  drawWindow(ctx, s, 'ne', 1.1, t)
  drawWindow(ctx, s, 'ne', 5.6, t)
  drawWindow(ctx, s, 'nw', 5.9, t)
  drawWhiteboard(ctx, s, 'nw', 1.1)
  drawPoster(ctx, s, 'ne', 4.1)
  drawClock(ctx, s, 'nw', 4.5, t)
}

/** 창문 — 틀·유리·창살·블라인드·창턱을 나눠 그린다. */
function drawWindow(ctx, s, side, g, t) {
  const len = 3.0
  const low = 23
  const high = 45
  const mid = (low + high) / 2

  // 바깥 틀(두께가 보이도록 두 겹)
  wallQuad(ctx, s, side, g - 0.16, len + 0.32, low - 2, high + 2, '#f7f7f5')
  wallQuad(ctx, s, side, g - 0.08, len + 0.16, low - 1, high + 1, '#dfe3e8')

  // 유리 — 위가 밝고 아래로 갈수록 진한 하늘
  wallQuad(ctx, s, side, g, len, low, high, '#9ecff0')
  wallQuad(ctx, s, side, g, len, mid, high, '#b9e2fa')
  wallQuad(ctx, s, side, g, len, high - 3, high, '#d6f0ff')

  // 구름 두 조각이 아주 느리게 흐른다
  const d1 = ((t / 9000) % 1) * len
  const d2 = ((t / 13000 + 0.45) % 1) * len
  wallQuad(ctx, s, side, g + d1 * 0.9, 0.55, high - 11, high - 7.5, 'rgba(255,255,255,0.95)')
  wallQuad(ctx, s, side, g + d1 * 0.9 + 0.2, 0.3, high - 13, high - 10, 'rgba(255,255,255,0.9)')
  wallQuad(ctx, s, side, g + d2 * 0.85, 0.42, low + 6, low + 8.5, 'rgba(255,255,255,0.75)')

  // 유리 반사 — 대각으로 지나가는 밝은 띠
  ctx.save()
  ctx.globalAlpha = 0.18
  wallQuad(ctx, s, side, g + 0.15, 0.5, low + 1, high - 1, '#ffffff')
  wallQuad(ctx, s, side, g + 0.85, 0.28, low + 1, high - 1, '#ffffff')
  ctx.restore()

  // 창살 — 세로 둘, 가로 하나
  for (const f of [1 / 3, 2 / 3]) {
    wallQuad(ctx, s, side, g + len * f - 0.045, 0.09, low, high, '#f7f7f5')
  }
  wallQuad(ctx, s, side, g, len, mid - 0.6, mid + 0.6, '#f7f7f5')

  // 블라인드(위쪽에 걷어 올린 상태)
  wallQuad(ctx, s, side, g - 0.1, len + 0.2, high + 1, high + 4, '#e9e4d8')
  for (let i = 0; i < 3; i++) {
    ctx.save()
    ctx.globalAlpha = 0.5
    wallQuad(ctx, s, side, g - 0.1, len + 0.2, high + 1.4 + i, high + 1.8 + i, '#c9c2b2')
    ctx.restore()
  }

  // 창턱
  wallQuad(ctx, s, side, g - 0.24, len + 0.48, low - 3.6, low - 2, '#f0ebdf')
  wallQuad(ctx, s, side, g - 0.24, len + 0.48, low - 4.4, low - 3.6, '#d8d1c1')
}

function drawWhiteboard(ctx, s, side, g) {
  const len = 2.9
  const low = 24
  const high = 43

  wallQuad(ctx, s, side, g - 0.12, len + 0.24, low - 1.2, high + 1.2, '#aab2c0')
  wallQuad(ctx, s, side, g - 0.06, len + 0.12, low - 0.6, high + 0.6, '#dfe4ea')
  wallQuad(ctx, s, side, g, len, low, high, '#fcfdff')

  // 내용: 상자 두 개 + 화살표 + 체크 + 밑줄
  wallQuad(ctx, s, side, g + 0.25, 0.75, high - 9, high - 4.5, '#4a7fd4')
  wallQuad(ctx, s, side, g + 1.45, 0.75, high - 9, high - 4.5, '#4a7fd4')
  wallQuad(ctx, s, side, g + 1.05, 0.36, high - 7, high - 6.4, '#7b8494')
  wallQuad(ctx, s, side, g + 0.25, 1.9, low + 6.5, low + 7.3, '#e05c5c')
  wallQuad(ctx, s, side, g + 0.25, 1.2, low + 4, low + 4.8, '#e05c5c')
  wallQuad(ctx, s, side, g + 2.1, 0.5, low + 4, low + 7.5, '#4caf6d')

  // 마커 받침과 마커 세 개
  wallQuad(ctx, s, side, g - 0.06, len + 0.12, low - 2, low - 0.4, '#c6cdd8')
  const colors = ['#e05c5c', '#4a7fd4', '#4caf6d']
  colors.forEach((c, i) => {
    wallQuad(ctx, s, side, g + 0.35 + i * 0.35, 0.24, low - 1.6, low - 0.8, c)
  })
}

/** 벽 포스터 — 빈 벽을 채운다. */
function drawPoster(ctx, s, side, g) {
  const len = 1.5
  const low = 28
  const high = 41
  wallQuad(ctx, s, side, g - 0.08, len + 0.16, low - 0.8, high + 0.8, '#c9b48f')
  wallQuad(ctx, s, side, g, len, low, high, '#f7f2e6')
  // 단순한 산 그림
  wallQuad(ctx, s, side, g, len, high - 5, high, '#8fc6e8')
  wallQuad(ctx, s, side, g + 0.25, 0.5, low + 2, high - 3, '#6f9e78')
  wallQuad(ctx, s, side, g + 0.7, 0.55, low + 2, high - 1.5, '#5d8a68')
  wallQuad(ctx, s, side, g, len, low, low + 2, '#d8c9a6')
}

function drawClock(ctx, s, side, g, t) {
  const base = wallBase(side, g)
  const step = wallStep(side)
  const cx = base.x + step.dx * 0.4
  const cy = base.y + step.dy * 0.4 - 47
  const r = 4.6

  ctx.save()
  ctx.translate(cx * s, cy * s)
  ctx.scale(1, 0.86) // 벽 기울기만큼 눌러 벽에 붙어 보이게
  ctx.fillStyle = '#3f4756'
  ctx.beginPath()
  ctx.arc(0, 0, (r + 0.9) * s, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fdfdfd'
  ctx.beginPath()
  ctx.arc(0, 0, r * s, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#c3cad6'
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    ctx.fillRect(Math.sin(a) * r * 0.82 * s - s * 0.3, -Math.cos(a) * r * 0.82 * s - s * 0.3, s * 0.6, s * 0.6)
  }
  const sec = (t / 1000) % 60
  const min = (t / 60000) % 60
  ctx.strokeStyle = '#3f4756'
  ctx.lineWidth = Math.max(1, s * 0.55)
  for (const [frac, len_] of [
    [min / 60, 0.6],
    [sec / 60, 0.82],
  ]) {
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(Math.sin(frac * Math.PI * 2) * r * len_ * s, -Math.cos(frac * Math.PI * 2) * r * len_ * s)
    ctx.stroke()
  }
  ctx.restore()
}

// ── 파티션(칸막이) ────────────────────────────────────────────────────────
// 책상의 북·서쪽에만 세운다. 캐릭터보다 뒤에 있으므로 앞을 가리지 않는다.
const PART_H = 12

export function drawPartitions(ctx, s, gx, gy) {
  const panel = (cx, cy, w, d, span) => {
    drawBox(ctx, s, cx, cy, w, d, PART_H, PART_FABRIC)
    const p = toScreen(cx, cy)
    // 패브릭 질감 — 1픽셀 점을 성기게 찍는다(단색 면이 플라스틱처럼 보이는 걸 막는다)
    ctx.save()
    ctx.globalAlpha = 0.16
    for (let i = 0; i < 24; i++) {
      const u = (((i * 37) % 100) / 100 - 0.5) * span * TILE_W * 0.45
      const v = 2 + ((i * 5) % (PART_H - 4))
      px(ctx, s, p.x + u, p.y - PART_H + v, 1, 1, '#5f6d80')
    }
    ctx.restore()
    // 상단 알루미늄 레일 + 하이라이트
    drawBox(ctx, s, cx, cy, w + 0.05, d + 0.05, 0.9, PART_RAIL, PART_H)
    px(ctx, s, p.x - (span * TILE_W) / 4.5, p.y - PART_H - 0.7, (span * TILE_W) / 2.2, 0.7, '#f5f8fc')
  }
  panel(gx - 0.58, gy - 0.04, 0.08, 1.22, 1.22) // 서쪽
  panel(gx - 0.04, gy - 0.58, 1.22, 0.08, 1.22) // 북쪽
}

// ── 업무 자리 ─────────────────────────────────────────────────────────────
export function drawWorkstation(ctx, s, gx, gy, screenOn, t) {
  drawAO(ctx, s, gx, gy, 19, 9.5, 0.2)

  // 다리 — 빛 받는 쪽에 1픽셀 하이라이트
  for (const [ox, oy] of [
    [-0.34, -0.34],
    [0.34, -0.34],
    [-0.34, 0.34],
    [0.34, 0.34],
  ]) {
    drawBox(ctx, s, gx + ox, gy + oy, 0.08, 0.08, DESK_H, DESK_LEG)
    const lp = toScreen(gx + ox, gy + oy)
    px(ctx, s, lp.x - 1.7, lp.y - DESK_H + 0.5, 0.8, DESK_H - 1.5, '#c9b48f')
  }

  // 상판
  drawBox(ctx, s, gx, gy, 1.0, 1.0, 1.5, DESK_TOP, DESK_H - 1.5)
  const p = toScreen(gx, gy)
  for (const f of [-0.3, 0, 0.3]) {
    topSeam(ctx, s, gx, gy, DESK_H, { gx: -0.45, gy: f }, { gx: 0.45, gy: f }, 'rgba(150,120,80,0.22)', 0.7)
  }
  // 앞모서리를 한 줄 어둡게 — 상판 두께가 살아난다
  px(ctx, s, p.x - TILE_W * 0.5, p.y - DESK_H + TILE_H * 0.5 - 0.5, TILE_W, 0.8, 'rgba(120,95,60,0.3)')

  // 서랍장 — 이음매와 손잡이까지
  drawBox(ctx, s, gx + 0.3, gy + 0.28, 0.32, 0.32, DESK_H - 2.2, DRAWER)
  const dp = toScreen(gx + 0.3, gy + 0.28)
  for (const dy of [3.0, 6.2]) {
    px(ctx, s, dp.x - 4.2, dp.y - dy - 0.4, 8.6, 0.7, 'rgba(140,115,80,0.5)')
    px(ctx, s, dp.x - 2.2, dp.y - dy + 1.1, 4.6, 1.1, '#8a7659')
    px(ctx, s, dp.x - 2.2, dp.y - dy + 1.1, 4.6, 0.5, '#c2ab86')
  }

  drawMonitor(ctx, s, gx - 0.2, gy - 0.22, screenOn, t)
  drawKeyboard(ctx, s, gx + 0.04, gy + 0.12)
  drawMug(ctx, s, gx + 0.36, gy - 0.06, t)
  drawPapers(ctx, s, gx - 0.34, gy + 0.32)
}

export function drawChair(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 7.5, 3.8, 0.16)
  const p = toScreen(gx, gy)
  // 5발 받침
  ctx.save()
  ctx.strokeStyle = '#39424f'
  ctx.lineWidth = Math.max(1, 1.4 * s)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.45
    const ex = p.x + Math.cos(a) * 6.2
    const ey = p.y + Math.sin(a) * 3.1
    ctx.beginPath()
    ctx.moveTo(p.x * s, p.y * s)
    ctx.lineTo(ex * s, ey * s)
    ctx.stroke()
    px(ctx, s, ex - 0.9, ey - 0.6, 1.8, 1.2, '#2b3340')
  }
  ctx.restore()
  // 가스 실린더
  px(ctx, s, p.x - 0.9, p.y - 4.6, 1.8, 4.6, '#8d96a5')
  px(ctx, s, p.x - 0.9, p.y - 4.6, 0.7, 4.6, '#b3bcc9')
  // 좌판
  drawBox(ctx, s, gx, gy, 0.38, 0.38, 1.3, CHAIR, 4.6)
  px(ctx, s, p.x - 6, p.y - 5.9, 12, 0.6, '#7b88a3')
}

export function drawChairBack(ctx, s, gx, gy) {
  drawBox(ctx, s, gx - 0.18, gy - 0.18, 0.34, 0.09, 8.5, CHAIR_BACK, 5.9)
  const p = toScreen(gx - 0.18, gy - 0.18)
  // 메시 등받이 — 점을 격자로
  ctx.save()
  ctx.globalAlpha = 0.32
  for (let r = 0; r < 5; r++) {
    for (let c = -3; c <= 3; c++) {
      px(ctx, s, p.x + c * 1.5 + (r % 2) * 0.75, p.y - 7 - r * 1.3, 0.8, 0.8, '#26303f')
    }
  }
  ctx.restore()
  // 팔걸이
  for (const dx of [-6.2, 6.2]) {
    px(ctx, s, p.x + dx - 0.8, p.y - 5.2, 1.6, 3.2, '#4a5568')
    px(ctx, s, p.x + dx - 2.3, p.y - 5.7, 4.6, 1.2, '#5b6981')
  }
}

function drawMonitor(ctx, s, gx, gy, on, t) {
  const p = toScreen(gx, gy)
  drawBox(ctx, s, gx, gy, 0.22, 0.16, 0.7, METAL, DESK_H)
  px(ctx, s, p.x - 0.9, p.y - DESK_H - 3.6, 1.8, 3, '#8d96a5')

  // 베젤 — 캐릭터 키(20)의 절반 정도로 작게
  const bottom = DESK_H + 3.6
  const w = 15
  const h = 9.5
  px(ctx, s, p.x - w / 2, p.y - bottom - h, w, h, '#2f3644')
  px(ctx, s, p.x - w / 2, p.y - bottom - h, w, 0.8, '#4a5464')
  px(ctx, s, p.x - w / 2, p.y - bottom - 1.4, w, 1.4, '#242a35')

  const sx = p.x - w / 2 + 1
  const sy = p.y - bottom - h + 1
  const sw = w - 2
  const sh = h - 3
  if (on) {
    px(ctx, s, sx, sy, sw, sh, '#16202e')
    const colors = ['#7fd1ff', '#a5e887', '#ffd479', '#ff9ec4', '#c4b5fd']
    for (let i = 0; i < 5; i++) {
      const row = sy + 0.7 + i * 1.15
      const indent = ((i * 3 + Math.floor(t / 300)) % 3) * 1.2
      const len = 2.5 + ((i * 5 + Math.floor(t / 700)) % 8)
      px(ctx, s, sx + 0.8 + indent, row, Math.min(len, sw - 1.6 - indent), 0.75, colors[i % colors.length])
    }
    if (Math.floor(t / 500) % 2 === 0) px(ctx, s, sx + 1.2, sy + 0.7 + 5 * 1.15, 0.8, 0.8, '#ffffff')
  } else {
    px(ctx, s, sx, sy, sw, sh, '#c4d2e2')
    px(ctx, s, sx, sy, sw, sh / 2, '#d8e4f0')
    px(ctx, s, sx + 1, sy + 1, 3, 0.7, '#aebccc')
  }
  px(ctx, s, p.x + w / 2 - 2.2, p.y - bottom - 1.1, 1, 0.8, on ? '#7ee08a' : '#7b8494')
  px(ctx, s, p.x - 1.4, p.y - bottom - 1.1, 2.8, 0.7, '#535d6d')
}

function drawKeyboard(ctx, s, gx, gy) {
  const p = toScreen(gx, gy)
  const w = 14
  const d = 5
  // 마우스패드
  ctx.save()
  ctx.globalAlpha = 0.3
  ctx.fillStyle = '#8e9bb0'
  ctx.beginPath()
  ctx.moveTo(p.x * s, (p.y - DESK_H - 3.4) * s)
  ctx.lineTo((p.x + 12) * s, (p.y - DESK_H) * s)
  ctx.lineTo(p.x * s, (p.y - DESK_H + 3.4) * s)
  ctx.lineTo((p.x - 12) * s, (p.y - DESK_H) * s)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  ctx.fillStyle = '#eef2f7'
  ctx.beginPath()
  ctx.moveTo(p.x * s, (p.y - DESK_H - d / 2) * s)
  ctx.lineTo((p.x + w / 2) * s, (p.y - DESK_H) * s)
  ctx.lineTo(p.x * s, (p.y - DESK_H + d / 2) * s)
  ctx.lineTo((p.x - w / 2) * s, (p.y - DESK_H) * s)
  ctx.closePath()
  ctx.fill()
  // 키 — 3줄. 아이소 방향을 따라 조금씩 어긋나게 찍는다
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 6; c++) {
      const u = (c - 2.5) * 2.05 + r * 0.75
      const v = (r - 1) * 1.15
      px(ctx, s, p.x + u - 0.55, p.y - DESK_H + v - 0.45, 1.1, 0.9, '#c2cad7')
    }
  }
  px(ctx, s, p.x - 2.2, p.y - DESK_H + 2.0, 4.6, 0.8, '#c2cad7')
  ctx.fillStyle = '#eef2f7'
  ctx.beginPath()
  ctx.ellipse((p.x + 9.5) * s, (p.y - DESK_H + 1.6) * s, 1.9 * s, 1.2 * s, 0, 0, Math.PI * 2)
  ctx.fill()
  px(ctx, s, p.x + 9.2, p.y - DESK_H + 0.8, 0.6, 1, '#c2cad7')
}

function drawMug(ctx, s, gx, gy, t) {
  const p = toScreen(gx, gy)
  const h = 3.6
  px(ctx, s, p.x - 1.7, p.y - DESK_H - h, 3.4, h, '#ffffff')
  px(ctx, s, p.x + 0.9, p.y - DESK_H - h, 0.8, h, '#d7dee8')
  px(ctx, s, p.x + 1.7, p.y - DESK_H - h + 0.9, 0.9, 1.4, '#e6ecf3')
  px(ctx, s, p.x - 1.7, p.y - DESK_H - h - 0.6, 3.4, 0.7, '#6b4a2f')
  px(ctx, s, p.x - 1.7, p.y - DESK_H - 1.6, 3.4, 0.8, '#e05c5c')
  ctx.save()
  ctx.globalAlpha = 0.45
  for (let i = 0; i < 2; i++) {
    const rise = ((t / 900 + i * 0.5) % 1) * 4
    px(ctx, s, p.x - 0.6 + i * 1.2 + Math.sin(rise * 2) * 0.5, p.y - DESK_H - h - 1.4 - rise, 0.7, 0.7, '#ffffff')
  }
  ctx.restore()
}

function drawPapers(ctx, s, gx, gy) {
  const p = toScreen(gx, gy)
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i === 2 ? '#ffffff' : '#f0f0ea'
    ctx.beginPath()
    ctx.moveTo((p.x + i * 0.5) * s, (p.y - DESK_H - i * 0.55 - 1.9) * s)
    ctx.lineTo((p.x + 4.6 + i * 0.5) * s, (p.y - DESK_H - i * 0.55) * s)
    ctx.lineTo((p.x + i * 0.5) * s, (p.y - DESK_H - i * 0.55 + 1.9) * s)
    ctx.lineTo((p.x - 4.6 + i * 0.5) * s, (p.y - DESK_H - i * 0.55) * s)
    ctx.closePath()
    ctx.fill()
  }
  for (let i = 0; i < 3; i++) {
    topSeam(
      ctx,
      s,
      gx,
      gy,
      DESK_H + 1.2,
      { gx: -0.05, gy: -0.03 + i * 0.03 },
      { gx: 0.05, gy: 0.01 + i * 0.03 },
      'rgba(120,130,150,0.5)',
      0.6,
    )
  }
}

// ── 소품 ─────────────────────────────────────────────────────────────────
export function drawMeetingTable(ctx, s, gx, gy) {
  const H = 10
  drawAO(ctx, s, gx, gy, 30, 15, 0.18)
  for (const [ox, oy] of [
    [-0.55, -0.55],
    [0.55, -0.55],
    [-0.55, 0.55],
    [0.55, 0.55],
  ]) {
    drawBox(ctx, s, gx + ox, gy + oy, 0.1, 0.1, H, DESK_LEG)
  }
  drawBox(ctx, s, gx, gy, 1.75, 1.75, 2, DESK_TOP, H - 2)

  for (const ox of [-0.42, 0.42]) {
    drawBox(ctx, s, gx + ox, gy + 0.05, 0.3, 0.22, 0.7, { top: '#e2e8ef', left: '#b3bac6', right: '#ced5df' }, H)
    drawBox(ctx, s, gx + ox, gy - 0.12, 0.3, 0.05, 4.5, BEZEL, H + 0.7)
    faceQuad(ctx, s, gx + ox, gy - 0.09, 'right', 0.26, H + 1.4, H + 4.6, '#5ca9d6')
  }
  drawBox(ctx, s, gx, gy + 0.45, 0.09, 0.09, 3.2, { top: '#ffffff', left: '#ccd4de', right: '#edf1f6' }, H)

  for (const [ox, oy] of [
    [-1.1, 0],
    [1.1, 0],
    [0, 1.1],
  ]) {
    drawChair(ctx, s, gx + ox, gy + oy)
    drawChairBack(ctx, s, gx + ox, gy + oy)
  }
}

export function drawCoffeeCorner(ctx, s, gx, gy) {
  const H = 11
  drawAO(ctx, s, gx, gy, 18, 9, 0.18)
  drawBox(ctx, s, gx, gy, 1.1, 0.7, H, { top: '#f1e9da', left: '#b5a48a', right: '#dacdb2' })

  // 머신 본체 + 앞면 디테일
  drawBox(ctx, s, gx - 0.16, gy - 0.08, 0.36, 0.28, 11, { top: '#4a5262', left: '#2b303b', right: '#3b4250' }, H)
  faceQuad(ctx, s, gx - 0.16, gy + 0.06, 'right', 0.3, H + 6, H + 9.5, '#232833') // 화면부
  faceQuad(ctx, s, gx - 0.24, gy + 0.06, 'right', 0.07, H + 7.4, H + 8.4, '#e05c5c')
  faceQuad(ctx, s, gx - 0.1, gy + 0.06, 'right', 0.07, H + 7.4, H + 8.4, '#4caf6d')
  faceQuad(ctx, s, gx - 0.16, gy + 0.06, 'right', 0.05, H + 2.5, H + 5, '#9aa2b1') // 노즐
  faceQuad(ctx, s, gx - 0.16, gy + 0.06, 'right', 0.22, H + 0.6, H + 1.2, '#79808e') // 컵 받침

  drawBox(ctx, s, gx + 0.28, gy - 0.08, 0.14, 0.14, 9, { top: '#e2f2fb', left: '#a9c4d4', right: '#c8e0ee' }, H)
  for (const ox of [0.1, 0.28]) {
    drawBox(ctx, s, gx + ox, gy + 0.26, 0.08, 0.08, 2.6, { top: '#ffffff', left: '#ccd4de', right: '#edf1f6' }, H)
  }
}

export function drawPlant(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 9, 4.5, 0.16)
  drawBox(ctx, s, gx, gy, 0.4, 0.4, 6, { top: '#e08a63', left: '#a05a3a', right: '#c9714b' })
  drawBox(ctx, s, gx, gy, 0.42, 0.42, 0.8, { top: '#c9714b', left: '#8f4f33', right: '#b3643f' }, 6)
  const p = toScreen(gx, gy)
  const leaves = [
    [0, -14, 6.5, 4.4, '#4f9152'],
    [-5, -11.5, 5.4, 3.6, '#5aa85d'],
    [5, -11.5, 5.4, 3.6, '#44814a'],
    [-2, -18, 4.6, 3.6, '#63b566'],
    [3, -17, 4.4, 3.2, '#4f9455'],
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
  { gx: 8.7, gy: 5.6, draw: drawPlant },
  { gx: 5.6, gy: 8.7, draw: drawPlant },
]
