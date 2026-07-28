// 가구 — **정확한 아이소 다각형 + 1픽셀 디테일**로 그린다.
//
// 크기는 전부 **격자 단위**로 적는다. 1격자 = 타일 하나 ≈ 1.9m.
// 그래서 gu(1.6) 처럼 미터로 생각하고 쓸 수 있다. 높이만 논리 픽셀(1px ≈ 8.5cm)이다.
// 캐릭터 키가 20px(1.7m)이므로 책상 높이 9px(0.76m)가 기준점이다.

import { TILE_W, TILE_H, toScreen, px, pxPoly, pxSolid, boxPal, tint, drawAO } from './iso.js'


/** 미터 → 격자 단위 (타일 하나가 약 1.9m). */
export const gu = (meters) => meters / 1.9
/** 미터 → 논리 픽셀 높이. */
export const ph = (meters) => meters * 11.8

export const DESK_H = 9

const OAK = boxPal('#d9bc90')
const OAK_DARK = boxPal('#9c8059')
const DRAWER_PAL = boxPal('#cdb086')
const SEAT_PAL = boxPal('#59667e')
const BACK_PAL = boxPal('#4d5a72')
const METAL_PAL = boxPal('#8d96a5')
const DARK_PAL = boxPal('#333a47')
const PANEL_PAL = boxPal('#93a6bd')
const SOFA_PAL = boxPal('#6f86a6')
const SOFA_CUSHION = boxPal('#8fa4c0')

// ── 공통 질감 ────────────────────────────────────────────────────────────
/** 윗면 다각형 안쪽에 결을 긋는다(다각형 모서리와 같은 기울기라 어긋나지 않는다). */
function grain(ctx, s, face, color, step = 3) {
  const { left, front, right, back } = face
  const n = Math.max(2, Math.round((front.y - back.y) / step))
  for (let i = 1; i < n; i++) {
    const f = i / n
    const ax = left.x + (back.x - left.x) * f
    const ay = left.y + (back.y - left.y) * f
    const bx = front.x + (right.x - front.x) * f
    const by = front.y + (right.y - front.y) * f
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1, 0.7 * s)
    ctx.beginPath()
    ctx.moveTo(ax * s, ay * s)
    ctx.lineTo(bx * s, by * s)
    ctx.stroke()
  }
}

function speckle(ctx, s, x, y, w, h, color, count = 20, alpha = 0.16) {
  ctx.save()
  ctx.globalAlpha = alpha
  for (let i = 0; i < count; i++) {
    px(ctx, s, x + ((i * 37) % Math.max(1, Math.round(w))), y + ((i * 23) % Math.max(1, Math.round(h))), 1, 1, color)
  }
  ctx.restore()
}

// ── 듀얼 모니터 ──────────────────────────────────────────────────────────
//
// 화면 좌표에 사각형 두 개를 붙여 그렸더니 **판때기를 세워 놓은 것처럼** 보였다.
// 모니터도 입체이므로 얇은 상자로 세우고, 화면은 그 상자의 **앞면(사용자를
// 마주보는 면)에 눕혀** 그려야 한다. 그러면 책상 뒷선을 따라 자연스럽게 놓인다.

/** 얇은 상자의 앞면(left→front 면)에 사각형을 눕혀 그린다. u,v는 0~1 비율. */
function faceRect(ctx, s, f, h, u0, u1, v0, v1, color) {
  const A = f.left
  const B = f.front
  const p = (u, v) => ({ x: A.x + (B.x - A.x) * u, y: A.y + (B.y - A.y) * u + h * (1 - v) })
  pxPoly(ctx, s, [p(u0, v1), p(u1, v1), p(u1, v0), p(u0, v0)], color)
}

function drawMonitorUnit(ctx, s, gx, gy, gw, on, t, seed) {
  const H = 7
  const lift = DESK_H + 4.5
  // 베젤(얇은 상자)
  const f = pxSolid(ctx, s, gx, gy, gw, gu(0.08), H, boxPal('#39414f'), lift)
  // 화면 — 앞면에 눕힌다
  faceRect(ctx, s, f, H, 0.08, 0.92, 0.14, 0.9, on ? '#16202e' : '#cfdcea')
  if (on) {
    const colors = ['#7fd1ff', '#a5e887', '#ffd479', '#ff9ec4']
    for (let i = 0; i < 4; i++) {
      const v = 0.78 - i * 0.16
      const start = 0.14 + (((i * 3 + seed * 2 + Math.floor(t / 320)) % 3) * 0.06)
      const len = 0.16 + (((i * 5 + seed * 3 + Math.floor(t / 760)) % 5) * 0.1)
      faceRect(ctx, s, f, H, start, Math.min(0.88, start + len), v, v + 0.09, colors[(i + seed) % 4])
    }
  } else {
    faceRect(ctx, s, f, H, 0.08, 0.92, 0.55, 0.9, '#dde8f3')
  }
  // 목 + 받침
  const p = toScreen(gx, gy)
  px(ctx, s, p.x - 0.5, p.y - lift, 1, 4.5, '#7f8998')
  px(ctx, s, p.x - 1, p.y - lift, 0.5, 4.5, '#b4bcc8')
  return f
}

