// 사무실 배경. 전부 도형으로 그린다(에셋 없음).
import { STAGE_W, STAGE_H } from './agents.js'

const FLOOR = '#2a2f3d'
const FLOOR_ALT = '#262b38'
const WALL = '#1b1f2a'
const WALL_TRIM = '#141821'
const DESK = '#6b4f36'
const DESK_TOP = '#8a6544'
const SCREEN_OFF = '#1d2430'
const SCREEN_ON = '#3ea6c9'

const TILE = 16
const WALL_H = 34

export function drawRoom(ctx, s, t) {
  // 벽
  ctx.fillStyle = WALL
  ctx.fillRect(0, 0, STAGE_W * s, WALL_H * s)
  ctx.fillStyle = WALL_TRIM
  ctx.fillRect(0, (WALL_H - 3) * s, STAGE_W * s, 3 * s)

  // 창문 두 개
  drawWindow(ctx, s, 40, 8, t)
  drawWindow(ctx, s, 232, 8, t)

  // 바닥 체크 타일
  for (let y = WALL_H; y < STAGE_H; y += TILE) {
    for (let x = 0; x < STAGE_W; x += TILE) {
      const alt = ((x / TILE) | 0) % 2 === ((y / TILE) | 0) % 2
      ctx.fillStyle = alt ? FLOOR : FLOOR_ALT
      ctx.fillRect(x * s, y * s, TILE * s, TILE * s)
    }
  }

  // 화분
  drawPlant(ctx, s, 12, 92)
  drawPlant(ctx, s, 306, 92)
}

function drawWindow(ctx, s, x, y, t) {
  const w = 48
  const h = 20
  ctx.fillStyle = '#0f1420'
  ctx.fillRect(x * s, y * s, w * s, h * s)
  // 밤하늘 + 아주 느리게 깜빡이는 별
  ctx.fillStyle = '#1c2740'
  ctx.fillRect((x + 2) * s, (y + 2) * s, (w - 4) * s, (h - 4) * s)
  for (let i = 0; i < 6; i++) {
    const sx = x + 5 + ((i * 13) % (w - 10))
    const sy = y + 4 + ((i * 7) % (h - 8))
    const twinkle = (Math.sin(t / 700 + i) + 1) / 2
    ctx.fillStyle = `rgba(220,235,255,${0.25 + twinkle * 0.6})`
    ctx.fillRect(sx * s, sy * s, s, s)
  }
  // 창틀
  ctx.fillStyle = '#39405a'
  ctx.fillRect(x * s, (y + h / 2 - 0.5) * s, w * s, s)
  ctx.fillRect((x + w / 2 - 0.5) * s, y * s, s, h * s)
}

function drawPlant(ctx, s, x, y) {
  ctx.fillStyle = '#7a4a30'
  ctx.fillRect(x * s, (y + 8) * s, 8 * s, 6 * s)
  ctx.fillStyle = '#4f8a4a'
  ctx.fillRect((x + 1) * s, y * s, 6 * s, 8 * s)
  ctx.fillStyle = '#66ab5e'
  ctx.fillRect((x + 2) * s, (y - 3) * s, 4 * s, 5 * s)
}

/** 책상 + 모니터. 캐릭터보다 **먼저** 그려서 앉은 몸이 책상에 가려지지 않게 한다. */
export function drawDesk(ctx, s, seat) {
  const x = seat.x - 16
  const y = seat.y
  ctx.fillStyle = DESK
  ctx.fillRect(x * s, y * s, 32 * s, 10 * s)
  ctx.fillStyle = DESK_TOP
  ctx.fillRect(x * s, y * s, 32 * s, 3 * s)
}

/** 모니터는 캐릭터 **뒤**에 있으므로 책상과 함께 그린다. */
export function drawMonitor(ctx, s, seat, on, t) {
  // 책상 상판 바로 위에 올려 놓는다(공중에 뜨면 가구로 안 보인다).
  const x = seat.x + 4
  const y = seat.y - 10
  ctx.fillStyle = '#171c26'
  ctx.fillRect(x * s, y * s, 12 * s, 9 * s)
  if (on) {
    // 코드가 흐르는 듯한 스캔라인
    ctx.fillStyle = SCREEN_ON
    ctx.fillRect((x + 1) * s, (y + 1) * s, 10 * s, 7 * s)
    ctx.fillStyle = 'rgba(10,20,30,0.45)'
    for (let i = 0; i < 4; i++) {
      const ly = y + 2 + ((i * 2 + Math.floor(t / 160)) % 6)
      ctx.fillRect((x + 2) * s, ly * s, (2 + ((i * 3) % 7)) * s, s)
    }
  } else {
    ctx.fillStyle = SCREEN_OFF
    ctx.fillRect((x + 1) * s, (y + 1) * s, 10 * s, 7 * s)
  }
  ctx.fillStyle = '#2b3242'
  ctx.fillRect((x + 5) * s, (y + 9) * s, 2 * s, 2 * s)
}
