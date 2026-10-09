"use strict";

(function () {
  const referencePattern = /\bsrcdoc\s*:\s*/gi;
  const runtimeMarker = "ecc-runtime-fixer";
  const MAX_OUTPUT_BYTES = 5_000_000;

  function enforceOutputLimit(source) {
    const size = new TextEncoder().encode(source).byteLength;
    if (size > MAX_OUTPUT_BYTES) {
      throw new Error(
        "The output would be " +
          size.toLocaleString("en-US") +
          " bytes. The maximum allowed is 5,000,000 bytes (5 MB).",
      );
    }
    return source;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function encodeBase64Bytes(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  async function gzipBytes(value) {
    if (typeof CompressionStream !== "function") {
      throw new Error(
        "This environment does not support gzip compression required to keep the fixed file under 5 MB.",
      );
    }
    const stream = new Blob([value])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function stringifyScriptString(value) {
    return JSON.stringify(value).replace(/</g, "\\x3c");
  }

  function escapeHtmlAttribute(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;");
  }

  async function encodeEndCardDocument(html, token) {
    const preparedHtml = prepareEndCardHtml(html, token);
    const compressed = await gzipBytes(preparedHtml);
    const payload = encodeBase64Bytes(compressed);
    const prefix =
      '<!doctype html><meta charset="utf-8"><meta name="ecc-compressed-end-card" content="base64-gzip"><script>(async function(){try{' +
      'var bytes=Uint8Array.from(atob("';
    const suffix =
      '"),function(c){return c.charCodeAt(0)});' +
      'var stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));' +
      'var html=await new Response(stream).text();document.open();document.write(html);document.close()' +
      '}catch(error){var target=document.body||document.documentElement;target.textContent="Unable to load the compressed End Card.";console.error(error)}})();<\/script>';
    return prefix + payload + suffix;
  }

  function createBridgeToken() {
    if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
      throw new Error("Secure randomness is unavailable; the MRAID click bridge cannot be created.");
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function findTemplateLiteral(source, variableName) {
    const declarationPattern = new RegExp(
      "\\b" + escapeRegExp(variableName) + "\\s*=\\s*`",
      "g",
    );
    let match;

    while ((match = declarationPattern.exec(source)) !== null) {
      const contentStart = declarationPattern.lastIndex;
      let escaped = false;
      let end = contentStart;

      for (; end < source.length; end += 1) {
        const character = source[end];

        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === "`") {
          break;
        }
      }

      if (end === source.length || !/^\s*(?:,|;|\)|\})/.test(source.slice(end + 1))) {
        continue;
      }

      const rawTemplate = source.slice(contentStart, end);

      if (hasTemplateInterpolation(rawTemplate)) {
        continue;
      }

      return {
        start: contentStart - 1,
        end: end + 1,
        html: decodeTemplateLiteral(rawTemplate),
      };
    }

    return null;
  }

  function findStaticHtmlTemplate(source, variableName, visited = new Set()) {
    if (visited.has(variableName)) {
      return null;
    }
    visited.add(variableName);

    const template = findTemplateLiteral(source, variableName);
    if (template && /<(?:!doctype\s+html|html\b)/i.test(template.html)) {
      return { ...template, variableName };
    }

    const aliasPattern = new RegExp(
      "(?:\\b(?:var|let|const)\\s+)?" +
        escapeRegExp(variableName) +
        "\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*(?=[,;])",
      "g",
    );
    let match;
    let alias = null;
    while ((match = aliasPattern.exec(source)) !== null) {
      alias = match[1];
    }
    if (!alias) {
      return null;
    }

    return findStaticHtmlTemplate(source, alias, visited);
  }

  function findAssignedValue(source, variableName) {
    const assignmentPattern = new RegExp(
      "\\b" +
        escapeRegExp(variableName) +
        "\\s*=\\s*(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|[A-Za-z_$][\\w$]*)\\s*(?=[,;])",
      "g",
    );
    let match;
    let assignment = null;

    while ((match = assignmentPattern.exec(source)) !== null) {
      assignment = match;
    }
    if (!assignment) {
      return null;
    }

    const expression = assignment[1];
    let value;
    if (expression[0] === '"') {
      value = JSON.parse(expression);
    } else if (expression[0] === "'") {
      value = decodeTemplateLiteral(expression.slice(1, -1));
    } else {
      value = expression;
    }

    return {
      start: assignment.index + assignment[0].indexOf(expression),
      end: assignment.index + assignment[0].indexOf(expression) + expression.length,
      value,
    };
  }

  function findHtmlDataUrl(source, variableName, visited = new Set()) {
    if (visited.has(variableName)) {
      return null;
    }
    visited.add(variableName);

    const assignment = findAssignedValue(source, variableName);
    if (!assignment) {
      return null;
    }
    if (/^data:text\/html(?:;base64)?,/i.test(assignment.value)) {
      return { ...assignment, variableName };
    }
    if (/^[A-Za-z_$][\w$]*$/.test(assignment.value)) {
      return findHtmlDataUrl(source, assignment.value, visited);
    }
    return null;
  }

  function decodeHtmlDataUrl(value) {
    const comma = value.indexOf(",");
    if (comma < 0) {
      throw new Error("The existing HTML data URL is malformed.");
    }
    const header = value.slice(0, comma);
    const payload = value.slice(comma + 1);
    if (/;base64/i.test(header)) {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      );
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(payload);
  }

  async function createDocumentFromHtmlDataUrl(value, token) {
    const decoded = decodeHtmlDataUrl(value);
    return decoded.includes('name="ecc-compressed-end-card"')
      ? decoded
      : encodeEndCardDocument(decoded, token);
  }

  function hasTemplateInterpolation(template) {
    let escaped = false;

    for (let index = 0; index < template.length - 1; index += 1) {
      const character = template[index];

      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "$" && template[index + 1] === "{") {
        return true;
      }
    }

    return false;
  }

  function decodeTemplateLiteral(template) {
    let decoded = "";

    for (let index = 0; index < template.length; index += 1) {
      const character = template[index];

      if (character !== "\\") {
        decoded += character;
        continue;
      }

      index += 1;
      if (index >= template.length) {
        throw new Error("The End Card template ends with an incomplete escape.");
      }

      const escaped = template[index];
      const simpleEscapes = {
        0: "\0",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\v",
        "\\": "\\",
        "`": "`",
        "$": "$",
      };

      if (Object.prototype.hasOwnProperty.call(simpleEscapes, escaped)) {
        decoded += simpleEscapes[escaped];
      } else if (escaped === "\n") {
        continue;
      } else if (escaped === "\r") {
        if (template[index + 1] === "\n") {
          index += 1;
        }
      } else if (escaped === "x" || escaped === "u") {
        const parsed = decodeHexEscape(template, index, escaped);
        decoded += parsed.value;
        index = parsed.end;
      } else {
        decoded += escaped;
      }
    }

    return decoded;
  }

  function decodeHexEscape(template, slashIndex, kind) {
    if (kind === "x") {
      const hex = template.slice(slashIndex + 1, slashIndex + 3);
      if (!/^[\da-fA-F]{2}$/.test(hex)) {
        throw new Error("The End Card contains an invalid hexadecimal escape.");
      }
      return {
        value: String.fromCharCode(parseInt(hex, 16)),
        end: slashIndex + 2,
      };
    }

    if (template[slashIndex + 1] === "{") {
      const closeIndex = template.indexOf("}", slashIndex + 2);
      const hex = template.slice(slashIndex + 2, closeIndex);
      if (closeIndex < 0 || !/^[\da-fA-F]{1,6}$/.test(hex)) {
        throw new Error("The End Card contains an invalid Unicode escape.");
      }
      const codePoint = parseInt(hex, 16);
      if (codePoint > 0x10ffff) {
        throw new Error("The End Card contains a Unicode code point out of range.");
      }
      return { value: String.fromCodePoint(codePoint), end: closeIndex };
    }

    const hex = template.slice(slashIndex + 1, slashIndex + 5);
    if (!/^[\da-fA-F]{4}$/.test(hex)) {
      throw new Error("The End Card contains an invalid Unicode escape.");
    }
    return {
      value: String.fromCharCode(parseInt(hex, 16)),
      end: slashIndex + 4,
    };
  }

  function extractExpressionAtTopLevel(source, startIndex) {
    let depth = 0;
    let quote = null;
    let escaped = false;

    for (let index = startIndex; index < source.length; index += 1) {
      const character = source[index];

      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }

      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        continue;
      }

      if (character === "/" && source[index + 1] === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n") {
          index += 1;
        }
        continue;
      }

      if (character === "/" && source[index + 1] === "*") {
        index += 2;
        while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
          index += 1;
        }
        index += 1;
        continue;
      }

      if (character === "(" || character === "[" || character === "{") {
        depth += 1;
        continue;
      }

      if (character === ")" || character === "]" || character === "}") {
        if (depth > 0) {
          depth -= 1;
        }
        if (depth === 0 && (character === "}" || character === ",")) {
          return source.slice(startIndex, index).trim();
        }
        continue;
      }

      if (depth === 0 && character === ",") {
        return source.slice(startIndex, index).trim();
      }

      if (depth === 0 && character === ";") {
        return source.slice(startIndex, index).trim();
      }
    }

    return source.slice(startIndex).trim();
  }

  function getEndCardReference(source) {
    let lastMatch = null;
    let match;

    while ((match = referencePattern.exec(source)) !== null) {
      const expression = extractExpressionAtTopLevel(
        source,
        match.index + match[0].length,
      );
      if (expression) {
        lastMatch = {
          index: match.index,
          0: source.slice(match.index, match.index + match[0].length + expression.length),
          1: expression,
        };
      }
    }

    referencePattern.lastIndex = 0;
    return lastMatch;
  }

  function getClickHandler(source, beforeIndex) {
    const matches = [];
    const searchStart = Math.max(0, beforeIndex - 1500);
    const scriptPrefix = source.slice(searchStart, beforeIndex);
    let match;

    while ((match = handlerPattern.exec(scriptPrefix)) !== null) {
      matches.push({
        index: match.index + searchStart,
        0: match[0],
        1: match[1],
        2: match[2],
        3: match[3],
      });
    }

    handlerPattern.lastIndex = 0;
    return matches.length > 0
      ? matches[matches.length - 1]
      : getDelegatedClickHandler(source, beforeIndex);
  }

  function findMatchingBrace(source, openIndex) {
    let depth = 0;
    let quote = null;
    let escaped = false;

    for (let index = openIndex; index < source.length; index += 1) {
      const character = source[index];

      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }

      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        continue;
      }

      if (character === "/" && source[index + 1] === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n") {
          index += 1;
        }
        continue;
      }

      if (character === "/" && source[index + 1] === "*") {
        index += 2;
        while (
          index < source.length &&
          !(source[index] === "*" && source[index + 1] === "/")
        ) {
          index += 1;
        }
        index += 1;
        continue;
      }

      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }

    return -1;
  }

  function getDelegatedClickHandler(source, beforeIndex) {
    const componentPrefix = source.slice(Math.max(0, beforeIndex - 3000), beforeIndex);
    const callbackPattern =
      /\b[A-Za-z_$][\w$]*\s*=\s*[\w$.]+\.useCallback\(\s*\(\s*\)\s*=>\s*\{\s*([A-Za-z_$][\w$]*)\s*\(/g;
    let callbackMatch;
    let handlerName = null;

    while ((callbackMatch = callbackPattern.exec(componentPrefix)) !== null) {
      handlerName = callbackMatch[1];
    }

    if (handlerName) {
      const delegated = findNamedClickHandler(source, handlerName, beforeIndex);
      if (delegated) {
        return delegated;
      }
    }

    const frameContext = source.slice(beforeIndex, beforeIndex + 1800);
    const callbackNames = Array.from(
      frameContext.matchAll(/\bonClick\s*:\s*([A-Za-z_$][\w$]*)/g),
      (match) => match[1],
    );

    for (const callbackName of callbackNames) {
      const callbackDeclaration = new RegExp(
        "\\b" +
          escapeRegExp(callbackName) +
        "\\s*=\\s*[\\s\\S]{0,100}?useCallback\\)?\\s*\\(\\s*(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*\\{",
        "g",
      );
      let callbackMatch;

      while ((callbackMatch = callbackDeclaration.exec(source)) !== null) {
        if (callbackMatch.index >= beforeIndex) {
          break;
        }

        const callbackOpenBrace =
          callbackMatch.index + callbackMatch[0].lastIndexOf("{");
        const callbackCloseBrace = findMatchingBrace(source, callbackOpenBrace);
        if (callbackCloseBrace < 0) {
          continue;
        }

        const callbackBody = source.slice(
          callbackOpenBrace + 1,
          callbackCloseBrace,
        );
        const calledNames = Array.from(
          callbackBody.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g),
          (match) => match[1],
        );

        for (const calledName of calledNames) {
          const delegated = findNamedClickHandler(source, calledName, beforeIndex);
          if (delegated) {
            return delegated;
          }
        }
      }
    }

    return null;
  }

  function findNamedClickHandler(source, handlerName, beforeIndex) {
    const declarationPattern = new RegExp(
      "\\bfunction\\s+" + escapeRegExp(handlerName) + "\\s*\\([^)]*\\)\\s*\\{",
      "g",
    );
    let declarationMatch;
    let declaration = null;

    while ((declarationMatch = declarationPattern.exec(source)) !== null) {
      if (declarationMatch.index >= beforeIndex) {
        break;
      }
      declaration = declarationMatch;
    }

    if (!declaration) {
      return null;
    }

    const openBrace = declaration.index + declaration[0].lastIndexOf("{");
    const closeBrace = findMatchingBrace(source, openBrace);
    if (closeBrace < 0) {
      return null;
    }

    const body = source.slice(openBrace + 1, closeBrace);
    if (
      !/\.open\s*\(/.test(body) ||
      !/(?:mraid|clickTag|handleMraidClick|handleClickAction)/i.test(body)
    ) {
      return null;
    }

    return {
      index: declaration.index,
      0: source.slice(declaration.index, closeBrace + 1),
      1: declaration[0].slice(0, declaration[0].lastIndexOf("{") + 1),
      2: null,
      3: null,
      delegated: true,
      bodyStart: openBrace + 1,
      bodyEnd: closeBrace,
      body,
    };
  }

  function hasFullScreenFrameStyle(source) {
    return /position:\s*["'`]fixed["'`][\s\S]{0,180}inset:\s*0[\s\S]{0,100}width:\s*["'`]100vw["'`][\s\S]{0,100}height:\s*["'`]100vh["'`]/.test(
      source,
    );
  }

  function endCardClickBridge(token) {
    return (
      '<script data-ecc-click-bridge="true">(function(){' +
      'var token="' +
      token +
      '";function send(url){try{parent.postMessage({type:"ecc-end-card-click",token:token,url:typeof url==="string"?url:""},"*")}catch(error){}}' +
      'window.__eccOpen=send;document.addEventListener("click",function(event){event.preventDefault();event.stopImmediatePropagation();send("")},true)' +
      '})();<\/script>'
    );
  }

  function prepareEndCardHtml(html, token) {
    const bridge = endCardClickBridge(token);
    const prepared = String(html).replace(
      /\bwindow\s*\.\s*open(?=\s*\()/gi,
      "window.__eccOpen",
    );

    if (prepared.includes('data-ecc-click-bridge="true"')) {
      return prepared;
    }
    if (/<\/body\s*>/i.test(prepared)) {
      return prepared.replace(/<\/body\s*>/i, bridge + "</body>");
    }
    if (/<\/html\s*>/i.test(prepared)) {
      return prepared.replace(/<\/html\s*>/i, bridge + "</html>");
    }
    return prepared + bridge;
  }

  function decodeHtmlAttribute(value) {
    return value
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&");
  }

  function buildRuntimeCompatibilityLayer(token) {
    const serializedBridge = JSON.stringify(endCardClickBridge(token)).replace(
      /</g,
      "\\x3c",
    );

    return (
      '<script id="' +
      runtimeMarker +
      '">(function(){' +
      'var token="' +
      token +
      '";' +
      'function toBase64(html){var bytes=new TextEncoder().encode(html),binary="";for(var i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+32768));return btoa(binary)}' +
      'function toDocument(html){var source=String(html).replace(/window\\s*\\.\\s*open(?=\\s*\\()/gi,"window.__eccOpen");source=(' +
      'function(value){var bridge=' +
      serializedBridge +
      ';if(value.indexOf("data-ecc-click-bridge")>=0)return value;var lower=value.toLowerCase(),index=lower.lastIndexOf("</body>");if(index>=0)return value.slice(0,index)+bridge+value.slice(index);index=lower.lastIndexOf("</html>");if(index>=0)return value.slice(0,index)+bridge+value.slice(index);return value+bridge})(source);return source}' +
      'function toDataUrl(html){return "data:text/html;base64,"+toBase64(toDocument(html))}' +
      'window.__eccDocument=toDocument;window.__eccDataUrl=toDataUrl;' +
      'window.__eccFrameDocument=function(frame,html){frame.dataset.eccEndCard="true";frame.dataset.eccEndCardReady="true";return toDocument(html)};' +
      'function clickout(url){console.log("CTA_CLICKED");var m=window.mraid||{},target=url||window.clickTag||window.clickTag1||window.clickthrough||window.clickThrough||"";if(m&&typeof m.open==="function")try{if(target)m.open(target);else m.open()}catch(error){console.warn("[MRAID] open failed",error)}}' +
      'window.__eccOpen=clickout;window.addEventListener("message",function(event){var data=event.data;if(data&&data.type==="ecc-end-card-click"&&data.token===token)clickout(data.url)},true);' +
      'var style=document.createElement("style");style.id="ecc-end-card-style";style.textContent="iframe[data-ecc-end-card]{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;min-width:100vw!important;min-height:100vh!important;max-width:none!important;max-height:none!important;z-index:2147483647!important;border:0!important}";(document.head||document.documentElement).appendChild(style);' +
      'function decodeDataUrl(url){var comma=url.indexOf(",");if(comma<0)return null;var header=url.slice(0,comma),payload=url.slice(comma+1);try{if(/;base64/i.test(header)){var raw=atob(payload),bytes=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return new TextDecoder().decode(bytes)}return decodeURIComponent(payload)}catch(error){return null}}' +
      'var srcdocDescriptor=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,"srcdoc");' +
      'function setFrameDocument(frame,html){frame.dataset.eccEndCard="true";frame.dataset.eccEndCardReady="true";if(srcdocDescriptor&&srcdocDescriptor.set)srcdocDescriptor.set.call(frame,toDocument(html));else frame.srcdoc=toDocument(html)}' +
      'async function decodeLegacyDocument(html){if(html.indexOf("ecc-compressed-end-card")<0)return html;var match=html.match(/atob\\(\"([^\"]+)\"\\)/);if(!match)throw new Error("Compressed End Card payload was not found");var bytes=Uint8Array.from(atob(match[1]),function(c){return c.charCodeAt(0)});return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()}' +
      'function processFrame(frame){if(!(frame instanceof HTMLIFrameElement)||frame.dataset.eccEndCardReady==="true")return;var raw=frame.getAttribute("srcdoc");if(raw!==null){setFrameDocument(frame,raw);return}var src=frame.getAttribute("src")||"";if(src.slice(0,14).toLowerCase()==="data:text/html"){var html=decodeDataUrl(src);if(html!==null){frame.dataset.eccEndCard="true";frame.dataset.eccEndCardReady="true";decodeLegacyDocument(html).then(function(documentHtml){if(srcdocDescriptor&&srcdocDescriptor.set)srcdocDescriptor.set.call(frame,toDocument(documentHtml));else frame.srcdoc=toDocument(documentHtml)}).catch(function(error){console.error("Unable to load the compressed End Card.",error)})}}}' +
      'function scan(root){if(root instanceof HTMLIFrameElement)processFrame(root);if(root.querySelectorAll)root.querySelectorAll("iframe").forEach(processFrame)}' +
      'var observer=new MutationObserver(function(records){for(var i=0;i<records.length;i++){var record=records[i];if(record.type==="attributes")processFrame(record.target);else record.addedNodes.forEach(scan)}});' +
      'if(srcdocDescriptor&&srcdocDescriptor.configurable)Object.defineProperty(HTMLIFrameElement.prototype,"srcdoc",{configurable:true,enumerable:srcdocDescriptor.enumerable,get:function(){return srcdocDescriptor.get.call(this)},set:function(value){setFrameDocument(this,value)}});' +
      'if(document.documentElement){observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["src","srcdoc"]});scan(document.documentElement)}' +
      '})();<\/script>'
    );
  }

  function injectRuntimeCompatibilityLayer(source, token) {
    const layer = buildRuntimeCompatibilityLayer(token);
    const existingLayerPattern = new RegExp(
      '<script id="' +
        escapeRegExp(runtimeMarker) +
        '">[\\s\\S]*?<\\/script>',
      "i",
    );
    if (existingLayerPattern.test(source)) {
      return source.replace(existingLayerPattern, layer);
    }

    const headMatch = /<head\b[^>]*>/i.exec(source);
    if (headMatch) {
      const insertion = headMatch.index + headMatch[0].length;
      return source.slice(0, insertion) + layer + source.slice(insertion);
    }

    const htmlMatch = /<html\b[^>]*>/i.exec(source);
    if (htmlMatch) {
      const insertion = htmlMatch.index + htmlMatch[0].length;
      return source.slice(0, insertion) + layer + source.slice(insertion);
    }

    return layer + source;
  }

  function inspectHtml(source) {
    if (typeof source !== "string" || source.trim() === "") {
      throw new Error("The selected file is empty.");
    }

    const reference = getEndCardReference(source);
    const hasNoWindowOpen = !/\bwindow\s*\.\s*open\s*\(/i.test(source);
    const hasRawSrcdoc = Boolean(reference) || /\bsrcdoc\s*=/i.test(source);
    const directHtmlSource =
      /\bsrc\s*:\s*["'`]data:text\/html(?:;base64)?,/i.test(source) ||
      /\bsrc\s*=\s*["']data:text\/html(?:;base64)?,/i.test(source);
    const sourceVariables = Array.from(
      source.matchAll(/\bsrc\s*:\s*([A-Za-z_$][\w$]*)\b/g),
      (match) => match[1],
    );
    const variableHtmlSource = sourceVariables.some((variableName) =>
      new RegExp(
        "\\b" +
          escapeRegExp(variableName) +
          "\\s*=\\s*[\"'`]data:text/html(?:;base64)?,",
        "i",
      ).test(source),
    );
    const hasHtmlDataSource = directHtmlSource || variableHtmlSource;
    const isRuntimeFixed = source.includes('id="' + runtimeMarker + '"');
    const legacyDataSourcePattern =
      /\bsrc\s*:\s*(?:window\.__eccDataUrl\s*\(\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)|([A-Za-z_$][\w$]*))\b/g;
    let legacyDataSourceMatch;
    let hasLegacyHtmlDataSource =
      /<iframe\b[^>]*\bsrc\s*=\s*["']data:text\/html(?:;base64)?,/i.test(
        source,
      );
    while (
      !hasLegacyHtmlDataSource &&
      (legacyDataSourceMatch = legacyDataSourcePattern.exec(source)) !== null
    ) {
      const variableName =
        legacyDataSourceMatch[1] || legacyDataSourceMatch[2];
      hasLegacyHtmlDataSource = Boolean(
        findHtmlDataUrl(source, variableName),
      );
    }
    legacyDataSourcePattern.lastIndex = 0;
    const staticWrappedSourcePattern =
      /\bsrc\s*:\s*window\.__eccDataUrl\s*\(\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)/g;
    let wrappedMatch;
    let hasUnencodedStaticEndCard = false;
    while (
      (wrappedMatch = staticWrappedSourcePattern.exec(source)) !== null
    ) {
      if (findStaticHtmlTemplate(source, wrappedMatch[1])) {
        hasUnencodedStaticEndCard = true;
        break;
      }
    }
    staticWrappedSourcePattern.lastIndex = 0;
    const needsStaticConversion = hasUnencodedStaticEndCard;

    return {
      kind: needsStaticConversion
        ? "raw-srcdoc"
        : isRuntimeFixed
        ? "base64-src"
        : hasRawSrcdoc
          ? "raw-srcdoc"
          : hasHtmlDataSource
          ? "base64-src"
          : "unsupported",
      hasNoWindowOpen,
      isFullScreen:
        isRuntimeFixed ||
        hasFullScreenFrameStyle(
          source.slice(
            Math.max(0, reference ? reference.index - 1600 : 0),
            reference ? reference.index + 2200 : source.length,
          ),
        ),
      hasMraidOpen:
        isRuntimeFixed || /(?:mraid|[A-Za-z_$][\w$]*)\.open\s*\(/.test(source),
      hasCtaLog:
        isRuntimeFixed || /console\.log\(["']CTA_CLICKED["']\)/.test(source),
      needsRepair:
        !isRuntimeFixed ||
        !hasNoWindowOpen ||
        needsStaticConversion ||
        hasLegacyHtmlDataSource,
    };
  }

  function replaceEndCardHandler(source, referenceIndex) {
    const handler = getClickHandler(source, referenceIndex);

    if (!handler) {
      throw new Error(
        "The End Card MRAID click handler was not recognized; no file was changed.",
      );
    }

    if (handler.delegated) {
      const body = handler.body
        .replace(/console\.log\(\s*["']CTA_CLICKED["']\s*\)\s*;?/g, "")
        .replace(/^\s+/, "");
      return {
        start: handler.bodyStart,
        end: handler.bodyEnd,
        value: 'console.log("CTA_CLICKED");' + body,
      };
    }

    const functionName = handler[1].match(/[A-Za-z_$][\w$]*/)?.[0] ?? "open";
    const mraidName = handler[2];
    const clickTargetName = handler[3];
    const replacement =
      functionName +
      '=()=>{console.log("CTA_CLICKED");const ' +
      mraidName +
      '=window.mraid||{},' +
      clickTargetName +
      '=window.clickTag||window.clickTag1||window.clickthrough||window.clickThrough||"";if(' +
      mraidName +
      '.open&&typeof ' +
      mraidName +
      '.open=="function"){' +
      clickTargetName +
      "?" +
      mraidName +
      ".open(" +
      clickTargetName +
      "):" +
      mraidName +
      ".open();return}}";

    return {
      start: handler.index,
      end: handler.index + handler[0].length,
      value: replacement,
    };
  }

  async function transformHtml(source) {
    if (typeof source !== "string" || source.trim() === "") {
      throw new Error("The selected file is empty.");
    }
    const existingToken = source.match(
      /<script id="ecc-runtime-fixer">[\s\S]*?var token="([a-f\d]+)"/i,
    );
    const token = existingToken ? existingToken[1] : createBridgeToken();

    const originalReferences = [];
    let reference;
    while ((reference = referencePattern.exec(source)) !== null) {
      const expression = extractExpressionAtTopLevel(
        source,
        reference.index + reference[0].length,
      );
      if (expression) {
        originalReferences.push({
          start: reference.index,
          end: reference.index + reference[0].length + expression.length,
          expression,
        });
      }
    }
    referencePattern.lastIndex = 0;

    const replacements = [];
    const replacedTemplates = new Set();
    const staticWrappedSourcePattern =
      /\bsrc\s*:\s*window\.__eccDataUrl\s*\(\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)/g;
    let wrappedSource;
    while (
      (wrappedSource = staticWrappedSourcePattern.exec(source)) !== null
    ) {
      const template = findStaticHtmlTemplate(source, wrappedSource[1]);
      if (!template) {
        continue;
      }
      if (!replacedTemplates.has(template.start)) {
        const document = await encodeEndCardDocument(template.html, token);
        replacements.push({
          start: template.start,
          end: template.end,
          value: stringifyScriptString(document),
        });
        replacedTemplates.add(template.start);
      }
      replacements.push({
        start: wrappedSource.index,
        end: staticWrappedSourcePattern.lastIndex,
        value: "srcDoc:" + wrappedSource[1],
      });
    }
    staticWrappedSourcePattern.lastIndex = 0;

    const replacedLegacyAssignments = new Set();
    const legacySourceProperties = [
      {
        pattern: /\bsrc\s*:\s*([A-Za-z_$][\w$]*)\b/g,
        variableIndex: 1,
      },
      {
        pattern:
          /\bsrc\s*:\s*window\.__eccDataUrl\s*\(\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)/g,
        variableIndex: 1,
      },
    ];
    for (const { pattern, variableIndex } of legacySourceProperties) {
      let legacySource;
      while ((legacySource = pattern.exec(source)) !== null) {
        const dataUrl = findHtmlDataUrl(
          source,
          legacySource[variableIndex],
        );
        if (!dataUrl) {
          continue;
        }

        const document = await createDocumentFromHtmlDataUrl(
          dataUrl.value,
          token,
        );
        if (!replacedLegacyAssignments.has(dataUrl.start)) {
          replacements.push({
            start: dataUrl.start,
            end: dataUrl.end,
            value: stringifyScriptString(document),
          });
          replacedLegacyAssignments.add(dataUrl.start);
        }
        replacements.push({
          start: legacySource.index,
          end: pattern.lastIndex,
          value:
            "srcDoc:" +
            legacySource[variableIndex] +
            ',"data-ecc-end-card":true,"data-ecc-end-card-ready":true',
        });
      }
    }

    const directHtmlAttributePattern =
      /<iframe\b[^>]*?\bsrc\s*=\s*(["'])(data:text\/html(?:;base64)?,[\s\S]*?)\1[^>]*>/gi;
    let directHtmlAttribute;
    while (
      (directHtmlAttribute = directHtmlAttributePattern.exec(source)) !== null
    ) {
      const document = await createDocumentFromHtmlDataUrl(
        directHtmlAttribute[2],
        token,
      );
      const fixedTag = directHtmlAttribute[0].replace(
        /\bsrc\s*=\s*(["'])[\s\S]*?\1/i,
        'srcdoc="' +
          escapeHtmlAttribute(document) +
          '" data-ecc-end-card="true" data-ecc-end-card-ready="true"',
      );
      replacements.push({
        start: directHtmlAttribute.index,
        end: directHtmlAttribute.index + directHtmlAttribute[0].length,
        value: fixedTag,
      });
    }

    const srcdocAttributePattern =
      /<iframe\b[^>]*?\bsrcdoc\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi;
    const srcdocAttributes = [];
    let attribute;
    while ((attribute = srcdocAttributePattern.exec(source)) !== null) {
      srcdocAttributes.push({
        start: attribute.index,
        end: attribute.index + attribute[0].length,
      });
      const html = decodeHtmlAttribute(attribute[2]);
      const document = await encodeEndCardDocument(html, token);
      const fixedTag = attribute[0].replace(
        /\bsrcdoc\s*=\s*(["'])[\s\S]*?\1/i,
        'srcdoc="' +
          escapeHtmlAttribute(document) +
          '" data-ecc-end-card="true" data-ecc-end-card-ready="true"',
      );
      replacements.push({
        start: attribute.index,
        end: attribute.index + attribute[0].length,
        value: fixedTag,
      });
    }

    for (const item of originalReferences) {
      if (
        srcdocAttributes.some(
          (range) => item.start >= range.start && item.start < range.end,
        )
      ) {
        continue;
      }

      const variableName = /^[A-Za-z_$][\w$]*$/.test(item.expression)
        ? item.expression
        : null;
      const template = variableName
        ? findStaticHtmlTemplate(source, variableName)
        : null;
      let sourceExpression;

      if (template) {
        const document = await encodeEndCardDocument(template.html, token);
        sourceExpression = variableName;
        if (!replacedTemplates.has(template.start)) {
          replacements.push({
            start: template.start,
            end: template.end,
            value: stringifyScriptString(document),
          });
          replacedTemplates.add(template.start);
        }
      } else {
        sourceExpression =
          "window.__eccDocument((" + item.expression + "))";
      }

      replacements.push({
        start: item.start,
        end: item.end,
        value:
          "srcDoc:" +
          sourceExpression +
          ',"data-ecc-end-card":true,"data-ecc-end-card-ready":true',
      });
    }

    const assignmentPattern =
      /\b((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\.srcdoc\s*=\s*/gi;
    let assignment;
    while ((assignment = assignmentPattern.exec(source)) !== null) {
      const expressionStart = assignment.index + assignment[0].length;
      const expression = extractExpressionAtTopLevel(source, expressionStart);
      if (expression) {
        replacements.push({
          start: assignment.index,
          end: expressionStart + expression.length,
          value:
            assignment[1] +
            ".srcdoc=window.__eccFrameDocument(" +
            assignment[1] +
            ",(" +
            expression +
            "))",
        });
      }
    }

    for (const replacement of replacements.sort(
      (left, right) => right.start - left.start,
    )) {
      source =
        source.slice(0, replacement.start) +
        replacement.value +
        source.slice(replacement.end);
    }

    source = source.replace(
      /\bwindow\s*\.\s*open(?=\s*\()/gi,
      "window.__eccOpen",
    );
    source = injectRuntimeCompatibilityLayer(source, token);

    const verified = inspectHtml(source);
    if (
      !source.includes('id="' + runtimeMarker + '"') ||
      !verified.isFullScreen ||
      !verified.hasMraidOpen ||
      !verified.hasCtaLog ||
      !verified.hasNoWindowOpen
    ) {
      throw new Error("The repaired MIP did not pass the Base64 End Card checks.");
    }

    return enforceOutputLimit(source);
  }

  async function injectSipHtml(mipSource, sipSource) {
    if (
      typeof mipSource !== "string" ||
      mipSource.trim() === "" ||
      typeof sipSource !== "string" ||
      sipSource.trim() === ""
    ) {
      throw new Error("Choose both a non-empty MIP HTML file and SIP HTML file.");
    }

    const token = createBridgeToken();
    const endCardDocument = await encodeEndCardDocument(sipSource, token);
    let result = mipSource;

    const placeholderReplacements = [];
    const sourceValueReplacements = [];
    const replacedLegacyAssignments = new Set();
    const legacySourcePropertyPattern =
      /\bsrc\s*:\s*(?:window\.__eccDataUrl\s*\(\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)|([A-Za-z_$][\w$]*))\b/g;
    let legacySourceProperty;
    while (
      (legacySourceProperty = legacySourcePropertyPattern.exec(mipSource)) !==
      null
    ) {
      const variableName =
        legacySourceProperty[1] || legacySourceProperty[2];
      const dataUrl = findHtmlDataUrl(mipSource, variableName);
      if (!dataUrl) {
        continue;
      }
      if (!replacedLegacyAssignments.has(dataUrl.start)) {
        sourceValueReplacements.push({
          start: dataUrl.start,
          end: dataUrl.end,
          value: stringifyScriptString(endCardDocument),
        });
        replacedLegacyAssignments.add(dataUrl.start);
      }
      placeholderReplacements.push({
        start: legacySourceProperty.index,
        end: legacySourcePropertyPattern.lastIndex,
        value:
          "srcDoc:" +
          variableName +
          ',"data-ecc-end-card":true,"data-ecc-end-card-ready":true',
      });
    }

    const directHtmlAttributePattern =
      /<iframe\b[^>]*?\bsrc\s*=\s*(["'])data:text\/html(?:;base64)?,[\s\S]*?\1[^>]*>/gi;
    let directHtmlAttribute;
    while (
      (directHtmlAttribute = directHtmlAttributePattern.exec(mipSource)) !==
      null
    ) {
      const fixedTag = directHtmlAttribute[0].replace(
        /\bsrc\s*=\s*(["'])[\s\S]*?\1/i,
        'srcdoc="' +
          escapeHtmlAttribute(endCardDocument) +
          '" data-ecc-end-card="true" data-ecc-end-card-ready="true"',
      );
      placeholderReplacements.push({
        start: directHtmlAttribute.index,
        end: directHtmlAttribute.index + directHtmlAttribute[0].length,
        value: fixedTag,
      });
    }

    const srcDocPropertyPattern = /\bsrcDoc\s*:\s*/gi;
    let srcDocProperty;
    while ((srcDocProperty = srcDocPropertyPattern.exec(mipSource)) !== null) {
      const expressionStart = srcDocProperty.index + srcDocProperty[0].length;
      const expression = extractExpressionAtTopLevel(mipSource, expressionStart);
      if (expression) {
        const variableName = /^[A-Za-z_$][\w$]*$/.test(expression)
          ? expression
          : null;
        const template = variableName
          ? findStaticHtmlTemplate(mipSource, variableName)
          : null;
        if (template) {
          if (!replacedLegacyAssignments.has(template.start)) {
            sourceValueReplacements.push({
              start: template.start,
              end: template.end,
              value: stringifyScriptString(endCardDocument),
            });
            replacedLegacyAssignments.add(template.start);
          }
          placeholderReplacements.push({
            start: srcDocProperty.index,
            end: expressionStart + expression.length,
            value:
              "srcDoc:" +
              variableName +
              ',"data-ecc-end-card":true,"data-ecc-end-card-ready":true',
          });
          continue;
        }

        placeholderReplacements.push({
          start: srcDocProperty.index,
          end: expressionStart + expression.length,
          value:
            "srcDoc:" +
            stringifyScriptString(endCardDocument) +
            ',"data-ecc-end-card":true,"data-ecc-end-card-ready":true',
        });
      }
    }

    const srcdocAttributePattern =
      /<iframe\b[^>]*?\bsrcdoc\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi;
    let srcdocAttribute;
    while ((srcdocAttribute = srcdocAttributePattern.exec(mipSource)) !== null) {
      const fixedTag = srcdocAttribute[0].replace(
        /\bsrcdoc\s*=\s*(["'])[\s\S]*?\1/i,
        'srcdoc="' +
          escapeHtmlAttribute(endCardDocument) +
          '" data-ecc-end-card="true" data-ecc-end-card-ready="true"',
      );
      placeholderReplacements.push({
        start: srcdocAttribute.index,
        end: srcdocAttribute.index + srcdocAttribute[0].length,
        value: fixedTag,
      });
    }

    if (placeholderReplacements.length > 1) {
      throw new Error(
        "More than one End Card placeholder was found. Keep a single placeholder in the MIP before adding the SIP.",
      );
    }

    if (placeholderReplacements.length === 1) {
      for (const replacement of [
        ...sourceValueReplacements,
        ...placeholderReplacements,
      ].sort((left, right) => right.start - left.start)) {
        result =
          result.slice(0, replacement.start) +
          replacement.value +
          result.slice(replacement.end);
      }
    } else {
      const iframe =
        '<iframe id="ecc-injected-end-card" data-ecc-end-card="true" data-ecc-end-card-ready="true" title="End Card" srcdoc="' +
        escapeHtmlAttribute(endCardDocument) +
        '" style="position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;border:0;pointer-events:auto"></iframe>';
      const bodyEnd = /<\/body\s*>/i;

      if (bodyEnd.test(result)) {
        result = result.replace(bodyEnd, iframe + "</body>");
      } else {
        result += iframe;
      }
    }

    result = result.replace(
      /\bwindow\s*\.\s*open(?=\s*\()/gi,
      "window.__eccOpen",
    );
    result = injectRuntimeCompatibilityLayer(result, token);

    const verification = inspectHtml(result);
    if (
      verification.kind !== "base64-src" ||
      !verification.isFullScreen ||
      !verification.hasMraidOpen ||
      !verification.hasCtaLog ||
      !verification.hasNoWindowOpen
    ) {
      throw new Error("The injected End Card did not pass Base64/MRAID verification.");
    }

    return enforceOutputLimit(result);
  }

  const api = { inspectHtml, transformHtml, injectSipHtml };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (typeof document !== "undefined") {
    initializeUi(api);
  }

  function initializeUi(checker) {
    const fileInput = document.getElementById("file-input");
    const dropZone = document.getElementById("drop-zone");
    const resultCard = document.getElementById("result-card");
    const resultIcon = document.getElementById("result-icon");
    const resultTitle = document.getElementById("result-title");
    const resultFile = document.getElementById("result-file");
    const resultMessage = document.getElementById("result-message");
    const checkList = document.getElementById("check-list");
    const resultActions = document.getElementById("result-actions");
    const fixButton = document.getElementById("fix-button");
    const fixDialog = document.getElementById("fix-dialog");
    const confirmFix = document.getElementById("confirm-fix");
    const toast = document.getElementById("toast");
    const checkTab = document.getElementById("check-tab");
    const injectTab = document.getElementById("inject-tab");
    const builderTab = document.getElementById("builder-tab");
    const checkPanel = document.getElementById("check-panel");
    const injectPanel = document.getElementById("inject-panel");
    const builderPanel = document.getElementById("builder-panel");
    const mipInput = document.getElementById("mip-input");
    const sipInput = document.getElementById("sip-input");
    const mipFileName = document.getElementById("mip-file-name");
    const sipFileName = document.getElementById("sip-file-name");
    const injectButton = document.getElementById("inject-button");
    const injectStatus = document.getElementById("inject-status");
    const themeToggle = document.getElementById("theme-toggle");
    const themeToggleIcon = document.getElementById("theme-toggle-icon");
    const themeToggleLabel = document.getElementById("theme-toggle-label");
    const themeColor = document.querySelector('meta[name="theme-color"]');
    const brandLogo = document.querySelector(".brand-logo");
    const updateVersion = document.getElementById("update-version");
    const updateStatus = document.getElementById("update-status");
    const checkUpdatesButton = document.getElementById("check-updates");
    const downloadUpdateButton = document.getElementById("download-update");
    const updateApi = window.ecFixIt;
    const changelogDialog = document.getElementById("changelog-dialog");
    const changelogBody = document.getElementById("changelog-body");
    const builderFrame = document.querySelector(".mip-builder-frame");

    let selectedFile = null;
    let selectedSource = "";
    let currentInspection = null;
    let selectedMipFile = null;
    let selectedSipFile = null;
    let toastTimer = 0;

    function syncBuilderTheme(theme) {
      builderFrame.dataset.theme = theme;
      builderFrame.contentWindow?.postMessage(
        { type: "ec-fix-it-theme", theme },
        "*",
      );
    }

    builderFrame.addEventListener("load", () => {
      syncBuilderTheme(document.documentElement.dataset.theme);
    });

    function applyTheme(theme, persist = false) {
      const nextTheme = theme === "dark" ? "dark" : "light";
      const followingTheme = nextTheme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = nextTheme;
      brandLogo.src =
        nextTheme === "dark"
          ? brandLogo.dataset.darkSrc
          : brandLogo.dataset.lightSrc;
      themeColor.content = getComputedStyle(document.documentElement)
        .getPropertyValue("--theme-color")
        .trim();
      syncBuilderTheme(nextTheme);
      themeToggle.setAttribute("aria-label", "Switch to " + followingTheme + " mode");
      themeToggle.title = "Switch to " + followingTheme + " mode";
      themeToggleLabel.textContent =
        followingTheme[0].toUpperCase() + followingTheme.slice(1) + " mode";
      themeToggleIcon.innerHTML =
        nextTheme === "dark"
          ? '<circle cx="10" cy="10" r="3.5"></circle><path d="M10 2v1.5m0 13V18m8-8h-1.5m-13 0H2m13.66-5.66-1.06 1.06m-9.2 9.2-1.06 1.06m11.32 0-1.06-1.06m-9.2-9.2L4.34 4.34"></path>'
          : '<path d="M16.8 13.2A7 7 0 0 1 6.8 3.2 7 7 0 1 0 16.8 13.2Z"></path>';
      if (persist) {
        localStorage.setItem("ec-fix-it-theme", nextTheme);
      }
    }

    const savedTheme = localStorage.getItem("ec-fix-it-theme");
    const preferredTheme =
      savedTheme === "dark" || savedTheme === "light"
        ? savedTheme
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    applyTheme(preferredTheme);
    themeToggle.addEventListener("click", () => {
      applyTheme(
        document.documentElement.dataset.theme === "dark" ? "light" : "dark",
        true,
      );
    });

    function renderChangelog(markdown) {
      const fragment = document.createDocumentFragment();
      let list = null;

      for (const line of markdown.split(/\r?\n/)) {
        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        const listItem = /^\s*[-*]\s+(.+)$/.exec(line);

        if (listItem) {
          if (!list) {
            list = document.createElement("ul");
            fragment.append(list);
          }
          const item = document.createElement("li");
          item.textContent = listItem[1];
          list.append(item);
          continue;
        }

        list = null;
        if (!line.trim()) {
          continue;
        }

        const element = document.createElement(heading ? "h" + heading[1].length : "p");
        element.textContent = heading ? heading[2] : line;
        fragment.append(element);
      }

      changelogBody.replaceChildren(fragment);
    }

    document.getElementById("show-changelog").addEventListener("click", async () => {
      changelogDialog.showModal();
      changelogBody.textContent = "Loading changelog…";
      try {
        const markdown = updateApi
          ? await updateApi.getChangelog()
          : await (await fetch("./CHANGELOG.md")).text();
        renderChangelog(markdown);
      } catch (error) {
        changelogBody.textContent =
          "Could not load the changelog: " +
          (error instanceof Error ? error.message : "Unknown error.");
      }
    });

    for (const closeButtonId of ["close-changelog", "dismiss-changelog"]) {
      document.getElementById(closeButtonId).addEventListener("click", () => {
        changelogDialog.close();
      });
    }

    if (!updateApi) {
      checkUpdatesButton.disabled = true;
      updateVersion.textContent = "Windows desktop app only";
      updateStatus.textContent =
        "Update checks are available in the EC fix-it executable.";
    } else {
      void updateApi
        .getVersion()
        .then((version) => {
          updateVersion.textContent = "Installed version: " + version;
        })
        .catch((error) => {
          updateVersion.textContent = "Installed version unavailable";
          updateStatus.textContent =
            error instanceof Error ? error.message : "Could not read the app version.";
        });

      checkUpdatesButton.addEventListener("click", async () => {
        checkUpdatesButton.disabled = true;
        downloadUpdateButton.hidden = true;
        updateStatus.textContent = "Checking GitHub releases…";

        try {
          const update = await updateApi.checkForUpdates();
          if (update.status === "no-release") {
            updateVersion.textContent = "Installed version: " + update.currentVersion;
            updateStatus.textContent =
              "No published GitHub release was found for EC fix-it.";
          } else if (update.status === "current") {
            updateVersion.textContent = "Installed version: " + update.currentVersion;
            updateStatus.textContent =
              "You’re up to date. Latest release: " + update.latestVersion + ".";
          } else if (update.status === "available") {
            updateVersion.textContent = "Installed version: " + update.currentVersion;
            updateStatus.textContent =
              "Version " +
              update.latestVersion +
              " is available. Download it, then close EC fix-it and replace the existing executable.";
            downloadUpdateButton.textContent =
              "Download v" + update.latestVersion;
            downloadUpdateButton.hidden = false;
          } else {
            throw new Error("GitHub returned an unknown update status.");
          }
        } catch (error) {
          updateStatus.textContent =
            "Could not check for updates: " +
            (error instanceof Error ? error.message : "Unknown error.");
        } finally {
          checkUpdatesButton.disabled = false;
        }
      });

      downloadUpdateButton.addEventListener("click", async () => {
        downloadUpdateButton.disabled = true;
        updateStatus.textContent = "Opening the verified GitHub release download…";
        try {
          const update = await updateApi.openUpdateDownload();
          updateStatus.textContent =
            "The v" +
            update.version +
            " download was opened. Close EC fix-it before replacing the existing executable.";
        } catch (error) {
          updateStatus.textContent =
            "Could not open the update download: " +
            (error instanceof Error ? error.message : "Unknown error.");
        } finally {
          downloadUpdateButton.disabled = false;
        }
      });
    }

    function showToast(message) {
      toast.textContent = message;
      toast.classList.add("is-visible");
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        toast.classList.remove("is-visible");
      }, 3200);
    }

    function addCheck(label, passed) {
      const item = document.createElement("li");
      item.textContent = label;
      if (!passed) {
        item.classList.add("is-pending");
      }
      checkList.append(item);
    }

    function renderResult(file, inspection, message) {
      currentInspection = inspection;
      resultCard.hidden = false;
      resultCard.classList.toggle(
        "is-warning",
        inspection.needsRepair,
      );
      resultIcon.setAttribute(
        "aria-label",
        inspection.needsRepair ? "Needs a fix" : "Check complete",
      );
      resultTitle.textContent =
        inspection.kind === "raw-srcdoc"
          ? "Raw HTML End Card detected"
          : inspection.kind === "base64-src"
            ? "Base64 End Card found"
            : "MIP inspected";
      resultFile.textContent = file.name;
      resultMessage.textContent = message;
      resultActions.hidden = !inspection.needsRepair;
      fixButton.textContent =
        inspection.kind === "unsupported"
          ? "Prepare MIP for End Cards"
          : "Review and fix";
      checkList.replaceChildren();

      addCheck(
        "End Card is stored in a compressed Base64 srcdoc loader",
        inspection.kind === "base64-src",
      );
      addCheck("Keep the End Card full-screen", inspection.isFullScreen);
      addCheck("Use the MRAID clickout handler", inspection.hasMraidOpen);
      addCheck("Log CTA_CLICKED on every CTA tap", inspection.hasCtaLog);
      addCheck("No window.open navigation", inspection.hasNoWindowOpen);
    }

    async function loadFile(file) {
      if (!file) {
        return;
      }
      if (!/\.html?$/i.test(file.name)) {
        showToast("Choose an .html or .htm file.");
        return;
      }

      try {
        const source = await file.text();
        const inspection = checker.inspectHtml(source);
        selectedFile = file;
        selectedSource = source;

        if (inspection.kind === "raw-srcdoc") {
          renderResult(
            file,
            inspection,
            "This End Card is supplied as HTML. The repair converts srcDoc and runtime-created HTML frames to Base64 and adds full-screen MRAID click handling.",
          );
          fixDialog.showModal();
        } else if (inspection.kind === "base64-src") {
          renderResult(
            file,
            inspection,
            "An HTML iframe source was found. Review the checks and apply the MRAID/full-screen compatibility layer if needed.",
          );
        } else {
          renderResult(
            file,
            inspection,
            "No familiar End Card source was detected. Preparing this MIP installs a runtime adapter that converts iframe srcDoc values to Base64 when the End Card is created.",
          );
        }
      } catch (error) {
        selectedFile = null;
        selectedSource = "";
        resultCard.hidden = false;
        resultCard.classList.add("is-warning");
        resultTitle.textContent = "Could not check this file";
        resultFile.textContent = file.name;
        resultMessage.textContent =
          error instanceof Error ? error.message : "The selected file could not be read.";
        resultActions.hidden = true;
        checkList.replaceChildren();
      }
    }

    async function downloadFixedFile() {
      if (!selectedFile || !selectedSource || !currentInspection) {
        return;
      }

      try {
        const fixedSource = await checker.transformHtml(selectedSource);
        const blob = new Blob([fixedSource], { type: "text/html;charset=utf-8" });
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = selectedFile.name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

        const fixedInspection = checker.inspectHtml(fixedSource);
        renderResult(
          selectedFile,
          fixedInspection,
          "The fixed file was downloaded with the original filename. Your original file was not changed.",
        );
        showToast("Fixed HTML downloaded.");
      } catch (error) {
        resultMessage.textContent =
          error instanceof Error ? error.message : "The End Card could not be repaired.";
        showToast("The End Card could not be repaired.");
      }
    }

    function selectTool(tab) {
      const tabs = [
        [checkTab, checkPanel],
        [injectTab, injectPanel],
        [builderTab, builderPanel],
      ];
      for (const [currentTab, panel] of tabs) {
        const selected = currentTab === tab;
        currentTab.classList.toggle("is-active", selected);
        currentTab.setAttribute("aria-selected", String(selected));
        currentTab.tabIndex = selected ? 0 : -1;
        panel.hidden = !selected;
      }
    }

    function updateInjectButton() {
      injectButton.disabled = !selectedMipFile || !selectedSipFile;
    }

    function checkHtmlFile(file, label) {
      if (file && !/\.html?$/i.test(file.name)) {
        showToast("Choose an .html or .htm file for the " + label + ".");
        return false;
      }
      return true;
    }

    async function downloadInjectedMip() {
      if (!selectedMipFile || !selectedSipFile) {
        return;
      }

      injectButton.disabled = true;
      injectStatus.textContent = "Reading both HTML files…";
      try {
        const [mipSource, sipSource] = await Promise.all([
          selectedMipFile.text(),
          selectedSipFile.text(),
        ]);
        const output = await checker.injectSipHtml(mipSource, sipSource);
        const blob = new Blob([output], { type: "text/html;charset=utf-8" });
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = selectedMipFile.name.replace(
          /\.html?$/i,
          "_with_end_card.html",
        );
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        injectStatus.textContent =
          "SIP End Card added and downloaded. Any existing placeholder display logic is preserved; MRAID clickout and CTA_CLICKED logging are enabled.";
        showToast("MIP with SIP End Card downloaded.");
      } catch (error) {
        injectStatus.textContent =
          error instanceof Error
            ? error.message
            : "The End Card could not be injected.";
      } finally {
        updateInjectButton();
      }
    }

    checkTab.addEventListener("click", () => selectTool(checkTab));
    injectTab.addEventListener("click", () => selectTool(injectTab));
    builderTab.addEventListener("click", () => selectTool(builderTab));
    const toolTabs = [checkTab, injectTab, builderTab];
    for (const tab of toolTabs) {
      tab.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const index = toolTabs.indexOf(tab);
          const offset = event.key === "ArrowRight" ? 1 : -1;
          const next = toolTabs[(index + offset + toolTabs.length) % toolTabs.length];
          selectTool(next);
          next.focus();
        }
      });
    }

    mipInput.addEventListener("change", () => {
      const file = mipInput.files && mipInput.files[0];
      if (!checkHtmlFile(file, "MIP")) {
        mipInput.value = "";
        return;
      }
      selectedMipFile = file || null;
      mipFileName.textContent = file ? file.name : "No MIP selected";
      injectStatus.textContent = "";
      updateInjectButton();
    });

    sipInput.addEventListener("change", () => {
      const file = sipInput.files && sipInput.files[0];
      if (!checkHtmlFile(file, "SIP")) {
        sipInput.value = "";
        return;
      }
      selectedSipFile = file || null;
      sipFileName.textContent = file ? file.name : "No SIP selected";
      injectStatus.textContent = "";
      updateInjectButton();
    });

    injectButton.addEventListener("click", () => {
      void downloadInjectedMip();
    });

    fileInput.addEventListener("change", () => {
      void loadFile(fileInput.files && fileInput.files[0]);
    });

    dropZone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        fileInput.click();
      }
    });

    for (const eventName of ["dragenter", "dragover"]) {
      dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.classList.add("is-dragging");
      });
    }

    for (const eventName of ["dragleave", "drop"]) {
      dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.classList.remove("is-dragging");
      });
    }

    dropZone.addEventListener("drop", (event) => {
      const file = event.dataTransfer && event.dataTransfer.files[0];
      void loadFile(file);
    });

    fixButton.addEventListener("click", () => {
      if (fixDialog.open) {
        fixDialog.close("review");
      }
      fixDialog.showModal();
    });

    confirmFix.addEventListener("click", (event) => {
      event.preventDefault();
      fixDialog.close("fix");
      downloadFixedFile();
    });
  }
})();
