"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { gunzipSync, gzipSync } = require("node:zlib");
const { randomBytes } = require("node:crypto");
const { inspectHtml, transformHtml, injectSipHtml } = require("../checker.js");

function decodeCompressedEndCard(source, variableName) {
  const expression = new RegExp(
    "\\b" +
      variableName +
      "\\s*[:=]\\s*(\"(?:\\\\.|[^\"\\\\])*\")",
  );
  const match = source.match(expression);
  assert.ok(match, "expected an embedded compressed End Card document");
  return decodeCompressedBootstrap(vm.runInNewContext(match[1]));
}

function decodeCompressedBootstrap(bootstrap) {
  const match = bootstrap.match(/atob\("([^"]+)"\)/);
  assert.ok(match, "expected a gzip payload in the Base64 bootstrap");
  return gunzipSync(Buffer.from(match[1], "base64")).toString("utf8");
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function verifyRuntimeScript(source) {
  const match = source.match(
    /<script id="ecc-runtime-fixer">([\s\S]*?)<\/script>/,
  );
  assert.ok(match, "expected the runtime compatibility layer");
  new vm.Script(match[1]);
}

test("converts a static End Card template to Base64 with a full-screen click bridge", async () => {
  const source =
    'const card=`<!doctype html><html><body><p>End Card café</p><script>window.open("/sale")</script></body></html>`,App=()=>jsx("iframe",{srcDoc:card,title:"End Scene",style:{position:"fixed",inset:0,width:"100vw",height:"100vh",border:0}});';

  const inspection = inspectHtml(source);
  assert.equal(inspection.kind, "raw-srcdoc");

  const fixed = await transformHtml(source);
  const payload = decodeCompressedEndCard(fixed, "card");
  assert.match(fixed, /srcDoc:card/);
  assert.match(fixed, /ecc-compressed-end-card/);
  assert.doesNotMatch(fixed, /src:\s*card/);
  assert.match(fixed, /data-ecc-end-card-ready/);
  assert.match(payload, /End Card café/);
  assert.match(payload, /window\.__eccOpen/);
  assert.match(payload, /data-ecc-click-bridge/);
  assert.doesNotMatch(fixed, /\bwindow\s*\.\s*open\s*\(/i);
  assert.doesNotMatch(fixed, /opacity:1!important|pointer-events:auto!important/);
  assert.deepEqual(
    {
      base64: inspectHtml(fixed).kind === "base64-src",
      fullScreen: inspectHtml(fixed).isFullScreen,
      mraid: inspectHtml(fixed).hasMraidOpen,
      log: inspectHtml(fixed).hasCtaLog,
      noWindowOpen: inspectHtml(fixed).hasNoWindowOpen,
    },
    { base64: true, fullScreen: true, mraid: true, log: true, noWindowOpen: true },
  );
  verifyRuntimeScript(fixed);
});

test("converts runtime-decoded srcDoc values through the runtime adapter", async () => {
  const source =
    'const decoded=readCard(payload),App=()=>jsx("iframe",{srcDoc:decoded,title:"End Scene"});';

  const fixed = await transformHtml(source);

  assert.match(fixed, /srcDoc:window\.__eccDocument\(\(decoded\)\)/);
  assert.match(fixed, /window\.__eccDocument=toDocument/);
  assert.doesNotMatch(fixed, /src:\s*window\.__eccDataUrl/i);
  verifyRuntimeScript(fixed);
});

test("converts dynamic template End Cards without rejecting interpolations", async () => {
  const source =
    'const card=`<html><body>${dynamicEndCard}</body></html>`,App=()=>jsx("iframe",{srcDoc:card});';

  const fixed = await transformHtml(source);

  assert.match(fixed, /srcDoc:window\.__eccDocument\(\(card\)\)/);
});

test("converts a static End Card behind an alias and an older runtime wrapper", async () => {
  const existingAdapter =
    '<script id="ecc-runtime-fixer">(function(){var token="0123456789abcdef0123456789abcdef";})();</script>';
  const source =
    existingAdapter +
    'var Me=`<!doctype html><html><head><title>SIP Template [HPL]</title></head><body>Static SIP</body></html>`,Le=Me;function App(){return jsx("iframe",{src:window.__eccDataUrl((Le))})}';

  assert.equal(inspectHtml(source).kind, "raw-srcdoc");
  const fixed = await transformHtml(source);

  assert.match(fixed, /var Me="\\x3c!doctype html/);
  assert.match(fixed, /srcDoc:Le/);
  assert.doesNotMatch(fixed, /<title>SIP Template \[HPL\]<\/title>/);
  const payload = decodeCompressedEndCard(fixed, "Me");
  assert.match(payload, /SIP Template \[HPL\]/);
});

test("upgrades an older compressed data-URL End Card to a srcdoc loader", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const compressed = gzipSync(
    "<!doctype html><html><body>Legacy End Card</body></html>",
  );
  const payload = compressed.toString("base64");
  const bootstrap =
    '<!doctype html><meta charset="utf-8"><meta name="ecc-compressed-end-card" content="base64-gzip"><script>(async function(){var bytes=Uint8Array.from(atob("' +
    payload +
    '"),function(c){return c.charCodeAt(0)});var html=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();document.open();document.write(html);document.close()})();</script>';
  const legacyUrl = "data:text/html," + encodeURIComponent(bootstrap);
  const source =
    '<script id="ecc-runtime-fixer">(function(){var token="' +
    token +
    '";})();</script><html><body><script>var Me=' +
    JSON.stringify(legacyUrl) +
    ',Le=Me;jsx("iframe",{src:Le,"data-ecc-end-card":true,"data-ecc-end-card-ready":true})</script></body></html>';

  assert.equal(inspectHtml(source).needsRepair, true);
  const fixed = await transformHtml(source);

  assert.equal(inspectHtml(fixed).needsRepair, false);
  assert.match(fixed, /srcDoc:Le/);
  assert.match(fixed, /name=\\"ecc-compressed-end-card\\"/);
  assert.doesNotMatch(fixed, /src:data:text\/html/);
  assert.match(fixed, /id="ecc-runtime-fixer"/);
  assert.match(decodeCompressedEndCard(fixed, "Me"), /Legacy End Card/);
  verifyRuntimeScript(fixed);
});

test("handles runtime assignment to lowercase iframe.srcdoc", async () => {
  const source =
    '<!doctype html><html><head></head><body><script>function mount(frame,html){frame.srcdoc=html}</script></body></html>';

  assert.equal(inspectHtml(source).kind, "raw-srcdoc");
  const fixed = await transformHtml(source);

  assert.match(fixed, /frame\.srcdoc=window\.__eccFrameDocument\(frame,\(html\)\)/);
  verifyRuntimeScript(fixed);
});

test("replaces a raw srcdoc attribute with a compressed Base64 loader document", async () => {
  const source =
    '<!doctype html><html><body><iframe srcdoc="&lt;html&gt;&lt;body&gt;SIP&lt;/body&gt;&lt;/html&gt;"></iframe></body></html>';
  const fixed = await transformHtml(source);

  assert.match(fixed, /\bsrcdoc\s*=/i);
  assert.doesNotMatch(fixed, /\bsrc\s*=\s*["']data:text\/html,/i);
  assert.match(fixed, /data-ecc-end-card-ready="true"/);
  const attribute = fixed.match(/srcdoc="([^"]*)"/i)[1];
  const bootstrap = decodeHtmlAttribute(attribute);
  const payload = decodeCompressedBootstrap(bootstrap);
  assert.match(payload, /SIP/);
});

test("does not require a recognized MRAID handler in unknown MIP formats", async () => {
  const source =
    '<!doctype html><html><head></head><body><script>function makeEndCard(frame,html){frame.srcdoc=html;}</script></body></html>';
  const fixed = await transformHtml(source);
  const inspection = inspectHtml(fixed);

  assert.equal(inspection.kind, "base64-src");
  assert.equal(inspection.isFullScreen, true);
  assert.equal(inspection.hasMraidOpen, true);
  assert.equal(inspection.hasCtaLog, true);
  assert.equal(inspection.hasNoWindowOpen, true);
});

test("runtime bridge captures End Card taps and opens through parent MRAID", async () => {
  const fixed = await transformHtml("<!doctype html><html><head></head><body></body></html>");
  const scriptMatch = fixed.match(
    /<script id="ecc-runtime-fixer">([\s\S]*?)<\/script>/,
  );
  const script = scriptMatch[1];
  const token = script.match(/var token="([a-f\d]+)"/)[1];
  const messages = {};
  const logs = [];
  const opened = [];
  const parentWindow = {
    mraid: { open: (url) => opened.push(url) },
    clickTag: "https://example.test/store",
    addEventListener: (name, callback) => {
      messages[name] = callback;
    },
  };
  const document = {
    head: { appendChild: () => {} },
    documentElement: { querySelectorAll: () => [] },
    createElement: () => ({}),
  };
  class FakeMutationObserver {
    observe() {}
  }
  class FakeIFrameElement {}
  const context = {
    window: parentWindow,
    document,
    HTMLIFrameElement: FakeIFrameElement,
    MutationObserver: FakeMutationObserver,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    console: { log: (...args) => logs.push(args) },
  };

  vm.runInNewContext(script, context);
  messages.message({
    data: {
      type: "ecc-end-card-click",
      token,
      url: "",
    },
  });

  assert.deepEqual(logs, [["CTA_CLICKED"]]);
  assert.deepEqual(opened, ["https://example.test/store"]);
});

test("detects existing Base64 HTML iframe data sources", async () => {
  const source =
    'const image="/cover.png",card="data:text/html;base64,PGh0bWw+PC9odG1sPg==";jsx("img",{src:image});jsx("iframe",{src:card});';

  assert.equal(inspectHtml(source).kind, "base64-src");
  const fixed = await transformHtml(source);
  assert.equal(inspectHtml(fixed).kind, "base64-src");
});

test("injects a SIP into a no-End-Card MIP as an immediate Base64 overlay", async () => {
  const mip =
    '<!doctype html><html><head></head><body><main id="game">Game</main></body></html>';
  const sip = `<!doctype html><html><body><button onclick="window.open('/store')">Shop</button></body></html>`;

  const fixed = await injectSipHtml(mip, sip);
  const match = fixed.match(
    /id="ecc-injected-end-card"[^>]+srcdoc="([^"]+)"/,
  );
  assert.ok(match, "expected an injected Base64 iframe");

  const payload = decodeCompressedBootstrap(decodeHtmlAttribute(match[1]));
  assert.match(payload, /window\.__eccOpen/);
  assert.match(payload, /data-ecc-click-bridge/);
  assert.match(fixed, /z-index:2147483647/);
  assert.equal(inspectHtml(fixed).kind, "base64-src");
  assert.equal(inspectHtml(fixed).isFullScreen, true);
  assert.equal(inspectHtml(fixed).hasMraidOpen, true);
  assert.equal(inspectHtml(fixed).hasCtaLog, true);
  assert.equal(inspectHtml(fixed).hasNoWindowOpen, true);
  assert.doesNotMatch(fixed, /src="data:text\/html,/);
  verifyRuntimeScript(fixed);
});

test("replaces a React srcDoc placeholder with the SIP and preserves its display logic", async () => {
  const mip =
    'const App=({active})=>jsx("iframe",{ref:frame,srcDoc:placeholder,title:"End Scene",style:{opacity:active?1:0,pointerEvents:active?"auto":"none"}});';
  const sip = "<!doctype html><html><body><main>Replacement SIP</main></body></html>";

  const fixed = await injectSipHtml(mip, sip);

  assert.match(fixed, /srcDoc:"\\x3c!doctype html/);
  assert.match(fixed, /"data-ecc-end-card":true/);
  assert.match(fixed, /"data-ecc-end-card-ready":true/);
  assert.match(fixed, /title:"End Scene"/);
  assert.match(fixed, /opacity:active\?1:0,pointerEvents:active\?"auto":"none"/);
  assert.doesNotMatch(fixed, /id="ecc-injected-end-card"/);
  assert.match(decodeCompressedEndCard(fixed, "srcDoc"), /Replacement SIP/);
  assert.equal(inspectHtml(fixed).kind, "base64-src");
  assert.equal(inspectHtml(fixed).isFullScreen, true);
  assert.equal(inspectHtml(fixed).hasMraidOpen, true);
  assert.equal(inspectHtml(fixed).hasCtaLog, true);
  assert.equal(inspectHtml(fixed).hasNoWindowOpen, true);
});

test("replaces the static End Card variable instead of leaving the old SIP in the MIP", async () => {
  const oldSip =
    "<!doctype html><html><head><title>Old SIP</title></head><body>" +
    "Old creative content ".repeat(2_000) +
    "</body></html>";
  const mip =
    'const oldCard=`' +
    oldSip +
    '`,App=()=>jsx("iframe",{srcDoc:oldCard,title:"End Scene",style:{opacity:active?1:0}});';
  const sip =
    "<!doctype html><html><head><title>New SIP</title></head><body>Replacement creative</body></html>";

  const fixed = await injectSipHtml(mip, sip);

  assert.match(fixed, /srcDoc:oldCard/);
  assert.match(fixed, /title:"End Scene"/);
  assert.doesNotMatch(fixed, /Old creative content/);
  assert.doesNotMatch(fixed, /<title>Old SIP<\/title>/);
  assert.match(decodeCompressedEndCard(fixed, "oldCard"), /Replacement creative/);
  assert.ok(Buffer.byteLength(fixed) < 5_000_000);
});

test("replaces a legacy data-URL End Card source in an MIP with the new SIP", async () => {
  const mip =
    'var oldCard="data:text/html;base64,PGh0bWw+PC9odG1sPg==",alias=oldCard;const App=()=>jsx("iframe",{src:alias,title:"End Scene"});';
  const sip = "<!doctype html><html><body><main>Replacement SIP</main></body></html>";

  const fixed = await injectSipHtml(mip, sip);

  assert.match(fixed, /srcDoc:alias/);
  assert.match(fixed, /title:"End Scene"/);
  assert.doesNotMatch(fixed, /oldCard="data:text\/html;base64,/);
  assert.match(decodeCompressedEndCard(fixed, "oldCard"), /Replacement SIP/);
  assert.equal(inspectHtml(fixed).kind, "base64-src");
});

test("replaces an HTML iframe srcdoc placeholder with the SIP", async () => {
  const mip = '<html><body><iframe id="end-card" srcdoc="<p>Placeholder</p>" title="End Scene"></iframe></body></html>';
  const sip = "<html><body>Replacement SIP</body></html>";

  const fixed = await injectSipHtml(mip, sip);

  assert.match(fixed, /id="end-card"[^>]+srcdoc="/);
  assert.match(fixed, /title="End Scene"/);
  assert.doesNotMatch(fixed, /id="ecc-injected-end-card"/);
  const attribute = fixed.match(/id="end-card"[^>]+srcdoc="([^"]+)"/)[1];
  assert.match(
    decodeCompressedBootstrap(decodeHtmlAttribute(attribute)),
    /Replacement SIP/,
  );
});

test("rejects ambiguous MIPs with multiple End Card placeholders", async () => {
  const mip =
    '<html><body><iframe srcdoc="first"></iframe><iframe srcdoc="second"></iframe></body></html>';
  await assert.rejects(
    () => injectSipHtml(mip, "<html><body>New End Card</body></html>"),
    /More than one End Card placeholder was found/,
  );
});

test("reports empty input explicitly", () => {
  assert.throws(() => inspectHtml(" "), /selected file is empty/);
});

test("rejects repaired MIP output above the 5 MB hard limit", async () => {
  const oversizedMip =
    '<!doctype html><html><head><title>' +
    "x".repeat(5_000_100) +
    '</title></head><body><iframe srcdoc="End Card"></iframe></body></html>';

  await assert.rejects(
    () => transformHtml(oversizedMip),
    /maximum allowed is 5,000,000 bytes \(5 MB\)/,
  );
});

test("rejects injected MIP + SIP output above the 5 MB hard limit", async () => {
  const mip = "<!doctype html><html><head></head><body></body></html>";
  const oversizedSip =
    "<!doctype html><html><body>" +
    randomBytes(4_000_000).toString("base64") +
    "</body></html>";

  await assert.rejects(
    () => injectSipHtml(mip, oversizedSip),
    /maximum allowed is 5,000,000 bytes \(5 MB\)/,
  );
});

test("keeps a large media End Card under the 5 MB limit without double-encoding its bootstrap", async () => {
  const video = randomBytes(2_300_000).toString("base64");
  const mipSource =
    'const existingAppData="' +
    randomBytes(1_150_000).toString("base64") +
    '",card=`<!doctype html><html><body><video src="data:video/mp4;base64,' +
    video +
    '"></video></body></html>`,App=()=>jsx("iframe",{srcDoc:card});';

  const fixed = await transformHtml(mipSource);
  assert.ok(new TextEncoder().encode(fixed).byteLength < 5_000_000);
  const payload = decodeCompressedEndCard(fixed, "card");
  assert.match(payload, /data:video\/mp4;base64,/);
  assert.match(fixed, /ecc-compressed-end-card/);
});
