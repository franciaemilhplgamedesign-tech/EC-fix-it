# Changelog

## 1.0.6 — 2026-10-09

- Renamed portable builds to `EC fix-it 1.x.x.exe`.
- Added verified automatic updates that download beside the current
  executable, verify the published size, SHA-256, and Windows executable
  signature, then replace and relaunch with rollback on failure.

## 1.0.5 — 2026-10-09

- Fixed update detection for the renamed public `EC-fix-it` repository.
- Accepted the published `EC.fix-it-X.Y.Z-win-x64.exe` asset name alongside
  the existing `EC fix-it-X.Y.Z-win-x64.exe` format.

## 1.0.4 — 2026-10-09

- Integrated the Template Builder in the MIP Builder tab, including editing,
  device preview, asset management, template import, and HTML/project export.
- Synced the builder theme with EC fix-it and matched its monochrome palette
  with subtle yellow accents.
- Kept the main header and tool tabs at their standard width when opening the
  MIP Builder and themed its scrollbars for light and dark modes.
- Removed the builder's duplicate theme button and added the in-app changelog
  and MIP Builder tab.

## 1.0.3 — 2026-10-07

- Added this in-app changelog, displayed in a modal from the bottom-right link.
- Updated the updater to recognize EC fix-it release tags such as
  `ec-fix-it-v1.0.2`.

## 1.0.2 — 2026-09

- Added a GitHub release update checker and installed-version display.
- Added a verified download flow for newer portable Windows builds.
- Improved End Card repair and SIP replacement, including compressed Base64
  payload handling and the 5 MB output limit.
- Added light and dark themes and EC fix-it branding.

## 1.0.1 — 2026-09

- Added the initial EC fix-it branding and theme refinements.
- Improved End Card repair and SIP injection workflows.
