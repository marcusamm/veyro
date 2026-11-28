'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('veyroMail', Object.freeze({
  invoke: (action, payload) => ipcRenderer.invoke('veyro:mail', action, payload),
}));
