// 팀 명단과 자리 배치(아이소메트릭 격자 좌표).
// 이름은 PROJECT-TEMPLATE의 `.claude/agents/*.md`와 맞춘다.
// 명단에 없는 이름이 이벤트로 들어와도 무시하지 않고 회색 캐릭터로 자리를 만든다.

import { makePalette } from './sprites.js'

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

// 책상이 놓인 격자 칸. 캐릭터는 책상의 **북쪽 한 칸 앞**에 서서 일한다.
const DESK_CELLS = [
  { gx: 1, gy: 1 },
  { gx: 3, gy: 1 },
  { gx: 5, gy: 1 },
  { gx: 1, gy: 3 },
  { gx: 3, gy: 3 },
  { gx: 5, gy: 3 },
  { gx: 1, gy: 5 },
  { gx: 3, gy: 5 },
  { gx: 5, gy: 5 },
]

// 리드는 팀을 마주보는 상석
const LEAD_DESK = { gx: 3, gy: -0.2 }

export function buildAgents() {
  const agents = new Map()
  agents.set(LEAD_ID, makeAgent(ROSTER[0], LEAD_DESK))
  ROSTER.slice(1).forEach((role, i) => {
    agents.set(role.id, makeAgent(role, DESK_CELLS[i % DESK_CELLS.length]))
  })
  return agents
}

export function makeAgent(role, desk) {
  const work = { gx: desk.gx, gy: desk.gy - 0.75 } // 책상 앞(일하는 자리)
  const rest = { gx: desk.gx - 0.55, gy: desk.gy + 0.85 } // 자리 옆(쉬는 자리)
  return {
    id: role.id,
    label: role.label ?? role.id,
    palette: makePalette(role.hair ? role : { ...UNKNOWN }),
    desk,
    work,
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
  const desk = { gx: 6.4, gy: (idx % 6) * 1.1 }
  const a = makeAgent({ id, label: id, ...UNKNOWN }, desk)
  agents.set(id, a)
  return a
}
