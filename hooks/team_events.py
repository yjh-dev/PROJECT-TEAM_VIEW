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
CANCEL_NAME = "team-cancel.flag"
MAX_LOG_BYTES = 512 * 1024  # 넘으면 새로 시작한다(앱이 잘림을 감지해 리셋한다)

# 명령 문자열에 이런 게 보이면 아예 기록하지 않는다(로그가 시크릿 유출 경로가 되지 않게).
SECRETISH = re.compile(
    r"AKIA|ASIA|gh[posur]_|github_pat_|xox[baprse]-|AIza|sk-|_live_|BEGIN [A-Z ]*PRIVATE KEY",
)


# 위임 결과 문자열에 들어 있는 에이전트 id. 나중에 SendMessage로 그 에이전트를
# 다시 깨울 때 `to`에 이 값이 들어오므로, 누구인지 알려면 표가 필요하다.
AGENT_ID_RE = re.compile(r"agentId[\"'\s:]+([A-Za-z0-9_-]{6,})")
ID_LIKE = re.compile(r"^a[0-9a-f]{8,}$")


def agent_id_from(res):
    try:
        text = res if isinstance(res, str) else json.dumps(res, ensure_ascii=False)
    except Exception:
        return None
    m = AGENT_ID_RE.search(text or "")
    return m.group(1) if m else None


def project_dir(payload):
    """이벤트를 기록할 프로젝트 뿌리.

    **cwd를 먼저 믿으면 안 된다.** 세션이 다른 폴더에서 작업하면 cwd가 따라
    움직이는데, 그 폴더에 `.claude`가 없으면 훅이 조용히 빠져나가 이벤트가
    통째로 사라진다. 실제로 그렇게 3시간 동안 아무것도 기록되지 않았고,
    Stop 훅이 대기열을 세션에 넣어 주지 못해 "명령을 내려도 작업을 안 하는"
    상태가 됐다.

    그래서 후보들 중 **실제로 `.claude`가 있는 첫 번째**를 고른다.
    CLAUDE_PROJECT_DIR(프로젝트 뿌리)이 먼저다.
    """
    candidates = [
        os.environ.get("CLAUDE_PROJECT_DIR"),
        payload.get("cwd"),
        os.getcwd(),
    ]
    for cand in candidates:
        if cand and os.path.isdir(os.path.join(cand, ".claude")):
            return cand
    return next((c for c in candidates if c), os.getcwd())


# 팀원에게 일을 넘기는 도구들. **이름이 하나가 아니다** — 예전에는 "Task"만 보고
# 있었는데 실제로는 "Agent"로 들어와서, 위임이 통째로 안 잡혔다. 그래서 서브에이전트가
# 시작하지 않은 것으로 처리되고 **그 팀원의 작업이 전부 리드에게 붙었다.**
# 화면에서는 "리드 혼자 계속 일하는" 모습으로 보인다.
DELEGATE_TOOLS = ("Task", "Agent")

# 초. SubagentStop이 오지 않으면 이만큼 뒤 자동 해제한다.
# 180초는 너무 짧았다 — 서브에이전트는 10분 넘게 도는 일이 흔한데, 그 사이 만료되면
# 남은 작업이 다시 리드에게 붙는다. 짝이 안 맞는 유령을 막는 것이 목적이므로
# 넉넉히 두되 무한정은 아니게 한다.
ACTIVE_TTL = 1800


def load_state(path):
    """활성 에이전트 목록을 읽되 **오래된 항목은 버린다.**

    Task 호출은 있었는데 짝이 되는 SubagentStop이 오지 않으면(테스트로 넣은
    가짜 이벤트, 중단된 세션 등) 그 에이전트가 영원히 활성으로 남아 이후 모든
    도구가 엉뚱한 사람에게 귀속된다. 실제로 그 일이 있었다.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            st = json.load(f)
    except Exception:
        return {"active": []}
    now = time.time()
    out = []
    for item in st.get("active") or []:
        if isinstance(item, dict):
            if now - float(item.get("at") or 0) < ACTIVE_TTL:
                out.append(item)
        elif isinstance(item, str):
            out.append({"name": item, "at": now})  # 예전 형식 호환
    st["active"] = out
    return st


CANCEL_TTL = 300  # 초. 이보다 오래된 취소 깃발은 무시하고 지운다.


def flag_age(path):
    """깃발이 세워진 지 몇 초 지났는지. 파일 안의 시각을 먼저 믿고, 없으면 mtime."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return time.time() - float(f.read().strip())
    except (OSError, ValueError):
        pass
    try:
        return time.time() - os.path.getmtime(path)
    except OSError:
        return 0.0


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


