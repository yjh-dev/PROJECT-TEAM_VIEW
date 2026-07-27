// 아이소메트릭 사무실. 전부 도형으로 그린다(에셋 없음).
import { GRID, TILE_H, TILE_W, toScreen, fillTile, drawBox } from './iso.js'

const FLOOR_A = { top: '#39405a', side: '#252a3c' }
const FLOOR_B = { top: '#333a52', side: '#212636' }
const DESK = { top: '#8a6544', left: '#5d4530', right: '#71543a' }
const SCREEN_FRAME = { top: '#2a3040', left: '#1b202c', right: '#222736' }

export function drawFloor(ctx, s) {
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const c = (gx + gy) % 2 === 0 ? FLOOR_A : FLOOR_B
      fillTile(ctx, s, gx, gy, c.top, c.side)
    }
  }
}

/** 뒤쪽 두 벽. 바닥보다 먼저 그려 뒤에 놓는다. */
export function drawWalls(ctx, s, t) {
  const H = 42

  // 북서쪽 벽
  for (let gy = 0; gy < GRID; gy++) {
    drawWallPanel(ctx, s, -1, gy, H, '#262c3e', '#1d2231')
  }
  // 북동쪽 벽
  for (let gx = 0; gx < GRID; gx++) {
    drawWallPanel(ctx, s, gx, -1, H, '#2c3346', null)
  }

  // 창문 — 밤하늘이 살짝 반짝인다
  drawWindow(ctx, s, 2, -1, t)
  drawWindow(ctx, s, 6, -1, t)
  drawWindow(ctx, s, -1, 3, t)
}

function drawWallPanel(ctx, s, gx, gy, h, face, edge) {
  const { x, y } = toScreen(gx, gy)
  const hw = TILE_W / 2
  const hh = TILE_H / 2
  ctx.beginPath()
  ctx.moveTo((x - hw) * s, (y - h) * s)
  ctx.lineTo(x * s, (y - h + hh) * s)
  ctx.lineTo((x + hw) * s, (y - h) * s)
  ctx.lineTo((x + hw) * s, y * s)
  ctx.lineTo(x * s, (y + hh) * s)
  ctx.lineTo((x - hw) * s, y * s)
  ctx.closePath()
  ctx.fillStyle = face
  ctx.fill()
  if (edge) {
    ctx.fillStyle = edge
    ctx.fillRect((x - hw) * s, (y - 1) * s, TILE_W * s, s)
  }
}

function drawWindow(ctx, s, gx, gy, t) {
  const { x, y } = toScreen(gx, gy)
  const w = 28
  const h = 20
  const cx = x
  const cy = y - 26

  ctx.fillStyle = '#141a2a'
  ctx.fillRect((cx - w / 2) * s, (cy - h / 2) * s, w * s, h * s)
  ctx.fillStyle = '#1b2740'
  ctx.fillRect((cx - w / 2 + 1) * s, (cy - h / 2 + 1) * s, (w - 2) * s, (h - 2) * s)
  for (let i = 0; i < 5; i++) {
    const sx = cx - w / 2 + 3 + ((i * 7) % (w - 6))
    const sy = cy - h / 2 + 3 + ((i * 5) % (h - 6))
    const tw = (Math.sin(t / 800 + i * 1.7) + 1) / 2
    ctx.fillStyle = `rgba(215,232,255,${0.2 + tw * 0.65})`
    ctx.fillRect(sx * s, sy * s, s, s)
  }
  ctx.fillStyle = '#454d6b'
  ctx.fillRect((cx - w / 2) * s, cy * s, w * s, s)
  ctx.fillRect(cx * s, (cy - h / 2) * s, s, h * s)
}

/** 책상 + 모니터. 책상 칸(gx, gy)에 놓는다. */
export function drawDesk(ctx, s, gx, gy, screenOn, t) {
  const DESK_H = 10
  drawBox(ctx, s, gx, gy, 1.05, 1.05, DESK_H, DESK)

  // 모니터는 책상 위(뒤쪽)에 세운다
  drawBox(ctx, s, gx - 0.18, gy - 0.18, 0.5, 0.5, 13, SCREEN_FRAME, DESK_H)

  const { x, y } = toScreen(gx - 0.18, gy - 0.18)
  const w = 15
  const h = 10
  const sx = x - w / 2
  const sy = y - DESK_H - 20
  if (screenOn) {
    ctx.fillStyle = '#2f7f9e'
    ctx.fillRect(sx * s, sy * s, w * s, h * s)
    ctx.fillStyle = 'rgba(185,242,255,0.8)'
    for (let i = 0; i < 5; i++) {
      const ly = sy + 1 + ((i * 2 + Math.floor(t / 150)) % (h - 2))
      ctx.fillRect((sx + 2) * s, ly * s, (3 + ((i * 4) % 9)) * s, s)
    }
  } else {
    ctx.fillStyle = '#1a1f2b'
    ctx.fillRect(sx * s, sy * s, w * s, h * s)
  }
}

/** 화분 — 빈 구석을 채운다. */
export function drawPlant(ctx, s, gx, gy) {
  drawBox(ctx, s, gx, gy, 0.4, 0.4, 5, { top: '#8a5a3a', left: '#5e3d27', right: '#734a2f' })
  const { x, y } = toScreen(gx, gy)
  ctx.fillStyle = '#5aa053'
  ctx.fillRect((x - 3) * s, (y - 13) * s, 6 * s, 8 * s)
  ctx.fillStyle = '#6cbb63'
  ctx.fillRect((x - 2) * s, (y - 17) * s, 4 * s, 5 * s)
}