function drawDualMonitor(ctx, s, gx, gy, on, t) {
  const gw = gu(0.62) // 24인치 한 대
  // 공용 받침 — 두 대를 하나의 스탠드가 받친다
  pxSolid(ctx, s, gx, gy, gw * 2.1, gu(0.3), 1, METAL_PAL, DESK_H)
  // 책상 뒷선(gx 축)을 따라 나란히 — 맞닿게 배치
  drawMonitorUnit(ctx, s, gx - gw / 2, gy, gw, on, t, 0)
  drawMonitorUnit(ctx, s, gx + gw / 2, gy, gw, on, t, 1)
}

// ── 책상 위 소품 ─────────────────────────────────────────────────────────
function drawKeyboard(ctx, s, gx, gy) {
  const f = pxSolid(ctx, s, gx, gy, gu(0.45), gu(0.18), 0.8, boxPal('#e2e8f0'), DESK_H)
  const p = toScreen(gx, gy)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 5; c++) {
      px(ctx, s, p.x - 4 + c * 1.7 + r * 0.5, p.y - DESK_H - 1.6 + r * 0.9, 1, 1, '#b9c2d0')
    }
  }
  px(ctx, s, p.x - 2, p.y - DESK_H + 1.2, 4, 1, '#b9c2d0')
  px(ctx, s, f.right.x - 3, f.right.y - 1.5, 2, 2, '#e6ebf2') // 마우스
  return f
}

export function drawMug(ctx, s, gx, gy, t, fresh = false) {
  const p = toScreen(gx, gy)
  const h = 3
  for (let i = 0; i < h; i++) px(ctx, s, p.x - 1.5, p.y - DESK_H - h + i, 3, 1, i === 0 ? '#ffffff' : '#eef2f7')
  px(ctx, s, p.x + 1.5, p.y - DESK_H - h + 1, 1, 1, '#dfe5ec')
  px(ctx, s, p.x - 1.5, p.y - DESK_H - h, 3, 1, '#6b4a2f')
  px(ctx, s, p.x - 1.5, p.y - DESK_H - 1, 3, 1, '#e05c5c')
  if (!fresh) return
  ctx.save()
  ctx.globalAlpha = 0.4
  for (let i = 0; i < 2; i++) {
    const rise = ((t / 900 + i * 0.5) % 1) * 3.5
    px(ctx, s, p.x - 0.5 + i + Math.sin(rise * 2) * 0.5, p.y - DESK_H - h - 1 - rise, 1, 1, '#ffffff')
  }
  ctx.restore()
}

function drawPapers(ctx, s, gx, gy) {
  for (let i = 0; i < 3; i++) {
    pxSolid(ctx, s, gx + i * 0.01, gy - i * 0.01, gu(0.3), gu(0.22), 0.4, boxPal(i === 2 ? '#ffffff' : '#f0f0ea'), DESK_H + i * 0.4)
  }
  const p = toScreen(gx, gy)
  px(ctx, s, p.x - 2, p.y - DESK_H - 2, 4, 1, 'rgba(120,130,150,0.45)')
}

// ── ㄱ자 책상 ────────────────────────────────────────────────────────────
//
// ㄱ자는 두 상판이 **모서리를 정확히 공유**해야 성립한다. 중심을 눈대중으로 옮기면
// 두 판이 대각으로 밀려 찌그러진다. 그래서 범위(x0..x1, y0..y1)로 적고 중심은 계산한다.
//
//   가로획: gx -0.5..0.5, gy -0.42..-0.06   (1.9m x 0.68m)
//   세로획: gx  0.14..0.5, gy -0.06.. 0.5   ← 오른쪽 끝(0.5)을 공유하며 앞으로 내려온다
const BAR = { x0: -0.5, x1: 0.5, y0: -0.42, y1: -0.06 }
const LEG = { x0: 0.14, x1: 0.5, y0: -0.06, y1: 0.5 }
/**
 * 자리 하나가 차지하는 바닥 넓이(격자 사각형). 경로 탐색이 이걸 보고 피해 간다.
 * **그리는 코드 바로 옆에 둔다** — 좌표를 두 군데 적으면 반드시 어긋난다.
 * 의자는 넣지 않는다. 앉으려면 걸어 들어가야 한다.
 */
