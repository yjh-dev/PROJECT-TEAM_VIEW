// 화면 검사를 여러 갈래로 돌려 한 번에 판정한다.
//
//   pnpm run check:ui
//
// 화면이 달라지는 갈래마다 한 번씩 띄우고, 창 크기도 최대·최소 두 가지를 본다.
// 하나라도 걸리면 **0이 아닌 코드로 끝난다** — 빌드가 이걸 보고 멈춘다.
//
// 이 검사가 없던 동안 같은 실수가 세 번 반복됐다(display를 준 요소에 [hidden]이
// 안 먹어 감춰야 할 것이 계속 보였다). 사람 눈으로 잡을 수 있는 종류가 아니다.
const { spawn } = require('child_process')
const path = require('path')

const ELECTRON = require('electron') // 실행 파일 경로 문자열
const AUDIT = path.join(__dirname, 'ui-audit.js')

// 화면이 갈리는 지점마다 하나씩. 창 크기는 최소(1180x760)도 같이 본다 —
// 좁은 창에서만 무너지는 것들이 있었다.
const CASES = [
  { scenario: 'normal', w: 1820, h: 1120 },
  { scenario: 'normal', w: 1180, h: 760 },
  { scenario: 'empty', w: 1820, h: 1120 },
  { scenario: 'missing', w: 1820, h: 1120 },
  { scenario: 'nologin', w: 1820, h: 1120 },
  { scenario: 'stress', w: 1820, h: 1120 },
]

// 잘려도 되는 것 — 마우스를 올리면 전문이 보이도록 title을 달아 둔 자리.
const ALLOW_CUT = new Set(['#now'])

function runOne({ scenario, w, h }) {
  return new Promise((resolve) => {
    const env = { ...process.env, SCENARIO: scenario, WIN_W: String(w), WIN_H: String(h) }
    const child = spawn(ELECTRON, [AUDIT], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => (out += b))
    child.stderr.on('data', (b) => (err += b))
    child.on('exit', (code) => {
      // 마지막 JSON 한 줄만 쓴다(Electron이 다른 잡음을 섞을 수 있다).
      const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop()
      if (!line) {
        resolve({ scenario, w, h, fatal: `결과를 받지 못했습니다 (code ${code}) ${err.trim().slice(0, 200)}` })
        return
      }
      try {
        resolve({ scenario, w, h, ...JSON.parse(line) })
      } catch (e) {
        resolve({ scenario, w, h, fatal: '결과를 읽지 못했습니다: ' + e.message })
      }
    })
  })
}

;(async () => {
  let bad = 0
  for (const c of CASES) {
    const r = await runOne(c)
    const label = `${r.scenario} ${r.w}x${r.h}`
    if (r.fatal) {
      console.error(`  ✗ ${label} — ${r.fatal}`)
      bad++
      continue
    }
    const found = []
    for (const [kind, items] of Object.entries(r)) {
      if (!Array.isArray(items) || !items.length) continue
      if (kind === '시나리오' || kind === '창') continue
      for (const it of items) {
        if (kind === '잘림' && ALLOW_CUT.has(it.요소)) continue
        found.push([kind, it])
      }
    }
    if (!found.length) {
      console.log(`  ✓ ${label}`)
      continue
    }
    bad += found.length
    console.error(`  ✗ ${label} — ${found.length}건`)
    for (const [kind, it] of found) {
      console.error(`      [${kind}] ${typeof it === 'string' ? it : JSON.stringify(it, null, 0)}`)
    }
  }
  if (bad) {
    console.error(`\n화면 검사 실패 — ${bad}건`)
    process.exit(1)
  }
  console.log(`화면 검사 통과 (갈래 ${CASES.length}가지)`)
})()
