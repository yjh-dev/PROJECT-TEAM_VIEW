// 아이소메트릭 좌표계. 격자(gx, gy) → 화면(논리 픽셀).
//
// 타일은 2:1 마름모(32x16)다. 고전 도트 게임에서 쓰는 비율이고, 정수 배율로 확대해도
// 픽셀이 뭉개지지 않는다.

export const TILE_W = 44
export const TILE_H = 22
// 도면 전체가 들어가는 격자 크기 (gx 0..GRID_W-1, gy 0..GRID_H-1).
// 방 구획은 layout.js가 정한다.
export const GRID_W = 13
export const GRID_H = 16 // 휴게실까지 포함한 깊이
export const GRID = Math.max(GRID_W, GRID_H) // 하위 호환용

export const STAGE_W = 650
export const STAGE_H = 412

// 격자 원점(0,0)이 놓일 화면 좌표. 위쪽에 벽 공간을 남긴다.
const ORIGIN_X = 358
const ORIGIN_Y = 72

/** 격자 좌표 → 화면 좌표(타일 중심). gx/gy는 소수여도 된다(캐릭터가 부드럽게 움직인다). */
export function toScreen(gx, gy) {
  return {
    x: ORIGIN_X + (gx - gy) * (TILE_W / 2),
    y: ORIGIN_Y + (gx + gy) * (TILE_H / 2),
  }
}

/** 화면 좌표 → 격자 좌표. 캐릭터 클릭 판정에 쓴다. */
export function toGrid(sx, sy) {
  const dx = sx - ORIGIN_X
  const dy = sy - ORIGIN_Y
  return {
    gx: (dy / (TILE_H / 2) + dx / (TILE_W / 2)) / 2,
    gy: (dy / (TILE_H / 2) - dx / (TILE_W / 2)) / 2,
  }
}

/** 그리는 순서. 값이 작을수록 뒤(먼저 그린다). */
export function depth(gx, gy) {
  return gx + gy
}

/** 마름모 타일 하나. */
export function fillTile(ctx, s, gx, gy, top, side) {
  const { x, y } = toScreen(gx, gy)
  const hw = TILE_W / 2
  const hh = TILE_H / 2

  ctx.beginPath()
  ctx.moveTo(x * s, (y - hh) * s)
  ctx.lineTo((x + hw) * s, y * s)
  ctx.lineTo(x * s, (y + hh) * s)
  ctx.lineTo((x - hw) * s, y * s)
  ctx.closePath()
  ctx.fillStyle = top
  ctx.fill()

  if (side) {
    // 타일 두께 — 바닥이 판때기가 아니라 블록처럼 보이게 한다
    const t = 3
    ctx.beginPath()
    ctx.moveTo((x - hw) * s, y * s)
    ctx.lineTo(x * s, (y + hh) * s)
    ctx.lineTo(x * s, (y + hh + t) * s)
    ctx.lineTo((x - hw) * s, (y + t) * s)
    ctx.closePath()
    ctx.fillStyle = side
    ctx.fill()
  }
}

/**
 * 아이소메트릭 상자(책상·모니터 등). h는 논리 높이.
 * 윗면·왼면·오른면을 밝기 차이로 칠해 입체로 보이게 한다.
 */
export function drawBox(ctx, s, gx, gy, w, d, h, colors, lift = 0) {
  const { x, y } = toScreen(gx, gy)
  const hw = (TILE_W / 2) * w
  const hd = (TILE_H / 2) * d
  const baseY = y - lift

  // 윗면
  ctx.beginPath()
  ctx.moveTo(x * s, (baseY - h - hd) * s)
  ctx.lineTo((x + hw) * s, (baseY - h) * s)
  ctx.lineTo(x * s, (baseY - h + hd) * s)
  ctx.lineTo((x - hw) * s, (baseY - h) * s)
  ctx.closePath()
  ctx.fillStyle = colors.top
  ctx.fill()

  // 왼쪽 면(그늘)
  ctx.beginPath()
  ctx.moveTo((x - hw) * s, (baseY - h) * s)
  ctx.lineTo(x * s, (baseY - h + hd) * s)
  ctx.lineTo(x * s, (baseY + hd) * s)
  ctx.lineTo((x - hw) * s, baseY * s)
  ctx.closePath()
  ctx.fillStyle = colors.left
  ctx.fill()

  // 오른쪽 면
  ctx.beginPath()
  ctx.moveTo((x + hw) * s, (baseY - h) * s)
  ctx.lineTo(x * s, (baseY - h + hd) * s)
  ctx.lineTo(x * s, (baseY + hd) * s)
  ctx.lineTo((x + hw) * s, baseY * s)
  ctx.closePath()
  ctx.fillStyle = colors.right
  ctx.fill()
}

