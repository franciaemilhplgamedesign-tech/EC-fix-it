"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { checkForUpdate } = require("./update-checker.cjs");

function assertTrustedSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !frame.url.startsWith("file:")) {
    throw new Error("Update requests must come from the EC fix-it app window.");
  }

  const sourcePath = path.resolve(fileURLToPath(frame.url));
  const appPagePath = path.resolve(__dirname, "..", "index.html");
  if (sourcePath !== appPagePath) {
    throw new Error("Update requests must come from the EC fix-it app window.");
  }
}

ipcMain.handle("app:get-version", (event) => {
  assertTrustedSender(event);
  return app.getVersion();
});

ipcMain.handle("app:get-changelog", async (event) => {
  assertTrustedSender(event);
  return fs.readFile(path.join(__dirname, "..", "CHANGELOG.md"), "utf8");
});

ipcMain.handle("updates:check", async (event) => {
  assertTrustedSender(event);
  return checkForUpdate(app.getVersion());
});

ipcMain.handle("updates:download", async (event) => {
  assertTrustedSender(event);
  const update = await checkForUpdate(app.getVersion());
  if (update.status !== "available") {
    throw new Error("There is no newer Windows executable to download.");
  }
  await shell.openExternal(update.downloadUrl);
  return { version: update.latestVersion };
});

function createWindow() {
  const window = new BrowserWindow({
    width: 960,
    height: 800,
    minWidth: 360,
    minHeight: 560,
    title: "EC fix-it",
    backgroundColor: "#f7f7f5",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      preload: path.join(__dirname, "preload.cjs"),
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
