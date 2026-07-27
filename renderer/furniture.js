// 가구 — **전부 1픽셀 단위로 찍는다.**
//
// 지금까지 가구는 ctx.fill()로 다각형을 칠했다. 캐릭터는 도트인데 가구만 매끈한
// 벡터라 서로 따로 놀았고, 얇은 상자는 지느러미처럼 뭉개졌다. 여기서는 모든 면을
// pxBox(1픽셀 줄 쌓기)로 만들고 표면에 점·줄 질감을 얹는다.
//
// **치수 기준**: 캐릭터 키 20px = 1.7m → 1px ≈ 8.5cm.
//   책상 높이 9px(0.76m) · 상판 폭 22px(1.9m) · 모니터 8px(0.68m) · 의자 8px(0.68m)
// 폭/깊이 인자는 타일 기준이라 헷갈리므로 아래 wOf/dOf로 픽셀에서 환산한다.

import { TILE_W, TILE_H, toScreen, px, pxBox, pxDiamond, boxPal, tint, drawAO } from './iso.js'

export const wOf = (widthPx) => widthPx / TILE_W
export const dOf = (depthPx) => depthPx / TILE_H

export const DESK_H = 9

const OAK = boxPal('#d8bb8e')
const OAK_DARK = boxPal('#a98a63')
const DRAWER_PAL = boxPal('#cfb289')
const CHAIR_PAL = boxPal('#5a6880')
const METAL_PAL = boxPal('#8d96a5')
const DARK_PAL = boxPal('#333a47')
const FABRIC = boxPal('#8ea0b6')
const SOFA_PAL = boxPal('#6f86a6')
const SOFA_CUSHION = boxPal('#8fa4c0')
const POT_PAL = boxPal('#c9714b')

// ── 공통 질감 ────────────────────────────────────────────────────────────
/** 윗면(마름모)에 결/줄눈을 1픽셀로 찍는다. */
function grainTop(ctx, s, cx, cy, w, d, color, step = 3) {
  const hw = (TILE_W / 2) * w
  const hh = (TILE_H / 2) * d
  const rows = Math.max(1, Math.round(hh))
  for (let i = -rows + 1; i < rows; i += step) {
    const f = 1 - Math.abs(i) / (rows + 0.0001)
    const half = Math.max(0.5, hw * f) - 1
    px(ctx, s, cx - half, cy + i, half * 2, 1, color)
  }
}

/** 면에 성긴 점을 찍어 천 느낌을 낸다. */
function speckle(ctx, s, x, y, w, h, color, count = 20, alpha = 0.16) {
  ctx.save()
  ctx.globalAlpha = alpha
  for (let i = 0; i < count; i++) {
    const ox = ((i * 37) % Math.max(1, Math.round(w)))
    const oy = ((i * 23) % Math.max(1, Math.round(h)))
    px(ctx, s, x + ox, y + oy, 1, 1, color)
  }
  ctx.restore()
}

// ── 모니터 ───────────────────────────────────────────────────────────────
function drawMonitor(ctx, s, gx, gy, on, t, seed = 0) {
  const p = toScreen(gx, gy)
  const W = 9
  const H = 6.5
  const standTop = DESK_H + 3

  // 받침 → 목
  pxBox(ctx, s, gx, gy, wOf(6), dOf(4), 1, METAL_PAL, DESK_H)
  px(ctx, s, p.x - 0.5, p.y - standTop, 1, 3, tint('#8d96a5', 0.85))
  px(ctx, s, p.x - 1, p.y - standTop, 0.5, 3, '#b4bcc8')

  // 베젤 — 한 줄씩 쌓아 모서리를 살린다
  const top = p.y - standTop - H
  for (let i = 0; i < H; i++) {
    const shade = i === 0 ? '#4e5768' : i >= H - 1.2 ? '#232a35' : '#333b48'
    px(ctx, s, p.x - W / 2, top + i, W, 1, shade)
  }
  // 화면
  const sx = p.x - W / 2 + 1
  const sy = top + 1
  const sw = W - 2
  const sh = H - 2.4
  if (on) {
    for (let i = 0; i < Math.round(sh); i++) {
      px(ctx, s, sx, sy + i, sw, 1, i % 2 ? '#16202e' : '#18232f')
    }
    const colors = ['#7fd1ff', '#a5e887', '#ffd479', '#ff9ec4']
    for (let i = 0; i < 4; i++) {
      const row = sy + i
      if (row > sy + sh - 1) break
      const indent = ((i * 3 + seed * 2 + Math.floor(t / 320)) % 3) * 0.8
      const len = 1.5 + ((i * 5 + seed * 3 + Math.floor(t / 760)) % 5)
      px(ctx, s, sx + 0.6 + indent, row, Math.min(len, sw - 1.2 - indent), 1, colors[(i + seed) % 4])
    }
  } else {
    for (let i = 0; i < Math.round(sh); i++) {
      px(ctx, s, sx, sy + i, sw, 1, i < sh / 2 ? '#d6e2ee' : '#c2d0df')
    }
  }
  px(ctx, s, p.x + W / 2 - 1.5, p.y - standTop - 1, 1, 1, on ? '#7ee08a' : '#79808d')
}

