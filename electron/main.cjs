"use strict";

const { app, BrowserWindow, dialog } = require("electron");
const path = require("node:path");

function createWindow() {
  const window = new BrowserWindow({
    width: 960,
    height: 800,
    minWidth: 360,
    minHeight: 560,
    title: "EC fix-it",
    backgroundColor: "#f5f6f4",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });

  window.webContents.on("will-download", async (event, item) => {
    item.pause();

    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: "Save fixed End Card HTML",
      defaultPath: item.getFilename(),
      buttonLabel: "Save fixed file",
      filters: [{ name: "HTML files", extensions: ["html", "htm"] }],
    });

    if (canceled || !filePath) {
      item.cancel();
      return;
    }

    item.setSavePath(filePath);
    item.resume();
  });

  void window.loadFile(path.join(__dirname, "..", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
