#!/usr/bin/env node
'use strict';

// Detect regressions introducing hardcoded Studio display strings using the TypeScript AST.
// Run: node scripts/check-localization-coverage.cjs (no added dependencies, build, or writes)
// Scope: JSX text and values, display props, display object properties, alert/confirm/prompt,
//       module-evaluation t() calls, and locale dependencies in translating useMemo calls.
// This does not prove all data flows. Display values passed through variables or arbitrary helpers,
// saved user data, server responses, and external plugins require screen and separate runtime checks.
// Do not classify all logs, comments, CSS, or technical IDs as translatable. Specify exceptions by
// file+kind+text, independent of line numbers. Do not allow known untranslated text as a baseline.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript/unstable/ast');
const { createSourceParser } = require('./typescript-analysis.cjs');
const parser = createSourceParser();
const root = path.resolve(__dirname, '..');
const displayProperties = new Set([
  'title', 'aria-label', 'aria-description', 'aria-valuetext', 'placeholder', 'alt',
  'label', 'description', 'tooltip', 'helperText', 'emptyMessage', 'caption',
]);

// Do not broadly allow excluded directories, uppercase strings, or key-like strings,
// which could hide new copy. The same text in another file or use requires a new review.
const exceptions = [
  ...['Ctrl+Space', 'Shift+Space'].map(text => [
    'src/app/pages/main_window/project_view/table_view/components/DataGridView.tsx', 'jsx-expression', text, 'Literal keyboard chord in the translated structural-delete hint',
  ]),
  ['src/app/pages/main_window/project_view/table_view/components/DataGridView.tsx', 'jsx-text', '→ Ctrl+-', 'Literal key sequence following the row or column selection chord'],
  ['src/lib/react-data-grid/DataGrid.tsx', 'jsx-text', 'End', 'Physical End key indicator while keyboard end-navigation mode is active'],
  ['src/app/components/AppDialogHost.tsx', 'jsx-expression', 'Devcel Studio', 'Product name in the default alert title, identical in all locales'],
  ['src/app/pages/main_window/project_view/table_view/TableTabView.tsx', 'prop:title', '(Alt+←)', 'Literal keyboard chord appended to the translated Back label'],
  ['src/app/pages/main_window/project_view/table_view/TableTabView.tsx', 'prop:title', '(Alt+→)', 'Literal keyboard chord appended to the translated Forward label'],
  ['src/app/components/color/ColorPickerPanel.tsx', 'jsx-text', 'A', 'RGBA alpha-channel symbol; technical RGB/HSV bar label shared by all locales'],
  ['src/app/components/common/WindowHeader.tsx', 'prop:alt', 'Devcel', 'Logo product name shared by all locales'],
  ['src/app/pages/main_window/project_view/table_view/components/VersionControls.tsx', 'jsx-text', 'v', 'Technical version-number prefix used by the shared row and column badge'],
  ['src/app/components/column-editor/ConditionalFormattingEditor.tsx', 'jsx-text', 'Aa', 'Uppercase and lowercase sample for the formatting preview'],
  ...['none', 'digits', 'alnum', 'identifier', 'custom'].map(name => [
    'src/app/components/interface/InterfaceEditor.tsx', 'object:label', `interface.pattern.${name}`, 'PATTERN_PRESETS MessageKey translated by t(preset.label) during rendering',
  ]),
  ['src/app/pages/app_updater/AppUpdaterPage.tsx', 'jsx-expression', 'v', 'Technical version-number prefix'],
  ['src/app/pages/export_dialog/ExportDialog.tsx', 'jsx-text', 'JSON', 'Standard file format name'],
  ['src/app/pages/main_window/project_view/properties_panel/PropertiesPanel.tsx', 'jsx-text', 'UUID', 'Standard identifier name'],
  ['src/app/pages/plugin_manager/components/PluginCatalogView.tsx', 'prop:placeholder', 'https://your-server.example/plugins.json', 'Example URL syntax'],
  ['src/app/pages/plugin_manager/components/PluginCatalogView.tsx', 'jsx-text', 'v', 'Technical version-number prefix'],
  ['src/app/pages/plugin_manager/components/PluginCatalogView.tsx', 'jsx-text', 'Devcel:', 'Product name'],
  ['src/app/pages/plugin_manager/components/PluginCatalogView.tsx', 'jsx-text', '/ API:', 'Standard API identifier'],
  ['src/app/pages/plugin_manager/components/PluginCatalogView.tsx', 'jsx-text', 'SHA-256:', 'Standard hashing algorithm name'],
  ['src/app/pages/plugin_manager/components/PluginDetailsView.tsx', 'jsx-text', 'v', 'Technical version-number prefix'],
  ['src/app/pages/plugin_manager/components/PluginInstallDialog.tsx', 'prop:placeholder', 'https://example.com/my-plugin.js', 'Example URL syntax'],
  ['src/app/pages/plugin_manager/components/PluginListView.tsx', 'jsx-text', 'v', 'Technical version-number prefix'],
  ...['v', 'ID', 'API', 'SHA-256'].map(text => [
    'src/app/pages/plugin_packages/PluginPackagePage.tsx', 'jsx-text', text, 'Package version prefix or standard technical identifier',
  ]),
  ...['UTF-8', 'Shift-JIS', 'EUC-JP', 'CSV'].map(text => [
    'src/app/plugins/examples/CSVExporterPlugin.ts', 'object:label', text, 'Standard encoding or file format name',
  ]),
  ...['UTF-8', 'Shift-JIS', 'EUC-JP'].map(text => [
    'src/app/plugins/examples/components/AdvancedCSVExportDialog.tsx', 'jsx-text', text, 'Standard encoding name',
  ]),
];
const exceptionKey = (file, kind, text) => JSON.stringify([file, kind, text]);
const allowlist = new Map(exceptions.map(([file, kind, text, reason]) => [exceptionKey(file, kind, text), reason]));
if (allowlist.size !== exceptions.length || exceptions.some(entry => !entry[3])) {
  throw new Error('Localization allowlist must contain unique, reasoned entries');
}