// ── 키보드 · 머그 · 서류 ─────────────────────────────────────────────────
function drawKeyboard(ctx, s, gx, gy) {
  const p = toScreen(gx, gy)
  pxDiamond(ctx, s, p.x, p.y - DESK_H, wOf(11), dOf(5), '#e6ebf2', '#f4f7fb')
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 5; c++) {
      px(ctx, s, p.x - 4 + c * 1.8 + r * 0.5, p.y - DESK_H - 1.2 + r * 1, 1, 1, '#b9c2d0')
    }
  }
  px(ctx, s, p.x - 2, p.y - DESK_H + 1.8, 4, 1, '#b9c2d0')
  // 마우스
  px(ctx, s, p.x + 7, p.y - DESK_H - 0.5, 2, 2, '#e6ebf2')
  px(ctx, s, p.x + 7.5, p.y - DESK_H - 0.5, 1, 1, '#b9c2d0')
}

export function drawMug(ctx, s, gx, gy, t, fresh = false) {
  const p = toScreen(gx, gy)
  const h = 3
  for (let i = 0; i < h; i++) {
    px(ctx, s, p.x - 1.5, p.y - DESK_H - h + i, 3, 1, i === 0 ? '#ffffff' : '#eef2f7')
  }
  px(ctx, s, p.x + 1.5, p.y - DESK_H - h + 1, 1, 1, '#dfe5ec') // 손잡이
  px(ctx, s, p.x - 1.5, p.y - DESK_H - h, 3, 1, '#6b4a2f') // 커피 표면
  px(ctx, s, p.x - 1.5, p.y - DESK_H - 1, 3, 1, '#e05c5c') // 띠
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
  const p = toScreen(gx, gy)
  for (let i = 0; i < 3; i++) {
    pxDiamond(ctx, s, p.x + i * 0.4, p.y - DESK_H - i * 0.5, wOf(7), dOf(3.4), i === 2 ? '#ffffff' : '#f0f0ea')
  }
  for (let i = 0; i < 2; i++) {
    px(ctx, s, p.x - 2 + i * 0.4, p.y - DESK_H - 1.4 + i, 4, 1, 'rgba(120,130,150,0.5)')
  }
}

