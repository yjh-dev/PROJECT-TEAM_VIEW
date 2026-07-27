// 사무실 도면. 방 경계·내벽·문·이동 경로를 한곳에서 정의한다.
//
// 좌표계는 격자(gx, gy)다. 방은 타일 범위로 잡고, 내벽은 **타일 한 칸짜리 조각**으로
// 쪼개 둔다 — 벽도 깊이 정렬 대상이라 통짜로 그리면 캐릭터와 앞뒤가 뒤집힌다.
//
//   사무실(office)          gx 0..8,  gy 0..11
//   ├ 회의실(meeting)       gx 9..12, gy 0..4
//   └ 탕비실(pantry)        gx 9..12, gy 6..11
//
// 내벽: gx=8.5 세로벽(사무실 ↔ 오른쪽 두 방), gy=5.5 가로벽(회의실 ↔ 탕비실)
// 문:   세로벽의 gy=2(회의실), gy=8(탕비실)

export const ROOMS = {
  office: { x0: 0, y0: 0, x1: 8, y1: 11, name: '사무실', floor: 'wood' },
  meeting: { x0: 9, y0: 0, x1: 12, y1: 4, name: '회의실', floor: 'carpet' },
  pantry: { x0: 9, y0: 6, x1: 12, y1: 11, name: '탕비실', floor: 'tile' },
}

export const WALL_X = 8.5 // 사무실과 오른쪽 방들을 가르는 세로벽
export const WALL_Y = 5.5 // 회의실과 탕비실을 가르는 가로벽

export const DOOR_MEETING_GY = 2
export const DOOR_PANTRY_GY = 8

// 문 앞뒤로 서는 지점. 이 두 점을 거쳐야 벽을 통과하지 않는다.
const OUT_M = { gx: 7.9, gy: DOOR_MEETING_GY }
const IN_M = { gx: 9.1, gy: DOOR_MEETING_GY }
const OUT_P = { gx: 7.9, gy: DOOR_PANTRY_GY }
const IN_P = { gx: 9.1, gy: DOOR_PANTRY_GY }

/**
 * 내벽 조각 목록. dir='nw'는 gy 방향으로 한 칸(세로벽), 'ne'는 gx 방향으로 한 칸.
 * 문이 있는 칸은 비운다.
 */
export function interiorWallSegments() {
  const segs = []
  for (let gy = ROOMS.office.y0; gy <= ROOMS.office.y1; gy++) {
    if (gy === DOOR_MEETING_GY || gy === DOOR_PANTRY_GY) continue
    segs.push({ gx: WALL_X, gy, dir: 'nw' })
  }
  for (let gx = ROOMS.meeting.x0; gx <= ROOMS.meeting.x1; gx++) {
    segs.push({ gx, gy: WALL_Y, dir: 'ne' })
  }
  return segs
}

/** 문틀(기둥 두 개 + 상인방)을 그릴 위치. */
export const DOORWAYS = [
  { gx: WALL_X, gy: DOOR_MEETING_GY, label: '회의실' },
  { gx: WALL_X, gy: DOOR_PANTRY_GY, label: '탕비실' },
]

export function zoneOf(gx, gy) {
  if (gx < WALL_X) return 'office'
  return gy < WALL_Y ? 'meeting' : 'pantry'
}

/**
 * from에서 to까지 벽을 통과하지 않는 경유지 목록(마지막이 to).
 * 방이 세 개뿐이라 표로 처리하는 편이 그래프 탐색보다 단순하고 확실하다.
 */
export function routeTo(from, to) {
  const a = zoneOf(from.gx, from.gy)
  const b = zoneOf(to.gx, to.gy)
  if (a === b) return [to]

  if (a === 'office' && b === 'meeting') return [OUT_M, IN_M, to]
  if (a === 'office' && b === 'pantry') return [OUT_P, IN_P, to]
  if (a === 'meeting' && b === 'office') return [IN_M, OUT_M, to]
  if (a === 'pantry' && b === 'office') return [IN_P, OUT_P, to]
  // 회의실 ↔ 탕비실은 사무실 복도를 거친다
  if (a === 'meeting' && b === 'pantry') return [IN_M, OUT_M, OUT_P, IN_P, to]
  if (a === 'pantry' && b === 'meeting') return [IN_P, OUT_P, OUT_M, IN_M, to]
  return [to]
}

/** 좌표가 어느 방 안(타일 위)인지 — 자리 배치가 방을 벗어나지 않게 검사할 때 쓴다. */
export function insideRoom(room, gx, gy) {
  const r = ROOMS[room]
  return gx >= r.x0 && gx <= r.x1 && gy >= r.y0 && gy <= r.y1
}
