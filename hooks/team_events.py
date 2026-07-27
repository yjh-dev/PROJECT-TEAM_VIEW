#!/usr/bin/env python3
"""Claude Code 훅 → team-view 이벤트 기록기.

훅 JSON을 stdin으로 받아 `<프로젝트>/.claude/team-events.jsonl`에 한 줄을 덧붙인다.
인자로 어떤 훅에서 불렸는지 알려준다:  pre | post | subagent_stop | stop | session | prompt

설치법은 README.md 참고.

원칙:
- **절대 작업을 막지 않는다.** 무슨 일이 있어도 exit 0. 시각화가 개발을 방해하면 안 된다.
- 빠르게 끝낸다. 파일 하나에 append만 한다.
- 비밀값을 기록하지 않는다. Bash 명령은 앞부분만, 그것도 토큰처럼 보이면 통째로 버린다.

에이전트 귀속에 대해:
  훅 페이로드에는 "지금 어느 서브에이전트가 도는 중인지"가 들어오지 않는다.
  그래서 Task 도구 호출(= 팀원 호출)로 시작을, SubagentStop으로 종료를 잡고,
  그 사이의 도구 이벤트는 **가장 최근에 시작된 활성 에이전트**에게 귀속시킨다.
  여러 팀원이 동시에 도는 경우 귀속이 틀릴 수 있다 — 알려진 한계다.
"""
import json
import os
import re
import sys
import time

# Windows 파이썬의 기본 stdout 인코딩은 ANSI 코드페이지(한국어면 cp949)다.
# 그런데 이 출력을 읽는 Claude Code는 UTF-8로 해석하므로 지시문의 한글이 깨진다.
# 지시가 깨져서 전달되면 기능 자체가 무의미해지므로 UTF-8로 고정한다.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

STATE_NAME = "team-events.state.json"
LOG_NAME = "team-events.jsonl"
COMMANDS_NAME = "team-commands.jsonl"
MAX_LOG_BYTES = 512 * 1024  # 넘으면 새로 시작한다(앱이 잘림을 감지해 리셋한다)

# 명령 문자열에 이런 게 보이면 아예 기록하지 않는다(로그가 시크릿 유출 경로가 되지 않게).
SECRETISH = re.compile(
    r"AKIA|ASIA|gh[posur]_|github_pat_|xox[baprse]-|AIza|sk-|_live_|BEGIN [A-Z ]*PRIVATE KEY",
)


def project_dir(payload):
    return (
        payload.get("cwd")
        or os.environ.get("CLAUDE_PROJECT_DIR")
        or os.getcwd()
    )


def load_state(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"active": []}


def save_state(path, state):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(state, f)
    except Exception:
        pass


def take_pending_commands(claude_dir):
    """대기 중인 지시를 모두 가져오고 파일을 비운다(같은 지시를 두 번 실행하지 않도록)."""
    path_ = os.path.join(claude_dir, COMMANDS_NAME)
    if not os.path.exists(path_):
        return []
    out = []
    try:
        with open(path_, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    c = json.loads(line)
                except Exception:
                    continue
                if c.get("status") == "pending":
                    out.append(c)
    except Exception:
        return []
    if out:
        try:
            os.remove(path_)
        except Exception:
            pass
    return out


def write_events(log_path, events):
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            for ev in events:
                ev.setdefault("ts", time.time())
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    except Exception:
        pass


def detail_for(tool, ti):
    if not isinstance(ti, dict):
        return None
    if tool == "Bash":
        cmd = str(ti.get("command") or "")
        if SECRETISH.search(cmd):
            return "(민감한 명령 — 생략)"
        return cmd[:40]
    for key in ("file_path", "notebook_path", "path", "pattern"):
        v = ti.get(key)
        if isinstance(v, str) and v:
            return v
    return None


def main():
    kind = sys.argv[1] if len(sys.argv) > 1 else "pre"
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(payload, dict):
        return

    root = project_dir(payload)
    claude_dir = os.path.join(root, ".claude")
    if not os.path.isdir(claude_dir):
        return  # .claude가 없으면 우리가 볼 프로젝트가 아니다

    log_path = os.path.join(claude_dir, LOG_NAME)
    state_path = os.path.join(claude_dir, STATE_NAME)
    state = load_state(state_path)
    active = state.get("active") or []

    tool = payload.get("tool_name") or ""
    ti = payload.get("tool_input") or {}
    events = []

    if kind == "session":
        active = []
        events.append({"type": "session", "state": "start", "agent": "lead"})
    elif kind == "stop":
        active = []
        # 앱에서 보낸 지시가 쌓여 있으면 여기서 **현재 세션에 밀어 넣는다.**
        # Stop 훅이 decision=block을 반환하면 세션이 멈추지 않고 reason을 받아 이어간다.
        pending = take_pending_commands(claude_dir)
        if pending:
            write_events(log_path, [
                {"type": "agent_start", "agent": c.get("agent") or "lead"} for c in pending
            ])
            save_state(state_path, {"active": [c.get("agent") for c in pending if c.get("agent")]})
            lines = []
            for c in pending:
                who = c.get("agent") or "lead"
                body = c.get("text", "")
                if who and who != "lead":
                    lines.append(f"- `{who}` 서브에이전트로: {body}")
                else:
                    lines.append(f"- {body}")
            reason = (
                "Team View 앱에서 전달된 지시가 있습니다. 아래를 처리하세요.\n"
                + "\n".join(lines)
            )
            print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
            sys.exit(0)
        events.append({"type": "session", "state": "idle", "agent": "lead"})
    elif kind == "prompt":
        events.append({"type": "prompt", "agent": "lead"})
    elif kind == "subagent_stop":
        agent = active.pop() if active else None
        events.append({"type": "agent_stop", "agent": agent or "lead"})
    elif kind == "pre":
        if tool == "Task":
            sub = ti.get("subagent_type") if isinstance(ti, dict) else None
            agent = sub or "팀원"
            active.append(agent)
            events.append({"type": "agent_start", "agent": agent})
            events.append({"type": "tool", "tool": "Task", "agent": "lead"})
        else:
            events.append(
                {
                    "type": "tool",
                    "tool": tool,
                    "agent": active[-1] if active else "lead",
                    "detail": detail_for(tool, ti),
                }
            )
    else:  # post — 지금은 pre만으로 충분해서 기록하지 않는다
        return

    state["active"] = active
    save_state(state_path, state)

    try:
        if os.path.exists(log_path) and os.path.getsize(log_path) > MAX_LOG_BYTES:
            os.remove(log_path)
        with open(log_path, "a", encoding="utf-8") as f:
            for ev in events:
                ev["ts"] = time.time()
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    except Exception:
        pass


try:
    main()
except Exception:
    pass  # 시각화가 개발을 막는 일은 없어야 한다
sys.exit(0)
