// 팀 명단과 자리 배치(아이소메트릭 격자 좌표).
//
// **명단은 고정이 아니다.** 고용·해고로 바뀌므로 진짜 명단은 메인이 프로젝트의
// `.claude/agents/`를 읽어 내려준다(projects:status의 team). 여기 있는 ROSTER는
// 그중 **앱이 미리 아는 id의 이름표·색 사전**이자, 명단을 아직 못 받았을 때
// (첫 프레임·검사 도구)의 기본값이다.
//
// 명단에 없는 이름이 이벤트로 들어와도 무시하지 않고 회색 캐릭터로 자리를 만든다.

import { makePalette } from './sprites.js'
import { ROOMS } from './layout.js'

export const LEAD_ID = 'lead'

export const ROSTER = [
  { id: LEAD_ID, label: '리드', hair: '#f2c14e', shirt: '#e8e8f0', accent: '#f2c14e' },
  { id: 'planner', label: '기획', hair: '#8b5e3c', shirt: '#7aa2f7', accent: '#c0caf5' },
  { id: 'ux-designer', label: '디자인', hair: '#d16ba5', shirt: '#f7768e', accent: '#ffd7e5' },
  { id: 'frontend-dev', label: '프론트', hair: '#3b3b52', shirt: '#7dcfff', accent: '#b4f9f8' },
  { id: 'backend-dev', label: '백엔드', hair: '#2f2f3a', shirt: '#9ece6a', accent: '#d7f7b0' },
  { id: 'mobile-dev', label: '모바일', hair: '#6b4a2f', shirt: '#bb9af7', accent: '#e0cffc' },
  { id: 'code-reviewer', label: '리뷰', hair: '#4a4a5a', shirt: '#e0af68', accent: '#ffe0a3' },
  { id: 'qa-tester', label: 'QA', hair: '#8c3b3b', shirt: '#73daca', accent: '#c2fff0' },
  { id: 'debugger', label: '디버거', hair: '#2b2b33', shirt: '#ff9e64', accent: '#ffd0a8' },
  { id: 'release-manager', label: '릴리스', hair: '#5a4b7c', shirt: '#a0a8c0', accent: '#dfe4f5' },
  // 묻는 말에 답하는 조사역. "어디까지 진행됐어?" 같은 질문에 기획자가 감사를 하고
  // 디자이너가 Figma 보고서를 만든 적이 있어서 따로 두었다.
  { id: 'scout', label: '조사', hair: '#3a3226', shirt: '#c99a6e', accent: '#f0d9c0' },
]

const KNOWN = new Map(ROSTER.map((r) => [r.id, r]))

/**
 * 화면에 쓰는 이름표. **사전에 없는 id는 id를 그대로 쓴다** — 직접 만든 팀원도
 * 이름 없이 떠 있지 않게. 이름표 사전이 두 군데(app.js) 있으면 반드시 어긋난다.
 */
export function labelOf(id) {
  return KNOWN.get(id)?.label ?? String(id ?? '')
}

// 앱이 템플릿으로 들고 있는 기본 팀원의 자리 번호. **메인과 같은 표**다 —
// 자리를 고르는 쪽은 메인이고(seat), 화면은 그 번호로 DESK_CELLS를 찾는다.
export const PRESET_SEATS = [
  'planner',
  'ux-designer',
  'frontend-dev',
  'backend-dev',
  'mobile-dev',
  'code-reviewer',
  'qa-tester',
  'debugger',
  'release-manager',
  'scout',
]

// 사전에 없는 팀원의 색. **자리 번호로 고른다** — 같은 자리면 늘 같은 색이라
// 껐다 켜도 그 사람이 그 사람으로 보인다. 색 고르는 UI는 두지 않는다.
const PALETTE = [
  { hair: '#4a3b2a', shirt: '#5fb3a1', accent: '#bff0e4' },
  { hair: '#7a4a5a', shirt: '#d98f6a', accent: '#ffd9c0' },
  { hair: '#2f3b4a', shirt: '#8fa8e0', accent: '#d5e2ff' },
  { hair: '#5c4a2a', shirt: '#a8c95f', accent: '#e6f5bd' },
  { hair: '#3a2f4a', shirt: '#b48ad9', accent: '#e8d5ff' },
  { hair: '#4a2f2f', shirt: '#e07a8a', accent: '#ffd0d8' },
  { hair: '#2a3a3a', shirt: '#6ac7d9', accent: '#c8f0ff' },
  { hair: '#4a4230', shirt: '#d9b45f', accent: '#ffeec0' },
]

