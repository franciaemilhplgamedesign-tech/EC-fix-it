"use strict";

const RELEASES_API =
  "https://api.github.com/repos/franciaemilhplgamedesign-tech/EC-fix-it/releases/latest";
const RELEASE_DOWNLOAD_PREFIX =
  "/franciaemilhplgamedesign-tech/EC-fix-it/releases/download/";

function parseVersion(version) {
  const match = /^(?:ec-fix-it-)?v?(\d+)\.(\d+)\.(\d+)$/i.exec(version);
  if (!match) {
    throw new Error("The app or release has an unsupported version format.");
  }
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

function validateDownloadUrl(asset, expectedNames) {
  if (
    !asset ||
    !expectedNames.includes(asset.name) ||
    typeof asset.browser_download_url !== "string"
  ) {
    throw new Error(
      "A newer release was found, but its portable Windows executable is missing.",
    );
  }

  const downloadUrl = new URL(asset.browser_download_url);
  const fileName = decodeURIComponent(downloadUrl.pathname.split("/").pop());
  if (
    downloadUrl.protocol !== "https:" ||
    downloadUrl.hostname !== "github.com" ||
    !downloadUrl.pathname.startsWith(RELEASE_DOWNLOAD_PREFIX) ||
    fileName !== asset.name
  ) {
    throw new Error("The release download link is invalid.");
  }
  return downloadUrl.toString();
}

async function checkForUpdate(currentVersion, fetchImpl = fetch) {
  parseVersion(currentVersion);
  const response = await fetchImpl(RELEASES_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "EC-fix-it-update-checker",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (response.status === 404) {
    return { status: "no-release", currentVersion };
  }
  if (!response.ok) {
    throw new Error(
      "GitHub release check failed with HTTP " + response.status + ".",
    );
  }

  const release = await response.json();
  if (!release || typeof release.tag_name !== "string" || !Array.isArray(release.assets)) {
    throw new Error("GitHub returned release data in an unsupported format.");
  }

  const latestVersion = parseVersion(release.tag_name).join(".");
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return { status: "current", currentVersion, latestVersion };
  }

  const expectedNames = [
    "EC fix-it " + latestVersion + ".exe",
    "EC fix-it " + latestVersion + "-win-x64.exe",
    "EC fix-it-" + latestVersion + "-win-x64.exe",
    "EC.fix-it-" + latestVersion + "-win-x64.exe",
  ];
  const asset = release.assets.find(
    (item) => item && expectedNames.includes(item.name),
  );
  const downloadUrl = validateDownloadUrl(asset, expectedNames);
  return {
    status: "available",
    currentVersion,
    latestVersion,
    assetName: asset.name,
    assetSize: asset.size,
    sha256: typeof asset.digest === "string"
      ? asset.digest.replace(/^sha256:/i, "")
      : null,
    downloadUrl,
  };
}

module.exports = { checkForUpdate, compareVersions };
