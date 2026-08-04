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
  // 주소를 주웠지만 서버가 죽은 실행 / 아직 확인 중인 실행. `#run-url`은
  // display를 준 요소라 [hidden]이 안 먹는 함정이 이미 세 번 났던 자리다.
  { scenario: 'rundead', w: 1820, h: 1120 },
  { scenario: 'rundead', w: 1180, h: 760 },
  // 팀원 관리 패널. 목록·버튼·만들기 폼이 한꺼번에 뜨는 화면이라 좁은 창에서
  // 가장 먼저 무너진다. 정원이 차고 처리 중인 갈래(teamfull)는 **버튼이 감춰지지
  // 않고 비활성으로 죽는지**를 본다 — 눌러도 아무 일 없는 버튼이 남으면 안 된다.
  { scenario: 'team', w: 1820, h: 1120 },
  { scenario: 'team', w: 1180, h: 760 },
  { scenario: 'teamfull', w: 1820, h: 1120 },
  { scenario: 'teamfull', w: 1180, h: 760 },
  // ☰의 연결 — 로그인 계정 표시와 전환. 이메일·조직명은 **남이 정한 길이**라
  // 자리에 맞춰 줄지 않는다. 짧은 계정과 아주 긴 계정을 둘 다 본다.
  // 처리 중인 갈래(acctbusy)는 팀원 패널과 같은 규칙을 본다 — 버튼이 감춰지지
  // 않고 **비활성으로 죽는지**.
  { scenario: 'acct', w: 1820, h: 1120 },
  { scenario: 'acct', w: 1180, h: 760 },
  { scenario: 'acctlong', w: 1820, h: 1120 },
  { scenario: 'acctlong', w: 1180, h: 760 },
  { scenario: 'acctout', w: 1820, h: 1120 },
  { scenario: 'acctout', w: 1180, h: 760 },
  { scenario: 'acctfigma', w: 1820, h: 1120 },
  { scenario: 'acctfigma', w: 1180, h: 760 },
  { scenario: 'acctbusy', w: 1820, h: 1120 },
  { scenario: 'acctbusy', w: 1180, h: 760 },
  // 첫 실행 설치 마법사. 화면이 여섯 단계로 갈리고 **좁은 창에서 왼쪽 단계 목록과
  // 오른쪽 내용이 같이 들어가야** 하므로 두 크기를 다 본다.
  //
  // 여기서 재는 것 중 하나는 **뜨지 않아야 할 때 안 뜨는가**다. 위의 갈래들은 전부
  // 이미 쓰던 사람(firstRunDone)이라, 프로그램이 없는 `missing`이나 프로젝트가 없는
  // `empty`에서도 마법사가 뜨면 실패로 잡힌다 — 가장 나쁜 회귀가 그것이다.
  //
  // 마법사 갈래는 한 장을 재는 것으로 끝나지 않는다. **누른 뒤 시간이 지나야 드러나는
  // 것들**을 ui-audit.js의 흐름 검사가 이어서 본다(어떤 결함을 보는지는 그쪽 주석에):
  //   wizard          동의 화면에 적힌 게시자·패키지 id·주소가 앱이 준 값과 같은가
  //   wizard-nowinget 자동 설치가 항목별로 갈리는가 · 못 까는 항목에 받으러 갈 길이 있는가
  //   wizard-fail     실패가 뒤늦은 진행 이벤트에 덮이지 않는가 · [다시 확인]이 잠기는가
  //   wizard-installing 설치 중 닫기가 묻는가 · 닫았다 열면 진행 화면이 그대로인가
  { scenario: 'wizard', w: 1820, h: 1120 },
  { scenario: 'wizard', w: 1180, h: 760 },
  { scenario: 'wizard-installing', w: 1820, h: 1120 },
  { scenario: 'wizard-installing', w: 1180, h: 760 },
  { scenario: 'wizard-fail', w: 1820, h: 1120 },
  { scenario: 'wizard-fail', w: 1180, h: 760 },
  { scenario: 'wizard-nowinget', w: 1820, h: 1120 },
  { scenario: 'wizard-nowinget', w: 1180, h: 760 },
  { scenario: 'wizard-login', w: 1820, h: 1120 },
  { scenario: 'wizard-login', w: 1180, h: 760 },
  { scenario: 'wizard-project', w: 1820, h: 1120 },
  { scenario: 'wizard-project', w: 1180, h: 760 },
  // **위에 떠야 할 것을 이름표가 뚫지 않는가.** 위의 마법사 갈래는 전부 붙은 회사가
  // 0개라 사무실이 비어 있고, 그래서 이름표가 마법사를 통째로 가리는 결함이 한 번도
  // 안 잡혔다(실측: 이름표·말풍선 17개 전부가 마법사 위에 그려졌다). 이 갈래는
  // **사무실에 사람이 있는 채로** 마법사를 띄운다. 재는 것은 ui-audit.js의 `가림` —
  // 한 장의 모양이 아니라 **칠하는 순서**를 본다.
  { scenario: 'wizard-office', w: 1820, h: 1120 },
  { scenario: 'wizard-office', w: 1180, h: 760 },
]

// 잘려도 되는 것 — 마우스를 올리면 전문이 보이도록 title을 달아 둔 자리.
const ALLOW_CUT = new Set(['#now'])

// 갈래마다 **어떤 흐름 검사가 돌아야 하는가.** ui-audit.js가 실제로 눌러 본 것을
// 그대로 돌려주고, 여기서 그것이 빠지지 않았는지 대조한다.
const WIZ_FLOW = {
  wizard: '동의 화면 값 대조',
  'wizard-nowinget': '동의 화면 값 대조',
  'wizard-fail': '실패 뒤 진행 이벤트 · 다시 확인 잠금',
  'wizard-installing': '설치 중 닫기·Esc · 닫았다 다시 열기',
}

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
    // 흐름 검사가 **실제로 돌았는지**까지 본다. 결과가 없는 것과 검사가 아예 안 돈 것은
    // 다르다 — 후자는 조용한 통과가 되어, 눌러 보는 검사가 통째로 죽어도 초록으로 지나간다.
    if (WIZ_FLOW[r.scenario] && r.흐름 !== WIZ_FLOW[r.scenario]) {
      console.error(`  ✗ ${label} — 흐름 검사가 돌지 않았다 (돈 것: ${r.흐름 || '없음'} / 돌아야 할 것: ${WIZ_FLOW[r.scenario]})`)
      bad++
      continue
    }
    for (const [kind, items] of Object.entries(r)) {
      if (!Array.isArray(items) || !items.length) continue
      if (kind === '시나리오' || kind === '창') continue
      for (const it of items) {
        if (kind === '잘림' && ALLOW_CUT.has(it.요소)) continue
        found.push([kind, it])
      }
    }
    // 이 갈래에서 **확인하지 못한 것**. 막지는 않되 조용히 넘어가지도 않는다 —
    // 통과 표시만 보고 "다 봤다"고 믿는 것이 제일 위험하다.
    if (r.알림) console.log(`  · (알림) ${label} — ${r.알림}`)
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
