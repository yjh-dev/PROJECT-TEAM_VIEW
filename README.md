# Team View

Claude Code 팀 에이전트가 **실제로 일하는 모습**을 도트 캐릭터로 보여주는 윈도우 앱.

터미널 로그 대신 사무실 한 칸을 봅니다. `frontend-dev`가 호출되면 그 캐릭터가 자기 책상으로
걸어가 앉아서 타이핑하고, 무슨 파일을 만지는지 말풍선에 뜹니다. 작업이 끝나면 자리에서 일어납니다.

> **화면의 모든 움직임은 실제 훅 이벤트에서 나옵니다.** 심심해 보이지 않으려고 가짜로
> 움직이는 캐릭터는 없습니다. 아무도 안 움직이면 정말로 아무 일도 없는 것입니다.

## 빠르게 보기 (훅 없이)

```bash
pnpm install
pnpm dev
```
창이 뜨면 **프로젝트 선택**으로 `.claude/`가 있는 폴더를 고르고, 다른 터미널에서:
```bash
node tools/emit-demo-events.js <그 폴더 경로>
```
가짜 시나리오(기획→디자인→프론트→리뷰→QA)가 25초간 흐릅니다. 실제 훅과 같은 형식이라
앱 입장에선 구분되지 않습니다 — 데모가 잘 돈다고 훅 연동이 된 건 아닙니다.

## 실제 연동 (훅 설치)

보고 싶은 프로젝트에 훅을 답니다.

1. `hooks/team_events.py`를 그 프로젝트의 `.claude/hooks/`로 복사합니다.
2. 그 프로젝트의 `.claude/settings.json`(공유) 또는 `settings.local.json`(나만)에 추가:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "python \"$CLAUDE_PROJECT_DIR/.claude/hooks/team_events.py\" pre", "timeout": 10 }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "python \"$CLAUDE_PROJECT_DIR/.claude/hooks/team_events.py\" subagent_stop", "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "python \"$CLAUDE_PROJECT_DIR/.claude/hooks/team_events.py\" prompt", "timeout": 10 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "python \"$CLAUDE_PROJECT_DIR/.claude/hooks/team_events.py\" stop", "timeout": 10 }] }
    ]
  }
}
```

3. **Claude Code를 재시작**합니다(훅은 시작할 때 읽힙니다).
4. 앱에서 그 프로젝트 폴더를 선택합니다. 끝.

`.claude/team-events.jsonl`과 `.claude/team-events.state.json`이 생깁니다. **`.gitignore`에
추가하세요** — 작업 기록이라 커밋할 이유가 없습니다.

## 알아둘 것

- **에이전트 귀속은 추정입니다.** 훅 페이로드에는 "지금 어느 서브에이전트가 도는 중인지"가
  없습니다. `Task` 호출로 시작을, `SubagentStop`으로 종료를 잡고 그 사이 도구 이벤트를
  가장 최근에 시작된 에이전트에게 붙입니다. **여러 팀원이 동시에 돌면 귀속이 틀릴 수 있습니다.**
- **도구 호출마다 파이썬 프로세스가 하나 뜹니다.** 호출당 수십 ms가 더해집니다. 느껴지면
  `PreToolUse` 훅을 빼고 `Task`/`SubagentStop`만 남기세요(누가 일하는지는 계속 보입니다).
- 훅은 **무슨 일이 있어도 exit 0**입니다. 시각화가 개발을 막지 않습니다.
- Bash 명령에서 키처럼 보이는 문자열이 발견되면 그 명령은 기록하지 않습니다(로그가 유출
  경로가 되지 않도록). 다만 완전하지 않으니 이 파일을 공유하지 마세요.
- 이벤트 로그가 512KB를 넘으면 새로 시작합니다. 앱이 잘림을 감지해 화면을 리셋합니다.

## 구조

```
main.js              Electron 메인 — 창 + 이벤트 파일 tail(폴링)
preload.js           렌더러에 노출하는 최소 API
renderer/
  index.html         화면 뼈대 (외부 리소스 없음, CSP 적용)
  app.js             렌더 루프 + 이벤트→행동 매핑
  sprites.js         도트 캐릭터를 코드로 찍는다 (에셋 파일 없음)
  agents.js          팀 명단·자리 배치·팔레트
  room.js            사무실 배경·책상·모니터
hooks/team_events.py Claude Code 훅 → 이벤트 기록기
tools/emit-demo-events.js  훅 없이 화면만 확인할 때
```

캐릭터를 추가하거나 색을 바꾸려면 `renderer/agents.js`의 `ROSTER`만 건드리면 됩니다.
명단에 없는 이름이 이벤트로 들어와도 회색 캐릭터로 자리를 만들어 줍니다(무시하지 않습니다).

## 아직 없는 것

- 배포용 exe 패키징(`electron-builder`) — 지금은 `pnpm dev`로 실행합니다
- 캐릭터 클릭 시 해당 에이전트의 최근 출력 보기
- 여러 프로젝트 동시 감시