export function workstationFootprint(gx, gy) {
  return [
    { x0: gx + BAR.x0, y0: gy + BAR.y0, x1: gx + BAR.x1, y1: gy + BAR.y1 },
    { x0: gx + LEG.x0, y0: gy + LEG.y0, x1: gx + LEG.x1, y1: gy + LEG.y1 },
    // 파티션 두 장 (drawPartitions의 panelAt 좌표와 같다)
    { x0: gx - 0.54, y0: gy - 0.47, x1: gx - 0.46, y1: gy + 0.35 },
    { x0: gx - 0.47, y0: gy - 0.54, x1: gx + 0.35, y1: gy - 0.46 },
  ]
}

const cen = (r) => ({ gx: (r.x0 + r.x1) / 2, gy: (r.y0 + r.y1) / 2 })
const wid = (r) => r.x1 - r.x0
const dep = (r) => r.y1 - r.y0

export function drawWorkstation(ctx, s, gx, gy, screenOn, t, cups = 0) {
  const b = cen(BAR)
  const l = cen(LEG)
  const bc = { gx: gx + b.gx, gy: gy + b.gy }
  const lc = { gx: gx + l.gx, gy: gy + l.gy }
  drawAO(ctx, s, gx + 0.1, gy - 0.05, 24, 12, 0.2)

  // 다리 — 상판 바깥 모서리에
  for (const [lx, ly] of [
    [gx + BAR.x0 + 0.05, gy + BAR.y0 + 0.06],
    [gx + BAR.x0 + 0.05, gy + BAR.y1 - 0.06],
    [gx + BAR.x1 - 0.05, gy + BAR.y0 + 0.06],
    [gx + LEG.x0 + 0.05, gy + LEG.y1 - 0.06],
    [gx + LEG.x1 - 0.05, gy + LEG.y1 - 0.06],
  ]) {
    pxSolid(ctx, s, lx, ly, gu(0.09), gu(0.09), DESK_H, OAK_DARK)
  }

  // 상판 — 세로획(뒤) 다음 가로획(앞)
  const legFace = pxSolid(ctx, s, lc.gx, lc.gy, wid(LEG), dep(LEG), 1.8, OAK, DESK_H - 1.8)
  grain(ctx, s, legFace, 'rgba(150,120,80,0.22)', 4)
  const barFace = pxSolid(ctx, s, bc.gx, bc.gy, wid(BAR), dep(BAR), 1.8, OAK, DESK_H - 1.8)
  grain(ctx, s, barFace, 'rgba(150,120,80,0.22)', 4)

  // 서랍
  pxSolid(ctx, s, lc.gx, lc.gy + 0.12, gu(0.42), gu(0.42), DESK_H - 2, DRAWER_PAL)
  const dp = toScreen(lc.gx, lc.gy + 0.12)
  for (const dy of [2.4, 5]) {
    px(ctx, s, dp.x - 4, dp.y - dy, 8, 1, tint('#cdb086', 0.72))
    px(ctx, s, dp.x - 2, dp.y - dy + 1.4, 4, 1, '#8a7659')
  }

  drawDualMonitor(ctx, s, bc.gx, bc.gy - 0.1, screenOn, t)
  drawKeyboard(ctx, s, bc.gx, bc.gy + 0.12)
  drawPapers(ctx, s, lc.gx - 0.06, lc.gy - 0.16)

  for (let i = 0; i < Math.min(cups, 6); i++) {
    const col = i % 3
    const row = Math.floor(i / 3)
    drawMug(ctx, s, lc.gx - 0.1 + col * 0.1, lc.gy + 0.02 + row * 0.1, t, i === 0)
  }
}

// ── 의자 ─────────────────────────────────────────────────────────────────
// 앉은 캐릭터와 겹치므로 **좌판까지만** 여기서 그리고, 등받이와 팔걸이는
// 캐릭터 뒤/앞에 각각 따로 그린다.
// 좌판 높이. 캐릭터가 20px ≈ 175cm이므로 1px ≈ 9cm — 사무용 의자 45cm는 약 5px다.
// 쿠션 두께 1.8을 더한 **윗면**이 그 높이가 되도록 잡는다(앉는 높이는 윗면이 기준).
const SEAT_H = 3.4
const SEAT_TOP = SEAT_H + 1.8

export function drawChair(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 6, 3, 0.18)
  const p = toScreen(gx, gy)

  // 5발 받침 — 낮고 짧게(앉으면 캐릭터에 가려진다)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.55
    const ux = Math.cos(a)
    const uy = Math.sin(a) * 0.5
    for (let d = 1; d <= 3.4; d += 1.1) {
      px(ctx, s, p.x + ux * d - 0.5, p.y + uy * d - 0.5, 1, 1, '#3c4453')
    }
    px(ctx, s, p.x + ux * 3.8 - 0.5, p.y + uy * 3.8 - 0.5, 1.4, 1, '#262d38')
  }
  px(ctx, s, p.x - 0.5, p.y - SEAT_H, 1, SEAT_H, '#7f8998')

  // 좌판 — 방석 두께를 주고 앞모서리를 한 줄 어둡게
  const f = pxSolid(ctx, s, gx, gy, gu(0.52), gu(0.52), 1.8, SEAT_PAL, SEAT_H)
  px(ctx, s, f.left.x + 1, f.front.y - 0.6, f.right.x - f.left.x - 2, 1, tint('#59667e', 1.22))
}

