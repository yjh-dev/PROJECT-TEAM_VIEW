// 밝은 사무실. 전부 도형으로 그린다(에셋 없음).
//
// 색은 실제 사무실에서 가져왔다: 밝은 오크 바닥, 크림색 벽에 낮은 웨인스코팅,
// 낮 하늘이 보이는 창. 가구는 "상자 하나"로 끝내지 않고 상판·다리·서랍·의자·
// 키보드·머그처럼 눈에 보이는 부품을 각각 그린다.

import { GRID, TILE_H, TILE_W, toScreen, fillTile, drawBox } from './iso.js'

// ── 팔레트 ────────────────────────────────────────────────────────────────
const FLOOR_A = { top: '#e2cba8', side: '#bfa17c' }
const FLOOR_B = { top: '#dcc39f', side: '#b99a75' }

const WALL_UPPER = '#f4f0e8'
const WALL_UPPER_R = '#eae4d9'
const WALL_LOWER = '#dfd8ca'
const WALL_LOWER_R = '#d3cabb'
const WALL_TRIM = '#c8bda9'

const DESK_TOP = { top: '#f0e0c4', left: '#c9b28c', right: '#dcc7a3' }
const DESK_LEG = { top: '#b39a75', left: '#8d7a5e', right: '#a08c6c' }
const DRAWER = { top: '#e6d6ba', left: '#bda681', right: '#d0bb96' }

const CHAIR_SEAT = { top: '#5f6a82', left: '#3f4759', right: '#4e5769' }
const CHAIR_BACK = { top: '#6b7791', left: '#454e62', right: '#586377' }

const BEZEL = { top: '#3a4150', left: '#252b36', right: '#2f3542' }
const STAND = { top: '#4a5262', left: '#333a47', right: '#3d4453' }

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

/** 마루널 결. 타일 하나에 얇은 선 두 줄이면 나무처럼 읽힌다. */
function drawPlankLines(ctx, s, gx, gy) {
  const { x, y } = toScreen(gx, gy)
  ctx.save()
  ctx.globalAlpha = 0.16
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

/** 회의 구역에 까는 러그. 바닥 위, 가구 아래. */
export function drawRug(ctx, s, gx, gy, w = 3, d = 3) {
  ctx.save()
  ctx.globalAlpha = 0.9
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < d; j++) {
      const edge = i === 0 || j === 0 || i === w - 1 || j === d - 1
      fillTile(ctx, s, gx + i, gy + j, edge ? '#c9d8e6' : '#dde8f2', null)
    }
  }
  ctx.restore()
}

// ── 벽 ───────────────────────────────────────────────────────────────────
export function drawWalls(ctx, s, t) {
  const H = 52
  const LOW = 18 // 웨인스코팅 높이

  for (let gy = 0; gy < GRID; gy++) {
    drawWallPanel(ctx, s, -1, gy, H, LOW, WALL_UPPER, WALL_LOWER)
  }
  for (let gx = 0; gx < GRID; gx++) {
    drawWallPanel(ctx, s, gx, -1, H, LOW, WALL_UPPER_R, WALL_LOWER_R)
  }

  drawWindow(ctx, s, 2, -1, t)
  drawWindow(ctx, s, 6, -1, t)
  drawWindow(ctx, s, -1, 6, t)
  drawWhiteboard(ctx, s, -1, 2)
  drawClock(ctx, s, 4.6, -1, t)
}

