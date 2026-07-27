// 밝은 사무실. 전부 도형으로 그린다(에셋 없음).
//
// 지켜야 할 것 셋:
// 1) **벽은 바닥 가장자리에 딱 붙여** 한 덩어리로 그린다(틈·톱니 방지).
// 2) **벽·상자에 붙는 것은 그 면에 눕힌다**(정면 직사각형은 아이소를 깬다).
// 3) **비율**: 캐릭터가 20단위다. 책상 10, 모니터는 책상 위 10 남짓 — 사람보다
//    커지면 장난감처럼 보인다.

import {
  GRID_W,
  GRID_H,
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
import { ROOMS } from './layout.js'

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

// 밝은 바닥 위에서 묻히지 않게 한 단계 진하게. 예전 색은 패널이 안 보이고
// 양 끝 기둥만 남아 흰 장대처럼 보였다.
const PART_FABRIC = { top: '#9fb0c4', left: '#6d7f96', right: '#8798ad' }
const PART_RAIL = { top: '#d5dde6', left: '#9aa5b3', right: '#bcc6d2' }

const BEZEL = { top: '#3b4351', left: '#232935', right: '#2f3644' }
const METAL = { top: '#9aa3b2', left: '#6d7686', right: '#828c9c' }

const DESK_H = 10

// ── 바닥 ─────────────────────────────────────────────────────────────────
// 방마다 바닥재가 다르다. 나무(사무실) / 카펫(회의실) / 타일(탕비실).
const FLOOR_SETS = {
  wood: [
    { top: '#e8d3b4', side: '#c2a582' },
    { top: '#e1c9a8', side: '#bb9d7a' },
  ],
  carpet: [
    { top: '#c8d3e2', side: '#a3aec0' },
    { top: '#c1cddd', side: '#9ca7ba' },
  ],
  tile: [
    { top: '#eef0f2', side: '#c3c7cd' },
    { top: '#e2e6ea', side: '#b8bdc4' },
  ],
}

export function drawFloor(ctx, s) {
  for (const key of Object.keys(ROOMS)) {
    const r = ROOMS[key]
    const set = FLOOR_SETS[r.floor]
    for (let gy = r.y0; gy <= r.y1; gy++) {
      for (let gx = r.x0; gx <= r.x1; gx++) {
        const c = set[(gx + gy) % 2]
        fillTile(ctx, s, gx, gy, c.top, c.side)
        if (r.floor === 'wood') drawPlankLines(ctx, s, gx, gy)
        else if (r.floor === 'tile') drawTileGrout(ctx, s, gx, gy)
      }
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

/** 타일 줄눈 — 마름모 네 변을 따라 얇게. */
function drawTileGrout(ctx, s, gx, gy) {
  const { x, y } = toScreen(gx, gy)
  ctx.save()
  ctx.globalAlpha = 0.35
  ctx.strokeStyle = '#aab0b8'
  ctx.lineWidth = Math.max(1, s * 0.4)
  ctx.beginPath()
  ctx.moveTo(x * s, (y - TILE_H / 2) * s)
  ctx.lineTo((x + TILE_W / 2) * s, y * s)
  ctx.lineTo(x * s, (y + TILE_H / 2) * s)
  ctx.lineTo((x - TILE_W / 2) * s, y * s)
  ctx.closePath()
  ctx.stroke()
  ctx.restore()
}

export function drawRug(ctx, s, gx, gy, w = 3, d = 3) {
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < d; j++) {
      const edge = i === 0 || j === 0 || i === w - 1 || j === d - 1
      fillTile(ctx, s, gx + i, gy + j, edge ? '#b9c8dc' : '#d3dfee', null)
    }
  }
}

// ── 벽 ───────────────────────────────────────────────────────────────────
const WALL_H = 54
const WAINSCOT = 18
const INNER_H = 32 // 유리 파티션 높이. 낮게 잡아야 안쪽 방이 보인다

export function drawWalls(ctx, s, t) {
  // 바깥벽 — 도면 전체를 감싼다
  wallQuad(ctx, s, 'nw', 0, GRID_H, WAINSCOT, WALL_H, WALL_NW_UP)
  wallQuad(ctx, s, 'nw', 0, GRID_H, 0, WAINSCOT, WALL_NW_LOW)
  wallQuad(ctx, s, 'nw', 0, GRID_H, WAINSCOT - 1.4, WAINSCOT, WALL_TRIM)

  wallQuad(ctx, s, 'ne', 0, GRID_W, WAINSCOT, WALL_H, WALL_NE_UP)
  wallQuad(ctx, s, 'ne', 0, GRID_W, 0, WAINSCOT, WALL_NE_LOW)
  wallQuad(ctx, s, 'ne', 0, GRID_W, WAINSCOT - 1.4, WAINSCOT, WALL_TRIM)

  const c = wallBase('nw', 0)
  ctx.fillStyle = '#e3dbcb'
  ctx.fillRect((c.x - 0.8) * s, (c.y - WALL_H) * s, 1.6 * s, WALL_H * s)

  drawWindow(ctx, s, 'ne', 1.1, t)
  drawWindow(ctx, s, 'ne', 5.6, t)
  drawWindow(ctx, s, 'ne', 9.6, t) // 회의실 창
  drawWindow(ctx, s, 'nw', 6.9, t)
  drawWhiteboard(ctx, s, 'nw', 1.2)
  drawPoster(ctx, s, 'ne', 4.2)
  drawClock(ctx, s, 'nw', 5.4, t)
}

/**
 * 내벽 한 칸 — **유리 파티션**이다.
 *
 * 불투명 벽으로 세웠더니 사무실을 통째로 가렸다. 카메라가 남동쪽에서 보는데
 * 이 벽은 사무실 **앞**에 서 있기 때문이다(깊이가 더 크다). 실제 사무실이 쓰는
 * 해법을 그대로 쓴다: 아래는 불투명 패널, 위는 유리. 뒤가 비쳐 보인다.
 *
 * dir='nw'면 gy 방향(세로벽), 'ne'면 gx 방향(가로벽).
 */
export function drawInnerWall(ctx, s, gx, gy, dir) {
  const along = dir === 'nw' ? { gx: 0, gy: 0.5 } : { gx: 0.5, gy: 0 }
  const a = toScreen(gx - along.gx, gy - along.gy)
  const b = toScreen(gx + along.gx, gy + along.gy)
  const SOLID = 8 // 아래쪽 불투명 패널 높이

  const quad = (yLow, yHigh, color, alpha = 1) => {
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.moveTo(a.x * s, (a.y - yHigh) * s)
    ctx.lineTo(b.x * s, (b.y - yHigh) * s)
    ctx.lineTo(b.x * s, (b.y - yLow) * s)
    ctx.lineTo(a.x * s, (a.y - yLow) * s)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.restore()
  }

  quad(0, SOLID, '#dcd6ca') // 하부 패널
  quad(SOLID - 1, SOLID, '#b9b2a4') // 패널 상단 몰딩
  quad(SOLID, INNER_H, '#cfe3ef', 0.3) // 유리
  quad(INNER_H - 8, INNER_H - 3, '#ffffff', 0.16) // 유리 반사 띠
  quad(INNER_H, INNER_H + 1.4, '#e8e2d6') // 상단 프레임

  // 세로 멀리언(칸 경계 기둥)
  for (const e of [-1, 1]) {
    const q = e < 0 ? a : b
    px(ctx, s, q.x - 0.9, q.y - INNER_H - 1.4, 1.8, INNER_H + 1.4, '#cfc9bb')
    px(ctx, s, q.x - 0.9, q.y - INNER_H - 1.4, 0.7, INNER_H + 1.4, '#efe9dd')
  }
}

/** 문틀 — 기둥 두 개 + 상인방. 문은 열려 있다(다니는 게 보여야 하므로). */
export function drawDoorway(ctx, s, gx, gy) {
  const p = toScreen(gx, gy)
  const H = INNER_H
  // 양쪽 기둥
  for (const e of [-1, 1]) {
    const q = toScreen(gx, gy + e * 0.5)
    drawBox(ctx, s, gx, gy + e * 0.5, 0.12, 0.12, H, {
      top: '#f2ede3',
      left: '#c8bfae',
      right: '#e0d8c8',
    })
    px(ctx, s, q.x - 1.6, q.y - H + 1, 0.8, H - 2, '#fdfaf3')
  }
  // 상인방 — 유리 파티션 상단 프레임과 높이를 맞춘다
  px(ctx, s, p.x - 12, p.y - H - 1.4, 24, 2.8, '#e8e2d6')
  px(ctx, s, p.x - 12, p.y - H - 1.4, 24, 0.8, '#fbf7ef')
  // 문지방
  px(ctx, s, p.x - 9, p.y - 0.9, 18, 1.4, '#c9bfa9')
  px(ctx, s, p.x - 9, p.y - 0.9, 18, 0.5, '#e2d9c5')
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

/** 화이트보드 — 프레임·판서 내용·포스트잇·마커 받침까지 벽면에 눕혀 그린다. */
function drawWhiteboard(ctx, s, side, g) {
  const len = 3.0
  const low = 23
  const high = 43

  // 프레임 3겹(바깥 그림자 → 알루미늄 → 안쪽 홈)
  wallQuad(ctx, s, side, g - 0.16, len + 0.32, low - 1.8, high + 1.8, 'rgba(120,105,85,0.28)')
  wallQuad(ctx, s, side, g - 0.12, len + 0.24, low - 1.4, high + 1.4, '#b9c0cc')
  wallQuad(ctx, s, side, g - 0.12, len + 0.24, high + 0.6, high + 1.4, '#d7dce4') // 윗면 하이라이트
  wallQuad(ctx, s, side, g - 0.05, len + 0.1, low - 0.6, high + 0.6, '#8d95a4')
  wallQuad(ctx, s, side, g, len, low, high, '#fbfcfe')
  wallQuad(ctx, s, side, g, len, high - 2.5, high, '#ffffff') // 위쪽이 더 밝다

  // ── 판서 내용 ──
  // 1) 순서도: 상자 3개 + 화살표
  const boxY = high - 9
  const boxes = [0.18, 1.05, 1.92]
  boxes.forEach((bx, i) => {
    wallQuad(ctx, s, side, g + bx, 0.62, boxY, boxY + 4.2, '#4a7fd4')
    wallQuad(ctx, s, side, g + bx, 0.62, boxY + 3.4, boxY + 4.2, '#7ba5e4') // 상자 윗면
    wallQuad(ctx, s, side, g + bx + 0.08, 0.46, boxY + 1.2, boxY + 1.9, 'rgba(255,255,255,0.75)')
    if (i < 2) {
      wallQuad(ctx, s, side, g + bx + 0.64, 0.2, boxY + 1.9, boxY + 2.4, '#6b7280')
      wallQuad(ctx, s, side, g + bx + 0.8, 0.06, boxY + 1.6, boxY + 2.7, '#6b7280') // 화살촉
    }
  })

  // 2) 막대그래프
  const barY = low + 3.5
  const bars = [2.5, 4.2, 3.1, 5.4]
  bars.forEach((h, i) => {
    wallQuad(ctx, s, side, g + 0.2 + i * 0.24, 0.16, barY, barY + h, i === 3 ? '#4caf6d' : '#8fb8e8')
  })
  wallQuad(ctx, s, side, g + 0.14, 1.05, barY - 0.5, barY, '#9aa3b2') // 축

  // 3) 체크리스트
  const listY = low + 9
  for (let i = 0; i < 3; i++) {
    const y = listY - i * 2.1
    wallQuad(ctx, s, side, g + 1.45, 0.16, y, y + 0.8, i < 2 ? '#4caf6d' : '#c9cfd8')
    wallQuad(ctx, s, side, g + 1.68, 0.7 + (i % 2) * 0.3, y + 0.15, y + 0.75, '#7b8494')
  }

  // 4) 포스트잇 두 장(살짝 기울여 붙인 느낌으로 높이를 어긋나게)
  wallQuad(ctx, s, side, g + 2.5, 0.34, low + 8.5, high - 8.5, '#ffe08a')
  wallQuad(ctx, s, side, g + 2.5, 0.34, high - 9.4, high - 8.5, '#f5cf6d')
  wallQuad(ctx, s, side, g + 2.55, 0.24, low + 10, low + 10.6, 'rgba(120,100,40,0.5)')
  wallQuad(ctx, s, side, g + 2.55, 0.18, low + 11.4, low + 12, 'rgba(120,100,40,0.5)')

  wallQuad(ctx, s, side, g + 2.55, 0.32, low + 2.5, low + 7.5, '#ffb3c6')
  wallQuad(ctx, s, side, g + 2.55, 0.32, low + 6.6, low + 7.5, '#f096ad')

  // 글씨 자국 — 지운 흔적
  ctx.save()
  ctx.globalAlpha = 0.12
  wallQuad(ctx, s, side, g + 0.2, 1.6, low + 12.5, low + 14.5, '#7b8494')
  ctx.restore()

  // 유리 반사
  ctx.save()
  ctx.globalAlpha = 0.13
  wallQuad(ctx, s, side, g + 0.1, 0.45, low + 1, high - 1, '#ffffff')
  ctx.restore()

  // 마커 받침 + 마커 3자루 + 지우개
  wallQuad(ctx, s, side, g - 0.1, len + 0.2, low - 2.6, low - 0.8, '#c6cdd8')
  wallQuad(ctx, s, side, g - 0.1, len + 0.2, low - 1.2, low - 0.8, '#e2e7ee')
  const markers = ['#e05c5c', '#4a7fd4', '#4caf6d']
  markers.forEach((c, i) => {
    wallQuad(ctx, s, side, g + 0.3 + i * 0.3, 0.22, low - 2.2, low - 1.3, c)
    wallQuad(ctx, s, side, g + 0.3 + i * 0.3, 0.06, low - 2.2, low - 1.3, '#33383f')
  })
  wallQuad(ctx, s, side, g + 2.2, 0.42, low - 2.4, low - 1.2, '#5b6472')
  wallQuad(ctx, s, side, g + 2.2, 0.42, low - 1.6, low - 1.2, '#7d8695')
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

    // 양 끝 기둥 — 패널보다 살짝 진하게(밝게 하면 흰 장대처럼 튄다)
    for (const e of [-1, 1]) {
      px(ctx, s, p.x + e * half - 1, p.y - PART_H, 2, PART_H, '#5f7087')
      px(ctx, s, p.x + e * half - 1, p.y - PART_H, 0.7, PART_H, '#8496ab')
      px(ctx, s, p.x + e * half - 2.4, p.y - 1.2, 4.8, 1.4, '#4e5e73') // 받침 발
    }

    // 상단 레일 + 하이라이트(폭을 줄여 얌전하게)
    drawBox(ctx, s, cx, cy, w + 0.05, d + 0.05, 0.9, PART_RAIL, PART_H)
    px(ctx, s, p.x - half + 2, p.y - PART_H - 0.6, half * 2 - 4, 0.6, '#e6ecf3')
  }
  panel(gx - 0.55, gy - 0.02, 0.07, 1.1, 1.1) // 서쪽
  panel(gx - 0.02, gy - 0.55, 1.1, 0.07, 1.1) // 북쪽
}

// ── 업무 자리(ㄱ자 책상 + 듀얼 모니터) ────────────────────────────────────
//
// 정사각 책상 하나로는 모니터 두 대를 올릴 자리가 안 나온다. 실제 사무용처럼
// 메인 상판 + 옆으로 뻗은 리턴(보조 상판)으로 ㄱ자를 만든다.

const MAIN = { w: 1.3, d: 0.62 } // 메인 상판(캐릭터가 마주보는 쪽)
const RET = { w: 0.6, d: 1.0 } // 리턴(왼쪽으로 꺾인 보조 상판)

export function drawWorkstation(ctx, s, gx, gy, screenOn, t, cups = 0) {
  const mainC = { gx, gy: gy - 0.18 }
  const retC = { gx: gx - 0.6, gy: gy + 0.32 }

  drawAO(ctx, s, gx - 0.15, gy, 26, 12, 0.2)

  // 다리: 메인 4개 + 리턴 2개
  const legs = [
    [mainC.gx - 0.55, mainC.gy - 0.24],
    [mainC.gx + 0.55, mainC.gy - 0.24],
    [mainC.gx - 0.55, mainC.gy + 0.24],
    [mainC.gx + 0.55, mainC.gy + 0.24],
    [retC.gx - 0.22, retC.gy + 0.42],
    [retC.gx + 0.22, retC.gy + 0.42],
  ]
  for (const [lx, ly] of legs) {
    drawBox(ctx, s, lx, ly, 0.08, 0.08, DESK_H, DESK_LEG)
    const lp = toScreen(lx, ly)
    px(ctx, s, lp.x - 1.7, lp.y - DESK_H + 0.5, 0.8, DESK_H - 1.5, '#c9b48f')
  }

  // 상판 두 장(겹치는 모서리가 ㄱ자를 만든다)
  drawBox(ctx, s, retC.gx, retC.gy, RET.w, RET.d, 1.5, DESK_TOP, DESK_H - 1.5)
  drawBox(ctx, s, mainC.gx, mainC.gy, MAIN.w, MAIN.d, 1.5, DESK_TOP, DESK_H - 1.5)

  // 나뭇결과 앞모서리 그림자
  const mp = toScreen(mainC.gx, mainC.gy)
  for (const f of [-0.18, 0, 0.18]) {
    topSeam(ctx, s, mainC.gx, mainC.gy, DESK_H, { gx: -0.6, gy: f }, { gx: 0.6, gy: f }, 'rgba(150,120,80,0.2)', 0.7)
  }
  px(ctx, s, mp.x - TILE_W * 0.62, mp.y - DESK_H + TILE_H * 0.62 - 0.5, TILE_W * 1.24, 0.8, 'rgba(120,95,60,0.28)')

  // 서랍장(메인 상판 오른쪽 아래)
  drawBox(ctx, s, gx + 0.42, gy + 0.06, 0.3, 0.3, DESK_H - 2.2, DRAWER)
  const dp = toScreen(gx + 0.42, gy + 0.06)
  for (const dy of [3.0, 6.2]) {
    px(ctx, s, dp.x - 4, dp.y - dy - 0.4, 8.2, 0.7, 'rgba(140,115,80,0.5)')
    px(ctx, s, dp.x - 2.1, dp.y - dy + 1.1, 4.4, 1.1, '#8a7659')
    px(ctx, s, dp.x - 2.1, dp.y - dy + 1.1, 4.4, 0.5, '#c2ab86')
  }

  // 듀얼 모니터 — 안쪽으로 살짝 각을 준다
  drawMonitor(ctx, s, mainC.gx - 0.34, mainC.gy - 0.2, screenOn, t, 0)
  drawMonitor(ctx, s, mainC.gx + 0.3, mainC.gy - 0.2, screenOn, t, 1)

  drawKeyboard(ctx, s, mainC.gx, mainC.gy + 0.2)
  drawPapers(ctx, s, retC.gx - 0.02, retC.gy + 0.2)

  // 탕비실에 다녀온 만큼 커피컵이 쌓인다(리턴 상판 위)
  for (let i = 0; i < Math.min(cups, 6); i++) {
    const col = i % 3
    const row = Math.floor(i / 3)
    drawMug(ctx, s, retC.gx - 0.16 + col * 0.16, retC.gy - 0.34 + row * 0.18, t, i === 0)
  }
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

function drawMonitor(ctx, s, gx, gy, on, t, seed = 0) {
  const p = toScreen(gx, gy)
  drawBox(ctx, s, gx, gy, 0.2, 0.14, 0.7, METAL, DESK_H)
  px(ctx, s, p.x - 0.9, p.y - DESK_H - 3.4, 1.8, 2.8, '#8d96a5')

  const bottom = DESK_H + 3.4
  const w = 13
  const h = 8.6
  px(ctx, s, p.x - w / 2, p.y - bottom - h, w, h, '#2f3644')
  px(ctx, s, p.x - w / 2, p.y - bottom - h, w, 0.8, '#4a5464')
  px(ctx, s, p.x - w / 2, p.y - bottom - 1.3, w, 1.3, '#242a35')

  const sx = p.x - w / 2 + 1
  const sy = p.y - bottom - h + 1
  const sw = w - 2
  const sh = h - 2.8
  if (on) {
    px(ctx, s, sx, sy, sw, sh, '#16202e')
    const colors = ['#7fd1ff', '#a5e887', '#ffd479', '#ff9ec4', '#c4b5fd']
    for (let i = 0; i < 4; i++) {
      const row = sy + 0.7 + i * 1.2
      const indent = ((i * 3 + seed * 2 + Math.floor(t / 300)) % 3) * 1.1
      const len = 2 + ((i * 5 + seed * 3 + Math.floor(t / 700)) % 7)
      px(ctx, s, sx + 0.8 + indent, row, Math.min(len, sw - 1.6 - indent), 0.7, colors[(i + seed) % colors.length])
    }
    if (Math.floor(t / 500) % 2 === seed % 2) px(ctx, s, sx + 1.1, sy + 0.7 + 4 * 1.2, 0.8, 0.8, '#ffffff')
  } else {
    px(ctx, s, sx, sy, sw, sh, '#c4d2e2')
    px(ctx, s, sx, sy, sw, sh / 2, '#d8e4f0')
  }
  px(ctx, s, p.x + w / 2 - 2, p.y - bottom - 1, 0.9, 0.7, on ? '#7ee08a' : '#7b8494')
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

/** 머그. fresh=true면 김이 오른다(방금 내려온 커피). */
function drawMug(ctx, s, gx, gy, t, fresh = false) {
  const p = toScreen(gx, gy)
  const h = 3.4
  px(ctx, s, p.x - 1.6, p.y - DESK_H - h, 3.2, h, '#ffffff')
  px(ctx, s, p.x + 0.8, p.y - DESK_H - h, 0.8, h, '#d7dee8')
  px(ctx, s, p.x + 1.6, p.y - DESK_H - h + 0.9, 0.9, 1.3, '#e6ecf3')
  px(ctx, s, p.x - 1.6, p.y - DESK_H - h - 0.6, 3.2, 0.7, '#6b4a2f')
  px(ctx, s, p.x - 1.6, p.y - DESK_H - 1.5, 3.2, 0.8, '#e05c5c')
  if (!fresh) return
  ctx.save()
  ctx.globalAlpha = 0.42
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
  drawAO(ctx, s, gx, gy, 32, 16, 0.2)

  // 다리 4개 + 가로 브레이스
  for (const [ox, oy] of [
    [-0.55, -0.55],
    [0.55, -0.55],
    [-0.55, 0.55],
    [0.55, 0.55],
  ]) {
    drawBox(ctx, s, gx + ox, gy + oy, 0.09, 0.09, H, DESK_LEG)
    const lp = toScreen(gx + ox, gy + oy)
    px(ctx, s, lp.x - 1.8, lp.y - H + 0.5, 0.8, H - 1.5, '#c9b48f')
  }
  drawBox(ctx, s, gx, gy, 1.15, 0.08, 0.8, DESK_LEG, 3)
  drawBox(ctx, s, gx, gy, 0.08, 1.15, 0.8, DESK_LEG, 3)

  // 상판 — 두께 있는 슬랩 + 나뭇결 + 앞모서리 그림자
  drawBox(ctx, s, gx, gy, 1.8, 1.8, 2, DESK_TOP, H - 2)
  const p = toScreen(gx, gy)
  for (const f of [-0.6, -0.3, 0, 0.3, 0.6]) {
    topSeam(ctx, s, gx, gy, H, { gx: -0.85, gy: f }, { gx: 0.85, gy: f }, 'rgba(150,120,80,0.2)', 0.7)
  }
  px(ctx, s, p.x - TILE_W * 0.9, p.y - H + TILE_H * 0.9 - 0.5, TILE_W * 1.8, 0.8, 'rgba(120,95,60,0.3)')

  // 노트북 두 대 — 받침·키보드·힌지·화면 내용까지
  for (const [ox, oy, flip] of [
    [-0.42, -0.12, false],
    [0.42, 0.12, true],
  ]) {
    const lp = toScreen(gx + ox, gy + oy)
    // 받침(키보드 면)
    ctx.fillStyle = '#dbe1e9'
    ctx.beginPath()
    ctx.moveTo(lp.x * s, (lp.y - H - 2.6) * s)
    ctx.lineTo((lp.x + 8) * s, (lp.y - H) * s)
    ctx.lineTo(lp.x * s, (lp.y - H + 2.6) * s)
    ctx.lineTo((lp.x - 8) * s, (lp.y - H) * s)
    ctx.closePath()
    ctx.fill()
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 5; c++) {
        px(ctx, s, lp.x + (c - 2) * 1.6 + r * 0.6 - 0.4, lp.y - H + (r - 0.5) * 1.1, 0.9, 0.7, '#b7bfcb')
      }
    }
    px(ctx, s, lp.x - 2, lp.y - H + 1.4, 4, 1.2, '#c8d0da') // 트랙패드
    // 화면
    const sx = lp.x - 7 + (flip ? 2 : 0)
    px(ctx, s, sx, lp.y - H - 9.5, 12, 7.5, '#2f3644')
    px(ctx, s, sx, lp.y - H - 9.5, 12, 0.7, '#4a5464')
    px(ctx, s, sx + 0.9, lp.y - H - 8.7, 10.2, 5.6, '#16202e')
    const cols = ['#7fd1ff', '#a5e887', '#ffd479']
    for (let i = 0; i < 3; i++) {
      px(ctx, s, sx + 1.6, lp.y - H - 8.1 + i * 1.5, 3 + i * 2.2, 0.7, cols[i])
    }
    px(ctx, s, sx + 5, lp.y - H - 2, 2, 0.6, '#9aa3b2') // 힌지
  }

  // 스피커폰 — 가운데 원형 기기에 LED 세 개
  ctx.fillStyle = '#4a5262'
  ctx.beginPath()
  ctx.ellipse(p.x * s, (p.y - H - 1) * s, 4.6 * s, 2.4 * s, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#5f697b'
  ctx.beginPath()
  ctx.ellipse(p.x * s, (p.y - H - 1.6) * s, 4.6 * s, 2.4 * s, 0, 0, Math.PI * 2)
  ctx.fill()
  for (let i = -1; i <= 1; i++) {
    px(ctx, s, p.x + i * 1.8 - 0.4, p.y - H - 2.2, 0.9, 0.7, i === 0 ? '#7ee08a' : '#39424f')
  }

  // 서류 묶음과 펜
  const dp = toScreen(gx - 0.15, gy + 0.5)
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i === 2 ? '#ffffff' : '#f0f0ea'
    ctx.beginPath()
    ctx.moveTo((dp.x + i * 0.5) * s, (dp.y - H - i * 0.5 - 2) * s)
    ctx.lineTo((dp.x + 5 + i * 0.5) * s, (dp.y - H - i * 0.5) * s)
    ctx.lineTo((dp.x + i * 0.5) * s, (dp.y - H - i * 0.5 + 2) * s)
    ctx.lineTo((dp.x - 5 + i * 0.5) * s, (dp.y - H - i * 0.5) * s)
    ctx.closePath()
    ctx.fill()
  }
  px(ctx, s, dp.x + 1, dp.y - H - 2.4, 4.5, 0.8, '#3b6fb8') // 펜

  // 머그
  const mp = toScreen(gx + 0.15, gy - 0.5)
  px(ctx, s, mp.x - 1.6, mp.y - H - 3.4, 3.2, 3.4, '#ffffff')
  px(ctx, s, mp.x + 0.8, mp.y - H - 3.4, 0.8, 3.4, '#d7dee8')
  px(ctx, s, mp.x - 1.6, mp.y - H - 4, 3.2, 0.7, '#6b4a2f')
  px(ctx, s, mp.x + 1.6, mp.y - H - 2.6, 0.9, 1.3, '#e6ecf3')
}

/** 회의 의자 하나(정렬용으로 분리). */
export function drawMeetingChair(ctx, s, gx, gy) {
  drawChair(ctx, s, gx, gy)
  drawChairBack(ctx, s, gx, gy)
}

export function drawCoffeeCorner(ctx, s, gx, gy, t) {
  const H = 11
  drawAO(ctx, s, gx, gy, 20, 10, 0.2)

  // 하부장 — 몸통 + 상판 슬랩(앞으로 조금 튀어나오게)
  drawBox(ctx, s, gx, gy, 1.02, 0.66, H - 1.2, { top: '#e8dcc6', left: '#a8977c', right: '#cdbfa2' })
  drawBox(ctx, s, gx, gy, 1.12, 0.74, 1.2, { top: '#f3ece0', left: '#b6a68b', right: '#dbcfb5' }, H - 1.2)

  const p = toScreen(gx, gy)
  // 문짝 두 개 + 손잡이
  for (const e of [-1, 1]) {
    faceQuad(ctx, s, gx + e * 0.24, gy + 0.34, 'right', 0.4, 1.5, H - 2.4, 'rgba(120,100,70,0.14)')
    const dp = toScreen(gx + e * 0.24, gy + 0.34)
    px(ctx, s, dp.x - 0.5, dp.y - H + 3.5, 1, 3.2, '#8d7a5e')
  }
  // 걸레받이 그늘
  px(ctx, s, p.x - 20, p.y + 0.5, 40, 1, 'rgba(90,70,45,0.18)')

  // ── 에스프레소 머신 ──
  const mx = gx - 0.2
  const my = gy - 0.06
  const mp = toScreen(mx, my)
  const top = H // 상판 높이
  drawBox(ctx, s, mx, my, 0.36, 0.28, 11, { top: '#4e5666', left: '#2b303b', right: '#3c4351' }, top)

  // 전면 패널(어두운 유광) + 디스플레이 + 버튼
  px(ctx, s, mp.x - 5.5, mp.y - top - 9.5, 11, 6, '#232833')
  px(ctx, s, mp.x - 4.2, mp.y - top - 8.8, 8.4, 2.6, '#0f1720')
  px(ctx, s, mp.x - 3.6, mp.y - top - 8.2, 3.2, 0.8, '#5ce0a0') // 디스플레이 글씨
  px(ctx, s, mp.x - 3.6, mp.y - top - 7, 1.6, 0.7, '#3a4351')
  for (let i = 0; i < 3; i++) {
    px(ctx, s, mp.x - 3.8 + i * 2.8, mp.y - top - 5.6, 1.8, 1.4, i === 0 ? '#e05c5c' : '#8f97a6')
    px(ctx, s, mp.x - 3.8 + i * 2.8, mp.y - top - 5.6, 1.8, 0.5, i === 0 ? '#f18b8b' : '#b6bdc9')
  }
  // 그룹헤드 + 포터필터
  px(ctx, s, mp.x - 1.6, mp.y - top - 3.4, 3.2, 1.6, '#8f97a6')
  px(ctx, s, mp.x - 2.6, mp.y - top - 2, 5.2, 1.2, '#5a6270')
  px(ctx, s, mp.x + 2.2, mp.y - top - 1.8, 3.2, 0.9, '#3c4351') // 손잡이
  // 스팀 완드
  px(ctx, s, mp.x + 5, mp.y - top - 7, 0.8, 5.5, '#9aa2b1')
  // 컵 받침(그레이트)
  px(ctx, s, mp.x - 5, mp.y - top - 0.9, 10, 1, '#39424f')
  for (let i = 0; i < 5; i++) px(ctx, s, mp.x - 4.2 + i * 2, mp.y - top - 0.7, 0.7, 0.7, '#6b7484')

  // 내려지는 컵 + 김
  px(ctx, s, mp.x - 1.4, mp.y - top - 3.4 + 1.6, 2.8, 2.6, '#ffffff')
  px(ctx, s, mp.x - 1.4, mp.y - top - 1.4, 2.8, 0.6, '#6b4a2f')
  ctx.save()
  ctx.globalAlpha = 0.4
  for (let i = 0; i < 2; i++) {
    const rise = ((t / 1100 + i * 0.5) % 1) * 5
    px(ctx, s, mp.x - 0.4 + Math.sin(rise * 2) * 0.8, mp.y - top - 4.5 - rise, 0.7, 0.7, '#ffffff')
  }
  ctx.restore()

  // ── 물통(반투명) ──
  const wp = toScreen(gx + 0.3, gy - 0.06)
  px(ctx, s, wp.x - 2.2, wp.y - top - 9, 4.4, 9, 'rgba(214,236,247,0.85)')
  px(ctx, s, wp.x - 2.2, wp.y - top - 5, 4.4, 5, 'rgba(150,205,232,0.9)') // 물 높이
  px(ctx, s, wp.x - 2.2, wp.y - top - 5, 4.4, 0.6, '#bfe4f5')
  px(ctx, s, wp.x - 2.2, wp.y - top - 9, 1, 9, 'rgba(255,255,255,0.5)') // 하이라이트

  // ── 컵 탑 + 원두 봉지 ──
  for (let i = 0; i < 3; i++) {
    const cp = toScreen(gx + 0.42, gy + 0.22)
    px(ctx, s, cp.x - 1.6 + i * 0.2, cp.y - top - 2.4 - i * 1.6, 3.2, 2.4, i === 2 ? '#ffffff' : '#f0f3f7')
    px(ctx, s, cp.x - 1.6 + i * 0.2, cp.y - top - 2.4 - i * 1.6, 3.2, 0.5, '#dfe5ec')
  }
  const bp = toScreen(gx - 0.46, gy + 0.2)
  px(ctx, s, bp.x - 2.4, bp.y - top - 6.5, 4.8, 6.5, '#6b4a2f')
  px(ctx, s, bp.x - 2.4, bp.y - top - 6.5, 4.8, 0.8, '#8a6242')
  px(ctx, s, bp.x - 1.6, bp.y - top - 4.5, 3.2, 1.8, '#e8dcc6')
  px(ctx, s, bp.x - 1, bp.y - top - 4, 2, 0.7, '#6b4a2f')
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

// 회의 테이블은 회의실(gx 9..12, gy 0..4), 커피 코너는 탕비실(gx 9..12, gy 6..11)에.
// ── 휴게실 가구 ───────────────────────────────────────────────────────────
export function drawSofa(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 26, 12, 0.2)
  const body = { top: '#7a8fae', left: '#4e6180', right: '#647a99' }
  const cushion = { top: '#93a8c4', left: '#5f7391', right: '#7c91ae' }

  drawBox(ctx, s, gx, gy, 1.5, 0.75, 5, body) // 몸통
  drawBox(ctx, s, gx, gy - 0.28, 1.5, 0.18, 11, body) // 등받이
  // 방석 두 장
  for (const e of [-0.34, 0.34]) {
    drawBox(ctx, s, gx + e, gy + 0.06, 0.62, 0.6, 1.6, cushion, 5)
  }
  // 팔걸이
  for (const e of [-1, 1]) {
    drawBox(ctx, s, gx + e * 0.78, gy, 0.14, 0.7, 8, body)
  }
  const p = toScreen(gx, gy)
  px(ctx, s, p.x - 15, p.y - 11.6, 30, 0.8, '#9db1cc') // 등받이 윗선
  // 쿠션 두 개
  px(ctx, s, p.x - 11, p.y - 10, 5, 4.5, '#e0c07a')
  px(ctx, s, p.x + 6, p.y - 10, 5, 4.5, '#c98b96')
}

export function drawLoungeTable(ctx, s, gx, gy, t) {
  drawAO(ctx, s, gx, gy, 16, 8, 0.18)
  drawBox(ctx, s, gx, gy, 0.8, 0.8, 5, { top: '#e9d6b6', left: '#b39a75', right: '#d3bc98' })
  const p = toScreen(gx, gy)
  // 잡지 두 권과 화분
  px(ctx, s, p.x - 7, p.y - 6.2, 7, 3, '#7fb3d5')
  px(ctx, s, p.x - 6, p.y - 6.8, 7, 3, '#e8a0a8')
  px(ctx, s, p.x + 3, p.y - 8, 3.4, 3.4, '#c9714b')
  px(ctx, s, p.x + 3.4, p.y - 10.4, 2.6, 2.6, '#5aa85d')
  // 김 나는 커피
  px(ctx, s, p.x - 1, p.y - 8.6, 2.8, 3.2, '#ffffff')
  px(ctx, s, p.x - 1, p.y - 9.2, 2.8, 0.7, '#6b4a2f')
  ctx.save()
  ctx.globalAlpha = 0.35
  const rise = ((t / 1200) % 1) * 3.5
  px(ctx, s, p.x + 0.2, p.y - 10.4 - rise, 0.7, 0.7, '#ffffff')
  ctx.restore()
}

/** 벽걸이 TV — 휴게실 벽에 건다(벽면에 눕혀 그린다). */
export function drawTV(ctx, s, side, g, t) {
  const len = 2.4
  const low = 26
  const high = 40
  wallQuad(ctx, s, side, g - 0.08, len + 0.16, low - 0.8, high + 0.8, '#22262e')
  wallQuad(ctx, s, side, g, len, low, high, '#0f1620')
  // 화면 — 색 띠가 천천히 바뀐다
  const hue = Math.floor(t / 2500) % 3
  const sets = [
    ['#2b6cb0', '#4a9fd8', '#8ecae6'],
    ['#7a4a8f', '#b06ab3', '#e0a3d5'],
    ['#2f7a5a', '#4fae7f', '#93d8b0'],
  ][hue]
  sets.forEach((c, i) => {
    wallQuad(ctx, s, side, g + 0.15 + i * 0.72, 0.62, low + 2 + i, high - 2 - i, c)
  })
  wallQuad(ctx, s, side, g, len, high - 1.5, high, 'rgba(255,255,255,0.18)')
}

/** 분리수거함 — 일반/재활용 두 칸. 커피컵을 여기 버린다. */
export function drawTrashBins(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 14, 7, 0.18)
  const bins = [
    { off: -0.26, body: { top: '#5b6472', left: '#3a414c', right: '#4a525e' }, lid: '#6f7a8a', mark: '#c9d2de' },
    { off: 0.26, body: { top: '#4a7fa8', left: '#2f5372', right: '#3d6a8f' }, lid: '#5b93bd', mark: '#cfe6f5' },
  ]
  for (const b of bins) {
    drawBox(ctx, s, gx + b.off, gy, 0.26, 0.26, 8, b.body)
    const p = toScreen(gx + b.off, gy)
    // 뚜껑과 투입구
    px(ctx, s, p.x - 5.4, p.y - 9.4, 10.8, 1.6, b.lid)
    px(ctx, s, p.x - 5.4, p.y - 9.4, 10.8, 0.6, '#ffffff40')
    px(ctx, s, p.x - 2.6, p.y - 9.8, 5.2, 0.9, '#1b2029')
    // 라벨
    px(ctx, s, p.x - 2.4, p.y - 6, 4.8, 2.6, b.mark)
    px(ctx, s, p.x - 1.6, p.y - 5.2, 3.2, 0.7, b.body.left)
  }
}

export const PROPS = [
  // 회의실
  { gx: 10.5, gy: 2, draw: drawMeetingTable },
  { gx: 9.4, gy: 2, draw: drawMeetingChair },
  { gx: 11.6, gy: 2, draw: drawMeetingChair },
  { gx: 10.5, gy: 3.1, draw: drawMeetingChair },
  { gx: 10.5, gy: 0.9, draw: drawMeetingChair },
  // 탕비실
  { gx: 10, gy: 7.4, draw: drawCoffeeCorner },
  { gx: 11.8, gy: 10.6, draw: drawTrashBins },
  { gx: 9.3, gy: 11, draw: drawPlant },
  // 휴게실
  { gx: 3.2, gy: 15.2, draw: drawSofa },
  { gx: 3.2, gy: 14.1, draw: drawLoungeTable },
  { gx: 9.6, gy: 15.2, draw: drawSofa },
  { gx: 9.6, gy: 14.1, draw: drawLoungeTable },
  { gx: 0.5, gy: 15.6, draw: drawPlant },
  { gx: 12.4, gy: 13.4, draw: drawPlant },
  // 사무실
  { gx: 0.4, gy: 11, draw: drawPlant },
  { gx: 8, gy: 11, draw: drawPlant },
]
