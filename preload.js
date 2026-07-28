// 렌더러에 노출하는 최소 API. 렌더러는 Node에 직접 닿지 않는다(contextIsolation).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('teamView', {
  pickProject: () => ipcRenderer.invoke('project:pick'),
  sendCommand: (payload) => ipcRenderer.invoke('command:send', payload),
  // 클립보드는 메인 프로세스에 맡긴다. 샌드박스 preload에서는 electron의 clipboard가
  // 없어서(undefined) 직접 부르면 예외가 났다. navigator.clipboard도 file://에서는 막힌다.
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  cancelAll: () => ipcRenderer.invoke('command:cancel'),
  currentProject: () => ipcRenderer.invoke('project:current'),
  onEvents: (cb) => ipcRenderer.on('events:new', (_e, events) => cb(events)),
  onReset: (cb) => ipcRenderer.on('events:reset', () => cb()),
  onStatus: (cb) => ipcRenderer.on('watch:status', (_e, status) => cb(status)),
})