/** 등받이 — 캐릭터보다 **뒤**에 그린다. */
export function drawChairBack(ctx, s, gx, gy) {
  const p = toScreen(gx - 0.16, gy - 0.16)
  const W = 9
  const H = 8
  // 좌판 **윗면**에서 시작해 어깨 높이까지. 전에는 좌판 아래에서 시작해
  // 등받이가 종아리까지 내려왔고, 그래서 앉은 사람이 등받이에 걸터앉은 것처럼 보였다.
  const bottom = p.y - SEAT_TOP + 1
  for (let i = 0; i < H; i++) {
    px(ctx, s, p.x - W / 2, bottom - H + i, W, 1, i === 0 ? '#6b7a95' : i >= H - 1 ? '#333c4d' : '#4c5870')
  }
  ctx.save()
  ctx.globalAlpha = 0.3
  for (let r = 1; r < H - 1; r += 2) {
    for (let c = 1; c < W - 1; c += 2) px(ctx, s, p.x - W / 2 + c, bottom - H + r, 1, 1, '#20283a')
  }
  ctx.restore()
}

/** 팔걸이 — 캐릭터보다 **앞**에 그려야 팔을 걸친 것처럼 보인다. */
export function drawChairArms(ctx, s, gx, gy) {
  const p = toScreen(gx, gy)
  for (const e of [-1, 1]) {
    const ax = p.x + e * 6
    px(ctx, s, ax - 0.5, p.y - SEAT_H - 1, 1, 3, '#404a5e')
    px(ctx, s, ax - 2, p.y - SEAT_H - 4, 4, 1.4, '#5a6880')
    px(ctx, s, ax - 2, p.y - SEAT_H - 4, 4, 0.6, '#75839f')
  }
}

// ── 큐비클 파티션 ────────────────────────────────────────────────────────
// 이전엔 얇은 상자에 점만 찍어 철망처럼 보였다. 실제 큐비클처럼
// **프레임 + 패브릭 패널 + 상단 레일 + 다리**로 구성한다.
const PART_H = 13

export function drawPartitions(ctx, s, gx, gy) {
  const panelAt = (cx, cy, gw, gd) => {
    drawAO(ctx, s, cx, cy, 14, 5, 0.14)
    // 패널 본체
    const f = pxSolid(ctx, s, cx, cy, gw, gd, PART_H, PANEL_PAL)
    const x0 = f.left.x
    const x1 = f.right.x
    // 패브릭 질감(가로 짜임)
    ctx.save()
    ctx.globalAlpha = 0.13
    for (let i = 2; i < PART_H - 2; i += 2) {
      px(ctx, s, x0 + 1, f.front.y - i, x1 - x0 - 2, 1, '#3f4d61')
    }
    ctx.restore()
    speckle(ctx, s, x0 + 1, f.front.y - PART_H + 2, x1 - x0 - 2, PART_H - 4, '#3f4d61', 22, 0.12)
    // 상단 알루미늄 레일
    pxSolid(ctx, s, cx, cy, gw + 0.02, gd + 0.02, 1.4, boxPal('#c8d2dd'), PART_H)
    // 세로 프레임(양 끝)과 다리
    for (const ex of [x0, x1 - 1]) {
      px(ctx, s, ex, f.front.y - PART_H, 1, PART_H, '#6a7c93')
      px(ctx, s, ex - 1, f.front.y - 1.6, 3, 1.6, '#55657a')
    }
  }
  panelAt(gx - 0.5, gy - 0.06, gu(0.14), gu(1.55))
  panelAt(gx - 0.06, gy - 0.5, gu(1.55), gu(0.14))
}

