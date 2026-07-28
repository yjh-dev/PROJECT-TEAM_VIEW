// 렌더러에 노출하는 최소 API. 렌더러는 Node에 직접 닿지 않는다(contextIsolation).
const { contextBridge, ipcRenderer, clipboard } = require('electron')

contextBridge.exposeInMainWorld('teamView', {
  pickProject: () => ipcRenderer.invoke('project:pick'),
  sendCommand: (payload) => ipcRenderer.invoke('command:send', payload),
  // 클립보드는 Electron 모듈을 쓴다. navigator.clipboard는 file:// 이 보안 컨텍스트가
  // 아니라 막히는 경우가 있어서, 렌더러에서 직접 부르지 않는다.
  copyText: (text) => {
    clipboard.writeText(String(text ?? ''))
    return true
  },
  currentProject: () => ipcRenderer.invoke('project:current'),
  onEvents: (cb) => ipcRenderer.on('events:new', (_e, events) => cb(events)),
  onReset: (cb) => ipcRenderer.on('events:reset', () => cb()),
  onStatus: (cb) => ipcRenderer.on('watch:status', (_e, status) => cb(status)),
})
