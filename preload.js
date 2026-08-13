// 렌더러에 노출하는 최소 API. 렌더러는 Node에 직접 닿지 않는다(contextIsolation).
//
// 프로젝트는 여러 개가 동시에 붙을 수 있으므로 지시·취소는 **어느 프로젝트인지**
// 함께 보낸다. 생략하면 메인이 지금 보고 있는 프로젝트로 처리한다.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('teamView', {
  addProject: () => ipcRenderer.invoke('project:add'),
  removeProject: (dir) => ipcRenderer.invoke('project:remove', dir),
  activateProject: (dir) => ipcRenderer.invoke('project:activate', dir),
  setupProject: (dir, parts) => ipcRenderer.invoke('project:setup', { dir, parts }),
  // 팀원 고용·해고. 명단은 디스크(`.claude/agents/*.md`)가 진실이라 화면이 따로
  // 들고 있지 않는다 — 바뀔 때마다 다시 물어본다.
  listTeam: (dir) => ipcRenderer.invoke('team:list', { dir }),
  hireAgent: (dir, id) => ipcRenderer.invoke('team:hire', { dir, id }),
  createAgent: (dir, spec) => ipcRenderer.invoke('team:create', { dir, ...spec }),
  fireAgent: (dir, id) => ipcRenderer.invoke('team:fire', { dir, id }),
  // 대화 보관 — 앱을 껐다 켜도 프로젝트별로 남아 있다
  loadChat: (dir) => ipcRenderer.invoke('chat:load', dir),
  appendChat: (dir, msg) => ipcRenderer.invoke('chat:append', { dir, msg }),
  // 실행 환경 — claude 설치·로그인, Figma 연결
  checkEnv: (opts) => ipcRenderer.invoke('env:check', opts),
  // 이 컴퓨터에 필요한 프로그램이 깔려 있는지 / 설치를 돕기
  checkRequirements: () => ipcRenderer.invoke('env:requirements'),
  install: (key) => ipcRenderer.invoke('env:install', key),
  // ── 처음 켠 사람을 위한 설치 자동화 ────────────────────────────────────
  // autoInstall이 돌려주는 `verified`가 **유일한 성공 근거**다. `ok`도 같은 값이지만,
  // 화면이 "완료"를 그릴 때는 verified를 보게 두는 편이 읽는 사람에게 분명하다.
  // 설치 프로그램이 0을 돌려줬다는 사실만으로 완료를 그리면 안 된다.
  canAutoInstall: () => ipcRenderer.invoke('env:can-auto-install'),
  autoInstall: (key) => ipcRenderer.invoke('env:install-auto', key),
  onInstallProgress: (cb) => ipcRenderer.on('env:install-progress', (_e, p) => cb(p)),
  // 사용자가 앱 밖에서 직접 깔았을 때. 껐다 켜라고 하기 전에 이걸 먼저 해 본다.
  refreshPath: () => ipcRenderer.invoke('env:path-refresh'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  // 이름만 받아 폴더·구성·git을 한 번에. 비개발자에게 폴더를 고르라고 묻지 않는다.
  createProject: (name) => ipcRenderer.invoke('project:create', { name }),
  wizardDone: () => ipcRenderer.invoke('wizard:done'),
  login: (what) => ipcRenderer.invoke('env:login', what),
  // 계정 전환. 로그인은 "아직 안 붙은" 길, 전환은 "붙어 있는 걸 바꾸는" 길이라 따로 둔다
  // (이미 로그인돼 있으면 `claude auth login`이 그냥 끝나서 계정을 못 바꿨다).
  switchAccount: (what) => ipcRenderer.invoke('env:switch', { what }),
  onEnv: (cb) => ipcRenderer.on('env:status', (_e, env) => cb(env)),
  listProjects: () => ipcRenderer.invoke('project:list'),
  sendCommand: (payload) => ipcRenderer.invoke('command:send', payload),
  // 클립보드는 메인 프로세스에 맡긴다. 샌드박스 preload에서는 electron의 clipboard가
  // 없어서(undefined) 직접 부르면 예외가 났다. navigator.clipboard도 file://에서는 막힌다.
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  // 답변에 실려 오는 결과물 링크(Figma 등)를 기본 브라우저로 연다.
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  revealFile: (p) => ipcRenderer.invoke('file:reveal', p),
  openLog: () => ipcRenderer.invoke('log:open'),
  setChatWidth: (px) => ipcRenderer.invoke('ui:chat-width', px),
  // 계정 전체 사용량. **첫 집계 전에는 `ready:false`**로 오고 나머지는 null이다 —
  // 597MB를 훑는 동안 화면을 세우지 않으려고 그렇게 만들었다. 잠시 뒤 다시 물으면 된다.
  // **분모(한도·예산)는 오지 않는다.** 구독의 실제 한도는 어디에서도 얻을 수 없고,
  // 우리가 세는 기간·대상도 Claude가 세는 것과 다르다. 센 값만 그대로 그린다 —
  // 퍼센트나 게이지로 바꾸는 순간 없는 한도를 그리게 된다.
  getUsageStats: () => ipcRenderer.invoke('usage:stats'),
  // 지금 보고 있는 프로젝트의 **대화 하나**가 얼마나 무거운지.
  // `{ turns, firstRead, lastRead, growth, heavy, sizeBytes }` 또는 **null**(기록 없음).
  // firstRead가 0이면 firstRead·growth는 null로 온다 — 0을 지어내지 않는다.
  getSessionCost: () => ipcRenderer.invoke('session:cost'),
  // 대화를 새로 시작한다. `handoff`(선택)를 주면 **새 대화의 첫 지시 앞에 한 번만** 붙는다.
  // `{ ok: true, id }` 또는 `{ ok: false, reason }`. 옛 세션 기록은 지우지 않는다.
  startNewSession: (opts) => ipcRenderer.invoke('session:new', opts ?? {}),
  vitals: (v) => ipcRenderer.invoke('ui:vitals', v),
  reportError: (info) => ipcRenderer.invoke('ui:error', info),
  gitInit: (dir) => ipcRenderer.invoke('git:init', dir),
  snapshotDiff: (dir, ref) => ipcRenderer.invoke('snapshot:diff', { dir, ref }),
  snapshotRestore: (dir, ref) => ipcRenderer.invoke('snapshot:restore', { dir, ref }),
  runStart: (dir) => ipcRenderer.invoke('run:start', dir),
  runStop: (dir) => ipcRenderer.invoke('run:stop', dir),
  runLog: (dir) => ipcRenderer.invoke('run:log', dir),
  cancelAll: (dir) => ipcRenderer.invoke('command:cancel', dir),
  // 이벤트에는 어느 프로젝트 것인지가 실려 온다. 렌더러는 보고 있는 것만 그린다.
  onEvents: (cb) => ipcRenderer.on('events:new', (_e, payload) => cb(payload)),
  onReset: (cb) => ipcRenderer.on('events:reset', (_e, payload) => cb(payload)),
  // 프로젝트마다 `hold`가 함께 온다: **한도로 대기열을 붙잡아 둔 동안**
  // `{ until: '2026-08-13T02:50:00.000Z', reason: '토큰 사용량 한도' }`, 아니면 null.
  // `until`은 언제나 실제 ISO 시각이고(모르면 기본 대기가 들어간다), `reason`은 앱이
  // 쓰는 실패 이름 그대로다. 지시는 큐에 그대로 남아 있고 그 시각이 지나면 이어서 돈다.
  onStatus: (cb) => ipcRenderer.on('projects:status', (_e, status) => cb(status)),
  onRunFailed: (cb) => ipcRenderer.on('run:failed', (_e, info) => cb(info)),
  onCommandFailed: (cb) => ipcRenderer.on('command:failed', (_e, info) => cb(info)),
})