function drawWallPanel(ctx, s, gx, gy, h, low, upper, lower) {
  const { x, y } = toScreen(gx, gy)
  const hw = TILE_W / 2
  const hh = TILE_H / 2

  // 위쪽(도배) 면
  ctx.beginPath()
  ctx.moveTo((x - hw) * s, (y - h) * s)
  ctx.lineTo(x * s, (y - h + hh) * s)
  ctx.lineTo((x + hw) * s, (y - h) * s)
  ctx.lineTo((x + hw) * s, (y - low) * s)
  ctx.lineTo(x * s, (y - low + hh) * s)
  ctx.lineTo((x - hw) * s, (y - low) * s)
  ctx.closePath()
  ctx.fillStyle = upper
  ctx.fill()

  // 아래쪽(웨인스코팅) 면
  ctx.beginPath()
  ctx.moveTo((x - hw) * s, (y - low) * s)
  ctx.lineTo(x * s, (y - low + hh) * s)
  ctx.lineTo((x + hw) * s, (y - low) * s)
  ctx.lineTo((x + hw) * s, y * s)
  ctx.lineTo(x * s, (y + hh) * s)
  ctx.lineTo((x - hw) * s, y * s)
  ctx.closePath()
  ctx.fillStyle = lower
  ctx.fill()

  // 몰딩 두 줄
  ctx.fillStyle = WALL_TRIM
  ctx.beginPath()
  ctx.moveTo((x - hw) * s, (y - low) * s)
  ctx.lineTo(x * s, (y - low + hh) * s)
  ctx.lineTo((x + hw) * s, (y - low) * s)
  ctx.lineTo((x + hw) * s, (y - low + 1.5) * s)
  ctx.lineTo(x * s, (y - low + hh + 1.5) * s)
  ctx.lineTo((x - hw) * s, (y - low + 1.5) * s)
  ctx.closePath()
  ctx.fill()
}

function drawWindow(ctx, s, gx, gy, t) {
  const { x, y } = toScreen(gx, gy)
  const w = 30
  const h = 24
  const cy = y - 34

  // 창틀
  ctx.fillStyle = '#ffffff'
  ctx.fillRect((x - w / 2 - 2) * s, (cy - h / 2 - 2) * s, (w + 4) * s, (h + 4) * s)

  // 하늘 그라데이션 대신 두 단계 — 도트 느낌을 유지한다
  ctx.fillStyle = '#a8d8f5'
  ctx.fillRect((x - w / 2) * s, (cy - h / 2) * s, w * s, h * s)
  ctx.fillStyle = '#c3e6fb'
  ctx.fillRect((x - w / 2) * s, (cy - h / 2) * s, w * s, (h / 2) * s)

  // 구름 — 아주 느리게 흐른다
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  for (let i = 0; i < 2; i++) {
    const drift = ((t / 90 + i * 40) % (w + 16)) - 8
    const cxp = x - w / 2 + drift
    const cyp = cy - h / 4 + i * 7
    if (cxp > x - w / 2 - 6 && cxp < x + w / 2) {
      ctx.fillRect(cxp * s, cyp * s, 7 * s, 2 * s)
      ctx.fillRect((cxp + 1) * s, (cyp - 2) * s, 4 * s, 2 * s)
    }
  }

  // 창살
  ctx.fillStyle = '#ffffff'
  ctx.fillRect((x - w / 2) * s, cy * s, w * s, 1.5 * s)
  ctx.fillRect(x * s, (cy - h / 2) * s, 1.5 * s, h * s)

  // 창턱
  ctx.fillStyle = '#e8e2d6'
  ctx.fillRect((x - w / 2 - 3) * s, (cy + h / 2 + 2) * s, (w + 6) * s, 2 * s)
}

function drawWhiteboard(ctx, s, gx, gy) {
  const { x, y } = toScreen(gx, gy)
  const w = 34
  const h = 22
  const cy = y - 32

  ctx.fillStyle = '#b9c0cc'
  ctx.fillRect((x - w / 2 - 1) * s, (cy - h / 2 - 1) * s, (w + 2) * s, (h + 2) * s)
  ctx.fillStyle = '#fbfcfe'
  ctx.fillRect((x - w / 2) * s, (cy - h / 2) * s, w * s, h * s)

  // 낙서 — 순서도 비슷한 것
  ctx.fillStyle = '#4a7fd4'
  ctx.fillRect((x - 12) * s, (cy - 6) * s, 8 * s, 5 * s)
  ctx.fillRect((x + 2) * s, (cy - 6) * s, 8 * s, 5 * s)
  ctx.fillStyle = '#6b7280'
  ctx.fillRect((x - 4) * s, (cy - 4) * s, 6 * s, s)
  ctx.fillStyle = '#e05c5c'
  ctx.fillRect((x - 12) * s, (cy + 3) * s, 14 * s, s)
  ctx.fillRect((x - 12) * s, (cy + 6) * s, 9 * s, s)

  // 마커 받침
  ctx.fillStyle = '#cfd6e0'
  ctx.fillRect((x - w / 2) * s, (cy + h / 2) * s, w * s, 1.5 * s)
  ctx.fillStyle = '#e05c5c'
  ctx.fillRect((x - 6) * s, (cy + h / 2 - 1) * s, 4 * s, s)
}