function scanSource(file, text) {
  const { source, diagnostics } = parser.parse(file, text);
  const issues = [];
  let allowed = 0;
  const add = (node, kind, value, checkAllowlist = true) => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized || (checkAllowlist && !/\p{L}/u.test(normalized))) return;
    if (checkAllowlist && allowlist.has(exceptionKey(file, kind, normalized))) { allowed++; return; }
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    issues.push({ file, line: line + 1, column: character + 1, kind, text: normalized });
  };
  // Conditional test values and t() keys/arguments are not display values. Follow only static
  // strings contributing to results, excluding technical enums, IDs, and user data.
  const value = (node, kind) => {
    if (!node) return;
    if (ts.isStringLiteralLikeNode(node)) add(node, kind, node.text);
    else if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertion(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) value(node.expression, kind);
    else if (ts.isConditionalExpression(node)) { value(node.whenTrue, kind); value(node.whenFalse, kind); }
    else if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(op)) {
        value(node.left, kind); value(node.right, kind);
      } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) value(node.right, kind);
    } else if (ts.isTemplateExpression(node)) {
      add(node.head, kind, node.head.text);
      for (const span of node.templateSpans) { value(span.expression, kind); add(span.literal, kind, span.literal.text); }
    } else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(element => value(element, kind));
  };
  const nonDisplayElement = node => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isJsxElement(parent) && ['style', 'script'].includes(parent.openingElement.tagName.getText(source))) return true;
    }
    return false;
  };
  const translationCall = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't';
  const hasTranslation = node => {
    if (translationCall(node)) return true;
    return Boolean(node.forEachChild(hasTranslation));
  };
  const localeBindings = new Set(['locale']);
  const collectBindings = node => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
      && ts.isCallExpression(node.initializer) && /(?:^|\.)useI18n$/.test(node.initializer.expression.getText(source))) {
      for (const element of node.name.elements) {
        if ((element.propertyName || element.name).getText(source) === 'locale' && ts.isIdentifier(element.name)) localeBindings.add(element.name.text);
      }
    }
    node.forEachChild(collectBindings);
  };
  collectBindings(source);
  function visit(node) {
    if (ts.isJsxText(node) && !nonDisplayElement(node)) add(node, 'jsx-text', node.text);
    if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) && !nonDisplayElement(node)) value(node, 'jsx-expression');
    if (ts.isJsxAttribute(node) && displayProperties.has(node.name.text)) value(node.initializer, `prop:${node.name.text}`);
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
      if (displayProperties.has(name)) value(node.initializer, `object:${name}`);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (/^(?:window\.)?(alert|confirm|prompt)$/.test(callee)) value(node.arguments[0], 'dialog');
      if (translationCall(node)) {
        let parent = node.parent;
        while (parent && !ts.isFunctionLikeDeclaration(parent)) parent = parent.parent;
        if (!parent) add(node, 'module-translation', 't() is evaluated at module load; use a getter or translate while rendering', false);
      }
      if (/(?:^|\.)useMemo$/.test(callee) && node.arguments[0] && hasTranslation(node.arguments[0])) {
        const deps = node.arguments[1];
        const hasLocale = deps && ts.isArrayLiteralExpression(deps) && deps.elements.some(dep =>
          (ts.isIdentifier(dep) && localeBindings.has(dep.text)) || (ts.isPropertyAccessExpression(dep) && dep.name.text === 'locale'));
        if (!hasLocale) add(node, 'memo-locale', 'Translation in useMemo requires the reactive locale dependency; t itself is stable', false);
      }
    }
    node.forEachChild(visit);
  }
  visit(source);
  for (const diagnostic of diagnostics) {
    const position = source.getLineAndCharacterOfPosition(diagnostic.pos);
    issues.push({ file, line: position.line + 1, column: position.character + 1, kind: 'parse', text: diagnostic.text });
  }
  return { issues, allowed };
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.[jt]sx?$/.test(entry.name) ? [absolute] : [];
  }).sort();
}
function main() {
  const files = sourceFiles(path.join(root, 'src')).filter(file =>
    !path.relative(root, file).split(path.sep).join('/').startsWith('src/app/i18n/generated/'));
  let allowed = 0;
  const issues = [];
  for (const file of files) {
    const result = scanSource(path.relative(root, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8'));
    allowed += result.allowed; issues.push(...result.issues);
  }
  for (const issue of issues) console.error(`${issue.file}:${issue.line}:${issue.column} [${issue.kind}] ${issue.text}`);
  console.log(`Localization coverage: ${files.length} source files, ${allowed} reviewed technical/key literals, ${issues.length} issues`);
  if (issues.length) {
    console.error('Move app-owned display text into the catalog. Add a precise reasoned exception only for data or technical notation.');
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { scanSource };