// ── ㄱ자 책상 ────────────────────────────────────────────────────────────
export function drawWorkstation(ctx, s, gx, gy, screenOn, t, cups = 0) {
  const main = { gx, gy: gy - 0.24 }
  const ret = { gx: gx + 0.3, gy: gy + 0.2 }
  drawAO(ctx, s, gx + 0.14, gy, 15, 7.5, 0.2)

  // 다리
  for (const [lx, ly] of [
    [main.gx - 0.22, main.gy - 0.12],
    [main.gx - 0.22, main.gy + 0.12],
    [ret.gx + 0.1, ret.gy - 0.22],
    [ret.gx - 0.1, ret.gy + 0.24],
    [ret.gx + 0.1, ret.gy + 0.24],
  ]) {
    pxBox(ctx, s, lx, ly, wOf(2), dOf(2), DESK_H, OAK_DARK)
  }

  // 상판 두 장(겹치는 모서리가 ㄱ자를 만든다)
  pxBox(ctx, s, ret.gx, ret.gy, wOf(11), dOf(16), 1.6, OAK, DESK_H - 1.6)
  pxBox(ctx, s, main.gx, main.gy, wOf(22), dOf(10), 1.6, OAK, DESK_H - 1.6)

  const mp = toScreen(main.gx, main.gy)
  grainTop(ctx, s, mp.x, mp.y - DESK_H, wOf(22), dOf(10), 'rgba(150,120,80,0.25)', 3)
  const rp = toScreen(ret.gx, ret.gy)
  grainTop(ctx, s, rp.x, rp.y - DESK_H, wOf(11), dOf(16), 'rgba(150,120,80,0.25)', 3)

  // 서랍 — 리턴 아래
  pxBox(ctx, s, ret.gx, ret.gy + 0.16, wOf(9), dOf(9), DESK_H - 2, DRAWER_PAL)
  const dp = toScreen(ret.gx, ret.gy + 0.16)
  for (const dy of [2.4, 5]) {
    px(ctx, s, dp.x - 4, dp.y - dy, 8, 1, tint('#cfb289', 0.72))
    px(ctx, s, dp.x - 2, dp.y - dy + 1.4, 4, 1, '#8a7659')
  }

  drawMonitor(ctx, s, main.gx - 0.18, main.gy - 0.08, screenOn, t, 0)
  drawMonitor(ctx, s, main.gx + 0.16, main.gy - 0.08, screenOn, t, 1)
  drawKeyboard(ctx, s, main.gx, main.gy + 0.14)
  drawPapers(ctx, s, ret.gx - 0.04, ret.gy - 0.24)

  for (let i = 0; i < Math.min(cups, 6); i++) {
    const col = i % 3
    const row = Math.floor(i / 3)
    drawMug(ctx, s, ret.gx - 0.12 + col * 0.12, ret.gy + 0.02 + row * 0.12, t, i === 0)
  }
}

// ── 의자 ─────────────────────────────────────────────────────────────────
export function drawChair(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 5.5, 2.8, 0.18)
  const p = toScreen(gx, gy)

  // 5발 — 픽셀 조각으로
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.5
    const ux = Math.cos(a)
    const uy = Math.sin(a) * 0.5
    for (let d = 1; d <= 4; d += 1) {
      px(ctx, s, p.x + ux * d - 0.5, p.y + uy * d - 0.5, 1, 1, '#3c4453')
    }
    px(ctx, s, p.x + ux * 4.4 - 0.5, p.y + uy * 4.4 - 0.5, 1.5, 1, '#262d38')
  }
  // 실린더
  px(ctx, s, p.x - 0.5, p.y - 3.5, 1, 3.5, '#7f8998')
  px(ctx, s, p.x - 1, p.y - 3.5, 0.5, 3.5, '#adb6c3')
  // 좌판
  pxBox(ctx, s, gx, gy, wOf(9), dOf(8), 1.4, CHAIR_PAL, 3.5)
}

export function drawChairBack(ctx, s, gx, gy) {
  const p = toScreen(gx - 0.1, gy - 0.1)
  const W = 8
  const H = 7
  const bottom = p.y - 4.6
  for (let i = 0; i < H; i++) {
    const c = i === 0 ? '#6b7a95' : i >= H - 1 ? '#333c4d' : '#4c5870'
    px(ctx, s, p.x - W / 2, bottom - H + i, W, 1, c)
  }
  // 메시 — 안쪽에 점 격자
  ctx.save()
  ctx.globalAlpha = 0.3
  for (let r = 1; r < H - 1; r += 2) {
    for (let c = 1; c < W - 1; c += 2) {
      px(ctx, s, p.x - W / 2 + c, bottom - H + r, 1, 1, '#20283a')
    }
  }
  ctx.restore()
  // 팔걸이
  for (const e of [-1, 1]) {
    px(ctx, s, p.x + e * 4.5 - 0.5, bottom - 2.5, 1, 2.5, '#404a5e')
    px(ctx, s, p.x + e * 4.5 - 1.5, bottom - 3, 3, 1, '#5a6880')
  }
}