def last_assistant_text(transcript_path):
    """세션 기록에서 **마지막 답변 텍스트**를 뽑는다.

    지금까지 경로가 앱 → 세션 한 방향이라, 앱에서 "안녕"을 보내도 대답이 앱으로
    돌아오지 않았다(화면에는 상태 변화만 보였다). Stop 훅 페이로드에 들어오는
    transcript_path를 읽어 마지막 assistant 메시지를 되돌려 준다.
    """
    if not transcript_path or not os.path.exists(transcript_path):
        return None
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            lines = f.readlines()[-400:]  # 끝부분만 본다(기록이 길 수 있다)
    except Exception:
        return None
    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("type") != "assistant":
            continue
        content = (rec.get("message") or {}).get("content")
        parts = []
        if isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text" and c.get("text"):
                    parts.append(c["text"])
        elif isinstance(content, str):
            parts.append(content)
        text = " ".join(" ".join(parts).split())
        if text:
            return text[:180]
    return None


def detail_for(tool, ti):
    if not isinstance(ti, dict):
        return None
    if tool == "Bash":
        cmd = " ".join(str(ti.get("command") or "").split())  # 줄바꿈·연속 공백 정리
        if SECRETISH.search(cmd):
            return "(민감한 명령 — 생략)"
        return cmd[:44]
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

    # ── 앱에서 누른 "작업 취소" ────────────────────────────────────────────
    # 이미 돌고 있는 세션은 밖에서 죽일 수 없다. 대신 **다음 도구 호출을 막는다** —
    # PreToolUse가 deny를 돌려주면 에이전트는 그 도구를 못 쓰고, 이유를 읽고 멈춘다.
    # 깃발은 세션이 한 턴을 마칠 때(Stop) 지운다. 안 지우면 다음 지시까지 막힌다.
    cancel_flag = os.path.join(claude_dir, CANCEL_NAME)
    if os.path.exists(cancel_flag) and flag_age(cancel_flag) > CANCEL_TTL:
        # 눌러 놓고 잊은 취소가 몇 시간 뒤 작업을 막으면 안 된다.
        try:
            os.remove(cancel_flag)
        except OSError:
            pass
    if kind == "pre" and os.path.exists(cancel_flag):
        write_events(log_path, [{"type": "cancel", "agent": "lead", "detail": "사용자가 작업을 취소했습니다"}])
        why = (
            "사용자가 Team View 앱에서 작업 취소를 눌렀습니다. "
            "지금 하던 일을 중단하고, 어디까지 했는지만 짧게 보고한 뒤 멈추세요. "
            "다른 도구를 쓰거나 작업을 이어가지 마세요."
        )
        # 새 형식(hookSpecificOutput)과 예전 형식(decision/reason)을 함께 낸다.
        # 취소가 조용히 무시되는 것이 최악이라 양쪽 다 채워 둔다.
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": why,
                    },
                    "decision": "block",
                    "reason": why,
                },
                ensure_ascii=False,
            )
        )
        sys.exit(0)
    if kind == "stop" and os.path.exists(cancel_flag):
        # 턴이 끝났으니 깃발을 내린다. 대기열 처리보다 **먼저** 해야 취소가
        # 다음 지시까지 잡아먹지 않는다.
        try:
            os.remove(cancel_flag)
        except OSError:
            pass
        save_state(state_path, {"active": []})
        write_events(log_path, [{"type": "session", "state": "idle", "agent": "lead"}])
        sys.exit(0)

    if kind == "session":
        active = []
        events.append({"type": "session", "state": "start", "agent": "lead"})
    elif kind == "stop":
        active = []
        # 앱에서 보낸 지시가 쌓여 있으면 여기서 **현재 세션에 밀어 넣는다.**
        # Stop 훅이 decision=block을 반환하면 세션이 멈추지 않고 reason을 받아 이어간다.
        pending = take_pending_commands(claude_dir)
        if pending:
            # **여기서 agent_start를 지어내지 않는다.** 예전에는 대기열의 담당 이름으로
            # 시작 이벤트를 써 버려서, 아무도 일을 시작하지 않았는데 그 캐릭터가
            # 자리로 걸어가 타이핑했다. 큐에 담긴 이름은 '희망'이지 '사실'이 아니다.
            # 실제 시작은 리드가 Task로 그 팀원을 부를 때 PreToolUse가 기록한다.
            lines = []
            named = False
            for c in pending:
                who = c.get("agent") or "lead"
                body = c.get("text", "")
                if who and who != "lead":
                    lines.append(f"- `{who}`에게 맡길 일: {body}")
                    named = True
                else:
                    lines.append(f"- {body}")
            reason = (
                "Team View 앱에서 전달된 지시가 있습니다. 아래를 처리하세요.\n"
                + "\n".join(lines)
            )
            if named:
                # 사람이 앱에서 고른 담당은 **지시일 뿐 판단이 아니다.** 프론트를 골라
                # 놓고 기획안 수정을 보내면 프론트가 기획서를 고치고 있었다.
                reason += (
                    "\n\n맡을 팀원이 지정돼 있어도 **그 역할에 맞는 일인지 먼저 판단하세요.**"
                    " 맞지 않으면 억지로 그 팀원에게 시키지 말고 성격에 맞는 팀원에게 넘기고,"
                    " 누구에게 맡겼는지 한 줄로 밝히세요."
                )
            print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
            sys.exit(0)
        reply = last_assistant_text(payload.get("transcript_path"))
        if reply:
            events.append({"type": "reply", "agent": "lead", "detail": reply})
        events.append({"type": "session", "state": "idle", "agent": "lead"})
    elif kind == "prompt":
        events.append({"type": "prompt", "agent": "lead"})
    elif kind == "subagent_stop":
        item = active.pop() if active else None
        events.append({"type": "agent_stop", "agent": (item or {}).get("name") or "lead"})
    elif kind == "pre":
        if tool in DELEGATE_TOOLS:
            sub = ti.get("subagent_type") if isinstance(ti, dict) else None
            agent = sub or "팀원"
            active.append({"name": agent, "at": time.time()})
            events.append({"type": "agent_start", "agent": agent})
            events.append({"type": "tool", "tool": tool, "agent": "lead"})
        elif tool == "SendMessage":
            # 서브에이전트를 **다시 깨우는 것**도 그 팀원이 다시 일을 시작하는 것이다.
            # 이걸 안 잡아서, 재개된 디자이너의 Figma 작업이 전부 리드에게 붙었다.
            # `to`는 보통 에이전트 id라 post에서 만들어 둔 표로 이름을 되찾는다.
            to = ti.get("to") if isinstance(ti, dict) else None
            resolved = (state.get("delegates") or {}).get(to)
            name = resolved or (to if to and not ID_LIKE.match(str(to)) else None)
            if name and name not in ("main", "lead"):
                active.append({"name": name, "at": time.time()})
                events.append({"type": "agent_start", "agent": name})
            events.append({"type": "tool", "tool": tool, "agent": "lead"})
        else:
            events.append(
                {
                    "type": "tool",
                    "tool": tool,
                    "agent": active[-1]["name"] if active else "lead",
                    "detail": detail_for(tool, ti),
                }
            )
    elif kind == "post":
        # 실패를 잡는다. 성공은 이미 pre에서 기록했으므로 여기서는 **오류만** 남긴다.
        # 화면에서 문제를 바로 알아채는 것이 목적이라 실패는 놓치면 안 된다.
        # 위임이 성공하면 **에이전트 id ↔ 팀원 이름**을 기억한다(SendMessage용).
        if tool in DELEGATE_TOOLS:
            who = ti.get("subagent_type") if isinstance(ti, dict) else None
            aid = agent_id_from(payload.get("tool_response"))
            if who and aid:
                table = dict(state.get("delegates") or {})
                table[aid] = who
                state["delegates"] = dict(list(table.items())[-20:])
        res = payload.get("tool_response")
        failed = False
        msg = ""
        if isinstance(res, dict):
            failed = bool(res.get("is_error") or res.get("error"))
            msg = str(res.get("error") or res.get("stderr") or "")
        elif isinstance(res, str):
            failed = res.lstrip().lower().startswith("error")
            msg = res
        if not failed:
            events = []  # 기록할 건 없지만 위에서 만든 표는 저장돼야 한다
        else:
            events.append(
            {
                "type": "error",
                "tool": tool,
                "agent": active[-1]["name"] if active else "lead",
                "detail": " ".join(msg.split())[:60] or detail_for(tool, ti),
            }
            )
    else:
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