// ── 벽면에 눕히는 사각형 ───────────────────────────────────────────────
// 창문·화이트보드·시계를 화면에 정면으로 그리면 "혼자 카메라를 쳐다보는" 꼴이 된다.
// 벽이 기울어져 있으므로 그 위에 붙는 것도 같은 각도로 기울여야 한다.
//
// side='nw' → gx=-1 벽(오른쪽 아래로 내려가는 면), side='ne' → gy=-1 벽(오른쪽 위로)

// 벽은 **바닥의 가장자리 선**(gx=-0.5 / gy=-0.5)에 서야 한다.
// 타일 중심(-1)에 세우면 바닥에서 반 타일 떨어져 틈이 생긴다.
export function wallBase(side, g) {
  return side === 'nw' ? toScreen(-0.5, g - 0.5) : toScreen(g - 0.5, -0.5)
}

export function wallStep(side) {
  return side === 'nw'
    ? { dx: -TILE_W / 2, dy: TILE_H / 2 }
    : { dx: TILE_W / 2, dy: TILE_H / 2 }
}

/** 벽면 위의 사각형. gStart~gStart+gLen 구간, 바닥에서 yLow~yHigh 높이. */
export function wallQuad(ctx, s, side, gStart, gLen, yLow, yHigh, color) {
  const a = wallBase(side, gStart)
  const step = wallStep(side)
  const bx = a.x + step.dx * gLen
  const by = a.y + step.dy * gLen

  ctx.beginPath()
  ctx.moveTo(a.x * s, (a.y - yHigh) * s)
  ctx.lineTo(bx * s, (by - yHigh) * s)
  ctx.lineTo(bx * s, (by - yLow) * s)
  ctx.lineTo(a.x * s, (a.y - yLow) * s)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

/** 상자의 앞면(왼쪽·오른쪽 면)에 붙이는 사각형. 모니터 화면처럼. */
export function faceQuad(ctx, s, gx, gy, side, w, yLow, yHigh, color) {
  const c = toScreen(gx, gy)
  const step = side === 'left' ? { dx: -TILE_W / 2, dy: TILE_H / 2 } : { dx: TILE_W / 2, dy: TILE_H / 2 }
  const ax = c.x - (step.dx * w) / 2
  const ay = c.y - (step.dy * w) / 2
  const bx = c.x + (step.dx * w) / 2
  const by = c.y + (step.dy * w) / 2

  ctx.beginPath()
  ctx.moveTo(ax * s, (ay - yHigh) * s)
  ctx.lineTo(bx * s, (by - yHigh) * s)
  ctx.lineTo(bx * s, (by - yLow) * s)
  ctx.lineTo(ax * s, (ay - yLow) * s)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

/**
 * 논리 좌표계(1 = 도트 하나) 기준의 사각형. 가구에 픽셀 디테일을 얹을 때 쓴다.
 * 소수 배율에서도 경계가 어긋나지 않게 반올림한다.
 */
export function px(ctx, s, x, y, w, h, color) {
  const x0 = Math.round(x * s)
  const y0 = Math.round(y * s)
  const x1 = Math.round((x + w) * s)
  const y1 = Math.round((y + h) * s)
  ctx.fillStyle = color
  ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0))
}

