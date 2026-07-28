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
  훅 페이로드가 **누가 그 도구를 불렀는지 직접 알려준다.** 서브에이전트가 부른
  도구에는 `agent_type`(= 명단 id, `subagent_type`과 같은 값)과 `agent_id`가 실리고,
  메인 세션(리드)이 부른 도구에는 두 키가 아예 없다. 그래서 귀속은 한 줄이다:
      agent = payload.get("agent_type") or "lead"

  예전에는 이 값이 안 온다고 보고 **추측**했다 — Task 호출로 시작을 잡고 SubagentStop으로
  끝을 잡고 그 사이 도구를 '가장 최근에 시작된 에이전트'에게 붙였다. 그 추측은 네 번 깨졌다:
  위임 도구 이름이 Task가 아니라 Agent로 와서 시작을 통째로 놓쳤고, SendMessage로 재개하면
  또 놓쳤고, TTL이 만료되면 남은 작업이 리드에게 되돌아갔고, **여러 팀원이 동시에 돌면
  그냥 틀렸다.** 실측으로 전제가 틀렸음을 확인해 전부 걷어냈다. 동시 실행 한계도 없어졌다.

  agent_type이 없는 구버전 Claude Code에서는 모든 도구가 리드에게 붙는다(추측하지 않는다).

회사에 대해:
  앱 지시를 처리하는 주체는 `.claude/team-worker.json`에 클레임을 적는다. 두 가지가 있다.

  1. **회사**(팀뷰 앱 자신 = 지금 방식): 앱이 대기열을 지켜보다가 `claude -p --continue`로
     지시를 하나씩 실행한다. 클레임에 `mode: "poller"`를 적고 **타이머로 30초마다
     갱신한다.** 회사가 띄운 claude에는 `TEAMVIEW_POLLER`가 환경변수로 실려 오므로
     훅은 그 세션을 알아본다.
  2. **대화형 워커**(`TEAMVIEW_WORKER=1`, 예전 방식): 세션이 자기 session_id를 적는다.
     하위 호환으로 남겨 뒀다. 살아 있는 회사 클레임이 우선이라 끼어들지 못한다.

  왜 앱으로 옮겼나: 대화형 워커의 클레임과 대기열 처리는 둘 다 **훅이 돌 때만** 일어난다.
  그런데 `Stop` 훅은 세션이 한 턴을 끝낼 때만 돈다 — 갓 띄운 워커는 입력을 받은 적이 없어
  턴이 없고, 그래서 큐가 영원히 쌓였다. 게다가 유휴 워커는 훅이 안 도니 클레임이 10분 뒤
  만료돼, 살아 있는데도 분리가 풀려 **사람과 대화하는 세션이 큐를 가져갔다.** 앱은 대화를
  하지 않으니 조용해질 일이 없고, 타이머는 훅과 무관하게 돈다.

  **살아 있는 회사 클레임이 최우선이다.** 그 동안 훅은 큐를 건드리지 않는다(같은 지시가
  두 번 실행되면 안 된다). 클레임이 없거나 오래되면 예전처럼 아무 세션이나 처리한다 —
  회사를 안 여는 사람까지 먹통이 되면 안 된다.
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
WORKER_NAME = "team-worker.json"
MAX_LOG_BYTES = 512 * 1024  # 넘으면 새로 시작한다(앱이 잘림을 감지해 리셋한다)

# 명령 문자열에 이런 게 보이면 아예 기록하지 않는다(로그가 시크릿 유출 경로가 되지 않게).
SECRETISH = re.compile(
    r"AKIA|ASIA|gh[posur]_|github_pat_|xox[baprse]-|AIza|sk-|_live_|BEGIN [A-Z ]*PRIVATE KEY",
)


def agent_of(payload):
    """이 호출의 주인. **추측하지 않는다** — 페이로드가 직접 알려준다.

    서브에이전트의 도구 호출에만 `agent_type`이 실린다(값은 명단 id 그대로).
    리드가 부른 호출에는 키 자체가 없으므로 없으면 리드다.
    """
    return payload.get("agent_type") or "lead"