function drawClock(ctx, s, gx, gy, t) {
  const { x, y } = toScreen(gx, gy)
  const cy = y - 44
  const r = 5
  ctx.fillStyle = '#3f4756'
  ctx.beginPath()
  ctx.arc(x * s, cy * s, (r + 1) * s, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fdfdfd'
  ctx.beginPath()
  ctx.arc(x * s, cy * s, r * s, 0, Math.PI * 2)
  ctx.fill()

  const sec = (t / 1000) % 60
  ctx.strokeStyle = '#3f4756'
  ctx.lineWidth = Math.max(1, s * 0.6)
  ctx.beginPath()
  ctx.moveTo(x * s, cy * s)
  ctx.lineTo((x + Math.sin((sec / 60) * Math.PI * 2) * r * 0.8) * s, (cy - Math.cos((sec / 60) * Math.PI * 2) * r * 0.8) * s)
  ctx.stroke()
}

// ── 업무 자리(책상 한 세트) ───────────────────────────────────────────────
export function drawWorkstation(ctx, s, gx, gy, screenOn, t) {
  const DESK_H = 11

  // 다리 네 개 → 상판 → 서랍 순으로 그려야 가구처럼 보인다
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

  // 서랍 손잡이 두 개
  const dr = toScreen(gx + 0.3, gy + 0.3)
  ctx.fillStyle = '#8d7a5e'
  ctx.fillRect((dr.x + 2) * s, (dr.y - 6) * s, 5 * s, 1.2 * s)
  ctx.fillRect((dr.x + 2) * s, (dr.y - 2) * s, 5 * s, 1.2 * s)

  drawChair(ctx, s, gx - 0.05, gy - 1.0)
  drawMonitor(ctx, s, gx - 0.2, gy - 0.2, DESK_H, screenOn, t)
  drawKeyboard(ctx, s, gx + 0.12, gy + 0.12, DESK_H)
  drawMug(ctx, s, gx + 0.42, gy - 0.28, DESK_H)
  drawPapers(ctx, s, gx - 0.42, gy + 0.3, DESK_H)
}

function drawChair(ctx, s, gx, gy) {
  drawBox(ctx, s, gx, gy, 0.1, 0.1, 5, CHAIR_SEAT) // 기둥
  drawBox(ctx, s, gx, gy, 0.5, 0.5, 1.5, CHAIR_SEAT, 5) // 좌판
  drawBox(ctx, s, gx - 0.22, gy - 0.22, 0.42, 0.12, 10, CHAIR_BACK, 6.5) // 등받이

  // 바퀴 다리
  const p = toScreen(gx, gy)
  ctx.fillStyle = '#3f4759'
  for (const dx of [-6, 0, 6]) {
    ctx.fillRect((p.x + dx - 1) * s, (p.y - 1) * s, 2.5 * s, 1.5 * s)
  }
}

function drawMonitor(ctx, s, gx, gy, deskH, on, t) {
  const p = toScreen(gx, gy)
  drawBox(ctx, s, gx, gy, 0.28, 0.28, 2, STAND, deskH) // 받침
  drawBox(ctx, s, gx, gy, 0.07, 0.07, 6, STAND, deskH + 2) // 목

  const w = 20
  const h = 13
  const sx = p.x - w / 2
  const sy = p.y - deskH - 8 - h

  // 베젤
  ctx.fillStyle = '#2f3542'
  ctx.fillRect((sx - 1.5) * s, (sy - 1.5) * s, (w + 3) * s, (h + 4) * s)

  if (on) {
    ctx.fillStyle = '#1e2a3a'
    ctx.fillRect(sx * s, sy * s, w * s, h * s)
    // 코드 줄 — 색이 다른 토큰이 섞여 흐른다
    const colors = ['#7fd1ff', '#a5e887', '#ffd479', '#ff9ec4']
    for (let i = 0; i < 6; i++) {
      const ly = sy + 1.5 + i * 2
      const off = (i * 3 + Math.floor(t / 220)) % 5
      ctx.fillStyle = colors[(i + Math.floor(t / 700)) % colors.length]
      ctx.fillRect((sx + 1.5 + off) * s, ly * s, (3 + ((i * 5) % 9)) * s, 1.2 * s)
    }
  } else {
    ctx.fillStyle = '#c9d6e4'
    ctx.fillRect(sx * s, sy * s, w * s, h * s)
    ctx.fillStyle = '#dbe6f1'
    ctx.fillRect(sx * s, sy * s, w * s, (h / 2) * s)
  }

  // 전원 램프
  ctx.fillStyle = on ? '#7ee08a' : '#8b93a1'
  ctx.fillRect((p.x + w / 2 - 3) * s, (sy + h + 1) * s, 1.5 * s, 1.5 * s)
}

function drawKeyboard(ctx, s, gx, gy, deskH) {
  const p = toScreen(gx, gy)
  const w = 16
  const d = 5
  ctx.fillStyle = '#e9edf3'
  ctx.beginPath()
  ctx.moveTo(p.x * s, (p.y - deskH - d / 2) * s)
  ctx.lineTo((p.x + w / 2) * s, (p.y - deskH) * s)
  ctx.lineTo(p.x * s, (p.y - deskH + d / 2) * s)
  ctx.lineTo((p.x - w / 2) * s, (p.y - deskH) * s)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#c3cad6'
  for (let i = -3; i <= 3; i++) {
    ctx.fillRect((p.x + i * 2) * s, (p.y - deskH - 0.5) * s, 1.2 * s, 1.2 * s)
  }
  // 마우스
  ctx.fillStyle = '#e9edf3'
  ctx.beginPath()
  ctx.ellipse((p.x + 11) * s, (p.y - deskH + 1) * s, 2 * s, 1.4 * s, 0, 0, Math.PI * 2)
  ctx.fill()
}

function drawMug(ctx, s, gx, gy, deskH) {
  const p = toScreen(gx, gy)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect((p.x - 2) * s, (p.y - deskH - 5) * s, 4 * s, 5 * s)
  ctx.fillStyle = '#e05c5c'
  ctx.fillRect((p.x - 2) * s, (p.y - deskH - 3.5) * s, 4 * s, 1.5 * s)
  ctx.fillStyle = '#cfd6e0'
  ctx.fillRect((p.x + 2) * s, (p.y - deskH - 4) * s, 1.2 * s, 2.5 * s)
  ctx.fillStyle = '#6b4a2f'
  ctx.fillRect((p.x - 1.6) * s, (p.y - deskH - 5) * s, 3.2 * s, 0.8 * s)
}

function drawPapers(ctx, s, gx, gy, deskH) {
  const p = toScreen(gx, gy)
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i === 2 ? '#ffffff' : '#f2f2ee'
    ctx.beginPath()
    ctx.moveTo(p.x * s, (p.y - deskH - i * 0.6 - 2) * s)
    ctx.lineTo((p.x + 5) * s, (p.y - deskH - i * 0.6) * s)
    ctx.lineTo(p.x * s, (p.y - deskH - i * 0.6 + 2) * s)
    ctx.lineTo((p.x - 5) * s, (p.y - deskH - i * 0.6) * s)
    ctx.closePath()
    ctx.fill()
  }
  ctx.fillStyle = '#b8bfcc'
  ctx.fillRect((p.x - 2) * s, (p.y - deskH - 3.4) * s, 4 * s, 0.7 * s)
}

