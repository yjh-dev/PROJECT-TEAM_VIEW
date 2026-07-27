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

/** 창문 — 6칸 유리, 창틀 두께, 걷어올린 블라인드, 창턱까지 나눠 그린다. */
function drawWindow(ctx, s, side, g, t) {
  const len = 2.8
  const low = 22
  const high = 44
  const H = high - low
  const cols = 3
  const rows = 2

  // 벽에 파인 개구부(안쪽 그림자) → 창틀 → 유리 순서
  wallQuad(ctx, s, side, g - 0.2, len + 0.4, low - 2.4, high + 2.4, 'rgba(120,105,85,0.35)')
  wallQuad(ctx, s, side, g - 0.16, len + 0.32, low - 2, high + 2, '#fbfaf7')
  wallQuad(ctx, s, side, g - 0.16, len + 0.32, high + 1.2, high + 2, '#d9d4c8') // 윗틀 그늘
  wallQuad(ctx, s, side, g - 0.08, len + 0.16, low - 1, high + 1, '#e7e3da')

  // 유리 칸 6개 — 칸마다 하늘 밝기를 조금씩 달리해 유리로 보이게 한다
  const cw = len / cols
  const ch = H / rows
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = g + c * cw + 0.05
      const y0 = low + r * ch + 0.4
      const w = cw - 0.1
      const h = ch - 0.8
      const top = r === rows - 1
      wallQuad(ctx, s, side, x0, w, y0, y0 + h, top ? '#a9d8f2' : '#8ec5e8')
      wallQuad(ctx, s, side, x0, w, y0 + h * 0.55, y0 + h, top ? '#c6e9fb' : '#a6d5ef')
      // 유리 반사 — 칸마다 대각 띠 하나
      ctx.save()
      ctx.globalAlpha = 0.22
      wallQuad(ctx, s, side, x0 + w * 0.15, w * 0.22, y0 + 0.5, y0 + h - 0.5, '#ffffff')
      ctx.restore()
    }
  }

  // 아래 칸 바닥에 도시 실루엣 — 밖에 세상이 있다는 신호
  ctx.save()
  ctx.globalAlpha = 0.35
  for (let i = 0; i < 7; i++) {
    const bw = 0.12 + ((i * 7) % 3) * 0.06
    const bh = 2 + ((i * 5) % 4)
    wallQuad(ctx, s, side, g + 0.15 + i * 0.36, bw, low + 0.6, low + 0.6 + bh, '#7a93ad')
  }
  ctx.restore()

  // 구름 두 조각
  const d1 = ((t / 11000) % 1) * len
  wallQuad(ctx, s, side, g + d1 * 0.85, 0.5, high - 8, high - 5.6, 'rgba(255,255,255,0.95)')
  wallQuad(ctx, s, side, g + d1 * 0.85 + 0.18, 0.28, high - 10, high - 7.6, 'rgba(255,255,255,0.9)')

  // 창살(세로 2 + 가로 1) — 유리 위에
  for (let c = 1; c < cols; c++) {
    wallQuad(ctx, s, side, g + c * cw - 0.05, 0.1, low, high, '#fbfaf7')
  }
  wallQuad(ctx, s, side, g, len, low + ch - 0.45, low + ch + 0.45, '#fbfaf7')

  // 걷어 올린 블라인드 — 슬랫 4장 + 당김줄
  wallQuad(ctx, s, side, g - 0.02, len + 0.04, high - 4.6, high + 0.6, '#efe9dc')
  for (let i = 0; i < 4; i++) {
    wallQuad(ctx, s, side, g - 0.02, len + 0.04, high - 4.2 + i * 1.15, high - 3.7 + i * 1.15, '#d6cfbe')
  }
  wallQuad(ctx, s, side, g + len - 0.35, 0.06, high - 12, high - 4.6, '#cfc7b4')

  // 창턱 — 두 단으로 두께를 준다
  wallQuad(ctx, s, side, g - 0.28, len + 0.56, low - 3.4, low - 1.8, '#f4efe3')
  wallQuad(ctx, s, side, g - 0.28, len + 0.56, low - 4.4, low - 3.4, '#cfc7b6')
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
const PART_H = 11

