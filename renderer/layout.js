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

// 문 앞뒤로 서는 지점. 이 두 점을 거쳐야 벽을 통과하지 않는다.
const OUT_M = { gx: 7.9, gy: DOOR_MEETING_GY }
const IN_M = { gx: 9.1, gy: DOOR_MEETING_GY }
const OUT_P = { gx: 7.9, gy: DOOR_PANTRY_GY }
const IN_P = { gx: 9.1, gy: DOOR_PANTRY_GY }
const OUT_L = { gx: DOOR_LOUNGE_GX, gy: 10.9 }
const IN_L = { gx: DOOR_LOUNGE_GX, gy: 12.1 }

// 방과 방을 잇는 문. 경로 탐색은 이 목록만 보고 한다.
const DOOR_LINKS = [
  { a: 'office', b: 'meeting', pa: OUT_M, pb: IN_M },
  { a: 'office', b: 'pantry', pa: OUT_P, pb: IN_P },
  { a: 'office', b: 'lounge', pa: OUT_L, pb: IN_L },
]

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

export function zoneOf(gx, gy) {
  if (gy > WALL_LOUNGE_Y) return 'lounge'
  if (gx < WALL_X) return 'office'
  return gy < WALL_Y ? 'meeting' : 'pantry'
}

/**
 * from에서 to까지 벽을 통과하지 않는 경유지 목록(마지막이 to).
 * 방이 늘어나도 표를 손보지 않도록 문 목록 위에서 너비 우선 탐색한다.
 */
export function routeTo(from, to) {
  const a = zoneOf(from.gx, from.gy)
  const b = zoneOf(to.gx, to.gy)
  if (a === b) return [to]

  const queue = [[a, []]]
  const seen = new Set([a])
  while (queue.length) {
    const [zone, path] = queue.shift()
    for (const link of DOOR_LINKS) {
      let next = null
      let hop = null
      if (link.a === zone) {
        next = link.b
        hop = [link.pa, link.pb]
      } else if (link.b === zone) {
        next = link.a
        hop = [link.pb, link.pa]
      }
      if (!next || seen.has(next)) continue
      const nextPath = [...path, ...hop]
      if (next === b) return [...nextPath, to]
      seen.add(next)
      queue.push([next, nextPath])
    }
  }
  return [to] // 길이 없으면 직선(있을 수 없지만 멈추지는 않는다)
}

// 방 안의 주요 지점들 — 유휴 행동이 여기로 간다.
export const SPOTS = {
  coffee: { gx: 10, gy: 8.7 },
  trash: { gx: 11.8, gy: 10.6 },
  meeting: [
    { gx: 9.4, gy: 2 },
    { gx: 11.6, gy: 2 },
    { gx: 10.5, gy: 3.1 },
  ],
  lounge: [
    { gx: 2, gy: 13.4 },
    { gx: 4.4, gy: 13.4 },
    { gx: 8.2, gy: 13.4 },
    { gx: 10.6, gy: 13.4 },
  ],
}