// ── 소품 ─────────────────────────────────────────────────────────────────
export function drawMeetingTable(ctx, s, gx, gy) {
  const TOP_H = 11
  for (const [ox, oy] of [
    [-0.6, -0.6],
    [0.6, -0.6],
    [-0.6, 0.6],
    [0.6, 0.6],
  ]) {
    drawBox(ctx, s, gx + ox, gy + oy, 0.12, 0.12, TOP_H, DESK_LEG)
  }
  drawBox(ctx, s, gx, gy, 1.9, 1.9, 2.4, DESK_TOP, TOP_H - 2.4)

  // 위에 놓인 것들: 노트북 두 대와 커피
  const p = toScreen(gx, gy)
  for (const dx of [-12, 8]) {
    ctx.fillStyle = '#cfd6e0'
    ctx.fillRect((p.x + dx) * s, (p.y - TOP_H - 4) * s, 9 * s, 4 * s)
    ctx.fillStyle = '#2f3542'
    ctx.fillRect((p.x + dx) * s, (p.y - TOP_H - 8) * s, 9 * s, 4.5 * s)
    ctx.fillStyle = '#7fd1ff'
    ctx.fillRect((p.x + dx + 1) * s, (p.y - TOP_H - 7) * s, 7 * s, 2.5 * s)
  }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect((p.x - 2) * s, (p.y - TOP_H - 4) * s, 3.5 * s, 4 * s)

  // 의자 네 개
  drawChair(ctx, s, gx - 1.15, gy)
  drawChair(ctx, s, gx + 1.15, gy)
  drawChair(ctx, s, gx, gy - 1.15)
  drawChair(ctx, s, gx, gy + 1.15)
}

