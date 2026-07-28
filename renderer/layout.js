// 사무실 도면. 방 경계·내벽·문·이동 경로를 한곳에서 정의한다.
//
// 좌표계는 격자(gx, gy)다. 내벽은 **타일 한 칸짜리 조각**으로 쪼개 둔다 —
// 벽도 깊이 정렬 대상이라 통짜로 그리면 캐릭터와 앞뒤가 뒤집힌다.
//
//   사무실(office)    gx 0..8,  gy 0..11
//   회의실(meeting)   gx 9..12, gy 0..4
//   탕비실(pantry)    gx 9..12, gy 6..11
//   휴게실(lounge)    gx 0..12, gy 12..15
//
// 내벽: gx=8.5 세로벽 / gy=5.5 가로벽(회의실↔탕비실) / gy=11.5 가로벽(위층↔휴게실)
// **방 사이에 빈 줄을 두면 안 된다** — 바닥이 끊겨 방이 따로 떠 있는 것처럼 보인다.

export const ROOMS = {
  office: { x0: 0, y0: 0, x1: 8, y1: 11, name: '사무실', floor: 'wood' },
  meeting: { x0: 9, y0: 0, x1: 12, y1: 4, name: '회의실', floor: 'carpet' },
  pantry: { x0: 9, y0: 6, x1: 12, y1: 11, name: '탕비실', floor: 'tile' },
  lounge: { x0: 0, y0: 12, x1: 12, y1: 15, name: '휴게실', floor: 'lounge' },
}

export const WALL_X = 8.5
export const WALL_Y = 5.5
export const WALL_LOUNGE_Y = 11.5

export const DOOR_MEETING_GY = 2
export const DOOR_PANTRY_GY = 8
export const DOOR_LOUNGE_GX = 4

export function interiorWallSegments() {
  const segs = []
  // 세로벽 (사무실 ↔ 회의실/탕비실)
  for (let gy = ROOMS.office.y0; gy <= ROOMS.office.y1; gy++) {
    if (gy === DOOR_MEETING_GY || gy === DOOR_PANTRY_GY) continue
    segs.push({ gx: WALL_X, gy, dir: 'nw' })
  }
  // 가로벽 (회의실 ↔ 탕비실)
  for (let gx = ROOMS.meeting.x0; gx <= ROOMS.meeting.x1; gx++) {
    segs.push({ gx, gy: WALL_Y, dir: 'ne' })
  }
  // 가로벽 (위층 전체 ↔ 휴게실)
  for (let gx = ROOMS.lounge.x0; gx <= ROOMS.lounge.x1; gx++) {
    if (gx === DOOR_LOUNGE_GX) continue
    segs.push({ gx, gy: WALL_LOUNGE_Y, dir: 'ne' })
  }
  return segs
}

export const DOORWAYS = [
  { gx: WALL_X, gy: DOOR_MEETING_GY, dir: 'nw' },
  { gx: WALL_X, gy: DOOR_PANTRY_GY, dir: 'nw' },
  { gx: DOOR_LOUNGE_GX, gy: WALL_LOUNGE_Y, dir: 'ne' },
]

// ── 통행 격자 ─────────────────────────────────────────────────────────────
//
// 예전에는 **방과 문만** 보고 길을 찾았다. 같은 방 안이면 무조건 직선이었으므로
// 책상·소파·냉장고를 그대로 뚫고 지나갔다. 이제 바닥 전체를 0.25칸 격자로 잘라
// 가구가 놓인 칸을 막고, 그 위에서 너비 우선 탐색으로 길을 찾은 뒤 폈다.
//
// 가구 위치는 room.js/furniture.js가 **그리는 곳에서** 함께 내보낸다. 좌표를
// 두 군데 적으면 반드시 어긋나기 때문이다.

const NAV_STEP = 0.25
const NAV_X0 = -0.5
const NAV_Y0 = -0.5
const NAV_W = Math.round((12.5 - NAV_X0) / NAV_STEP) + 1
const NAV_H = Math.round((15.5 - NAV_Y0) / NAV_STEP) + 1

// 캐릭터 반폭(격자). 이만큼 장애물을 부풀려 모서리를 스치지 않게 한다.
const BODY = 0.17

let nav = null // Uint8Array — 1이면 못 지나감

const navIdx = (i, j) => j * NAV_W + i
const toCellX = (gx) => Math.round((gx - NAV_X0) / NAV_STEP)
const toCellY = (gy) => Math.round((gy - NAV_Y0) / NAV_STEP)
const toGridX = (i) => NAV_X0 + i * NAV_STEP
const toGridY = (j) => NAV_Y0 + j * NAV_STEP

