"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

function wrapCallExpression(dotPath, args) {
  const parts = String(dotPath || "").split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("call.path empty");
  const jsonArgs = JSON.stringify(args ?? []);
  return `(async () => {
    const _path = ${JSON.stringify(parts)};
    let cur = globalThis;
    for (let i = 0; i < _path.length; i++) {
      cur = cur[_path[i]];
      if (cur == null) throw new Error('call path not found at: ' + _path.slice(0, i + 1).join('.'));
    }
    if (typeof cur !== 'function') throw new Error('call path is not a function: ' + _path.join('.'));
    return await cur.apply(null, ${jsonArgs});
  })()`;
}

function resolveButtonScriptPath(projectRoot) {
  return path.join(projectRoot, "button.js");
}

async function readButtonScript(projectRoot) {
  const scriptPath = resolveButtonScriptPath(projectRoot);
  let source = await fs.readFile(scriptPath, "utf8");
  return validateSourcePayload(source);
}

function validateSourcePayload(source) {
  return source;
}

function hashButtonScript(script) {
  return crypto.createHash("sha1").update(String(script ?? ""), "utf8").digest("hex");
}

async function probeGameCtl(session, requiredMethods) {
  const methods = Array.isArray(requiredMethods) ? requiredMethods.filter(Boolean) : [];
  const expr = `(() => {
    var ctl = typeof gameCtl === "object" && gameCtl ? gameCtl : null;
    if (!ctl && typeof globalThis !== "undefined") {
      ctl = typeof globalThis.gameCtl === "object" && globalThis.gameCtl ? globalThis.gameCtl : null;
    }
    var methods = ${JSON.stringify(methods)};
    var state = {
      hasGameCtl: !!ctl,
      scriptHash: ctl && typeof ctl.__scriptHash === "string" ? ctl.__scriptHash : null,
      methods: {}
    };
    for (var i = 0; i < methods.length; i++) {
      var key = methods[i];
      state.methods[key] = !!(ctl && typeof ctl[key] === "function");
    }
    return state;
  })()`;

  try {
    return await session.evaluate(expr, { awaitPromise: true });
  } catch (_) {
    return null;
  }
}

async function ensureGameCtl(session, projectRoot, requiredMethods = []) {
  const script = await readButtonScript(projectRoot);
  const scriptHash = hashButtonScript(script);
  let state = await probeGameCtl(session, requiredMethods);
  const hasAllMethods =
    state &&
    state.hasGameCtl &&
    requiredMethods.every((key) => state.methods && state.methods[key]);
  const hasLatestScript = state && state.scriptHash === scriptHash;
  if (hasAllMethods && hasLatestScript) {
    return { injected: false, state };
  }

  await session.evaluate(`(async () => { ${script}
; if (globalThis.gameCtl && typeof globalThis.gameCtl === "object") {
    globalThis.gameCtl.__scriptHash = ${JSON.stringify(scriptHash)};
  }
; return { injected: true, scriptHash: ${JSON.stringify(scriptHash)} }; })()`, {
    awaitPromise: true,
  });

  state = await probeGameCtl(session, requiredMethods);
  if (!state) {
    throw new Error(
      `button.js 注入后 gameCtl 探测失败（probeGameCtl 返回 null，CDP evaluate 异常）`
    );
  }
  if (!state.hasGameCtl) {
    throw new Error(
      `button.js 注入后 gameCtl 仍不存在于 global scope（scriptHash=${state.scriptHash}）`
    );
  }
  const missingMethods = requiredMethods.filter((key) => !(state.methods && state.methods[key]));
  if (missingMethods.length > 0) {
    throw new Error(
      `button.js 注入后 gameCtl 以下方法不可用: ${missingMethods.join(", ")}`
    );
  }
  if (state.scriptHash !== scriptHash) {
    throw new Error(
      `button.js 注入后 scriptHash 不匹配: 期望 ${scriptHash}，实际 ${state.scriptHash}`
    );
  }
  return { injected: true, state };
}

async function callGameCtl(session, pathName, args) {
  const expr = wrapCallExpression(pathName, args);
  return await session.evaluate(expr, { awaitPromise: true });
}

module.exports = {
  wrapCallExpression,
  resolveButtonScriptPath,
  readButtonScript,
  ensureGameCtl,
  callGameCtl,
};