def note_start(active, key, name):
    """처음 보는 에이전트면 `agent_start` 한 줄. 이미 알고 있으면 아무것도 내지 않는다.

    시작을 '위임 도구 호출'로만 잡던 시절에는 도구 이름이 Task가 아니거나(Agent)
    SendMessage로 재개하면 시작을 통째로 놓쳤다. 이제 **그 에이전트가 실제로 도구를
    쓰는 순간** 잡으므로 어떤 경로로 깨어나든 걸린다.
    """
    if not key or not name or name == "lead":
        return []
    if key in active:
        return []
    # 위임 시점에 미리 잡아 둔 자리(name:<이름>)를 실제 agent_id로 승계한다.
    # 안 그러면 같은 팀원에게 시작이 두 번 나가 앱에서 대기 배지가 두 번 깎인다.
    placeholder = active.pop("name:" + name, None)
    active[key] = name
    return [] if placeholder else [{"type": "agent_start", "agent": name}]


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


WORKER_TTL = 600  # 초. 이보다 오래된 클레임은 **죽은 워커**로 보고 무시한다.
WORKER_REFRESH = 30  # 초. 이 안에 이미 갱신했으면 디스크에 다시 쓰지 않는다.


def is_worker():
    """이 세션이 앱 전용 워커로 떠 있는가(`TEAMVIEW_WORKER=1`)."""
    return os.environ.get("TEAMVIEW_WORKER", "").strip().lower() not in ("", "0", "false", "no")


def is_poller_child():
    """이 세션을 **폴러가 띄웠는가**(`TEAMVIEW_POLLER=<폴러 pid>`).

    폴러는 `claude -p`를 매번 새로 띄우므로 고정된 session_id가 없다. 그래서 클레임은
    폴러가 자기 pid로 적고, 자식 세션은 환경변수로 자신을 밝힌다(환경변수는 claude →
    훅 프로세스까지 그대로 상속된다). 이 표식이 있으면 클레임의 주인과 session_id가
    달라도 앱 일을 맡은 세션이 맞다.
    """
    return bool(os.environ.get("TEAMVIEW_POLLER", "").strip())


def read_claim(claude_dir):
    """지금 앱 일을 맡고 있다고 적어 둔 세션. 없으면 None."""
    try:
        with open(os.path.join(claude_dir, WORKER_NAME), "r", encoding="utf-8") as f:
            claim = json.load(f)
    except Exception:
        return None
    if not isinstance(claim, dict) or not claim.get("session_id"):
        return None
    return claim


def claim_age(claim):
    try:
        return time.time() - float(claim.get("at") or 0)
    except (TypeError, ValueError):
        return WORKER_TTL + 1  # 읽을 수 없는 시각은 오래된 것으로 친다


def refresh_claim(claude_dir, session_id, claim):
    """워커가 "지금 내가 맡고 있다"고 표시한다.

    **매 호출마다 쓰지 않는다.** 이 훅은 도구 호출마다 도는데, 그때마다 디스크에
    쓰면 그 비용이 전부 개발 속도에서 빠진다. 내 것이고 최근이면 건너뛴다.
    다른 세션의 클레임이면 나이와 상관없이 곧바로 넘겨받는다(마지막 워커가 이긴다).
    """
    if not session_id:
        return  # 누구인지 못 적으면 클레임은 의미가 없다
    if claim and claim.get("session_id") == session_id and claim_age(claim) < WORKER_REFRESH:
        return
    try:
        with open(os.path.join(claude_dir, WORKER_NAME), "w", encoding="utf-8") as f:
            json.dump({"session_id": session_id, "at": time.time()}, f)
    except Exception:
        pass


def poller_claim(claude_dir):
    """살아 있는 폴러 클레임. 없으면 None."""
    claim = read_claim(claude_dir)
    if claim and claim.get("mode") == "poller" and claim_age(claim) <= WORKER_TTL:
        return claim
    return None