export function drawPartitions(ctx, s, gx, gy) {
  const panel = (cx, cy, w, d, span) => {
    const p = toScreen(cx, cy)
    drawAO(ctx, s, cx, cy, span * 14, 3.5, 0.14)

    // 패널 본체
    drawBox(ctx, s, cx, cy, w, d, PART_H, PART_FABRIC)

    // 패브릭 짜임 — 가로줄 + 성긴 점. 단색 면이 플라스틱처럼 보이는 걸 막는다.
    const half = (span * TILE_W) / 4
    ctx.save()
    ctx.globalAlpha = 0.14
    for (let i = 1; i < PART_H - 1; i += 2) {
      px(ctx, s, p.x - half, p.y - i, half * 2, 0.6, '#5f6d80')
    }
    ctx.globalAlpha = 0.1
    for (let i = 0; i < 18; i++) {
      px(ctx, s, p.x - half + ((i * 13) % (half * 2)), p.y - 2 - ((i * 5) % (PART_H - 4)), 0.8, 0.8, '#46505f')
    }
    ctx.restore()

    // 양 끝 기둥 — 패널이 공중에 뜬 판때기로 보이지 않게 한다
    for (const e of [-1, 1]) {
      px(ctx, s, p.x + e * half - 1, p.y - PART_H, 2, PART_H, '#9aa6b6')
      px(ctx, s, p.x + e * half - 1, p.y - PART_H, 0.8, PART_H, '#c3ccd8')
      // 받침 발
      px(ctx, s, p.x + e * half - 2.6, p.y - 1.2, 5.2, 1.4, '#7b8798')
    }

    // 상단 레일 + 하이라이트
    drawBox(ctx, s, cx, cy, w + 0.05, d + 0.05, 0.9, PART_RAIL, PART_H)
    px(ctx, s, p.x - half + 1, p.y - PART_H - 0.7, half * 2 - 2, 0.7, '#f6f9fc')
  }
  panel(gx - 0.55, gy - 0.02, 0.07, 1.1, 1.1) // 서쪽
  panel(gx - 0.02, gy - 0.55, 1.1, 0.07, 1.1) // 북쪽
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
  drawAO(ctx, s, gx, gy, 7, 3.5, 0.18)
  const p = toScreen(gx, gy)

  // 5발 받침 — 선 대신 픽셀 조각으로 찍는다(선으로 그으면 낙서처럼 보인다)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.5
    const ux = Math.cos(a)
    const uy = Math.sin(a) * 0.5
    for (let d = 1.5; d <= 6; d += 1.1) {
      px(ctx, s, p.x + ux * d - 0.7, p.y + uy * d - 0.5, 1.5, 1.1, '#3c4453')
    }
    px(ctx, s, p.x + ux * 6.4 - 1, p.y + uy * 6.4 - 0.7, 2, 1.5, '#2a323e')
  }

  // 가스 실린더
  px(ctx, s, p.x - 1, p.y - 5, 2, 5, '#7f8998')
  px(ctx, s, p.x - 1, p.y - 5, 0.8, 5, '#adb6c3')

  // 좌판 — 쿠션 느낌으로 윗면에 밝은 띠
  drawBox(ctx, s, gx, gy, 0.34, 0.34, 1.5, CHAIR, 5)
  px(ctx, s, p.x - 5.5, p.y - 6.6, 11, 0.7, '#8593ad')
  px(ctx, s, p.x - 5.5, p.y - 5.2, 11, 0.6, '#39415240')
}

export function drawChairBack(ctx, s, gx, gy) {
  const p = toScreen(gx - 0.16, gy - 0.16)
  const bw = 12
  const bh = 9
  const bottom = p.y - 6.6

  // 등받이 프레임
  px(ctx, s, p.x - bw / 2, bottom - bh, bw, bh, '#3f4a5e')
  // 메시 — 프레임 안쪽만 밝게 채우고 점을 찍는다
  px(ctx, s, p.x - bw / 2 + 1.2, bottom - bh + 1.2, bw - 2.4, bh - 2.4, '#5b6a86')
  ctx.save()
  ctx.globalAlpha = 0.28
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 6; c++) {
      px(ctx, s, p.x - bw / 2 + 2 + c * 1.5, bottom - bh + 2 + r * 1.3, 0.8, 0.8, '#232c3a')
    }
  }
  ctx.restore()
  // 위쪽 헤드레스트와 하이라이트
  px(ctx, s, p.x - bw / 2 + 1, bottom - bh - 1.4, bw - 2, 1.6, '#4d5a72')
  px(ctx, s, p.x - bw / 2 + 1, bottom - bh - 1.4, bw - 2, 0.6, '#6f7f9d')

  // 팔걸이 — 세로 지지대 + 가로 패드
  for (const e of [-1, 1]) {
    px(ctx, s, p.x + e * 6.4 - 0.7, bottom - 4, 1.4, 4, '#404a5e')
    px(ctx, s, p.x + e * 6.4 - 2.6, bottom - 4.8, 5.2, 1.4, '#59657e')
    px(ctx, s, p.x + e * 6.4 - 2.6, bottom - 4.8, 5.2, 0.6, '#75839f')
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

  // 의자는 테이블과 깊이가 달라서 **PROPS에 따로** 넣는다. 여기서 같이 그리면
  // 테이블 앞 의자가 테이블 깊이로 정렬돼, 그 사이를 지나는 캐릭터와 앞뒤가 뒤집힌다.
}

