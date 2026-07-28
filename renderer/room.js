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
  pxSolid,
} from './iso.js'
import { ROOMS } from './layout.js'
import {
  drawFridge,
  drawWaterCooler,
  drawSink,
  drawMicrowave,
  drawShelf,
  drawBookshelf,
  drawFloorLamp,
  drawVending,
  drawBeanBag,
  drawLoungeRug,
  drawWorkstation,
  drawChair,
  drawChairBack,
  drawChairArms,
  drawPartitions,
  drawMeetingTable,
  drawMeetingChair,
  drawCoffeeCorner,
  drawTrashBins,
  drawSofa,
  drawLoungeTable,
  drawPlant,
  workstationFootprint,
} from './furniture.js'

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
  // 휴게실 — 따뜻한 색 러그 느낌
  lounge: [
    { top: '#e6d9c6', side: '#bfae97' },
    { top: '#dfd0ba', side: '#b8a68e' },
  ],
}

export function drawFloor(ctx, s) {
  for (const key of Object.keys(ROOMS)) {
    const r = ROOMS[key]
    // 없는 바닥재 이름이 들어와도 화면 전체가 죽지 않게 기본값으로 떨어진다.
    const set = FLOOR_SETS[r.floor] ?? FLOOR_SETS.wood
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
  drawTV(ctx, s, 'nw', 13.6, t) // 휴게실 벽걸이 TV
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

/**
 * 문 — 문틀 + **활짝 열린 문짝** + 손잡이 + 명패.
 *
 * 전에는 문틀만 그리고 구멍만 뚫려 있어서 "벽이 끊긴 자리"처럼 보였다.
 * 실제로는 문짝이 안쪽으로 열려 벽에 붙어 있어야 문으로 읽힌다.
 * dir='nw'면 세로벽의 문(문짝이 gx 방향으로 열린다), 'ne'면 가로벽의 문.
 */
export function drawDoorway(ctx, s, gx, gy, dir = 'nw') {
  const p = toScreen(gx, gy)
  const H = INNER_H
  const JAMB = { top: '#f2ede3', lit: '#fdfaf3', left: '#c8bfae', right: '#e0d8c8', edge: '#b3a894' }

  // 양쪽 문설주
  for (const e of [-1, 1]) {
    const jx = dir === 'nw' ? gx : gx + e * 0.5
    const jy = dir === 'nw' ? gy + e * 0.5 : gy
    pxSolid(ctx, s, jx, jy, 0.1, 0.1, H, JAMB)
  }

  // 열린 문짝 — 한쪽 설주에 붙어 방 안쪽으로 90도 열려 있다
  const hingeX = dir === 'nw' ? gx : gx - 0.5
  const hingeY = dir === 'nw' ? gy - 0.5 : gy
  const leafCx = dir === 'nw' ? hingeX + 0.28 : hingeX
  const leafCy = dir === 'nw' ? hingeY : hingeY + 0.28
  const leaf = pxSolid(
    ctx,
    s,
    leafCx,
    leafCy,
    dir === 'nw' ? 0.5 : 0.08,
    dir === 'nw' ? 0.08 : 0.5,
    H - 2,
    { top: '#e9dfcb', lit: '#f6efe1', left: '#b7a68c', right: '#d6c9b0', edge: '#9d9078' },
  )
  // 문짝 패널 홈 두 칸
  const lx = leaf.left.x
  const rx = leaf.right.x
  for (const yy of [H - 8, H - 16]) {
    px(ctx, s, lx + 2, leaf.front.y - yy, rx - lx - 4, 1, 'rgba(140,125,100,0.35)')
  }
  // 손잡이
  px(ctx, s, rx - 3, leaf.front.y - H / 2, 1.6, 1.2, '#9c8a6d')

  // 상인방
  px(ctx, s, p.x - 12, p.y - H - 1.4, 24, 2.8, '#e8e2d6')
  px(ctx, s, p.x - 12, p.y - H - 1.4, 24, 0.8, '#fbf7ef')
  // 문지방
  px(ctx, s, p.x - 9, p.y - 0.9, 18, 1.4, '#c9bfa9')
  px(ctx, s, p.x - 9, p.y - 0.9, 18, 0.5, '#e2d9c5')
  // 명패
  px(ctx, s, p.x + 7, p.y - H + 4, 5, 3, '#8fa8c4')
  px(ctx, s, p.x + 7.6, p.y - H + 5, 3.8, 1, '#eaf2fb')
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

/** 벽걸이 TV — 휴게실 벽에 건다(벽면에 눕혀 그린다). */
function drawTV(ctx, s, side, g, t) {
  const len = 2.4
  const low = 26
  const high = 40
  wallQuad(ctx, s, side, g - 0.1, len + 0.2, low - 1, high + 1, '#22262e')
  wallQuad(ctx, s, side, g - 0.1, len + 0.2, high, high + 1, '#3a404a') // 위 테두리 하이라이트
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
  wallQuad(ctx, s, side, g, len, high - 1.5, high, 'rgba(255,255,255,0.16)')
  // 받침대와 전원 LED
  wallQuad(ctx, s, side, g + len / 2 - 0.1, 0.2, low - 2.5, low, '#2b3038')
  wallQuad(ctx, s, side, g + len - 0.3, 0.12, low + 0.6, low + 1.2, '#7ee08a')
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


// w·d는 그 물건이 차지하는 바닥 넓이(격자 단위)다. 경로 탐색이 이걸 보고
// 돌아간다 — 없으면 지나갈 수 있는 것(러그)이거나, 사람이 앉는 자리(의자)다.
// 소파·빈백은 **앉는 자리**지만 몸통은 막아야 하므로 넣는다. 앉으러 갈 때는
// 바로 앞까지 걸어간 뒤 앉는다(layout.js routeTo 참고).
export const PROPS = [
  // 회의실
  { gx: 10.5, gy: 2, draw: drawMeetingTable, w: 1.37, d: 0.9 },
  { gx: 9.5, gy: 2, draw: drawMeetingChair },
  { gx: 11.5, gy: 2, draw: drawMeetingChair },
  { gx: 10.5, gy: 3, draw: drawMeetingChair },
  { gx: 10.5, gy: 1, draw: drawMeetingChair },
  // 탕비실 — 커피머신·싱크대·냉장고·정수기·선반·분리수거
  { gx: 9.6, gy: 6.6, draw: drawCoffeeCorner, w: 1.16, d: 0.58 },
  { gx: 11.6, gy: 6.6, draw: drawSink, w: 0.84, d: 0.47 },
  { gx: 12.2, gy: 8.6, draw: drawFridge, w: 0.4, d: 0.38 },
  { gx: 9.3, gy: 8.4, draw: drawWaterCooler, w: 0.24, d: 0.24 },
  { gx: 11.4, gy: 9.6, draw: drawTrashBins, w: 0.9, d: 0.3 },
  { gx: 9.4, gy: 10.6, draw: drawPlant, w: 0.3, d: 0.3 },
  // 휴게실 — 소파·티테이블·책장·자판기·조명·빈백
  { gx: 3, gy: 12.6, draw: drawLoungeRug },
  { gx: 3, gy: 12.6, draw: drawSofa, w: 1.36, d: 0.5 },
  { gx: 3, gy: 13.7, draw: drawLoungeTable, w: 0.53, d: 0.37 },
  { gx: 1, gy: 14.6, draw: drawBeanBag, w: 0.32, d: 0.3 },
  { gx: 4.6, gy: 14.6, draw: drawBeanBag, w: 0.32, d: 0.3 },
  { gx: 6.4, gy: 12.4, draw: drawBookshelf, w: 0.53, d: 0.22 },
  { gx: 0.4, gy: 12.6, draw: drawFloorLamp, w: 0.15, d: 0.15 },
  { gx: 8.6, gy: 12.4, draw: drawVending, w: 0.42, d: 0.32 },
  { gx: 10.6, gy: 12.6, draw: drawSofa, w: 1.36, d: 0.5 },
  { gx: 10.6, gy: 13.7, draw: drawLoungeTable, w: 0.53, d: 0.37 },
  { gx: 12.4, gy: 14.4, draw: drawPlant, w: 0.3, d: 0.3 },
  { gx: 7.4, gy: 15.2, draw: drawPlant, w: 0.3, d: 0.3 },
  // 사무실
  { gx: 0.4, gy: 11, draw: drawPlant, w: 0.3, d: 0.3 },
]

/** 가구가 막는 바닥 사각형들. layout.js의 통행 격자가 이걸 받는다. */
export function propFootprints() {
  return PROPS.filter((p) => p.w).map((p) => ({
    x0: p.gx - p.w / 2,
    y0: p.gy - p.d / 2,
    x1: p.gx + p.w / 2,
    y1: p.gy + p.d / 2,
  }))
}

// 앱은 room.js 하나만 import하면 되도록 가구 그리기도 여기서 내보낸다.
export {
  workstationFootprint,
  drawFridge,
  drawWaterCooler,
  drawSink,
  drawMicrowave,
  drawShelf,
  drawBookshelf,
  drawFloorLamp,
  drawVending,
  drawBeanBag,
  drawLoungeRug,
  drawWorkstation,
  drawChair,
  drawChairBack,
  drawChairArms,
  drawPartitions,
  drawMeetingTable,
  drawMeetingChair,
  drawCoffeeCorner,
  drawTrashBins,
  drawSofa,
  drawLoungeTable,
  drawPlant,
}
