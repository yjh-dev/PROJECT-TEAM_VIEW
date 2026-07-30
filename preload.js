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
  // 실행 환경 — claude 설치·로그인, Figma 연결
  checkEnv: (opts) => ipcRenderer.invoke('env:check', opts),
  login: (what) => ipcRenderer.invoke('env:login', what),
  onEnv: (cb) => ipcRenderer.on('env:status', (_e, env) => cb(env)),
  listProjects: () => ipcRenderer.invoke('project:list'),
  sendCommand: (payload) => ipcRenderer.invoke('command:send', payload),
  // 클립보드는 메인 프로세스에 맡긴다. 샌드박스 preload에서는 electron의 clipboard가
  // 없어서(undefined) 직접 부르면 예외가 났다. navigator.clipboard도 file://에서는 막힌다.
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  cancelAll: (dir) => ipcRenderer.invoke('command:cancel', dir),
  // 이벤트에는 어느 프로젝트 것인지가 실려 온다. 렌더러는 보고 있는 것만 그린다.
  onEvents: (cb) => ipcRenderer.on('events:new', (_e, payload) => cb(payload)),
  onReset: (cb) => ipcRenderer.on('events:reset', (_e, payload) => cb(payload)),
  onStatus: (cb) => ipcRenderer.on('projects:status', (_e, status) => cb(status)),
})