/** 아이소 윗면(마름모)에 얹는 얇은 선. 나뭇결·이음매용. */
export function topSeam(ctx, s, gx, gy, lift, from, to, color, thick = 0.8) {
  const a = toScreen(gx + from.gx, gy + from.gy)
  const b = toScreen(gx + to.gx, gy + to.gy)
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1, thick * s)
  ctx.beginPath()
  ctx.moveTo(a.x * s, (a.y - lift) * s)
  ctx.lineTo(b.x * s, (b.y - lift) * s)
  ctx.stroke()
}

// ── 픽셀로 찍는 아이소 프리미티브 ────────────────────────────────────────
//
// 지금까지 가구는 ctx.fill()로 다각형을 칠했다. 캐릭터는 도트로 찍는데 가구만
// 매끈한 벡터라 서로 따로 놀았고, 얇은 상자는 지느러미처럼 뭉개졌다.
// 여기서는 면을 **1픽셀 줄로 쌓아** 캐릭터와 같은 질감으로 만든다.

/**
 * 마름모 윗면을 1픽셀 가로줄로 쌓는다.
 * bevel > 1이면 뾰족한 꼭짓점을 깎아 **모서리가 둥근 면**이 된다.
 * (의자 좌판처럼 날카로운 마름모로 보이면 안 되는 곳에 쓴다.)
 */
export function pxDiamond(ctx, s, cx, cy, w, d, color, lit, bevel = 1) {
  const hw = (TILE_W / 2) * w
  const hh = (TILE_H / 2) * d
  const rows = Math.max(1, Math.round(hh))
  for (let i = -rows; i <= rows; i++) {
    const f = Math.min(1, (1 - Math.abs(i) / (rows + 0.0001)) * bevel)
    const half = Math.max(0.5, hw * f)
    px(ctx, s, cx - half, cy + i, half * 2, 1, i <= -rows + 1 && lit ? lit : color)
  }
}

/**
 * 아이소 상자를 픽셀로 찍는다. 윗면은 가로줄, 옆면은 세로줄로 쌓고
 * 실루엣에 1픽셀 외곽선을 둘러 도트처럼 보이게 한다.
 *
 * pal = { top, lit, left, right, edge }
 */
export function pxBox(ctx, s, gx, gy, w, d, h, pal, lift = 0, bevel = 1) {
  const c = toScreen(gx, gy)
  const cx = c.x
  const cy = c.y - lift
  const hw = (TILE_W / 2) * w
  const hh = (TILE_H / 2) * d
  const cols = Math.max(1, Math.round(hw))

  // 옆면 — 왼쪽/오른쪽을 세로 1픽셀 줄로
  for (let i = 0; i <= cols; i++) {
    const f = i / cols
    const yEdge = cy + hh * (1 - f) // 아래 모서리를 따라 내려간다
    const xL = cx - hw * f
    const xR = cx + hw * f
    px(ctx, s, xL, yEdge - h, 1, h, pal.left)
    px(ctx, s, xR - 1, yEdge - h, 1, h, pal.right)
  }
  // 앞쪽 꼭짓점 아래 기둥(두 면이 만나는 모서리)
  px(ctx, s, cx - 1, cy + hh - h, 2, h, pal.edge ?? pal.left)

  // 윗면
  pxDiamond(ctx, s, cx, cy - h, w, d, pal.top, pal.lit, bevel)

  // 실루엣 외곽선 — 아래쪽 두 변만 살짝
  if (pal.edge) {
    for (let i = 0; i <= cols; i++) {
      const f = i / cols
      const yEdge = cy + hh * (1 - f)
      px(ctx, s, cx - hw * f, yEdge - 1, 1, 1, pal.edge)
      px(ctx, s, cx + hw * f - 1, yEdge - 1, 1, 1, pal.edge)
    }
  }
}

// ── 정확한 아이소 입체 ───────────────────────────────────────────────────
//
// 마름모를 "선형 보간"으로 채우면 줄마다 폭이 3px, 5px, 4px… 제멋대로 줄어 계단이
// 지저분해진다(가구가 찌글거리던 진짜 원인). 아이소 사각형은 네 꼭짓점이 정해진
// **볼록 다각형**이므로, 다각형을 그대로 스캔라인으로 채우면 모서리 기울기가
// 정확히 1/2로 떨어져 도트가 깔끔하게 맞는다.

