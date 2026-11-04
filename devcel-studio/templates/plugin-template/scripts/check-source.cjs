'use strict';
const path = require('node:path');
const { API, DiagnosticCategory, SymbolFlags } = require('typescript/unstable/sync');
const ts = require('typescript/unstable/ast');

/** Source safety rules for the plugin authoring contract. */
function inspectSource(source, checker) {
  const issues = [];
  const comments = new Map();
  const declarations = new Map();
  const caughtBindings = [];
  const add = (node, rule, text) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    issues.push({ rule, line: line + 1, column: character + 1, text });
  };
  const unwrap = node => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const literal = node => {
    if (!node) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return `string:${node.text}`;
    if (ts.isNumericLiteral(node)) return `number:${Number(node.text)}`;
    if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
      if (node.operator === ts.SyntaxKind.MinusToken) return `number:${-Number(node.operand.text)}`;
      if (node.operator === ts.SyntaxKind.PlusToken) return `number:${Number(node.operand.text)}`;
    }
  };
  const effectful = raw => {
    const node = unwrap(raw);
    if (ts.isAsExpression(node) || ts.isTypeAssertion(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return effectful(node.expression);
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node)) return true;
    if (ts.isDeleteExpression(node) || ts.isVoidExpression(node)) return true;
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) return [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator);
    return ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  };
  const captureComments = position => {
    for (const range of [...(ts.getLeadingCommentRanges(source.text, position) || []), ...(ts.getTrailingCommentRanges(source.text, position) || [])]) comments.set(range.pos, range);
  };
  function visit(node) {
    captureComments(node.pos); captureComments(node.end);
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const collect = name => { if (ts.isIdentifier(name)) caughtBindings.push({ name, block: node.block }); else for (const element of name.elements) if (ts.isBindingElement(element)) collect(element.name); };
      collect(node.variableDeclaration.name);
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'Array' && !node.typeArguments?.length && (node.arguments?.length ?? 0) !== 1) add(node, 'array-literal', 'Use an array literal; a single numeric length argument is allowed.');
    if (ts.isEnumDeclaration(node)) {
      const seen = new Set();
      for (const member of node.members) { const value = literal(member.initializer); if (value !== undefined) { if (seen.has(value)) add(member, 'unique-enum', 'Enum values must be distinct.'); seen.add(value); } }
    }
    if ((ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node)) && node.members.length === 0) add(node, 'explicit-object-type', 'Describe object members or use object/unknown.');
    if (ts.isNonNullExpression(node)) {
      const value = unwrap(node.expression);
      if (ts.isNonNullExpression(value)) add(node, 'single-non-null', 'Do not repeat a non-null assertion.');
      if (value.flags & ts.NodeFlags.OptionalChain) add(node, 'optional-chain-result', 'Do not assert an optional-chain result is non-null.');
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken && ts.isNonNullExpression(unwrap(node.expression))) add(node, 'single-non-null', 'Do not combine a non-null assertion with optional access.');
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name) && node.name.text !== 'global') add(node, 'es-modules', 'Use ES modules instead of namespace/module declarations.');
    if ((ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') || ts.isImportEqualsDeclaration(node)) add(node, 'es-imports', 'Use ES imports instead of require/import-equals.');
    if ((ts.isVariableDeclaration(node) && node.initializer && unwrap(node.initializer).kind === ts.SyntaxKind.ThisKeyword) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && unwrap(node.right).kind === ts.SyntaxKind.ThisKeyword)) add(node, 'no-this-alias', 'Use this directly or an arrow function.');
    if (ts.isTypeParameterDeclaration(node) && node.constraint && [ts.SyntaxKind.AnyKeyword, ts.SyntaxKind.UnknownKeyword].includes(node.constraint.kind)) add(node, 'meaningful-constraint', 'Remove the unconstrained type parameter bound.');
    const referencedType = ts.isTypeReferenceNode(node) ? node.typeName : ts.isExpressionWithTypeArguments(node) ? node.expression : undefined;
    if (referencedType && ts.isIdentifier(referencedType)) {
      if (referencedType.text === 'Function') add(node, 'function-signature', 'Use an explicit callable signature.');
      if (['Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt'].includes(referencedType.text)) add(node, 'primitive-types', 'Use primitive types instead of wrapper object types.');
    }
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      const name = node.name?.text;
      const symbol = checker && node.name ? checker.getSymbolAtLocation(node.name) : undefined;
      if (symbol && (symbol.flags & SymbolFlags.Class) && (symbol.flags & SymbolFlags.Interface)) add(node, 'separate-declarations', 'Do not merge class and interface declarations.');
      if (name) { let scope = declarations.get(node.parent); if (!scope) declarations.set(node.parent, scope = new Map()); let entry = scope.get(name); if (!entry) scope.set(name, entry = []); entry.push(node); }
      for (const member of node.members) {
        const sameReturn = member.type && ts.isTypeReferenceNode(member.type) && member.type.typeName.getText(source) === name;
        if ((ts.isInterfaceDeclaration(node) && ts.isConstructSignatureDeclaration(member) && sameReturn)
          || (ts.isInterfaceDeclaration(node) && member.name?.getText(source) === 'constructor')
          || (ts.isClassDeclaration(node) && member.name?.getText(source) === 'new' && sameReturn)) add(member, 'constructor-shape', 'Use a constructor declaration or a separate constructor type.');
      }
    }
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
      if (node.type && ts.isLiteralTypeNode(node.type) && node.initializer && literal(node.type.literal) !== undefined && literal(node.type.literal) === literal(node.initializer)) add(node, 'literal-inference', 'Use an as const initializer instead of repeating its literal type.');
    }
    if ((ts.isAsExpression(node) || ts.isTypeAssertion(node)) && ts.isLiteralTypeNode(node.type) && literal(node.type.literal) !== undefined && literal(node.type.literal) === literal(node.expression)) add(node, 'literal-inference', 'Use as const instead of repeating the literal value.');
    if (ts.isExpressionStatement(node)) {
      const statements = node.parent.statements;
      const index = statements?.indexOf(node) ?? -1;
      const directive = ts.isStringLiteral(node.expression) && index >= 0 && statements.slice(0, index).every(statement => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression));
      if (!directive && !effectful(node.expression)) add(node, 'effectful-expression', 'Expression statements must have a side effect.');
    }
    node.forEachChild(visit);
  }
  visit(source);
  for (const { name, block } of caughtBindings) {
    const symbol = checker?.getSymbolAtLocation(name);
    let used = false;
    const reference = node => {
      if (ts.isIdentifier(node) && node.text === name.text && (!checker || checker.getSymbolAtLocation(node)?.id === symbol?.id)) used = true;
      node.forEachChild(reference);
    };
    reference(block);
    if (!used) add(name, 'used-catch-binding', 'Omit an unused catch binding.');
  }
  for (const scope of declarations.values()) for (const nodes of scope.values()) {
    if (!checker && nodes.some(ts.isClassDeclaration) && nodes.some(ts.isInterfaceDeclaration)) for (const node of nodes) add(node, 'separate-declarations', 'Do not merge class and interface declarations.');
  }
  for (const range of comments.values()) {
    const text = source.text.slice(range.pos, range.end);
    const position = { getStart: () => range.pos };
    for (const match of text.matchAll(/@ts-(ignore|nocheck|expect-error|check)\b([^\r\n]*)/g)) {
      if (['ignore', 'nocheck'].includes(match[1]) || (match[1] === 'expect-error' && match[2].replace(/\*\/$/, '').trim().length < 3)) add(position, 'explained-type-check', 'Use @ts-expect-error with a meaningful explanation; do not disable checking.');
    }
    if (/^\/\/\/\s*<reference\s+(?:path|types)=/m.test(text)) add(position, 'module-references', 'Use imports instead of path/types triple-slash references.');
  }
  return issues;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const config = path.join(root, 'tsconfig.lint.json');
  const api = new API({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      if (!project) throw new Error('The plugin lint project could not be loaded.');
      const program = project.program;
      const diagnostics = [...program.getProgramDiagnostics(), ...program.getGlobalDiagnostics(), ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].filter(item => item.category === DiagnosticCategory.Error);
      for (const item of diagnostics) console.error(`${item.fileName || config}:${item.pos} TS${item.code} ${item.text}`);
      let count = diagnostics.length, checked = 0;
      for (const file of program.getSourceFileNames()) {
        const relative = path.relative(root, file).split(path.sep).join('/');
        if (!relative.startsWith('src/') || relative.startsWith('src/types/') || file.endsWith('.d.ts')) continue;
        const source = program.getSourceFile(file);
        checked++;
        for (const issue of inspectSource(source, project.checker)) { count++; console.error(`${relative}:${issue.line}:${issue.column} [${issue.rule}] ${issue.text}`); }
      }
      if (checked === 0) throw new Error('The plugin lint project contains no authoring sources.');
      console.log(`Plugin source checks: ${checked} sources, ${count} issues`);
      if (count) process.exitCode = 1;
    } finally { snapshot.dispose(); }
  } finally { api.close(); }
}
if (require.main === module) main();
module.exports = { inspectSource };
