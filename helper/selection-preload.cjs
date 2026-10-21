const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshOrb', {
  selection: {
    search() {
      ipcRenderer.send('orb:selection-action', { action: 'search' })
    },
    translate() {
      ipcRenderer.send('orb:selection-action', { action: 'translate' })
    },
    sendToAgent() {
      ipcRenderer.send('orb:selection-action', { action: 'send' })
    },
    setLanguage(language) {
      ipcRenderer.send('orb:selection-action', { action: 'language', language })
    },
    setContentSize(size) {
      return ipcRenderer.invoke('orb:selection-size', size)
    },
    onState(callback) {
      ipcRenderer.on('orb:selection-state', (_event, state) => callback(state))
    },
    onAppearance(callback) {
      ipcRenderer.on('orb:appearance', (_event, appearance) => callback(appearance))
    },
  },
})
