# EC fix-it

A desktop tool for single-file MIP HTML exports. It repairs embedded End Cards
and can add or replace an End Card using a separate SIP HTML file. Selected
files are read and processed on the user's computer; they are never uploaded.
The app is branded EC fix-it, uses the supplied light and dark logos, and
supports black-and-white light and dark themes with subtle yellow accents.
The system appearance is used as the default until a theme is selected.

The checker stores static End Cards in a compressed, Base64 payload inside an
iframe `srcdoc` loader, avoiding `data:` navigations that can be blocked by
embedded browsers. Large cards are gzip-compressed to reduce output size. The
checker makes the End Card full-screen and clickable, routes taps through
`mraid.open`, and logs `CTA_CLICKED`. A runtime adapter covers MIPs that create
their iframe dynamically or use an unrecognized source format. `window.open`
calls are rewritten to the MRAID click bridge.

The **Add SIP End Card** tab accepts a MIP and a SIP HTML file. If the MIP has
a single HTML End Card placeholder (`srcDoc` or an iframe `srcdoc` attribute),
the SIP replaces that placeholder in place. For a static End Card variable,
the existing embedded HTML is replaced at its declaration so it is not left
in the output alongside the new SIP. The MIP's display timing and layout are
preserved. Multiple placeholders are rejected as ambiguous. If there is no
placeholder, the SIP is added as a full-screen Base64-backed iframe overlay.

The **MIP Builder** tab embeds the Template Builder for designing scenes,
placing interactive elements, previewing common device sizes, importing
templates, and exporting a single HTML file or a project ZIP. Its standalone
page is bundled locally as `mip-builder.html`; it does not require a network
connection or a separate runtime.

Both repair and injection enforce a hard output limit of 5 MB
(5,000,000 bytes). Oversized output is rejected before download.

## Build the Windows executable

Install dependencies and build the portable, 64-bit Windows executable:

```bash
npm install
npm run dist:win
```

The finished `EC fix-it-1.0.5-win-x64.exe` is written to `release/`.
It is a self-contained portable desktop app and does not require a separate
Node.js installation.

## Check for updates

In the Windows app, use **Check for updates** at the bottom of the window.
The checker compares the installed version with the latest stable GitHub
release in `franciaemilhplgamedesign-tech/End-Card-Checker`. When a newer
version is available, **Download** opens its verified portable Windows
executable in the browser. Close EC fix-it before replacing the old executable.

Each published release must use a version tag (for example,
`ec-fix-it-v1.0.5`) and include an asset named
`EC fix-it-X.Y.Z-win-x64.exe`. The checker reports when no release or matching
executable has been published yet. After changing the app version in
`package.json`, rebuild the portable executable before attaching it to the
matching GitHub release.

The update checker accepts both `EC fix-it-X.Y.Z-win-x64.exe` and
`EC.fix-it-X.Y.Z-win-x64.exe` asset naming and validates downloads against the
canonical `EC-fix-it` repository URL.

Release notes are maintained in [CHANGELOG.md](./CHANGELOG.md) and can be
opened from the app's bottom-right **Changelog** link.

For development, run `npm start`. To open the checker in a browser, open
`index.html` directly.

## Test

The built-in tests use the Node.js test runner:

```bash
node --test
```

The checker supports React `srcDoc` properties, runtime `iframe.srcdoc`
assignments, existing HTML data URLs, static HTML and dynamically generated
HTML. It does not need to recognize each MIP's existing CTA handler: the
injected adapter captures End Card taps, forwards them to the parent MRAID
bridge, and enforces a full-screen frame.
