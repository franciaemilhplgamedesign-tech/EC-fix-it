"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { checkForUpdate, compareVersions } = require("../electron/update-checker.cjs");

function createFetchResponse(status, body) {
  return async (url, options) => {
    assert.equal(
      url,
      "https://api.github.com/repos/franciaemilhplgamedesign-tech/End-Card-Checker/releases/latest",
    );
    assert.equal(options.headers.Accept, "application/vnd.github+json");
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  };
}

test("compares three-part app versions numerically", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("ec-fix-it-v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.2", "1.2.3"), -1);
});

test("reports a newer release with the matching portable Windows asset", async () => {
  const result = await checkForUpdate(
    "1.0.0",
    createFetchResponse(200, {
      tag_name: "ec-fix-it-v1.2.0",
      assets: [
        {
          name: "EC fix-it-1.2.0-win-x64.exe",
          browser_download_url:
            "https://github.com/franciaemilhplgamedesign-tech/End-Card-Checker/releases/download/ec-fix-it-v1.2.0/EC%20fix-it-1.2.0-win-x64.exe",
        },
      ],
    }),
  );

  assert.deepEqual(result, {
    status: "available",
    currentVersion: "1.0.0",
    latestVersion: "1.2.0",
    downloadUrl:
      "https://github.com/franciaemilhplgamedesign-tech/End-Card-Checker/releases/download/ec-fix-it-v1.2.0/EC%20fix-it-1.2.0-win-x64.exe",
  });
});

test("reports the app as current when the latest version is not newer", async () => {
  const result = await checkForUpdate(
    "1.2.0",
    createFetchResponse(200, { tag_name: "v1.2.0", assets: [] }),
  );
  assert.deepEqual(result, {
    status: "current",
    currentVersion: "1.2.0",
    latestVersion: "1.2.0",
  });
});

test("recognizes the EC fix-it release tag for the installed version", async () => {
  const result = await checkForUpdate(
    "1.0.2",
    createFetchResponse(200, { tag_name: "ec-fix-it-v1.0.2", assets: [] }),
  );
  assert.deepEqual(result, {
    status: "current",
    currentVersion: "1.0.2",
    latestVersion: "1.0.2",
  });
});

test("reports when there is no published GitHub release", async () => {
  const result = await checkForUpdate(
    "1.0.0",
    createFetchResponse(404, null),
  );
  assert.deepEqual(result, { status: "no-release", currentVersion: "1.0.0" });
});

test("rejects a newer release without the expected portable executable", async () => {
  await assert.rejects(
    checkForUpdate(
      "1.0.0",
      createFetchResponse(200, {
        tag_name: "v1.1.0",
        assets: [{ name: "source.zip", browser_download_url: "https://example.com/source.zip" }],
      }),
    ),
    /portable Windows executable is missing/,
  );
});

test("rejects an executable download hosted outside the expected GitHub release", async () => {
  await assert.rejects(
    checkForUpdate(
      "1.0.0",
      createFetchResponse(200, {
        tag_name: "v1.1.0",
        assets: [
          {
            name: "EC fix-it-1.1.0-win-x64.exe",
            browser_download_url: "https://example.com/EC-fix-it.exe",
          },
        ],
      }),
    ),
    /release download link is invalid/,
  );
});

test("rejects malformed release versions and GitHub errors", async () => {
  await assert.rejects(
    checkForUpdate("1.0.0", createFetchResponse(200, { tag_name: "latest", assets: [] })),
    /unsupported version format/,
  );
  await assert.rejects(
    checkForUpdate("1.0.0", createFetchResponse(503, null)),
    /HTTP 503/,
  );
});
