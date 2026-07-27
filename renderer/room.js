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
// 책상(약 1칸)보다 조금 큰 정도로만. 이전엔 1.9칸 길이에 높이 16이라
// 책상보다 커 보여서 큐비클이 아니라 벽처럼 읽혔다.
const PART_H = 12

export function drawPartitions(ctx, s, gx, gy) {
  // 서쪽 칸막이
  drawBox(ctx, s, gx - 0.62, gy - 0.05, 0.1, 1.3, PART_H, PART_FABRIC)
  drawBox(ctx, s, gx - 0.62, gy - 0.05, 0.14, 1.34, 0.9, PART_RAIL, PART_H)
  // 북쪽 칸막이
  drawBox(ctx, s, gx - 0.05, gy - 0.62, 1.3, 0.1, PART_H, PART_FABRIC)
  drawBox(ctx, s, gx - 0.05, gy - 0.62, 1.34, 0.14, 0.9, PART_RAIL, PART_H)
}

// ── 업무 자리 ─────────────────────────────────────────────────────────────
export function drawWorkstation(ctx, s, gx, gy, screenOn, t) {
  drawAO(ctx, s, gx, gy, 20, 10, 0.18)

  for (const [ox, oy] of [
    [-0.36, -0.36],
    [0.36, -0.36],
    [-0.36, 0.36],
    [0.36, 0.36],
  ]) {
    drawBox(ctx, s, gx + ox, gy + oy, 0.09, 0.09, DESK_H, DESK_LEG)
  }
  drawBox(ctx, s, gx, gy, 1.02, 1.02, 1.6, DESK_TOP, DESK_H - 1.6)
  drawBox(ctx, s, gx + 0.32, gy + 0.3, 0.34, 0.34, DESK_H - 2.4, DRAWER)
  faceQuad(ctx, s, gx + 0.32, gy + 0.47, 'right', 0.2, DESK_H - 5, DESK_H - 4.3, '#8a7659')
  faceQuad(ctx, s, gx + 0.32, gy + 0.47, 'right', 0.2, DESK_H - 7.5, DESK_H - 6.8, '#8a7659')

  drawMonitor(ctx, s, gx - 0.24, gy - 0.24, screenOn, t)
  drawKeyboard(ctx, s, gx + 0.08, gy + 0.06)
  drawMug(ctx, s, gx + 0.44, gy - 0.34)
  drawPapers(ctx, s, gx - 0.42, gy + 0.34)
}

export function drawChair(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 8, 4, 0.14)
  drawBox(ctx, s, gx, gy, 0.4, 0.4, 1.4, CHAIR, 4.6) // 좌판
  drawBox(ctx, s, gx, gy, 0.08, 0.08, 4.6, METAL) // 기둥
  const p = toScreen(gx, gy)
  ctx.fillStyle = '#39424f'
  for (const [dx, dy] of [
    [-5, 1],
    [5, 1],
    [0, 3],
  ]) {
    ctx.fillRect((p.x + dx - 1) * s, (p.y + dy - 1) * s, 2.4 * s, 1.4 * s)
  }
}

export function drawChairBack(ctx, s, gx, gy) {
  drawBox(ctx, s, gx - 0.2, gy - 0.2, 0.38, 0.1, 9, CHAIR_BACK, 6)
}