/** 볼록 다각형을 1픽셀 가로줄로 채운다. pts는 논리 좌표 [{x,y}...]. */
export function pxPoly(ctx, s, pts, color, litColor) {
  let minY = Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const y0 = Math.round(minY)
  const y1 = Math.round(maxY)
  for (let y = y0; y < y1; y++) {
    const yc = y + 0.5
    let xa = Infinity
    let xb = -Infinity
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const q = pts[(i + 1) % pts.length]
      if (p.y === q.y) continue
      const lo = Math.min(p.y, q.y)
      const hi = Math.max(p.y, q.y)
      if (yc < lo || yc >= hi) continue
      const x = p.x + ((yc - p.y) / (q.y - p.y)) * (q.x - p.x)
      if (x < xa) xa = x
      if (x > xb) xb = x
    }
    if (xa > xb) continue
    px(ctx, s, xa, y, Math.max(1, xb - xa), 1, y < y0 + 1 && litColor ? litColor : color)
  }
}

/**
 * 아이소 직육면체. gw/gd는 **격자 단위 전체 크기**(1 = 타일 하나 ≈ 1.9m),
 * h는 논리 픽셀 높이. 윗면과 보이는 두 옆면을 다각형으로 채운다.
 */
export function pxSolid(ctx, s, gx, gy, gw, gd, h, pal, lift = 0) {
  const c = toScreen(gx, gy)
  const cy = c.y - lift
  const a = gw / 2
  const b = gd / 2
  const HX = TILE_W / 2
  const HY = TILE_H / 2

  // 윗면 네 꼭짓점(뒤 → 오른쪽 → 앞 → 왼쪽)
  const top = [
    { x: c.x + (-a + b) * HX, y: cy - h - (a + b) * HY }, // 뒤
    { x: c.x + (a + b) * HX, y: cy - h + (a - b) * HY }, // 오른쪽
    { x: c.x + (a - b) * HX, y: cy - h + (a + b) * HY }, // 앞
    { x: c.x - (a + b) * HX, y: cy - h + (-a + b) * HY }, // 왼쪽
  ]
  const [back, right, front, left] = top

  // 옆면 두 장(앞쪽 두 모서리에서 아래로)
  if (h > 0) {
    pxPoly(
      ctx,
      s,
      [left, front, { x: front.x, y: front.y + h }, { x: left.x, y: left.y + h }],
      pal.left,
    )
    pxPoly(
      ctx,
      s,
      [front, right, { x: right.x, y: right.y + h }, { x: front.x, y: front.y + h }],
      pal.right,
    )
    if (pal.edge) {
      px(ctx, s, front.x - 0.5, front.y, 1, h, pal.edge)
    }
  }
  pxPoly(ctx, s, top, pal.top, pal.lit)
  return { back, right, front, left, cy }
}

/** 색을 밝게/어둡게 — 팔레트를 손으로 다 고르지 않기 위해. */
export function tint(hex, k) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.min(255, Math.round(v * k))),
  )
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** 한 가지 색에서 상자용 팔레트를 만든다(윗면 밝게, 왼면 어둡게). */
export function boxPal(base) {
  return {
    top: tint(base, 1.12),
    lit: tint(base, 1.24),
    left: tint(base, 0.72),
    right: tint(base, 0.92),
    edge: tint(base, 0.55),
  }
}

/** 가구 밑 그늘. 바닥에 놓여 있다는 느낌을 준다(입체감의 절반은 이것에서 나온다). */
export function drawAO(ctx, s, gx, gy, rx = 16, ry = 8, alpha = 0.18) {
  const { x, y } = toScreen(gx, gy)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = '#5a4530'
  ctx.beginPath()
  ctx.ellipse(x * s, y * s, rx * s, ry * s, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** 캐릭터 발밑 그림자. 바닥에 붙어 있다는 느낌을 준다. */
export function drawShadow(ctx, s, gx, gy) {
  const { x, y } = toScreen(gx, gy)
  ctx.save()
  ctx.globalAlpha = 0.22
  ctx.fillStyle = '#5a4530'
  ctx.beginPath()
  ctx.ellipse(x * s, y * s, 8 * s, 4 * s, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}
