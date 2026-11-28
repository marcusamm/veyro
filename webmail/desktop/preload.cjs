'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('veyroDesktop', Object.freeze({
  invoke: (action, payload) => ipcRenderer.invoke('veyro:shell', action, payload),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('veyro:state', listener);
    return () => ipcRenderer.removeListener('veyro:state', listener);
  },
  onAdd: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('veyro:open-add', listener);
    return () => ipcRenderer.removeListener('veyro:open-add', listener);
  },
}));