export function drawCoffeeCorner(ctx, s, gx, gy) {
  const H = 12
  // 카운터
  drawBox(ctx, s, gx, gy, 1.1, 0.7, H, { top: '#efe7d8', left: '#b7a68b', right: '#d6c8ae' })

  const p = toScreen(gx, gy)
  // 커피머신 본체
  ctx.fillStyle = '#3c4250'
  ctx.fillRect((p.x - 7) * s, (p.y - H - 14) * s, 12 * s, 14 * s)
  ctx.fillStyle = '#2b303b'
  ctx.fillRect((p.x - 7) * s, (p.y - H - 6) * s, 12 * s, 6 * s)
  // 물통
  ctx.fillStyle = 'rgba(190,225,245,0.85)'
  ctx.fillRect((p.x + 5) * s, (p.y - H - 12) * s, 4 * s, 12 * s)
  // 버튼과 노즐
  ctx.fillStyle = '#e05c5c'
  ctx.fillRect((p.x - 5) * s, (p.y - H - 12) * s, 2 * s, 2 * s)
  ctx.fillStyle = '#8f97a6'
  ctx.fillRect((p.x - 2) * s, (p.y - H - 7) * s, 1.5 * s, 3 * s)
  // 컵 두 개
  for (const dx of [4, 7]) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect((p.x + dx) * s, (p.y - H - 3) * s, 2.5 * s, 3 * s)
  }
}

export function drawPlant(ctx, s, gx, gy) {
  const p = toScreen(gx, gy)
  // 화분
  drawBox(ctx, s, gx, gy, 0.42, 0.42, 7, { top: '#e08a63', left: '#a55c3c', right: '#c9714b' })
  // 잎 — 겹쳐진 타원 몇 개면 관엽식물처럼 보인다
  const leaves = [
    [0, -16, 7, 5, '#4f9152'],
    [-5, -13, 6, 4, '#5aa85d'],
    [5, -13, 6, 4, '#47854a'],
    [-2, -20, 5, 4, '#63b566'],
    [3, -19, 5, 3.5, '#519455'],
  ]
  for (const [dx, dy, rx, ry, color] of leaves) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.ellipse((p.x + dx) * s, (p.y + dy) * s, rx * s, ry * s, 0, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** 깊이 정렬에 함께 넣을 정적 소품들. */
export const PROPS = [
  { gx: 5.5, gy: 5.5, draw: drawMeetingTable },
  { gx: 2.4, gy: 2.4, draw: drawCoffeeCorner },
  { gx: -0.5, gy: 8.4, draw: drawPlant },
  { gx: 8.4, gy: -0.5, draw: drawPlant },
  { gx: 8.4, gy: 8.4, draw: drawPlant },
]