const UNKNOWN = { hair: '#5a5a68', shirt: '#8a8a99', accent: '#c8c8d4' }

/** 이 id를 무슨 이름·무슨 색으로 그릴 것인가. 아는 사람이면 사전 그대로. */
function roleOf(id, seat) {
  const known = KNOWN.get(id)
  if (known) return known
  // 자리 번호가 없으면 색을 고정할 근거가 없다 — 회색으로 둔다.
  const colors = Number.isInteger(seat) ? PALETTE[seat % PALETTE.length] : UNKNOWN
  return { id, label: String(id), ...colors }
}

// 자리는 **모두 사무실(office) 안**에 둔다. 회의실·탕비실은 다 같이 쓰는 공간이다.
// 사무실은 gx 0..8, gy 0..11. 3칸 간격으로 벌려 통로를 낸다.
//
// **새 자리는 반드시 맨 뒤에 붙인다.** 앞에 끼우면 자리 번호가 통째로 밀려
// 기존 팀원이 전부 다른 자리에 앉는다.
const DESK_CELLS = [
  { gx: 1, gy: 2 },
  { gx: 4, gy: 2 },
  { gx: 7, gy: 2 },
  { gx: 1, gy: 5 },
  { gx: 4, gy: 5 },
  { gx: 7, gy: 5 },
  { gx: 1, gy: 8 },
  { gx: 4, gy: 8 },
  { gx: 7, gy: 8 },
  // 조사역 자리. 리드 옆(gy 0)이라 의자가 gy 0.95로 사무실 안에 들어온다.
  { gx: 7, gy: 0 },
  // 고용으로 늘어난 자리 넷. 앞줄 빈칸(1,0)과 뒷줄(gy 10)이다.
  // 통행에 문제가 없는지는 tools/check-nav.js가 정원을 꽉 채워 확인한다.
  { gx: 1, gy: 0 },
  { gx: 1, gy: 10 },
  { gx: 4, gy: 10 },
  { gx: 7, gy: 10 },
]

/** 팀원을 몇 명까지 앉힐 수 있는가. 메인의 capacity와 같아야 한다. */
export const SEAT_COUNT = DESK_CELLS.length

// 자리를 못 받은 사람(정원 밖·이벤트로만 나타난 이름)의 임시 자리.
// **gy 10 줄은 이제 진짜 자리다** — 예전처럼 (7,10)·(7,9)로 흘리면 남의 책상과 겹친다.
const TEMP_DESKS = [
  { gx: 7, gy: 11 },
  { gx: 1, gy: 11 },
]

// 리드는 맨 위에서 팀 전체를 바라본다
const LEAD_DESK = { gx: 4, gy: 0 }

/**
 * 이 팀원의 자리 번호. 메인이 준 seat이 먼저고, 없으면 기본 팀 표에서 찾는다.
 * 둘 다 없으면 null — 임시 자리에 앉는다.
 */
function seatOf(m) {
  const id = typeof m === 'string' ? m : m?.id
  const seat = typeof m === 'object' && m ? m.seat : null
  if (Number.isInteger(seat) && seat >= 0 && seat < DESK_CELLS.length) return seat
  const i = PRESET_SEATS.indexOf(id)
  return i >= 0 ? i : null
}

const deskFor = (seat, extra) => (seat == null ? TEMP_DESKS[extra % TEMP_DESKS.length] : DESK_CELLS[seat])

/** 명단 한 줄에서 id만. 문자열로 줘도, `{ id }`로 줘도 받는다. */
const idOf = (m) => (typeof m === 'string' ? m : m?.id)

/**
 * 명단을 통째로 세운다.
 *
 * @param {Array<string|{id:string,seat?:number}>} team 없으면 기본 팀(ROSTER).
 *        **인자 없이 부르면 예전과 완전히 같은 결과**여야 한다(도면 검사가 그렇게 부른다).
 */
export function buildAgents(team = ROSTER) {
  const agents = new Map()
  agents.set(LEAD_ID, makeAgent(roleOf(LEAD_ID, null), LEAD_DESK, null))
  let extra = 0
  for (const m of team) {
    const id = idOf(m)
    if (!id || id === LEAD_ID || agents.has(id)) continue
    const seat = seatOf(m)
    agents.set(id, makeAgent(roleOf(id, seat), deskFor(seat, extra), seat))
    if (seat == null) extra++
  }
  return agents
}

