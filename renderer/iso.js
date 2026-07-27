// 아이소메트릭 좌표계. 격자(gx, gy) → 화면(논리 픽셀).
//
// 타일은 2:1 마름모(32x16)다. 고전 도트 게임에서 쓰는 비율이고, 정수 배율로 확대해도
// 픽셀이 뭉개지지 않는다.

export const TILE_W = 44
export const TILE_H = 22
export const GRID = 10 // 10x10 바닥 — 캐릭터가 어떤 자세여도 타일 위에 있도록

// 9x9 격자가 딱 들어가는 크기. 여기서 더 키우면 정수 배율이 3에서 2로 떨어져
// 오히려 작아 보인다(픽셀 아트라 배율은 정수여야 한다).
export const STAGE_W = 500
export const STAGE_H = 336

// 격자 원점(0,0)이 놓일 화면 좌표. 위쪽에 벽 공간을 남긴다.
const ORIGIN_X = STAGE_W / 2
const ORIGIN_Y = 84

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

export function wallBase(side, g) {
  return side === 'nw' ? toScreen(-1, g) : toScreen(g, -1)
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
