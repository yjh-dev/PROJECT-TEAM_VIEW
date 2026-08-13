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
  // 상단 사용량. **여섯 갈래의 초기 조건이 서로 다르다** — 하나라도 같으면 그 조건에서만
  // 나는 결함이 원리적으로 발생 불가가 된다. 마법사 여섯 갈래가 전부 "캐릭터 0명"이라
  // 가림 결함을 한 번도 못 잡던 것과 같은 사고가 이미 있었다.
  // 사용량에서도 같은 사고가 났다 — 스텁이 `null`(상단 숫자 자체가 안 뜸)을 "새 PC"라고
  // 부르며 내보냈는데, **앱은 어떤 경우에도 객체를 준다.** 검사가 도달 불가능한
  // 동작을 지켜 주고 있었던 것이다. 그래서 아래 갈래는 전부 앱이 실제로 낼 수 있는
  // 값만 쓴다(자리가 비는 경로는 `usage-none` 하나뿐이다 — 통로가 없을 때).
  //
  //   usage-pending  첫 집계 전(ready:false, days:null) — 0으로 그리면 거짓말이다
  //                  (한 번도 안 돌린 새 PC의 화면은 `empty` 갈래가 그대로 본다:
  //                   앱이 0을 채워 주므로 '오늘 출력 0'이 실제로 뜬다)
  //   usage-partial  안 쓴 날(0)과 못 본 날(null)이 섞인 차트 — 빈칸이 0으로 안 그려지는지
  //   usage-newday   자정 직후 — 오늘이 전부 0이라 캐시 배수를 낼 수 없다(0으로 나누기)
  //   usage-limit    한도에 걸린 기록 — 리셋 시각이 화면에 있는지
  //   usage-huge     캐시 읽기 21.6억(실측) — 자리수에 좁은 창이 버티는지
  //   usage-none     사용량 통로가 없는 낡은 preload — 상단 숫자가 **자리를 비우는지**
  //
  // 재는 것만으로는 "잘 그려진 채로 없는 숫자를 지어내는" 결함이 안 잡힌다. 그래서
  // ui-audit.js의 사용량 흐름 검사가 **앱이 준 원본과 화면 글자를 맞대 보고**, 화면에
  // 퍼센트가 하나도 없는지와 "이건 한도가 아니다" 안내가 실제로 그려지는지를 본다.
  { scenario: 'usage-pending', w: 1820, h: 1120 },
  { scenario: 'usage-pending', w: 1180, h: 760 },
  { scenario: 'usage-partial', w: 1820, h: 1120 },
  { scenario: 'usage-partial', w: 1180, h: 760 },
  { scenario: 'usage-newday', w: 1820, h: 1120 },
  { scenario: 'usage-newday', w: 1180, h: 760 },
  { scenario: 'usage-limit', w: 1820, h: 1120 },
  { scenario: 'usage-limit', w: 1180, h: 760 },
  { scenario: 'usage-huge', w: 1820, h: 1120 },
  { scenario: 'usage-huge', w: 1180, h: 760 },
  { scenario: 'usage-none', w: 1820, h: 1120 },
  // 지금 대화의 무게와 [새 대화 시작]. **네 갈래의 초기 조건이 서로 다르다.**
  // 여기서 재는 것은 한 장의 모양이 아니라 **눌러 본 뒤의 결과**다(ui-audit.js의
  // 새 대화 흐름 검사가 본다):
  //   session-heavy    무거운 대화(198턴 · 처음의 14배) + 놀고 있는 회사 —
  //                    묻고 나서 갈아타는가 · **인수인계 메모가 실제로 앱에 실려 가는가** ·
  //                    갈아탄 뒤 화면이 옛 무게를 그대로 들고 있지 않은가
  //   session-light    가벼운 대화 + 지시가 도는 회사 — 앱이 거절하면(`{ok:false, reason}`)
  //                    **그 이유가 화면에 그대로 오는가** · 적어 둔 메모가 살아 있는가
  //   session-none     기록이 하나도 없다(값이 null) — 0으로 그리지 않는가 ·
  //                    버튼이 감춰지지 않고 **비활성으로 죽는가**
  //   session-nogrowth 첫 턴 값이 없어 배수를 낼 수 없는 대화 —
  //                    **0으로 나눈 NaN·Infinity가 화면에 새어 나오지 않는가**
  // 확인 창이 뜬 순간을 좁은 창에서도 한 번 잰다 — 물음과 메모 칸이 같이 들어가야 한다.
  { scenario: 'session-heavy', w: 1820, h: 1120 },
  { scenario: 'session-heavy', w: 1180, h: 760 },
  { scenario: 'session-light', w: 1820, h: 1120 },
  { scenario: 'session-light', w: 1180, h: 760 },
  { scenario: 'session-none', w: 1820, h: 1120 },
  { scenario: 'session-nogrowth', w: 1820, h: 1120 },
  { scenario: 'session-nogrowth', w: 1180, h: 760 },
  // 한도로 큐가 붙잡힌 상태. **두 갈래의 초기 조건이 서로 다르다** — 붙잡힌 회사와
  // 붙잡히지 않은 회사이고, 둘 다 대기 지시가 있다(대기만 보고 안내를 띄우면 평소에도
  // 계속 떠 있게 되는데, 대기 0건으로만 재면 그 결함이 원리적으로 발생 불가가 된다).
  // 재는 것은 한 장의 모양이 아니라 **적힌 말이 앱이 준 값에서 나왔는가**다
  // (ui-audit.js의 한도 홀드 검사가 본다):
  //   hold-active  이유가 앱이 준 말 그대로인가 · 남은 시간이 `until`에서 나왔는가 ·
  //                대기 지시가 취소된 게 아니라는 것이 분명한가
  //   hold-none    붙잡히지 않았으면 **아무것도 뜨지 않는가**
  // 안내는 채팅 입력창 바로 위라 좁은 창에서 가장 먼저 무너진다 — 두 크기를 다 본다.
  { scenario: 'hold-active', w: 1820, h: 1120 },
  { scenario: 'hold-active', w: 1180, h: 760 },
  { scenario: 'hold-none', w: 1820, h: 1120 },
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
  // 사용량도 같다. 화면이 잘 그려졌는지가 아니라 **적힌 숫자가 앱이 준 값에서 나온
  // 것인지**를 보는 검사라, 이게 조용히 죽으면 지어낸 숫자가 그대로 새어 나간다.
  'usage-pending': '사용량 화면 대조',
  'usage-partial': '사용량 화면 대조',
  'usage-newday': '사용량 화면 대조',
  'usage-limit': '사용량 화면 대조',
  'usage-huge': '사용량 화면 대조',
  // 상단 숫자가 **숨어야** 하는 유일한 갈래. 흐름 이름이 다른 것이 곧 확인 항목이다 —
  // 여기서 '사용량 화면 대조'가 돌았다면 없는 통로 위에 화면이 떠 버린 것이다.
  'usage-none': '사용량 통로 없음 확인',
  // 새 대화로 갈아타기. **어디까지 눌러 봤는지가 갈래마다 다르다** — 이름이 곧 확인
  // 항목이라, 하나라도 빠지면 그 자리에서 검사가 조용히 죽은 것이다.
  // (기록이 없는 갈래는 버튼이 죽어 있으므로 확인 창까지 가지 못하는 것이 정상이다.)
  'session-heavy': '새 대화 화면 대조 · 새 대화 확인 창 · 그만두기 · 인수인계 메모 전달',
  'session-light': '새 대화 화면 대조 · 새 대화 확인 창 · 그만두기 · 시작 거절 이유 표시',
  'session-none': '새 대화 화면 대조',
  'session-nogrowth': '새 대화 화면 대조 · 새 대화 확인 창 · 그만두기 · 인수인계 메모 전달',
  // 한도 홀드. 이름이 곧 확인 항목이다 — `hold-none`에서 '한도 홀드 화면 대조'가 돌았다면
  // 붙잡히지도 않았는데 안내가 떠 있었다는 뜻이고, 그 반대도 마찬가지다.
  'hold-active': '한도 홀드 화면 대조',
  'hold-none': '홀드 없음 확인',
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