// ── 회의 테이블 ──────────────────────────────────────────────────────────
export function drawMeetingTable(ctx, s, gx, gy) {
  const H = 9
  drawAO(ctx, s, gx, gy, 26, 13, 0.2)
  for (const [ox, oy] of [
    [-0.36, -0.26],
    [0.36, -0.26],
    [-0.36, 0.26],
    [0.36, 0.26],
  ]) {
    pxSolid(ctx, s, gx + ox, gy + oy, gu(0.1), gu(0.1), H, OAK_DARK)
  }
  const f = pxSolid(ctx, s, gx, gy, gu(2.6), gu(1.7), 2, OAK, H - 2)
  grain(ctx, s, f, 'rgba(150,120,80,0.2)', 4)

  for (const ox of [-0.22, 0.22]) {
    const lp = toScreen(gx + ox, gy + 0.04)
    pxSolid(ctx, s, gx + ox, gy + 0.04, gu(0.42), gu(0.28), 0.6, boxPal('#dfe5ec'), H)
    for (let i = 0; i < 5; i++) px(ctx, s, lp.x - 3 + i * 1.4, lp.y - H - 1, 1, 1, '#b7bfcb')
    for (let i = 0; i < 5; i++) px(ctx, s, lp.x - 4, lp.y - H - 5.6 + i, 8, 1, i === 0 ? '#4a5464' : '#2f3644')
    px(ctx, s, lp.x - 3, lp.y - H - 4.6, 6, 3, '#5ca9d6')
  }
  const p = toScreen(gx, gy)
  pxSolid(ctx, s, gx, gy - 0.02, gu(0.34), gu(0.24), 1, boxPal('#5f697b'), H)
  for (let i = -1; i <= 1; i++) px(ctx, s, p.x + i * 1.6 - 0.5, p.y - H - 1.4, 1, 1, i === 0 ? '#7ee08a' : '#39424f')
}

export function drawMeetingChair(ctx, s, gx, gy) {
  drawChair(ctx, s, gx, gy)
  drawChairBack(ctx, s, gx, gy)
  drawChairArms(ctx, s, gx, gy)
}

// ── 탕비실 ───────────────────────────────────────────────────────────────
export function drawCoffeeCorner(ctx, s, gx, gy, t) {
  const H = 10
  drawAO(ctx, s, gx, gy, 20, 10, 0.2)
  pxSolid(ctx, s, gx, gy, gu(2.2), gu(1.1), H - 1, boxPal('#ddd0b8'))
  const f = pxSolid(ctx, s, gx, gy, gu(2.3), gu(1.2), 1, boxPal('#efe6d6'), H - 1)

  for (const e of [-1, 1]) {
    px(ctx, s, f.front.x + e * 6, f.front.y - H + 3, 1, H - 5, 'rgba(120,100,70,0.25)')
    px(ctx, s, f.front.x + e * 3.5, f.front.y - H + 5.5, 1, 3, '#9c8a6d')
  }

  const m = { gx: gx - 0.16, gy: gy - 0.04 }
  pxSolid(ctx, s, m.gx, m.gy, gu(0.9), gu(0.6), 10, DARK_PAL, H)
  const mp = toScreen(m.gx, m.gy)
  px(ctx, s, mp.x - 4, mp.y - H - 9, 8, 4, '#20262f')
  px(ctx, s, mp.x - 3, mp.y - H - 8.4, 4, 1, '#5ce0a0')
  px(ctx, s, mp.x - 3, mp.y - H - 6.6, 1.5, 1, '#e05c5c')
  px(ctx, s, mp.x - 1, mp.y - H - 6.6, 1.5, 1, '#8f97a6')
  px(ctx, s, mp.x - 0.5, mp.y - H - 4.6, 1, 2, '#9aa2b1')
  px(ctx, s, mp.x - 4, mp.y - H - 1.4, 8, 1, '#39424f')
  for (let i = 0; i < 4; i++) px(ctx, s, mp.x - 3 + i * 2, mp.y - H - 1.2, 1, 1, '#6b7484')
  px(ctx, s, mp.x - 1, mp.y - H - 3.4, 2, 2, '#ffffff')
  px(ctx, s, mp.x - 1, mp.y - H - 3.4, 2, 1, '#6b4a2f')
  ctx.save()
  ctx.globalAlpha = 0.4
  for (let i = 0; i < 2; i++) {
    const rise = ((t / 1100 + i * 0.5) % 1) * 4
    px(ctx, s, mp.x - 0.5 + Math.sin(rise * 2) * 0.6, mp.y - H - 4.5 - rise, 1, 1, '#ffffff')
  }
  ctx.restore()

  const wp = toScreen(gx + 0.26, gy - 0.04)
  for (let i = 0; i < 8; i++) {
    px(ctx, s, wp.x - 1.5, wp.y - H - 8 + i, 3, 1, i < 3 ? 'rgba(226,242,251,0.9)' : 'rgba(150,205,232,0.95)')
  }
  const cp = toScreen(gx + 0.36, gy + 0.18)
  for (let i = 0; i < 3; i++) {
    px(ctx, s, cp.x - 1.2 + i * 0.2, cp.y - H - 2 - i * 1.4, 2.4, 1.6, i === 2 ? '#ffffff' : '#f0f3f7')
  }
}

