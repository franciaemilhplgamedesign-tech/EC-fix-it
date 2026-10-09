"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.join(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
const builderHtml = fs.readFileSync(
  path.join(projectRoot, "mip-builder.html"),
  "utf8",
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);

test("packages the standalone Template Builder in the MIP Builder tab", () => {
  assert.match(indexHtml, /id="builder-tab"[\s\S]*?MIP Builder/);
  assert.match(
    indexHtml,
    /<iframe[\s\S]*?src="\.\/mip-builder\.html"[\s\S]*?title="MIP Template Builder"/,
  );
  assert.ok(packageJson.build.files.includes("mip-builder.html"));
  assert.match(builderHtml, /<div id="root"><\/div>/);
  assert.match(builderHtml, /<script type="module">/);
  assert.match(builderHtml, /Template preview/);
  assert.match(builderHtml, /Project Folder/);
  assert.equal([...builderHtml.matchAll(/<\/script/gi)].length, 1);
  assert.doesNotMatch(builderHtml, /theme-toggle-button|Switch to light theme/);
  assert.match(builderHtml, /ec-fix-it-theme/);
  assert.match(builderHtml, /#f0cd55/);
  assert.match(builderHtml, /--scrollbar-thumb-hover:\s*#f0cd55/);
  assert.match(
    builderHtml,
    /Configure elements, then export a self-contained build\./,
  );
});
