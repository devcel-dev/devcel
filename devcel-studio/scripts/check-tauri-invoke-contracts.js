#!/usr/bin/env node

import fs from "fs";
import path from "path";
import * as ts from "typescript/unstable/ast";
import { createSourceParser } from "./typescript-analysis.cjs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STUDIO_ROOT = path.resolve(__dirname, "..");
const TAURI_SRC_ROOT = path.join(STUDIO_ROOT, "src-tauri", "src");
const TAURI_LIB_RS = path.join(TAURI_SRC_ROOT, "lib.rs");
const FRONTEND_SRC_ROOT = path.join(STUDIO_ROOT, "src");

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function walkFiles(rootDir, exts) {
  const result = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      if (exts.some((ext) => fullPath.endsWith(ext))) {
        result.push(fullPath);
      }
    }
  }

  return result;
}

function splitTopLevel(text, separator) {
  const chunks = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let inDoubleQuote = false;
  let inBacktick = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      escape = true;
      continue;
    }

    if (ch === '"' && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }

    if (ch === "`" && !inDoubleQuote) {
      inBacktick = !inBacktick;
      current += ch;
      continue;
    }

    if (inDoubleQuote || inBacktick) {
      current += ch;
      continue;
    }

    if (ch === "(") parenDepth++;
    if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (ch === "[") bracketDepth++;
    if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (ch === "{") braceDepth++;
    if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (ch === "<") angleDepth++;
    if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);

    const isTopLevel =
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0;

    if (ch === separator && isTopLevel) {
      chunks.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

function findMatching(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let inDoubleQuote = false;
  let inBacktick = false;
  let escape = false;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"' && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (ch === "`" && !inDoubleQuote) {
      inBacktick = !inBacktick;
      continue;
    }

    if (inDoubleQuote || inBacktick) {
      continue;
    }

    if (ch === openChar) depth++;
    if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function extractGenerateHandlerEntries(libText) {
  const entries = new Set();
  let searchStart = 0;

  while (true) {
    const marker = "generate_handler![";
    const idx = libText.indexOf(marker, searchStart);
    if (idx === -1) break;

    const openBracketIndex = idx + marker.length - 1;
    const closeBracketIndex = findMatching(libText, openBracketIndex, "[", "]");
    if (closeBracketIndex === -1) {
      throw new Error("Failed to parse generate_handler![] block");
    }

    const body = libText.slice(openBracketIndex + 1, closeBracketIndex);
    const sanitized = body
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    for (const token of splitTopLevel(sanitized, ",")) {
      if (!token) continue;
      const name = token.includes("::")
        ? token.slice(token.lastIndexOf("::") + 2)
        : token;
      if (name) entries.add(name.trim());
    }

    searchStart = closeBracketIndex + 1;
  }

  return entries;
}

function parseRustCommandDefinitions(rsText) {
  const definitions = new Map();
  let searchStart = 0;

  while (true) {
    const attrIdx = rsText.indexOf("#[tauri::command]", searchStart);
    if (attrIdx === -1) break;

    const fnMatch = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    fnMatch.lastIndex = attrIdx;
    const matched = fnMatch.exec(rsText);
    if (!matched) break;

    const commandName = matched[1];
    const openParenIndex = fnMatch.lastIndex - 1;
    const closeParenIndex = findMatching(rsText, openParenIndex, "(", ")");
    if (closeParenIndex === -1) {
      throw new Error(`Failed to parse command signature: ${commandName}`);
    }

    const paramsSource = rsText.slice(openParenIndex + 1, closeParenIndex);
    const sanitizedParams = paramsSource
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const rawParams = splitTopLevel(sanitizedParams, ",");
    const params = [];

    for (const rawParam of rawParams) {
      if (!rawParam) continue;
      if (rawParam.trim() === "self" || rawParam.trim() === "&self") continue;

      const colonParts = splitTopLevel(rawParam, ":");
      if (colonParts.length < 2) continue;
      let paramName = colonParts[0].trim();
      if (paramName.startsWith("mut ")) {
        paramName = paramName.slice(4).trim();
      }
      if (paramName.startsWith("&")) {
        paramName = paramName.slice(1).trim();
      }
      if (paramName.length > 0) {
        const paramType = colonParts.slice(1).join(":").trim();
        params.push({
          name: paramName,
          optional: /^(?:(?:std|core)::option::)?Option\s*</.test(paramType),
          injected: /^(?:tauri::)?(?:State\s*<|(?:AppHandle|WebviewWindow|Webview|Window)(?:\s*<|$))/.test(paramType),
        });
      }
    }

    definitions.set(commandName, params);
    searchStart = closeParenIndex + 1;
  }

  return definitions;
}

function camelCase(name) {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function createExpectedCommandMap() {
  const libText = readFile(TAURI_LIB_RS);
  const registered = extractGenerateHandlerEntries(libText);

  const allRsFiles = walkFiles(TAURI_SRC_ROOT, [".rs"]);
  const definitions = new Map();
  for (const rsFile of allRsFiles) {
    const defs = parseRustCommandDefinitions(readFile(rsFile));
    for (const [name, params] of defs) {
      if (!definitions.has(name)) {
        definitions.set(name, params);
      }
    }
  }

  const expected = new Map();
  for (const commandName of registered) {
    const params = definitions.get(commandName) || [];
    const filteredParams = params.filter(
      ({ name, injected }) => !injected && !["state", "app_handle", "app", "window"].includes(name)
    );

    const aliases = new Set();
    for (const { name } of filteredParams) {
      aliases.add(name);
      aliases.add(camelCase(name));
    }

    expected.set(commandName, {
      params: filteredParams.map(({ name }) => name),
      requiredParams: filteredParams.filter(({ optional }) => !optional).map(({ name }) => name),
      aliases,
    });
  }

  return expected;
}

function collectObjectKeys(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) {
    return { keys: [], hasDynamicSpread: false, hasDynamicKeys: false };
  }

  const keys = [];
  let hasDynamicSpread = false;
  let hasDynamicKeys = false;

  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop)) {
      if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
        keys.push(prop.name.text);
      } else {
        hasDynamicKeys = true;
      }
      continue;
    }

    if (ts.isShorthandPropertyAssignment(prop)) {
      keys.push(prop.name.text);
      continue;
    }

    if (ts.isSpreadAssignment(prop)) {
      hasDynamicSpread = true;
    }
  }

  return { keys, hasDynamicSpread, hasDynamicKeys };
}

// An object used between its initializer and invoke may have been extended,
// reassigned, or passed to code that mutates it. Its initial keys are incomplete.
function hasInterveningReference(sourceFile, initializer, argument) {
  let found = false;
  const visit = (node) => {
    if (found || node.end <= initializer.end || node.pos >= argument.getStart(sourceFile)) return;
    if (ts.isIdentifier(node) && node.text === argument.text && node !== argument) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return found;
}

function analyzeInvokeContracts(expectedCommands) {
  const parser = createSourceParser();
  try {
  const sourceFiles = walkFiles(FRONTEND_SRC_ROOT, [".ts", ".tsx"]);
  const issues = [];

  for (const filePath of sourceFiles) {
    const code = readFile(filePath);
    const { source: sourceFile, diagnostics } = parser.parse(filePath, code);
    if (diagnostics.length) throw new Error(`${filePath}: ${diagnostics.map(diagnostic => diagnostic.text).join('\n')}`);

    const formatPos = (node) => {
      const lc = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      return `${lc.line + 1}:${lc.character + 1}`;
    };

    const visit = (node, scopeStack) => {
      let currentScopeStack = scopeStack;

      if (
        ts.isSourceFile(node) ||
        ts.isBlock(node) ||
        ts.isFunctionLikeDeclaration(node)
      ) {
        const scope = new Map(scopeStack[scopeStack.length - 1] || []);
        currentScopeStack = [...scopeStack, scope];

        if (ts.isFunctionLikeDeclaration(node)) {
          for (const parameter of node.parameters) {
            if (ts.isIdentifier(parameter.name)) scope.set(parameter.name.text, null);
          }
        }

        if (node.statements) {
          for (const st of node.statements) {
            if (!ts.isVariableStatement(st)) continue;
            for (const decl of st.declarationList.declarations) {
              if (ts.isIdentifier(decl.name)) {
                if (decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
                  scope.set(decl.name.text, decl.initializer);
                } else {
                  scope.set(decl.name.text, null);
                }
              }
            }
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isInvoke =
          (ts.isIdentifier(callee) && callee.text === "invoke") ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === "invoke");

        if (isInvoke && node.arguments.length > 0) {
          const arg0 = node.arguments[0];
          if (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0)) {
            const commandName = arg0.text;
            const expected = expectedCommands.get(commandName);
            if (expected) {
              let keys = [];
              let hasDynamicSpread = false;
              let hasDynamicArgs = false;

              if (node.arguments.length >= 2) {
                const arg1 = node.arguments[1];
                if (ts.isObjectLiteralExpression(arg1)) {
                  const collected = collectObjectKeys(arg1);
                  keys = collected.keys;
                  hasDynamicSpread = collected.hasDynamicSpread;
                  hasDynamicArgs = collected.hasDynamicKeys;
                } else if (ts.isIdentifier(arg1)) {
                  const resolved = currentScopeStack
                    .slice()
                    .reverse()
                    .find((scope) => scope.has(arg1.text))
                    ?.get(arg1.text);
                  if (resolved) {
                    const collected = collectObjectKeys(resolved);
                    const hasInterveningUse = hasInterveningReference(sourceFile, resolved, arg1);
                    keys = hasInterveningUse ? [] : collected.keys;
                    hasDynamicSpread = collected.hasDynamicSpread;
                    hasDynamicArgs = collected.hasDynamicKeys || hasInterveningUse;
                  } else {
                    hasDynamicArgs = true;
                  }
                } else {
                  hasDynamicArgs = true;
                }
              }

              if (!hasDynamicSpread && !hasDynamicArgs) {
                const missingParams = expected.requiredParams.filter(
                  (name) => !keys.includes(name) && !keys.includes(camelCase(name))
                );
                if (missingParams.length > 0) {
                  issues.push({
                    level: "error",
                    filePath,
                    position: formatPos(node),
                    type: "missing-expected-key",
                    commandName,
                    keys,
                    missingParams,
                  });
                }
              }

              const invalidKeys = keys.filter((k) => !expected.aliases.has(k));
              if (invalidKeys.length > 0) {
                issues.push({
                  level: "error",
                  filePath,
                  position: formatPos(node),
                  type: "invalid-key",
                  commandName,
                  keys,
                  invalidKeys,
                  expected: [...expected.aliases],
                });
              }

              if (hasDynamicArgs) {
                issues.push({
                  level: "warn",
                  filePath,
                  position: formatPos(node),
                  type: "dynamic-args",
                  commandName,
                });
              }

              if (hasDynamicSpread) {
                issues.push({
                  level: "warn",
                  filePath,
                  position: formatPos(node),
                  type: "dynamic-spread",
                  commandName,
                });
              }
            }
          }
        }
      }

      node.forEachChild((child) => visit(child, currentScopeStack));
    };

    visit(sourceFile, [new Map()]);
  }

  return issues;
  } finally { parser.close(); }
}

/** Declaring a capability file does not activate it when Tauri has an explicit list. */
export function analyzeCapabilityConfig(config, capabilities) {
  const selected = config.app?.security?.capabilities;
  // Without an explicit list Tauri includes all capability files automatically.
  if (selected === undefined) return [];
  const declared = new Set(capabilities.map((capability) => capability.identifier));
  const active = new Set(selected.map((capability) => typeof capability === "string" ? capability : capability.identifier));
  const issues = [];
  for (const capability of selected) {
    if (typeof capability === "string" && !declared.has(capability)) {
      issues.push({ level: "error", type: "capability-config", message: `Unknown active capability: ${capability}` });
    }
  }
  // This app keeps every declared window capability active. An unreferenced file
  // otherwise looks valid while its close-request listener cannot call destroy().
  for (const identifier of declared) {
    if (!active.has(identifier)) {
      issues.push({ level: "error", type: "capability-config", message: `Capability ${identifier} is declared but missing from app.security.capabilities in tauri.conf.json` });
    }
  }
  return issues;
}

function main() {
  const expectedCommands = createExpectedCommandMap();
  const issues = analyzeInvokeContracts(expectedCommands);
  const tauriRoot = path.dirname(TAURI_SRC_ROOT);
  const capabilities = walkFiles(path.join(tauriRoot, "capabilities"), [".json"])
    .map((filePath) => JSON.parse(readFile(filePath)));
  issues.push(...analyzeCapabilityConfig(JSON.parse(readFile(path.join(tauriRoot, "tauri.conf.json"))), capabilities));

  for (const issue of issues) {
    if (issue.type === "capability-config") {
      console.log(`[error] ${issue.message}`);
      continue;
    }
    if (issue.type === "missing-expected-key") {
      console.log(
        `[error] ${issue.filePath}:${issue.position} invoke(${issue.commandName}) keys=[${issue.keys.join(
          ", "
        )}] missingRequired=[${issue.missingParams.map(camelCase).join(", ")}]`
      );
      continue;
    }

    if (issue.type === "invalid-key") {
      console.log(
        `[error] ${issue.filePath}:${issue.position} invoke(${issue.commandName}) invalidKeys=[${issue.invalidKeys.join(
          ", "
        )}] keys=[${issue.keys.join(", ")}] expected=[${issue.expected.join(", ")}]`
      );
      continue;
    }

    if (issue.type === "dynamic-args") {
      console.log(
        `[warn] ${issue.filePath}:${issue.position} invoke(${issue.commandName}) contains dynamic arguments and was partially checked`
      );
      continue;
    }

    if (issue.type === "dynamic-spread") {
      console.log(
        `[warn] ${issue.filePath}:${issue.position} invoke(${issue.commandName}) contains spread object and was partially checked`
      );
    }
  }

  const errorCount = issues.filter((i) => i.level === "error").length;
  const warnCount = issues.filter((i) => i.level === "warn").length;
  console.log(`checked_commands=${expectedCommands.size} checked_capabilities=${capabilities.length} errors=${errorCount} warnings=${warnCount}`);

  if (errorCount > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`[error] contract check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
