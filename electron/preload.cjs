"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ecFixIt", {
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  openUpdateDownload: () => ipcRenderer.invoke("updates:download"),
});