// ── 큐비클 파티션 ────────────────────────────────────────────────────────
const PART_H = 9

export function drawPartitions(ctx, s, gx, gy) {
  const panel = (cx, cy, w, d, spanPx) => {
    pxBox(ctx, s, cx, cy, w, d, PART_H, FABRIC)
    const p = toScreen(cx, cy)
    speckle(ctx, s, p.x - spanPx / 2, p.y - PART_H, spanPx, PART_H - 1, '#5a6a80', 26, 0.18)
    // 상단 레일
    px(ctx, s, p.x - spanPx / 2, p.y - PART_H - 1, spanPx, 1, '#d3dbe4')
    // 양 끝 기둥
    for (const e of [-1, 1]) {
      px(ctx, s, p.x + (e * spanPx) / 2 - 0.5, p.y - PART_H, 1, PART_H, '#61728a')
    }
  }
  panel(gx - 0.4, gy - 0.02, wOf(2), dOf(18), 18)
  panel(gx - 0.02, gy - 0.4, wOf(18), dOf(2), 18)
}

// ── 회의 테이블 ──────────────────────────────────────────────────────────
export function drawMeetingTable(ctx, s, gx, gy) {
  const H = 9
  drawAO(ctx, s, gx, gy, 20, 10, 0.2)
  for (const [ox, oy] of [
    [-0.3, -0.3],
    [0.3, -0.3],
    [-0.3, 0.3],
    [0.3, 0.3],
  ]) {
    pxBox(ctx, s, gx + ox, gy + oy, wOf(2), dOf(2), H, OAK_DARK)
  }
  pxBox(ctx, s, gx, gy, wOf(30), dOf(22), 1.8, OAK, H - 1.8)
  const p = toScreen(gx, gy)
  grainTop(ctx, s, p.x, p.y - H, wOf(30), dOf(22), 'rgba(150,120,80,0.22)', 3)

  // 노트북 두 대
  for (const ox of [-0.24, 0.24]) {
    const lp = toScreen(gx + ox, gy + 0.05)
    pxDiamond(ctx, s, lp.x, lp.y - H, wOf(8), dOf(5), '#dfe5ec', '#f0f3f7')
    for (let i = 0; i < 5; i++) px(ctx, s, lp.x - 3 + i * 1.4, lp.y - H - 0.6, 1, 1, '#b7bfcb')
    for (let i = 0; i < 5; i++) {
      px(ctx, s, lp.x - 4, lp.y - H - 5 + i, 8, 1, i === 0 ? '#4a5464' : '#2f3644')
    }
    px(ctx, s, lp.x - 3, lp.y - H - 4, 6, 3, '#5ca9d6')
    px(ctx, s, lp.x - 2.5, lp.y - H - 3.5, 3, 1, '#bfe6ff')
  }
  // 스피커폰
  pxDiamond(ctx, s, p.x, p.y - H - 1, wOf(7), dOf(4), '#5f697b', '#7b8698')
  for (let i = -1; i <= 1; i++) px(ctx, s, p.x + i * 1.6 - 0.5, p.y - H - 1.4, 1, 1, i === 0 ? '#7ee08a' : '#39424f')
}

export function drawMeetingChair(ctx, s, gx, gy) {
  drawChair(ctx, s, gx, gy)
  drawChairBack(ctx, s, gx, gy)
}

