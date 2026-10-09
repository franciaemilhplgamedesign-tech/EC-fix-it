"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ecFixIt", {
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  getChangelog: () => ipcRenderer.invoke("app:get-changelog"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
});
