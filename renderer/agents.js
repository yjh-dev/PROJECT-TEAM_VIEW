// 팀 명단과 자리 배치. 이름은 PROJECT-TEMPLATE의 `.claude/agents/*.md`와 맞춘다.
// 여기 없는 이름이 이벤트로 들어오면 임시 자리에 앉힌 뒤 회색으로 그린다(무시하지 않는다).

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

/**
 * 자리 배치: 위쪽에 리드 책상 하나, 아래 3x3 그리드에 팀원 9명.
 * 좌표는 논리 픽셀(320x200 기준)이고 렌더러가 정수배로 확대한다.
 */
export const STAGE_W = 320
export const STAGE_H = 200

const DESK_COLS = [58, 160, 262]
const DESK_ROWS = [96, 136, 176]

export function buildAgents() {
  const agents = new Map()

  // 리드 자리 — 팀을 마주보는 위쪽 가운데
  agents.set(LEAD_ID, makeAgent(ROSTER[0], { x: 160, y: 56 }))

  const rest = ROSTER.slice(1)
  rest.forEach((role, i) => {
    const seat = { x: DESK_COLS[i % 3], y: DESK_ROWS[Math.floor(i / 3)] }
    agents.set(role.id, makeAgent(role, seat))
  })
  return agents
}

export function makeAgent(role, seat) {
  return {
    id: role.id,
    label: role.label ?? role.id,
    palette: makePalette(role.hair ? role : { ...UNKNOWN }),
    seat,
    // 쉴 때는 자리 왼쪽 아래(라운지)에서 서성인다
    x: seat.x,
    y: seat.y + 14,
    tx: seat.x,
    ty: seat.y + 14,
    pose: 'idle',
    flip: false,
    active: false,
    task: null, // 말풍선에 띄울 현재 작업
    lastEventAt: 0,
    busyUntil: 0,
  }
}

export function agentOrCreate(agents, id) {
  if (agents.has(id)) return agents.get(id)
  const idx = agents.size
  const seat = {
    x: DESK_COLS[idx % 3],
    y: DESK_ROWS[Math.min(2, Math.floor(idx / 3))] + 22,
  }
  const a = makeAgent({ id, label: id, ...UNKNOWN }, seat)
  agents.set(id, a)
  return a
}