// ── 탕비실 ───────────────────────────────────────────────────────────────
export function drawCoffeeCorner(ctx, s, gx, gy, t) {
  const H = 10
  drawAO(ctx, s, gx, gy, 16, 8, 0.2)
  pxBox(ctx, s, gx, gy, wOf(26), dOf(14), H - 1, boxPal('#ddd0b8'))
  pxBox(ctx, s, gx, gy, wOf(28), dOf(16), 1, boxPal('#efe6d6'), H - 1)

  const p = toScreen(gx, gy)
  // 문짝 두 개(세로 이음매)와 손잡이
  for (const e of [-1, 1]) {
    px(ctx, s, p.x + e * 5, p.y - H + 3, 1, H - 5, 'rgba(120,100,70,0.25)')
    px(ctx, s, p.x + e * 3 - 0.5, p.y - H + 5, 1, 3, '#9c8a6d')
  }

  // 에스프레소 머신
  const m = { gx: gx - 0.14, gy: gy - 0.06 }
  pxBox(ctx, s, m.gx, m.gy, wOf(11), dOf(8), 10, DARK_PAL, H)
  const mp = toScreen(m.gx, m.gy)
  px(ctx, s, mp.x - 4, mp.y - H - 9, 8, 4, '#20262f') // 전면 패널
  px(ctx, s, mp.x - 3, mp.y - H - 8.4, 4, 1, '#5ce0a0') // 디스플레이
  px(ctx, s, mp.x - 3, mp.y - H - 6.6, 1.5, 1, '#e05c5c') // 버튼
  px(ctx, s, mp.x - 1, mp.y - H - 6.6, 1.5, 1, '#8f97a6')
  px(ctx, s, mp.x - 0.5, mp.y - H - 4.6, 1, 2, '#9aa2b1') // 노즐
  px(ctx, s, mp.x - 4, mp.y - H - 1.4, 8, 1, '#39424f') // 컵 받침
  for (let i = 0; i < 4; i++) px(ctx, s, mp.x - 3 + i * 2, mp.y - H - 1.2, 1, 1, '#6b7484')

  // 내려지는 컵 + 김
  px(ctx, s, mp.x - 1, mp.y - H - 3.4, 2, 2, '#ffffff')
  px(ctx, s, mp.x - 1, mp.y - H - 3.4, 2, 1, '#6b4a2f')
  ctx.save()
  ctx.globalAlpha = 0.4
  for (let i = 0; i < 2; i++) {
    const rise = ((t / 1100 + i * 0.5) % 1) * 4
    px(ctx, s, mp.x - 0.5 + Math.sin(rise * 2) * 0.6, mp.y - H - 4.5 - rise, 1, 1, '#ffffff')
  }
  ctx.restore()

  // 물통(반투명) + 컵 탑
  const wp = toScreen(gx + 0.24, gy - 0.06)
  for (let i = 0; i < 8; i++) {
    px(ctx, s, wp.x - 1.5, wp.y - H - 8 + i, 3, 1, i < 3 ? 'rgba(226,242,251,0.9)' : 'rgba(150,205,232,0.95)')
  }
  const cp = toScreen(gx + 0.34, gy + 0.2)
  for (let i = 0; i < 3; i++) px(ctx, s, cp.x - 1.2 + i * 0.2, cp.y - H - 2 - i * 1.4, 2.4, 1.6, i === 2 ? '#ffffff' : '#f0f3f7')
}

export function drawTrashBins(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 10, 5, 0.18)
  const bins = [
    { off: -0.16, pal: boxPal('#4a525e'), mark: '#c9d2de' },
    { off: 0.16, pal: boxPal('#3d6a8f'), mark: '#cfe6f5' },
  ]
  for (const b of bins) {
    pxBox(ctx, s, gx + b.off, gy, wOf(8), dOf(8), 8, b.pal)
    const p = toScreen(gx + b.off, gy)
    px(ctx, s, p.x - 4, p.y - 9.5, 8, 1.5, tint(b.pal.top, 1.1)) // 뚜껑
    px(ctx, s, p.x - 2, p.y - 9.8, 4, 1, '#1b2029') // 투입구
    px(ctx, s, p.x - 1.5, p.y - 5, 3, 2, b.mark) // 라벨
  }
}