/** 회의 의자 하나(정렬용으로 분리). */
export function drawMeetingChair(ctx, s, gx, gy) {
  drawChair(ctx, s, gx, gy)
  drawChairBack(ctx, s, gx, gy)
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
  drawAO(ctx, s, gx, gy, 10, 5, 0.2)
  const p = toScreen(gx, gy)

  // 화분 — 아래로 갈수록 좁아지는 사다리꼴을 픽셀 줄로 쌓는다
  const potH = 8
  for (let i = 0; i < potH; i++) {
    const w = 11 - i * 0.55
    const y = p.y - potH + i
    px(ctx, s, p.x - w / 2, y, w, 1.05, i < 2 ? '#d9835c' : '#c9714b')
    px(ctx, s, p.x - w / 2, y, 1.4, 1.05, '#e79a72') // 빛 받는 왼쪽 모서리
    px(ctx, s, p.x + w / 2 - 1.4, y, 1.4, 1.05, '#a75a3a') // 그늘진 오른쪽
  }
  // 테두리(림)와 흙
  px(ctx, s, p.x - 6.4, p.y - potH - 1.6, 12.8, 1.8, '#e08a63')
  px(ctx, s, p.x - 6.4, p.y - potH - 1.6, 12.8, 0.7, '#f0a17b')
  ctx.fillStyle = '#5a4433'
  ctx.beginPath()
  ctx.ellipse(p.x * s, (p.y - potH - 1.2) * s, 5.2 * s, 1.7 * s, 0, 0, Math.PI * 2)
  ctx.fill()

  // 잎 — 줄기 + 잎사귀를 한 장씩. 잎마다 그늘 쪽을 어둡게 찍는다.
  const leaves = [
    [-6, -6, -1, '#4d8f52'],
    [6, -7, 1, '#417f48'],
    [-3.5, -12, -1, '#5aa85d'],
    [3.5, -13, 1, '#4f9455'],
    [0, -17, 0, '#63b566'],
    [-7, -11, -1, '#468649'],
    [7, -12, 1, '#3d7844'],
  ]
  for (const [dx, dy, dir, color] of leaves) {
    const bx = p.x
    const by = p.y - potH - 1.5
    // 줄기
    ctx.save()
    ctx.strokeStyle = '#3f7a45'
    ctx.lineWidth = Math.max(1, 0.9 * s)
    ctx.beginPath()
    ctx.moveTo(bx * s, by * s)
    ctx.lineTo((bx + dx * 0.7) * s, (by + dy * 0.8) * s)
    ctx.stroke()
    ctx.restore()
    // 잎사귀 — 위아래로 좁아지는 픽셀 줄 쌓기
    const lx = bx + dx
    const ly = by + dy
    for (let i = 0; i < 7; i++) {
      const t2 = i / 6
      const w = Math.sin(t2 * Math.PI) * 6.5 + 1
      const y = ly - 3.5 + i
      px(ctx, s, lx - w / 2 + dir * 0.6, y, w, 1.05, color)
    }
    // 잎맥
    px(ctx, s, lx - 0.4 + dir * 0.6, ly - 3.2, 0.8, 6.4, 'rgba(255,255,255,0.22)')
  }
}

export const PROPS = [
  { gx: 2.5, gy: 5.5, draw: drawMeetingTable },
  { gx: 1.4, gy: 5.5, draw: drawMeetingChair },
  { gx: 3.6, gy: 5.5, draw: drawMeetingChair },
  { gx: 2.5, gy: 6.6, draw: drawMeetingChair },
  { gx: 5.5, gy: 2.5, draw: drawCoffeeCorner },
  { gx: 8.7, gy: 5.6, draw: drawPlant },
  { gx: 5.6, gy: 8.7, draw: drawPlant },
]