def may_act(claude_dir, payload):
    """이 세션이 앱 일(이벤트 기록)을 맡아도 되는지.

    사람과 대화하는 세션과 앱이 시키는 일을 같은 창에서 하다가 셋 다 겪었다:
    대화 중이라 턴이 길면 지시가 그동안 쌓이기만 했고, 앱 지시가 사람과의 대화에
    섞여 들어왔고, 그 세션의 도구 호출이 전부 화면에 찍혀 "리드가 쉬지 않고
    일하는" 것처럼 보였다. 그래서 **앱을 상대하는 쪽 하나만** 기록하게 한다.

    되돌릴 수 없는 규칙이 하나 있다: **클레임이 없으면 예전처럼 동작한다.**
    워커를 안 띄운 사람까지 먹통이 되면 안 된다.
    """
    claim = read_claim(claude_dir)
    session_id = payload.get("session_id")
    if is_poller_child():
        return True  # 클레임은 폴러가 직접 갱신한다. 자식 세션은 건드리지 않는다.
    if poller_claim(claude_dir):
        # 폴러가 맡고 있다. 폴러가 띄운 세션(위 분기)만 기록한다 — 대화형 워커가
        # 끼어들어 클레임을 뺏으면 큐를 두 곳에서 집어가게 된다.
        return False
    if is_worker():
        refresh_claim(claude_dir, session_id, claim)
        return True
    if not claim or claim_age(claim) > WORKER_TTL:
        return True  # 워커를 안 쓰거나(하위 호환) 워커가 죽었다 — 먹통이 되느니 아무나 처리한다
    return claim.get("session_id") == session_id


def poller_owns_queue(claude_dir):
    """대기열을 폴러가 소비하는가.

    폴러가 돌고 있으면 훅은 큐를 **절대** 건드리지 않는다. 폴러가 하나씩 꺼내
    실행하는데 훅까지 집어가면 같은 지시가 두 번 실행되거나 순서가 뒤엉킨다.
    폴러가 없으면(하위 호환) 예전처럼 Stop 훅이 집어간다.
    """
    return bool(is_poller_child() or poller_claim(claude_dir))


# 팀원에게 일을 넘기는 도구들. 위임하는 **그 순간** 캐릭터가 움직이게 하려고 남겨 둔다 —
# 서브에이전트의 첫 도구 호출(= agent_type이 처음 실려 오는 시점)은 몇 초 뒤에나 온다.
# 이제 이건 화면 반응을 앞당기는 **보조 수단일 뿐, 귀속의 근거가 아니다.** 예전에는
# 근거였고, 그래서 도구 이름이 "Agent"로 오던 시절에 위임을 통째로 놓쳤다.
DELEGATE_TOOLS = ("Task", "Agent")