// ── 휴게실 ───────────────────────────────────────────────────────────────
export function drawSofa(ctx, s, gx, gy) {
  drawAO(ctx, s, gx, gy, 15, 7, 0.2)
  // 등받이 → 좌판 → 팔걸이 (뒤에서 앞으로)
  pxBox(ctx, s, gx, gy - 0.2, wOf(26), dOf(6), 9, SOFA_PAL)
  pxBox(ctx, s, gx, gy + 0.02, wOf(26), dOf(11), 4, SOFA_PAL)
  const p = toScreen(gx, gy)
  speckle(ctx, s, p.x - 13, p.y - 9, 26, 5, '#42536b', 26, 0.14)

  // 방석 두 장
  for (const e of [-0.14, 0.14]) {
    pxBox(ctx, s, gx + e, gy + 0.02, wOf(11), dOf(9), 1.4, SOFA_CUSHION, 4)
  }
  // 팔걸이
  for (const e of [-1, 1]) {
    pxBox(ctx, s, gx + e * 0.31, gy + 0.02, wOf(4), dOf(11), 6, SOFA_PAL)
  }
  // 쿠션 두 개
  for (const [e, color, edge] of [
    [-0.16, '#e0c07a', '#c9a75f'],
    [0.16, '#c98b96', '#b0727d'],
  ]) {
    const cp = toScreen(gx + e, gy - 0.1)
    for (let i = 0; i < 4; i++) px(ctx, s, cp.x - 2.5, cp.y - 8 + i, 5, 1, i === 0 ? edge : color)
  }
  // 다리
  for (const [ox, oy] of [
    [-0.28, -0.14],
    [0.28, -0.14],
    [-0.28, 0.16],
    [0.28, 0.16],
  ]) {
    const lp = toScreen(gx + ox, gy + oy)
    px(ctx, s, lp.x - 0.5, lp.y - 1.6, 1, 1.6, '#5d4b3a')
  }
}

export function drawLoungeTable(ctx, s, gx, gy, t) {
  drawAO(ctx, s, gx, gy, 9, 4.5, 0.18)
  for (const [ox, oy] of [
    [-0.14, -0.14],
    [0.14, -0.14],
    [-0.14, 0.14],
    [0.14, 0.14],
  ]) {
    pxBox(ctx, s, gx + ox, gy + oy, wOf(1.5), dOf(1.5), 4, OAK_DARK)
  }
  pxBox(ctx, s, gx, gy, wOf(14), dOf(10), 1, OAK, 4)
  const p = toScreen(gx, gy)
  // 잡지 두 권
  px(ctx, s, p.x - 4, p.y - 5.4, 4, 2, '#7fb3d5')
  px(ctx, s, p.x - 3.4, p.y - 6, 4, 2, '#e8a0a8')
  // 컵
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
  // 화분 — 아래로 좁아지는 사다리꼴을 픽셀 줄로
  const potH = 6
  for (let i = 0; i < potH; i++) {
    const w = 8 - i * 0.5
    px(ctx, s, p.x - w / 2, p.y - potH + i, w, 1, i < 1 ? tint('#c9714b', 1.15) : '#c9714b')
    px(ctx, s, p.x - w / 2, p.y - potH + i, 1, 1, tint('#c9714b', 1.3))
    px(ctx, s, p.x + w / 2 - 1, p.y - potH + i, 1, 1, tint('#c9714b', 0.75))
  }
  px(ctx, s, p.x - 4.5, p.y - potH - 1.2, 9, 1.4, '#e08a63')
  px(ctx, s, p.x - 3, p.y - potH - 1, 6, 1, '#5a4433') // 흙

  // 잎 — 한 장씩, 잎맥까지
  const leaves = [
    [-4, -4, '#4d8f52'],
    [4, -5, '#417f48'],
    [-2, -9, '#5aa85d'],
    [2, -10, '#4f9455'],
    [0, -13, '#63b566'],
  ]
  for (const [dx, dy, color] of leaves) {
    const lx = p.x + dx
    const ly = p.y - potH - 1 + dy
    for (let i = 0; i < 5; i++) {
      const w = Math.sin(((i + 0.5) / 5) * Math.PI) * 5 + 1
      px(ctx, s, lx - w / 2, ly + i, w, 1, color)
    }
    px(ctx, s, lx - 0.5, ly, 1, 5, tint(color, 1.25))
    // 줄기
    px(ctx, s, p.x + dx * 0.3, ly + 5, 1, Math.max(1, -dy - 4), tint(color, 0.8))
  }
}
