// 팀 명단과 자리 배치(아이소메트릭 격자 좌표).
// 이름은 PROJECT-TEMPLATE의 `.claude/agents/*.md`와 맞춘다.
// 명단에 없는 이름이 이벤트로 들어와도 무시하지 않고 회색 캐릭터로 자리를 만든다.

import { makePalette } from './sprites.js'
import { GRID } from './iso.js'

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
]

const UNKNOWN = { hair: '#5a5a68', shirt: '#8a8a99', accent: '#c8c8d4' }

// 책상이 놓인 격자 칸(10x10 바닥, 0..9). 3칸 간격으로 벌려 통로를 둔다.
// 캐릭터는 책상 앞 의자에 앉고, 쉴 때는 통로 쪽으로 물러난다.
// **모든 좌표가 0..9 안에 있어야 한다** — 벗어나면 캐릭터가 바닥 밖에 뜬다.
const DESK_CELLS = [
  { gx: 1, gy: 1 },
  { gx: 4, gy: 1 },
  { gx: 7, gy: 1 },
  { gx: 1, gy: 4 },
  { gx: 4, gy: 4 },
  { gx: 7, gy: 4 },
  { gx: 1, gy: 7 },
  { gx: 4, gy: 7 },
  { gx: 7, gy: 7 },
]

// 리드는 오른쪽 끝에서 팀을 바라본다
const LEAD_DESK = { gx: 9, gy: 1 }

export function buildAgents() {
  const agents = new Map()
  agents.set(LEAD_ID, makeAgent(ROSTER[0], LEAD_DESK))
  ROSTER.slice(1).forEach((role, i) => {
    agents.set(role.id, makeAgent(role, DESK_CELLS[i % DESK_CELLS.length]))
  })
  return agents
}

// 바닥은 0..GRID-1 칸이고 타일이 ±0.5씩 덮는다. 가장자리에 딱 붙으면 발이
// 반쯤 걸치므로 여유를 두고 **항상 바닥 안**으로 잘라낸다.
const clampCell = (v) => Math.max(0, Math.min(GRID - 1, v))
const onFloor = (p) => ({ gx: clampCell(p.gx), gy: clampCell(p.gy) })

export function makeAgent(role, desk) {
  // 의자 칸 = 일하는 자리(여기 앉는다). 쉴 때는 책상 옆 통로로 물러난다.
  const chair = onFloor({ gx: desk.gx, gy: desk.gy + 0.95 })
  const rest = onFloor({ gx: desk.gx + 0.8, gy: desk.gy + 1.6 })
  return {
    chair,
    id: role.id,
    label: role.label ?? role.id,
    palette: makePalette(role.hair ? role : { ...UNKNOWN }),
    desk,
    work: chair,
    rest,
    gx: rest.gx,
    gy: rest.gy,
    pose: 'idle',
    flip: false,
    active: false,
    task: null,
    lastEventAt: 0,
    busyUntil: 0,
    queued: 0, // 이 팀원에게 보낸 지시 중 아직 결과가 안 온 개수
  }
}

export function agentOrCreate(agents, id) {
  if (agents.has(id)) return agents.get(id)
  const idx = agents.size - 1
  const desk = { gx: 9, gy: 4 + (idx % 5) } // 명단에 없는 팀원의 임시 자리(바닥 안)
  const a = makeAgent({ id, label: id, ...UNKNOWN }, desk)
  agents.set(id, a)
  return a
}
