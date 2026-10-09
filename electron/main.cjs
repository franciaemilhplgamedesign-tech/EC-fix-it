"use strict";

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { checkForUpdate } = require("./update-checker.cjs");
const { startWindowsUpdate } = require("./update-installer.cjs");

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

ipcMain.handle("updates:install", async (event) => {
  assertTrustedSender(event);
  if (!app.isPackaged || process.platform !== "win32") {
    throw new Error("Automatic updates are available only in the packaged Windows app.");
  }
  const update = await checkForUpdate(app.getVersion());
  if (update.status !== "available") {
    throw new Error("There is no newer Windows executable to download.");
  }
  if (!update.sha256) {
    throw new Error(
      "This release does not publish a SHA-256 digest, so automatic installation was blocked. Republish it with a SHA-256 digest.",
    );
  }
  const executablePath = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!executablePath) {
    throw new Error(
      "The portable executable location is unavailable. Start EC fix-it from its portable .exe before updating.",
    );
  }

  const result = await startWindowsUpdate(update, executablePath, process.pid);
  setTimeout(() => app.quit(), 1000);
  return result;
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
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

    const filename = item.getFilename();
    const isProjectBundle = path.extname(filename).toLowerCase() === ".zip";
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: isProjectBundle ? "Save MIP Builder project" : "Save EC fix-it HTML",
      defaultPath: filename,
      buttonLabel: "Save file",
      filters: [
        isProjectBundle
          ? { name: "ZIP archives", extensions: ["zip"] }
          : { name: "HTML files", extensions: ["html", "htm"] },
      ],
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