export function drawTrashBins(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 16, 6, 0.18)
  for (const b of [
    { off: -0.3, pal: boxPal('#4a525e'), mark: '#c9d2de' }, // 일반
    { off: 0, pal: boxPal('#3d6a8f'), mark: '#cfe6f5' }, // 재활용
    { off: 0.3, pal: boxPal('#4f7a43'), mark: '#d9efc8' }, // 음식물
  ]) {
    const f = pxSolid(ctx, s, gx + b.off, gy, gu(0.45), gu(0.45), 8, b.pal)
    pxSolid(ctx, s, gx + b.off, gy, gu(0.5), gu(0.5), 1.2, boxPal(tint(b.pal.top, 1.08)), 8)
    px(ctx, s, f.front.x - 2, f.front.y - 9.6, 4, 1, '#1b2029')
    px(ctx, s, f.front.x - 1.5, f.front.y - 5, 3, 2, b.mark)
  }
}

// ── 휴게실 ───────────────────────────────────────────────────────────────
export function drawSofa(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 20, 9, 0.2)
  pxSolid(ctx, s, gx, gy - 0.24, gu(2.1), gu(0.28), 9, SOFA_PAL) // 등받이
  const seat = pxSolid(ctx, s, gx, gy, gu(2.1), gu(0.85), 4, SOFA_PAL)
  speckle(ctx, s, seat.left.x + 2, seat.front.y - 4, seat.right.x - seat.left.x - 4, 3, '#42536b', 22, 0.14)

  for (const e of [-0.28, 0.28]) {
    pxSolid(ctx, s, gx + e, gy, gu(0.85), gu(0.7), 1.4, SOFA_CUSHION, 4)
  }
  for (const e of [-1, 1]) {
    pxSolid(ctx, s, gx + e * 0.6, gy, gu(0.3), gu(0.85), 6.5, SOFA_PAL)
  }
  for (const [e, color, edge] of [
    [-0.3, '#e0c07a', '#c9a75f'],
    [0.3, '#c98b96', '#b0727d'],
  ]) {
    const cp = toScreen(gx + e, gy - 0.14)
    for (let i = 0; i < 4; i++) px(ctx, s, cp.x - 2.5, cp.y - 8 + i, 5, 1, i === 0 ? edge : color)
  }
}

export function drawLoungeTable(ctx, s, gx, gy, t) {
  drawAO(ctx, s, gx, gy, 11, 5, 0.18)
  for (const [ox, oy] of [
    [-0.18, -0.14],
    [0.18, -0.14],
    [-0.18, 0.14],
    [0.18, 0.14],
  ]) {
    pxSolid(ctx, s, gx + ox, gy + oy, gu(0.07), gu(0.07), 4, OAK_DARK)
  }
  pxSolid(ctx, s, gx, gy, gu(1.0), gu(0.7), 1, OAK, 4)
  const p = toScreen(gx, gy)
  px(ctx, s, p.x - 4, p.y - 5.4, 4, 2, '#7fb3d5')
  px(ctx, s, p.x - 3.4, p.y - 6, 4, 2, '#e8a0a8')
  px(ctx, s, p.x + 1.5, p.y - 6.6, 2, 2.2, '#ffffff')
  px(ctx, s, p.x + 1.5, p.y - 6.8, 2, 0.8, '#6b4a2f')
  ctx.save()
  ctx.globalAlpha = 0.35
  const rise = ((t / 1200) % 1) * 3
  px(ctx, s, p.x + 2 + Math.sin(rise * 2) * 0.4, p.y - 7.8 - rise, 1, 1, '#ffffff')
  ctx.restore()
}

// ── 화분 ─────────────────────────────────────────────────────────────────
export function drawPlant(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 7, 3.5, 0.18)
  const p = toScreen(gx, gy)
  const potH = 6
  for (let i = 0; i < potH; i++) {
    const w = 8 - i * 0.5
    px(ctx, s, p.x - w / 2, p.y - potH + i, w, 1, i < 1 ? tint('#c9714b', 1.15) : '#c9714b')
    px(ctx, s, p.x - w / 2, p.y - potH + i, 1, 1, tint('#c9714b', 1.3))
    px(ctx, s, p.x + w / 2 - 1, p.y - potH + i, 1, 1, tint('#c9714b', 0.75))
  }
  px(ctx, s, p.x - 4.5, p.y - potH - 1.2, 9, 1.4, '#e08a63')
  px(ctx, s, p.x - 3, p.y - potH - 1, 6, 1, '#5a4433')

  for (const [dx, dy, color] of [
    [-4, -4, '#4d8f52'],
    [4, -5, '#417f48'],
    [-2, -9, '#5aa85d'],
    [2, -10, '#4f9455'],
    [0, -13, '#63b566'],
  ]) {
    const lx = p.x + dx
    const ly = p.y - potH - 1 + dy
    for (let i = 0; i < 5; i++) {
      const w = Math.sin(((i + 0.5) / 5) * Math.PI) * 5 + 1
      px(ctx, s, lx - w / 2, ly + i, w, 1, color)
    }
    px(ctx, s, lx - 0.5, ly, 1, 5, tint(color, 1.25))
    px(ctx, s, p.x + dx * 0.3, ly + 5, 1, Math.max(1, -dy - 4), tint(color, 0.8))
  }
}