function drawMonitor(ctx, s, gx, gy, on, t) {
  // 받침 → 목 → 몸통 → 화면. 몸통 높이를 캐릭터(20)보다 낮게 잡는다.
  drawBox(ctx, s, gx, gy, 0.26, 0.2, 0.8, METAL, DESK_H)
  drawBox(ctx, s, gx, gy, 0.06, 0.06, 3, METAL, DESK_H + 0.8)

  const bodyBottom = DESK_H + 3.8
  drawBox(ctx, s, gx, gy, 0.52, 0.1, 8, BEZEL, bodyBottom)

  const yLow = bodyBottom + 0.9
  const yHigh = bodyBottom + 7.2
  if (on) {
    faceQuad(ctx, s, gx, gy + 0.06, 'right', 0.46, yLow, yHigh, '#1d2939')
    const colors = ['#7fd1ff', '#a5e887', '#ffd479', '#ff9ec4']
    for (let i = 0; i < 4; i++) {
      const y0 = yLow + 0.9 + i * 1.5
      const off = ((i * 3 + Math.floor(t / 260)) % 4) * 0.045
      faceQuad(
        ctx,
        s,
        gx - 0.16 + off + (i % 2) * 0.05,
        gy + 0.06,
        'right',
        0.1 + ((i * 7) % 16) / 100,
        y0,
        y0 + 0.8,
        colors[(i + Math.floor(t / 900)) % colors.length],
      )
    }
  } else {
    faceQuad(ctx, s, gx, gy + 0.06, 'right', 0.46, yLow, yHigh, '#c9d6e4')
    faceQuad(ctx, s, gx, gy + 0.06, 'right', 0.46, (yLow + yHigh) / 2, yHigh, '#dde8f2')
  }
  faceQuad(ctx, s, gx + 0.17, gy + 0.06, 'right', 0.05, bodyBottom + 0.2, bodyBottom + 0.7, on ? '#7ee08a' : '#8b93a1')
}

function drawKeyboard(ctx, s, gx, gy) {
  const p = toScreen(gx, gy)
  const w = 15
  const d = 5.5
  ctx.fillStyle = '#eff3f8'
  ctx.beginPath()
  ctx.moveTo(p.x * s, (p.y - DESK_H - d / 2) * s)
  ctx.lineTo((p.x + w / 2) * s, (p.y - DESK_H) * s)
  ctx.lineTo(p.x * s, (p.y - DESK_H + d / 2) * s)
  ctx.lineTo((p.x - w / 2) * s, (p.y - DESK_H) * s)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#c8cfda'
  for (let r = -1; r <= 1; r++) {
    for (let i = -2; i <= 2; i++) {
      ctx.fillRect((p.x + i * 2.4 + r * 1.1) * s, (p.y - DESK_H + r * 1.25 - 0.5) * s, 1.5 * s, 1 * s)
    }
  }
  ctx.fillStyle = '#eff3f8'
  ctx.beginPath()
  ctx.ellipse((p.x + 10.5) * s, (p.y - DESK_H + 1.6) * s, 2 * s, 1.3 * s, 0, 0, Math.PI * 2)
  ctx.fill()
}

function drawMug(ctx, s, gx, gy) {
  drawBox(ctx, s, gx, gy, 0.1, 0.1, 3.6, { top: '#ffffff', left: '#ccd4de', right: '#edf1f6' }, DESK_H)
  const p = toScreen(gx, gy)
  ctx.fillStyle = '#6b4a2f'
  ctx.beginPath()
  ctx.ellipse(p.x * s, (p.y - DESK_H - 3.6) * s, 2 * s, 1 * s, 0, 0, Math.PI * 2)
  ctx.fill()
  faceQuad(ctx, s, gx, gy + 0.05, 'right', 0.09, DESK_H + 1, DESK_H + 2.2, '#e05c5c')
}

function drawPapers(ctx, s, gx, gy) {
  const p = toScreen(gx, gy)
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i === 2 ? '#ffffff' : '#f1f1ec'
    ctx.beginPath()
    ctx.moveTo((p.x + i * 0.5) * s, (p.y - DESK_H - i * 0.6 - 2) * s)
    ctx.lineTo((p.x + 5 + i * 0.5) * s, (p.y - DESK_H - i * 0.6) * s)
    ctx.lineTo((p.x + i * 0.5) * s, (p.y - DESK_H - i * 0.6 + 2) * s)
    ctx.lineTo((p.x - 5 + i * 0.5) * s, (p.y - DESK_H - i * 0.6) * s)
    ctx.closePath()
    ctx.fill()
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