/**
 * 명단을 지금 상태 그대로 갱신한다. **있는 사람은 객체를 살려 둔다** —
 * 통째로 다시 만들면 걸어가던 애니메이션·말풍선·대기 배지가 다 날아간다.
 *
 * 나간 사람은 map에서 지우고 돌려준다. 문으로 걸어 나가는 연출은 화면 쪽(app.js)
 * 몫이다 — 여기서 지우자마자 사라지면 팝 하고 없어진다.
 *
 * @returns {{added: object[], removed: object[]}}
 */
export function applyTeam(agents, team) {
  const wanted = new Map()
  for (const m of team ?? []) {
    const id = idOf(m)
    if (!id || id === LEAD_ID) continue
    wanted.set(id, seatOf(m))
  }

  const removed = []
  for (const [id, a] of [...agents]) {
    if (id === LEAD_ID || wanted.has(id)) continue
    agents.delete(id)
    removed.push(a)
  }

  const added = []
  for (const [id, seat] of wanted) {
    const have = agents.get(id)
    if (!have) {
      const a = makeAgent(roleOf(id, seat), deskFor(seat, countTemp(agents)), seat)
      agents.set(id, a)
      added.push(a)
      continue
    }
    // 자리를 옮겼으면 책상만 따라간다. 상태(작업·대기·말풍선)는 그대로 둔다.
    if (have.seatNo !== seat) reseat(have, deskFor(seat, countTemp(agents)), seat)
  }
  return { added, removed }
}

/** 임시 자리에 앉아 있는 사람 수. 다음 임시 자리를 고르는 데 쓴다. */
function countTemp(agents) {
  let n = 0
  for (const a of agents.values()) if (a.id !== LEAD_ID && a.seatNo == null) n++
  return n
}

// 자리 계산 결과가 사무실 밖(벽 너머·바닥 밖)으로 나가지 않게 잘라낸다.
const O = ROOMS.office
const onFloor = (p) => ({
  gx: Math.max(O.x0, Math.min(O.x1, p.gx)),
  gy: Math.max(O.y0, Math.min(O.y1, p.gy)),
})

/**
 * 책상 한 칸에서 나오는 지점들.
 *   의자 칸 = 자기 자리. **기본 상태는 여기 앉아 있는 것**이다 — 일이 없다고
 *   통로에 서 있으면 사무실이 아니라 대기실처럼 보인다.
 *   서는 자리는 자리에서 잠깐 일어설 때(스트레칭 등) 쓴다.
 */
function deskPoints(desk) {
  return {
    chair: onFloor({ gx: desk.gx, gy: desk.gy + 0.95 }),
    stand: onFloor({ gx: desk.gx + 0.8, gy: desk.gy + 1.6 }),
  }
}

/** 자리를 옮긴다. 걷던 길은 옛 자리 기준이라 지운다. */
function reseat(a, desk, seat) {
  const { chair, stand } = deskPoints(desk)
  a.desk = desk
  a.chair = chair
  a.stand = stand
  a.work = chair
  a.rest = chair
  a.seatNo = seat
  a.goal = null
  a.path = null
}

export function makeAgent(role, desk, seat = null) {
  const { chair, stand } = deskPoints(desk)
  return {
    chair,
    id: role.id,
    label: role.label ?? role.id,
    palette: makePalette(role.hair ? role : { ...UNKNOWN }),
    // 칩의 색 점이 캐릭터 옷 색과 같아야 누구 줄인지 알아본다.
    shirt: role.shirt ?? UNKNOWN.shirt,
    seatNo: seat, // 자리 번호(메인이 준 seat). 임시 자리면 null
    desk,
    work: chair,
    rest: chair, // 쉴 때도 자기 의자
    stand, // 자리에서 잠깐 일어설 때(스트레칭 등)
    gx: chair.gx,
    gy: chair.gy,
    pose: 'sit',
    seat: 'desk',
    flip: false,
    active: false,
    working: false,
    task: null,
    act: null, // 지금 무슨 종류의 일을 하는지(수정/읽기/실행/검색/위임)
    lastEventAt: 0,
    busyUntil: 0,
    queued: 0, // 이 팀원에게 보낸 지시 중 아직 결과가 안 온 개수
    cups: 0, // 탕비실에 다녀온 횟수만큼 책상에 쌓이는 커피컵
  }
}

export function agentOrCreate(agents, id) {
  if (agents.has(id)) return agents.get(id)
  const a = makeAgent(roleOf(id, null), deskFor(null, countTemp(agents)), null)
  agents.set(id, a)
  return a
}
