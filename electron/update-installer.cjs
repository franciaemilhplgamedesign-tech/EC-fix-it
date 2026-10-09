"use strict";

const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createWriteStream } = require("node:fs");
const { mkdtemp, open, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Transform, Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const MAX_UPDATE_SIZE = 500_000_000;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

const WINDOWS_UPDATE_SCRIPT = String.raw`param(
  [Parameter(Mandatory=$true)][string]$OldPath,
  [Parameter(Mandatory=$true)][string]$StagedPath,
  [Parameter(Mandatory=$true)][string]$NewPath,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][int]$AppProcessId,
  [Parameter(Mandatory=$true)][int]$PortableLauncherProcessId,
  [Parameter(Mandatory=$true)][string]$ScriptPath
)
$ErrorActionPreference = 'Stop'
$OldBackup = "$OldPath.update-backup-$AppProcessId"
$NewBackup = "$NewPath.update-backup-$AppProcessId"
$LogPath = "$env:TEMP\ec-fix-it-update-$AppProcessId.log"
$OldMoved = $false
$NewMoved = $false
try {
  if (Get-Process -Id $AppProcessId -ErrorAction SilentlyContinue) {
    Wait-Process -Id $AppProcessId -Timeout 120 -ErrorAction Stop
  }
  if ($PortableLauncherProcessId -gt 0 -and $PortableLauncherProcessId -ne $AppProcessId) {
    $Launcher = Get-CimInstance Win32_Process -Filter "ProcessId = $PortableLauncherProcessId" -ErrorAction SilentlyContinue
    if ($Launcher -and $Launcher.ExecutablePath -ieq $OldPath) {
      Wait-Process -Id $PortableLauncherProcessId -Timeout 120 -ErrorAction Stop
    }
  }
  if (-not (Test-Path -LiteralPath $StagedPath -PathType Leaf)) {
    throw 'The verified update file is missing.'
  }
  $ActualSha256 = (Get-FileHash -LiteralPath $StagedPath -Algorithm SHA256).Hash
  if ($ActualSha256 -ne $ExpectedSha256) {
    throw 'The staged update failed SHA-256 verification.'
  }
  if (Test-Path -LiteralPath $OldPath -PathType Leaf) {
    [System.IO.File]::Move($OldPath, $OldBackup)
    $OldMoved = $true
  }
  if (Test-Path -LiteralPath $NewPath -PathType Leaf) {
    [System.IO.File]::Move($NewPath, $NewBackup)
    $NewMoved = $true
  }
  [System.IO.File]::Move($StagedPath, $NewPath)
  $NewProcess = Start-Process -FilePath $NewPath -PassThru
  Start-Sleep -Seconds 3
  if ($NewProcess.HasExited) {
    throw 'The updated application closed immediately after launch.'
  }
  if ($OldMoved) { Remove-Item -LiteralPath $OldBackup -Force -ErrorAction SilentlyContinue }
  if ($NewMoved) { Remove-Item -LiteralPath $NewBackup -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath (Split-Path -Parent $ScriptPath) -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
} catch {
  if (Test-Path -LiteralPath $NewPath -PathType Leaf) {
    Remove-Item -LiteralPath $NewPath -Force
  }
  if ($NewMoved -and (Test-Path -LiteralPath $NewBackup -PathType Leaf)) {
    [System.IO.File]::Move($NewBackup, $NewPath)
  }
  if ($OldMoved -and (Test-Path -LiteralPath $OldBackup -PathType Leaf)) {
    [System.IO.File]::Move($OldBackup, $OldPath)
    Start-Process -FilePath $OldPath
  }
  Set-Content -LiteralPath $LogPath -Value $_.Exception.Message
  try {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
      ("EC fix-it could not finish updating. The prior executable was restored.{0}{0}{1}{0}{0}Details: {2}" -f [Environment]::NewLine, $_.Exception.Message, $LogPath),
      'EC fix-it update failed',
      'OK',
      'Warning'
    ) | Out-Null
  } catch {}
  Remove-Item -LiteralPath (Split-Path -Parent $ScriptPath) -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}`;

function isPortableExecutable(bytes) {
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    return false;
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  return (
    peOffset >= 64 &&
    peOffset + 4 <= bytes.length &&
    bytes.toString("ascii", peOffset, peOffset + 4) === "PE\u0000\u0000"
  );
}

async function downloadVerifiedUpdate(update, destinationDirectory, fetchImpl = fetch) {
  if (
    !update ||
    typeof update.downloadUrl !== "string" ||
    typeof update.assetName !== "string" ||
    !Number.isSafeInteger(update.assetSize) ||
    update.assetSize < 1 ||
    update.assetSize > MAX_UPDATE_SIZE ||
    typeof update.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(update.sha256)
  ) {
    throw new Error("The release is missing valid size or SHA-256 verification data.");
  }

  const downloadUrl = new URL(update.downloadUrl);
  if (
    downloadUrl.protocol !== "https:" ||
    downloadUrl.hostname !== "github.com" ||
    !downloadUrl.pathname.startsWith(
      "/franciaemilhplgamedesign-tech/EC-fix-it/releases/download/",
    )
  ) {
    throw new Error("The update download URL is not a trusted GitHub release URL.");
  }

  const response = await fetchImpl(downloadUrl.toString(), {
    headers: { "User-Agent": "EC-fix-it-update-installer" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    throw new Error("The update download failed with HTTP " + response.status + ".");
  }

  const resolvedUrl = new URL(response.url);
  if (
    resolvedUrl.protocol !== "https:" ||
    !ALLOWED_DOWNLOAD_HOSTS.has(resolvedUrl.hostname)
  ) {
    throw new Error("GitHub redirected the update to an untrusted download host.");
  }

  const stagedPath = path.join(
    destinationDirectory,
    "." + update.assetName + "." + process.pid + ".download",
  );
  const hash = createHash("sha256");
  let downloadedBytes = 0;
  let headerBytes = Buffer.alloc(0);
  const verifyStream = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length;
      if (downloadedBytes > update.assetSize || downloadedBytes > MAX_UPDATE_SIZE) {
        callback(new Error("The downloaded update exceeds its published size."));
        return;
      }
      if (headerBytes.length < 1_048_576) {
        headerBytes = Buffer.concat([
          headerBytes,
          chunk.subarray(0, 1_048_576 - headerBytes.length),
        ]);
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  let handle;
  try {
    handle = await open(stagedPath, "wx");
    await handle.close();
    await pipeline(
      Readable.fromWeb(response.body),
      verifyStream,
      createWriteStream(stagedPath, { flags: "w" }),
    );
    if (downloadedBytes !== update.assetSize) {
      throw new Error("The downloaded update size does not match the release metadata.");
    }
    if (!isPortableExecutable(headerBytes)) {
      throw new Error("The downloaded update is not a valid Windows executable.");
    }
    if (hash.digest("hex").toLowerCase() !== update.sha256.toLowerCase()) {
      throw new Error("The downloaded update failed SHA-256 verification.");
    }
    return stagedPath;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    try {
      await rm(stagedPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "The update download failed and its temporary file could not be removed.",
      );
    }
    throw error;
  }
}

async function createWindowsUpdateScript() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ec-fix-it-update-"));
  const scriptPath = path.join(directory, "install-update.ps1");
  try {
    await writeFile(scriptPath, WINDOWS_UPDATE_SCRIPT, {
      encoding: "utf8",
      flag: "wx",
    });
    return scriptPath;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function startWindowsUpdate(update, appExecutablePath, appProcessId) {
  if (process.platform !== "win32") {
    throw new Error("Automatic executable replacement is supported only on Windows.");
  }
  if (!path.isAbsolute(appExecutablePath) || path.extname(appExecutablePath).toLowerCase() !== ".exe") {
    throw new Error("The current portable executable path could not be determined.");
  }

  const directory = path.dirname(appExecutablePath);
  const stagedPath = await downloadVerifiedUpdate(update, directory);
  const newPath = path.join(
    directory,
    "EC fix-it " + update.latestVersion + ".exe",
  );

  let scriptPath;
  try {
    scriptPath = await createWindowsUpdateScript();
    await new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-OldPath",
          appExecutablePath,
          "-StagedPath",
          stagedPath,
          "-NewPath",
          newPath,
          "-ExpectedSha256",
          update.sha256,
          "-AppProcessId",
          String(appProcessId),
          "-PortableLauncherProcessId",
          String(process.ppid),
          "-ScriptPath",
          scriptPath,
        ],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.once("error", reject);
      child.once("spawn", resolve);
      child.unref();
    });
  } catch (error) {
    await rm(stagedPath, { force: true }).catch(() => {});
    if (scriptPath) {
      await rm(path.dirname(scriptPath), { recursive: true, force: true }).catch(
        () => {},
      );
    }
    throw error;
  }

  return { version: update.latestVersion, fileName: path.basename(newPath) };
}

module.exports = {
  MAX_UPDATE_SIZE,
  WINDOWS_UPDATE_SCRIPT,
  createWindowsUpdateScript,
  downloadVerifiedUpdate,
  isPortableExecutable,
  startWindowsUpdate,
};
