// 렌더러에 노출하는 최소 API. 렌더러는 Node에 직접 닿지 않는다(contextIsolation).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('teamView', {
  pickProject: () => ipcRenderer.invoke('project:pick'),
  sendCommand: (payload) => ipcRenderer.invoke('command:send', payload),
  currentProject: () => ipcRenderer.invoke('project:current'),
  onEvents: (cb) => ipcRenderer.on('events:new', (_e, events) => cb(events)),
  onReset: (cb) => ipcRenderer.on('events:reset', () => cb()),
  onStatus: (cb) => ipcRenderer.on('watch:status', (_e, status) => cb(status)),
})
