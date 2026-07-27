// 훅을 붙이기 전에 앱만 확인하고 싶을 때 쓰는 데모 이벤트 생성기.
//
//   node tools/emit-demo-events.js <프로젝트폴더>
//
// 실제 훅과 **똑같은 형식**을 같은 파일에 흘려보낸다. 앱 입장에서는 구분되지 않는다.
// (그래서 데모로 잘 보인다고 실제 연동이 된다는 뜻은 아니다 — 훅 설치는 별도다.)

const fs = require('fs')
const path = require('path')

const root = process.argv[2] || process.cwd()
const dir = path.join(root, '.claude')
const file = path.join(dir, 'team-events.jsonl')

if (!fs.existsSync(dir)) {
  console.error(`.claude 폴더가 없습니다: ${dir}`)
  process.exit(1)
}

const SCENARIO = [
  { wait: 300, ev: { type: 'session', state: 'start', agent: 'lead' } },
  { wait: 900, ev: { type: 'prompt', agent: 'lead' } },
  { wait: 900, ev: { type: 'agent_start', agent: 'planner' } },
  { wait: 1200, ev: { type: 'tool', tool: 'Read', agent: 'planner', detail: 'src/app/page.tsx' } },
  { wait: 1400, ev: { type: 'tool', tool: 'Grep', agent: 'planner' } },
  { wait: 1200, ev: { type: 'agent_stop', agent: 'planner' } },
  { wait: 600, ev: { type: 'agent_start', agent: 'ux-designer' } },
  { wait: 1500, ev: { type: 'tool', tool: 'Write', agent: 'ux-designer', detail: 'docs/design/cart.md' } },
  { wait: 1200, ev: { type: 'agent_stop', agent: 'ux-designer' } },
  { wait: 500, ev: { type: 'agent_start', agent: 'frontend-dev' } },
  { wait: 1300, ev: { type: 'tool', tool: 'Edit', agent: 'frontend-dev', detail: 'components/CartItem.tsx' } },
  { wait: 1300, ev: { type: 'tool', tool: 'Edit', agent: 'frontend-dev', detail: 'app/(shop)/cart/page.tsx' } },
  { wait: 1400, ev: { type: 'tool', tool: 'Bash', agent: 'frontend-dev', detail: 'pnpm typecheck' } },
  { wait: 1200, ev: { type: 'agent_stop', agent: 'frontend-dev' } },
  { wait: 500, ev: { type: 'agent_start', agent: 'code-reviewer' } },
  { wait: 1500, ev: { type: 'tool', tool: 'Bash', agent: 'code-reviewer', detail: 'git diff' } },
  { wait: 1200, ev: { type: 'agent_stop', agent: 'code-reviewer' } },
  { wait: 500, ev: { type: 'agent_start', agent: 'qa-tester' } },
  { wait: 1500, ev: { type: 'tool', tool: 'Bash', agent: 'qa-tester', detail: 'pnpm test' } },
  { wait: 1300, ev: { type: 'agent_stop', agent: 'qa-tester' } },
  { wait: 1500, ev: { type: 'session', state: 'idle', agent: 'lead' } },
]

console.log(`데모 이벤트를 흘립니다 → ${file}`)
let i = 0
function next() {
  if (i >= SCENARIO.length) {
    console.log('끝. 다시 보려면 같은 명령을 실행하세요.')
    return
  }
  const { wait, ev } = SCENARIO[i++]
  setTimeout(() => {
    fs.appendFileSync(file, JSON.stringify({ ...ev, ts: Date.now() / 1000 }) + '\n')
    console.log(' ', ev.type, ev.agent ?? '', ev.detail ?? '')
    next()
  }, wait)
}
next()