// ── 탕비실 추가 오브젝트 ─────────────────────────────────────────────────

/** 냉장고 — 위·아래 문, 손잡이, 자석 메모. */
export function drawFridge(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 11, 5, 0.2)
  const H = 21
  const f = pxSolid(ctx, s, gx, gy, gu(0.75), gu(0.72), H, boxPal('#dfe4ea'))
  const x0 = f.left.x
  const x1 = f.right.x
  const yb = f.front.y
  // 문 경계
  px(ctx, s, x0 + 1, yb - 13, x1 - x0 - 2, 1, '#a9b1bb')
  // 손잡이 두 개
  px(ctx, s, x0 + 3, yb - 12, 1.2, 4, '#8d96a5')
  px(ctx, s, x0 + 3, yb - 19, 1.2, 4, '#8d96a5')
  // 자석 메모
  px(ctx, s, x1 - 7, yb - 18, 3, 2.5, '#ffd479')
  px(ctx, s, x1 - 6.5, yb - 11, 2.5, 2, '#7fd1ff')
}

/** 정수기 — 물통·꼭지·컵 홀더. */
export function drawWaterCooler(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 7, 3.5, 0.18)
  const H = 12
  const f = pxSolid(ctx, s, gx, gy, gu(0.45), gu(0.45), H, boxPal('#e8edf2'))
  const p = toScreen(gx, gy)
  // 물통(반투명 파랑)
  for (let i = 0; i < 7; i++) {
    const w = 6 - Math.abs(i - 3) * 0.4
    px(ctx, s, p.x - w / 2, p.y - H - 7 + i, w, 1, i < 2 ? 'rgba(226,242,251,0.95)' : 'rgba(140,200,232,0.95)')
  }
  // 꼭지 두 개(냉/온)
  px(ctx, s, f.front.x - 2.5, f.front.y - H + 4, 1.5, 2, '#5b93bd')
  px(ctx, s, f.front.x + 1, f.front.y - H + 4, 1.5, 2, '#e05c5c')
  px(ctx, s, f.front.x - 3, f.front.y - H + 1.5, 6, 1, '#b9c2d0') // 물받이
}

/** 싱크대 — 상판·수전·개수대·수납장. */
export function drawSink(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 16, 8, 0.2)
  const H = 10
  pxSolid(ctx, s, gx, gy, gu(1.6), gu(0.9), H - 1, boxPal('#d8d2c6'))
  const f = pxSolid(ctx, s, gx, gy, gu(1.7), gu(1.0), 1, boxPal('#eceff2'), H - 1)
  const p = toScreen(gx, gy)
  // 개수대(움푹 팬 사각형)
  pxSolid(ctx, s, gx - 0.12, gy, gu(0.55), gu(0.5), 0.6, boxPal('#b9c0c8'), H - 0.6)
  // 수전
  px(ctx, s, p.x + 4, p.y - H - 5, 1, 5, '#9aa3b2')
  px(ctx, s, p.x + 1.5, p.y - H - 5, 3.5, 1, '#9aa3b2')
  // 수납장 문 이음매와 손잡이
  for (const e of [-1, 1]) {
    px(ctx, s, f.front.x + e * 5, f.front.y - H + 3, 1, H - 5, 'rgba(120,110,90,0.25)')
    px(ctx, s, f.front.x + e * 2.5, f.front.y - H + 5.5, 1, 2.5, '#9c9384')
  }
  // 세제와 수세미
  px(ctx, s, p.x - 8, p.y - H - 4, 2, 4, '#6fbf72')
  px(ctx, s, p.x - 5, p.y - H - 2.4, 2.5, 2, '#ffd479')
}

/** 전자레인지 — 문·창·버튼. */
export function drawMicrowave(ctx, s, gx, gy, lift) {
  const f = pxSolid(ctx, s, gx, gy, gu(0.55), gu(0.42), 6, boxPal('#4a525e'), lift)
  const x0 = f.left.x
  const yb = f.front.y
  px(ctx, s, x0 + 1.5, yb - 5, 6, 3.5, '#20262f') // 유리창
  px(ctx, s, x0 + 2, yb - 4.5, 5, 1, '#3d4a5c')
  px(ctx, s, x0 + 8.5, yb - 5, 2, 1, '#c9d2de') // 버튼
  px(ctx, s, x0 + 8.5, yb - 3, 2, 1, '#8f97a6')
}

