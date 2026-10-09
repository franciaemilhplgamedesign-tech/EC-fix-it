"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { mkdtemp, readdir, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  WINDOWS_UPDATE_SCRIPT,
  downloadVerifiedUpdate,
  isPortableExecutable,
} = require("../electron/update-installer.cjs");

function createPortableExecutable() {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\u0000\u0000", 64, "binary");
  return bytes;
}

function createFetchResponse(bytes, resolvedUrl = "https://release-assets.githubusercontent.com/update.exe") {
  return async (url, options) => {
    assert.equal(
      url,
      "https://github.com/franciaemilhplgamedesign-tech/EC-fix-it/releases/download/v1.2.3/EC%20fix-it%201.2.3.exe",
    );
    assert.equal(options.headers["User-Agent"], "EC-fix-it-update-installer");
    return {
      ok: true,
      status: 200,
      url: resolvedUrl,
      body: Readable.toWeb(Readable.from([bytes])),
    };
  };
}

function createUpdate(bytes, overrides = {}) {
  const { createHash } = require("node:crypto");
  return {
    downloadUrl:
      "https://github.com/franciaemilhplgamedesign-tech/EC-fix-it/releases/download/v1.2.3/EC%20fix-it%201.2.3.exe",
    assetName: "EC fix-it 1.2.3.exe",
    assetSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...overrides,
  };
}

test("recognizes only files with a Windows MZ and PE signature", () => {
  const validExecutable = createPortableExecutable();
  assert.equal(isPortableExecutable(validExecutable), true);
  assert.equal(isPortableExecutable(Buffer.from("not an executable")), false);

  const malformedExecutable = Buffer.from(validExecutable);
  malformedExecutable.write("NOPE", 64, "ascii");
  assert.equal(isPortableExecutable(malformedExecutable), false);
});

test("downloads an update only after validating size, hash, and PE signature", async () => {
  const bytes = createPortableExecutable();
  const directory = await mkdtemp(path.join(os.tmpdir(), "ec-fix-it-installer-test-"));
  try {
    const stagedPath = await downloadVerifiedUpdate(
      createUpdate(bytes),
      directory,
      createFetchResponse(bytes),
    );
    assert.equal(path.dirname(stagedPath), directory);
    assert.deepEqual(await readdir(directory), [path.basename(stagedPath)]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes incomplete downloads when published size or digest does not match", async () => {
  const bytes = createPortableExecutable();
  const directory = await mkdtemp(path.join(os.tmpdir(), "ec-fix-it-installer-test-"));
  try {
    await assert.rejects(
      downloadVerifiedUpdate(
        createUpdate(bytes, { assetSize: bytes.length + 1 }),
        directory,
        createFetchResponse(bytes),
      ),
      /size does not match/,
    );
    await assert.rejects(
      downloadVerifiedUpdate(
        createUpdate(bytes, { sha256: "0".repeat(64) }),
        directory,
        createFetchResponse(bytes),
      ),
      /SHA-256 verification/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects untrusted redirects and invalid executable data", async () => {
  const bytes = createPortableExecutable();
  const directory = await mkdtemp(path.join(os.tmpdir(), "ec-fix-it-installer-test-"));
  try {
    await assert.rejects(
      downloadVerifiedUpdate(
        createUpdate(bytes),
        directory,
        createFetchResponse(bytes, "https://example.com/update.exe"),
      ),
      /untrusted download host/,
    );
    await assert.rejects(
      downloadVerifiedUpdate(
        createUpdate(Buffer.from("not an executable")),
        directory,
        createFetchResponse(Buffer.from("not an executable")),
      ),
      /not a valid Windows executable/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the replacement helper verifies the staged file and rolls back on failure", () => {
  assert.match(WINDOWS_UPDATE_SCRIPT, /Wait-Process -Id \$AppProcessId/);
  assert.match(WINDOWS_UPDATE_SCRIPT, /PortableLauncherProcessId/);
  assert.match(WINDOWS_UPDATE_SCRIPT, /Get-FileHash .*SHA256/);
  assert.match(WINDOWS_UPDATE_SCRIPT, /update-backup-/);
  assert.match(WINDOWS_UPDATE_SCRIPT, /Start-Process -FilePath \$OldPath/);
});