/** 바닥이 깔린 곳인가. 방 사각형은 칸 중심 기준이라 사방 0.5칸이 더 있다. */
function onFloor(gx, gy) {
  for (const r of Object.values(ROOMS)) {
    if (gx >= r.x0 - 0.5 && gx <= r.x1 + 0.5 && gy >= r.y0 - 0.5 && gy <= r.y1 + 0.5) return true
  }
  return false
}

/** 내벽 위인가. 문 앞은 열어 둔다. */
function onWall(gx, gy) {
  const T = 0.13 // 벽 한 줄만 막는다(두껍게 막으면 문이 좁아진다)
  // 문이 열린 폭. 문짝은 ±0.5칸이지만 **±0.4까지만** 열어 둔다 —
  // 딱 0.5로 두면 격자 반올림 때문에 문틀 바깥을 스치며 지나간다.
  const DOOR = 0.4
  if (Math.abs(gx - WALL_X) < T && gy <= ROOMS.office.y1 + 0.5) {
    const door =
      Math.abs(gy - DOOR_MEETING_GY) <= DOOR || Math.abs(gy - DOOR_PANTRY_GY) <= DOOR
    if (!door) return true
  }
  if (Math.abs(gy - WALL_Y) < T && gx > WALL_X) return true // 회의실↔탕비실, 문 없음
  if (Math.abs(gy - WALL_LOUNGE_Y) < T && Math.abs(gx - DOOR_LOUNGE_GX) > DOOR) return true
  return false
}

/**
 * 가구가 놓인 자리를 통행 격자에 반영한다. 앱이 시작할 때 한 번 부른다.
 * @param {Array<{x0:number,y0:number,x1:number,y1:number}>} rects 격자 좌표 사각형
 */
export function setObstacles(rects) {
  nav = new Uint8Array(NAV_W * NAV_H)
  for (let j = 0; j < NAV_H; j++) {
    const gy = toGridY(j)
    for (let i = 0; i < NAV_W; i++) {
      const gx = toGridX(i)
      let blocked = !onFloor(gx, gy) || onWall(gx, gy)
      if (!blocked) {
        for (const r of rects) {
          if (gx > r.x0 - BODY && gx < r.x1 + BODY && gy > r.y0 - BODY && gy < r.y1 + BODY) {
            blocked = true
            break
          }
        }
      }
      nav[navIdx(i, j)] = blocked ? 1 : 0
    }
  }
}

function walkable(i, j) {
  if (i < 0 || j < 0 || i >= NAV_W || j >= NAV_H) return false
  return nav[navIdx(i, j)] === 0
}

/** 막힌 칸이면 가장 가까운 지나갈 수 있는 칸. 의자·소파가 목적지일 때 쓴다. */
function nearestOpen(i, j) {
  if (walkable(i, j)) return [i, j]
  for (let r = 1; r <= 10; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
        if (walkable(i + di, j + dj)) return [i + di, j + dj]
      }
    }
  }
  return null
}

/** 4방향 너비 우선 탐색. 격자가 작아서(53×65) 매번 새로 찾아도 충분히 빠르다. */
function bfs(start, goal) {
  const prev = new Int32Array(NAV_W * NAV_H).fill(-1)
  const from = navIdx(start[0], start[1])
  const target = navIdx(goal[0], goal[1])
  prev[from] = from
  const queue = [from]
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]
    if (cur === target) break
    const i = cur % NAV_W
    const j = (cur - i) / NAV_W
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const ni = i + di
      const nj = j + dj
      if (!walkable(ni, nj)) continue
      const nk = navIdx(ni, nj)
      if (prev[nk] !== -1) continue
      prev[nk] = cur
      queue.push(nk)
    }
  }
  if (prev[target] === -1) return null
  const out = []
  for (let k = target; k !== from; k = prev[k]) {
    const i = k % NAV_W
    out.push([i, (k - i) / NAV_W])
  }
  out.push(start)
  return out.reverse()
}

/**
 * 두 지점 사이에 실제로 걸어갈 길이 있는가. 도면 검사(tools/check-nav.js)용이다.
 * routeTo의 반환 길이로는 판단할 수 없다 — 직선으로 갈 수 있으면 경유지가 하나다.
 */