/** 벽 선반 — 컵과 접시. */
export function drawShelf(ctx, s, gx, gy) {
  const H = 15
  const f = pxSolid(ctx, s, gx, gy, gu(1.0), gu(0.3), 1.2, boxPal('#c9ad84'), H)
  const p = toScreen(gx, gy)
  for (let i = 0; i < 4; i++) {
    px(ctx, s, p.x - 7 + i * 3.6, p.y - H - 3.4, 2.6, 3.4, i % 2 ? '#ffffff' : '#f0d9a8')
  }
  // 받침 브래킷
  for (const e of [-1, 1]) px(ctx, s, f.front.x + e * 6, f.front.y - H + 1, 1, 2.5, '#9c8059')
}

// ── 휴게실 추가 오브젝트 ─────────────────────────────────────────────────

/** 책장 — 칸마다 색이 다른 책들. */
export function drawBookshelf(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 13, 6, 0.2)
  const H = 20
  const f = pxSolid(ctx, s, gx, gy, gu(1.0), gu(0.4), H, boxPal('#b08d5f'))
  const x0 = f.left.x + 1.5
  const x1 = f.right.x - 1.5
  const yb = f.front.y
  const colors = ['#e05c5c', '#4a7fd4', '#4caf6d', '#e0af68', '#bb9af7', '#7dcfff']
  for (let shelf = 0; shelf < 3; shelf++) {
    const y = yb - 5 - shelf * 5.5
    px(ctx, s, x0 - 1, y, x1 - x0 + 2, 1, '#8a6b45') // 선반 판
    let x = x0
    let i = shelf
    while (x < x1 - 1.5) {
      const w = 1.2 + ((i * 7) % 3) * 0.5
      const h = 3.4 - ((i * 5) % 2) * 0.6
      px(ctx, s, x, y - h, w, h, colors[i % colors.length])
      px(ctx, s, x, y - h, w, 0.6, tint(colors[i % colors.length], 1.25))
      x += w + 0.4
      i++
    }
  }
}

/** 스탠드 조명 — 기둥·갓·바닥에 번지는 빛. */
export function drawFloorLamp(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 6, 3, 0.18)
  const p = toScreen(gx, gy)
  pxSolid(ctx, s, gx, gy, gu(0.28), gu(0.28), 1, boxPal('#5b6472'))
  px(ctx, s, p.x - 0.5, p.y - 17, 1, 16, '#7f8998')
  // 갓
  for (let i = 0; i < 5; i++) {
    const w = 6 + i * 0.9
    px(ctx, s, p.x - w / 2, p.y - 22 + i, w, 1, i === 0 ? '#fff3d0' : '#f0dfae')
  }
  // 바닥에 번지는 빛
  ctx.save()
  ctx.globalAlpha = 0.12
  ctx.fillStyle = '#ffe9a8'
  ctx.beginPath()
  ctx.ellipse(p.x * s, p.y * s, 14 * s, 7 * s, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** 자판기 — 진열창·상품·배출구. */
export function drawVending(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 11, 5, 0.2)
  const H = 22
  const f = pxSolid(ctx, s, gx, gy, gu(0.8), gu(0.6), H, boxPal('#c0392b'))
  const x0 = f.left.x
  const yb = f.front.y
  // 진열창
  px(ctx, s, x0 + 1.5, yb - H + 2, 9, 12, '#20262f')
  const colors = ['#7fd1ff', '#a5e887', '#ffd479', '#ff9ec4', '#c4b5fd']
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      px(ctx, s, x0 + 2.5 + c * 2.8, yb - H + 3.5 + r * 3.6, 2, 2.6, colors[(r * 3 + c) % colors.length])
    }
  }
  // 버튼 줄과 배출구
  for (let i = 0; i < 3; i++) px(ctx, s, x0 + 12, yb - H + 4 + i * 2.4, 1.6, 1.4, '#f0f0f0')
  px(ctx, s, x0 + 2, yb - 5, 8, 3, '#2b2b2b')
}

/** 빈백 — 둥글게 퍼진 쿠션. */
export function drawBeanBag(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 9, 4.5, 0.18)
  const p = toScreen(gx, gy)
  const base = '#7f9b6f'
  for (let i = 0; i < 7; i++) {
    const w = 14 - i * 1.6
    px(ctx, s, p.x - w / 2, p.y - 1 - i, w, 1, i < 2 ? tint(base, 1.15) : base)
  }
  px(ctx, s, p.x - 3, p.y - 8, 6, 1, tint(base, 1.3))
  px(ctx, s, p.x - 5, p.y - 3, 10, 1, tint(base, 0.8))
}

/** 러그 — 휴게실 바닥에 까는 큰 원형. */
export function drawLoungeRug(ctx, s, gx, gy) {
  const p = toScreen(gx, gy)
  ctx.save()
  for (const [r, color] of [
    [26, '#cbb9a0'],
    [20, '#dccbb2'],
    [13, '#cbb9a0'],
  ]) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.ellipse(p.x * s, p.y * s, r * s, r * 0.5 * s, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}