def load_state(path):
    """진행 중인 서브에이전트만 담는다: `{키: 이름}`.

    키는 보통 `agent_id`, 위임 시점에 미리 만들어 둔 자리는 `name:<이름>`이다.
    쓰임은 **하나뿐** — 같은 에이전트에게 agent_start를 두 번 내지 않는 것.
    누가 일하는지는 매 호출의 agent_type이 알려주므로 여기에 기대지 않는다.

    예전에는 이 목록이 귀속의 근거라서 TTL로 유령을 걷어내야 했다(짝이 안 맞는 시작이
    남으면 이후 도구가 전부 엉뚱한 사람에게 붙었다). 이제 근거가 아니므로 TTL도 없앴다.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            st = json.load(f)
    except Exception:
        return {"active": {}}
    if not isinstance(st.get("active"), dict):
        st["active"] = {}  # 예전 형식(리스트)·깨진 값은 되살릴 이유가 없다
    st.pop("delegates", None)  # id↔이름 표는 agent_type이 대신한다
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


def _append_win(path_, data):
    """Windows에서 **진짜** 원자적 append.

    파이썬(CRT)의 `open(..., "a")`는 O_APPEND를 '쓰기 직전에 끝으로 seek'으로 흉내낸다.
    seek과 write 사이에 다른 프로세스가 쓰면 그 줄을 덮어쓴다 — 실측으로 6개 프로세스가
    2400줄을 쓰면 242줄이 사라졌다. 실제 로그에서도 줄 하나가 `}`만 남아 깨져 있었다.
    FILE_APPEND_DATA로 열면 커널이 '끝으로 이동 + 쓰기'를 한 번에 처리한다(같은 실측 0건).
    """
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    FILE_APPEND_DATA = 0x0004
    SHARE_ALL = 0x1 | 0x2 | 0x4  # 앱·다른 훅이 동시에 읽고 쓸 수 있어야 한다
    OPEN_ALWAYS = 4
    INVALID = wintypes.HANDLE(-1).value

    h = k32.CreateFileW(path_, FILE_APPEND_DATA, SHARE_ALL, None, OPEN_ALWAYS, 0x80, None)
    if h == INVALID:
        raise OSError(ctypes.get_last_error(), "CreateFileW")
    try:
        written = wintypes.DWORD(0)
        buf = ctypes.create_string_buffer(data, len(data))
        if not k32.WriteFile(h, buf, len(data), ctypes.byref(written), None):
            raise OSError(ctypes.get_last_error(), "WriteFile")
    finally:
        k32.CloseHandle(h)


def append_atomic(path_, text):
    """한 번의 write로 붙인다. 줄이 섞이거나 덮어써지지 않게."""
    data = text.encode("utf-8")
    if os.name == "nt":
        for _ in range(3):  # 공유 위반은 순간적이다 — 몇 번 다시 해 본다
            try:
                _append_win(path_, data)
                return
            except OSError:
                time.sleep(0.02)
    # POSIX의 O_APPEND는 커널이 보장한다. Windows에서 위가 실패했을 때의 최후 수단이기도 하다.
    with open(path_, "ab") as f:
        f.write(data)


def write_events(log_path, events):
    """이벤트를 **한 번의 append로** 기록한다.

    여러 줄을 한 번에 쓰는 이유도 같다 — 줄 단위로 나눠 쓰면 그 사이에 다른
    프로세스의 줄이 끼어들 수 있다(내용은 안 깨져도 순서가 뒤집힌다).
    """
    if not events:
        return
    try:
        # 로그가 너무 커지면 새로 시작한다(앱이 잘림을 감지해 화면을 리셋한다).
        if os.path.exists(log_path) and os.path.getsize(log_path) > MAX_LOG_BYTES:
            os.remove(log_path)
    except OSError:
        pass
    try:
        chunk = ""
        for ev in events:
            ev.setdefault("ts", time.time())
            chunk += json.dumps(ev, ensure_ascii=False) + "\n"
        append_atomic(log_path, chunk)
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

    # 다른 세션이 워커를 맡고 있으면 **아무것도 하지 않는다.** 기록도, 대기열도,
    # 취소 깃발도 건드리지 않는다 — 사람과 대화하던 세션이 앱의 취소 버튼에
    # 막히거나, 그 세션의 도구 호출이 앱 화면을 채우면 안 된다.
    if not may_act(claude_dir, payload):
        return

    log_path = os.path.join(claude_dir, LOG_NAME)
    state_path = os.path.join(claude_dir, STATE_NAME)
    state = load_state(state_path)
    active = state["active"]

    tool = payload.get("tool_name") or ""
    ti = payload.get("tool_input") or {}
    agent = agent_of(payload)  # 이 호출의 주인. 리드면 "lead".
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
        # 단 폴러가 띄운 세션이면 손대지 않는다 — 깃발이 여기서 사라지면 폴러가
        # 곧바로 다음 지시를 집어가 "취소했는데 계속 일한다"가 된다. 폴러가
        # 실행이 끝난 뒤 직접 내린다.
        if not is_poller_child():
            try:
                os.remove(cancel_flag)
            except OSError:
                pass
        save_state(state_path, {"active": []})
        write_events(log_path, [{"type": "session", "state": "idle", "agent": "lead"}])
        sys.exit(0)

    if kind == "session":
        active = {}
        events.append({"type": "session", "state": "start", "agent": "lead"})
    elif kind == "stop":
        active = {}
        # 앱에서 보낸 지시가 쌓여 있으면 여기서 **현재 세션에 밀어 넣는다.**
        # Stop 훅이 decision=block을 반환하면 세션이 멈추지 않고 reason을 받아 이어간다.
        # 폴러가 돌고 있으면 큐는 폴러 것이다(중복 실행 방지) — 손대지 않는다.
        pending = [] if poller_owns_queue(claude_dir) else take_pending_commands(claude_dir)
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
            # **지시를 가져갔다는 사실을 남긴다.** 앱은 지금까지 agent_start로만
            # 대기 배지를 지웠는데, 리드가 위임 없이 직접 답하면(인사·단순 질문)
            # agent_start가 아예 없어서 "지시 1건 대기"가 영영 남았다.
            # 아래 sys.exit(0)로 나가면 함수 끝의 기록 코드에 닿지 못하므로 여기서 직접 쓴다.
            write_events(
                log_path,
                [{"type": "command_taken", "agent": c.get("agent") or "lead"} for c in pending],
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
        # 누가 끝났는지도 페이로드가 알려준다(agent_id·agent_type이 함께 실린다).
        # 예전에는 '가장 최근에 시작된 것'을 꺼냈고, 둘이 동시에 돌면 엉뚱한 사람이
        # 종료 처리돼 실제로 일하는 캐릭터가 자리에 앉은 채 남았다.
        key = payload.get("agent_id") or (f"name:{agent}" if agent != "lead" else None)
        name = active.pop(key, None) if key else None
        if not name and agent == "lead" and active:
            # agent_type이 없는 구버전: 귀속은 추측하지 않지만 **시작/종료 짝은 맞춘다.**
            # 안 그러면 위임으로 시작만 난 캐릭터가 영원히 일하는 것처럼 남는다.
            key = list(active)[-1]
            name = active.pop(key)
        events.append({"type": "agent_stop", "agent": name or agent})
    elif kind == "pre":
        # 이 에이전트를 처음 본다면 그게 시작이다. 도구 이름이 무엇이든, 새 위임이든
        # 재개든 상관없이 걸린다 — 예전에는 Task/SendMessage를 각각 특수 처리하다 놓쳤다.
        events.extend(note_start(active, payload.get("agent_id"), agent))
        if tool in DELEGATE_TOOLS:
            # 위임하는 **그 순간** 그 팀원이 움직이게 한다. 서브에이전트의 첫 도구
            # 호출은 몇 초 뒤에 오는데, 그동안 화면이 조용하면 지시가 먹힌 건지 알 수 없다.
            sub = (ti.get("subagent_type") if isinstance(ti, dict) else None) or "팀원"
            events.extend(note_start(active, f"name:{sub}", sub))
            events.append({"type": "tool", "tool": tool, "agent": agent})
        else:
            events.append(
                {
                    "type": "tool",
                    "tool": tool,
                    "agent": agent,
                    "detail": detail_for(tool, ti),
                }
            )
    elif kind == "post":
        # 실패를 잡는다. 성공은 이미 pre에서 기록했으므로 여기서는 **오류만** 남긴다.
        # 화면에서 문제를 바로 알아채는 것이 목적이라 실패는 놓치면 안 된다.
        # PreToolUse 훅을 빼고 쓰는 설정(README 참고)에서는 여기가 그 팀원을 처음
        # 보는 자리이므로 시작도 챙긴다.
        events.extend(note_start(active, payload.get("agent_id"), agent))
        res = payload.get("tool_response")
        failed = False
        msg = ""
        if isinstance(res, dict):
            failed = bool(res.get("is_error") or res.get("error"))
            msg = str(res.get("error") or res.get("stderr") or "")
        elif isinstance(res, str):
            failed = res.lstrip().lower().startswith("error")
            msg = res
        if failed:
            # 성공이면 여기서 더 쓸 건 없다(위 note_start가 만든 시작 줄만 남는다).
            events.append(
                {
                    "type": "error",
                    "tool": tool,
                    "agent": agent,
                    "detail": " ".join(msg.split())[:60] or detail_for(tool, ti),
                }
            )
    else:
        return

    state["active"] = active
    save_state(state_path, state)
    write_events(log_path, events)


try:
    main()
except Exception:
    pass  # 시각화가 개발을 막는 일은 없어야 한다
sys.exit(0)