export function isReachable(from, to) {
  if (!nav) return false
  const start = nearestOpen(toCellX(from.gx), toCellY(from.gy))
  const goal = nearestOpen(toCellX(to.gx), toCellY(to.gy))
  if (!start || !goal) return false
  return bfs(start, goal) !== null
}

/** 두 점을 잇는 직선이 막힌 칸을 지나지 않는가. */
function clearLine(ax, ay, bx, by) {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (NAV_STEP * 0.5)))
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    if (!walkable(toCellX(ax + (bx - ax) * t), toCellY(ay + (by - ay) * t))) return false
  }
  return true
}

/** 계단처럼 꺾인 격자 경로를 펴서 사람이 걷는 것처럼 만든다. */
function straighten(points) {
  const out = []
  let i = 0
  let guard = 0
  while (i < points.length - 1 && guard++ < 200) {
    let j = points.length - 1
    while (j > i + 1 && !clearLine(points[i].gx, points[i].gy, points[j].gx, points[j].gy)) j--
    out.push(points[j])
    i = j
  }
  return out
}

/**
 * from에서 to까지 벽과 가구를 피해 가는 경유지 목록(마지막이 to).
 * 목적지가 의자·소파처럼 **막힌 자리**여도 된다 — 바로 앞까지 걸어간 뒤 앉는다.
 */
export function routeTo(from, to) {
  if (!nav) return [to] // 아직 가구를 못 받았으면 예전처럼 직선
  const start = nearestOpen(toCellX(from.gx), toCellY(from.gy))
  const goal = nearestOpen(toCellX(to.gx), toCellY(to.gy))
  if (!start || !goal) return [to]

  const cells = bfs(start, goal)
  if (!cells) return [to] // 갇혔다 — 멈추게 두지는 않는다

  const points = cells.map(([i, j]) => ({ gx: toGridX(i), gy: toGridY(j) }))
  points[0] = { gx: from.gx, gy: from.gy } // 첫 점은 지금 서 있는 자리
  const path = straighten(points)

  const last = path[path.length - 1]
  if (!last || Math.hypot(last.gx - to.gx, last.gy - to.gy) > 0.02) path.push(to)
  return path
}

// 방 안의 주요 지점들 — 유휴 행동이 여기로 간다.
// `sit` 값이 있으면 그 자리에 **실제로 앉는다**. 종류마다 앉는 높이가 달라서
// 이름을 그대로 쓴다(의자와 빈백은 눈높이가 다르다).
export const SPOTS = {
  coffee: { gx: 10, gy: 8.7 },
  water: { gx: 9.3, gy: 9.2 },
  trash: { gx: 11.8, gy: 10.6 },
  vending: { gx: 8.6, gy: 13.3 },
  bookshelf: { gx: 6.4, gy: 13.2 },
  meeting: [
    { gx: 9.4, gy: 2, sit: 'meeting' },
    { gx: 11.6, gy: 2, sit: 'meeting' },
    { gx: 10.5, gy: 3.1, sit: 'meeting' },
    { gx: 10.5, gy: 1.1, sit: 'meeting' },
  ],
  // 소파는 2인석이다. 실제 소파가 놓인 칸(3, 12.6)과 (10.6, 12.6) 위에 맞춘다.
  sofa: [
    { gx: 2.4, gy: 12.6, sit: 'sofa' },
    { gx: 3.6, gy: 12.6, sit: 'sofa' },
    { gx: 10.0, gy: 12.6, sit: 'sofa' },
    { gx: 11.2, gy: 12.6, sit: 'sofa' },
  ],
  beanbag: [
    { gx: 1, gy: 14.6, sit: 'beanbag' },
    { gx: 4.6, gy: 14.6, sit: 'beanbag' },
  ],
  // 창가 — 북쪽·서쪽 외벽을 따라 밖을 본다
  window: [
    { gx: 2, gy: 0.25 },
    { gx: 6, gy: 0.25 },
    { gx: 0.25, gy: 4 },
    { gx: 0.25, gy: 8 },
  ],
  // 자유 배회 — 책상 사이 통로. 자리를 비껴 놓아야 책상을 뚫고 서지 않는다.
  wander: [
    { gx: 2.6, gy: 3.6 },
    { gx: 5.6, gy: 6.6 },
    { gx: 2.6, gy: 9.6 },
    { gx: 5.6, gy: 0.8 },
    { gx: 0.5, gy: 6.5 },
    { gx: 8.2, gy: 10.4 },
    { gx: 6.6, gy: 3.6 },
  ],
}
