import { quoteFormulaName, quoteFormulaString, tokenizeFormula, type FormulaToken } from './formulaTokens';

export interface CompletionColumn {
  uuid: string; data_name: string; display_name?: string; data_type: string;
  reference_config?: { target_table_uuid: string } | null;
  table_ref_config?: { interface_uuid: string } | null;
}
export interface CompletionTable {
  uuid: string; data_name: string; display_name?: string; columns?: CompletionColumn[]; isInterface?: boolean;
}
export interface CompletionCatalog {
  functions: readonly string[];
  tables: readonly CompletionTable[];
  currentTable?: string;
}
export interface FormulaCandidate {
  kind: 'function' | 'table' | 'column' | 'variable' | 'field';
  label: string; detail: string; insert: string; caretOffset?: number;
}
export interface FormulaCompletion {
  start: number; end: number; expected: string; candidates: FormulaCandidate[];
  /** Only these schemas need to be loaded to refine member suggestions. */
  neededTables: string[];
}
type Shape = { kind: 'unknown' } | { kind: 'row'; table: string }
  | { kind: 'collection'; item: Shape } | { kind: 'record'; fields: Map<string, Shape> }
  | { kind: 'color' } | { kind: 'table-reference'; interface: string };
const unknown: Shape = { kind: 'unknown' };
type Env = Map<string, { name: string; shape: Shape }>;
const key = (value: string | undefined) => (value ?? '').toUpperCase();
const eq = (a: string | undefined, b: string | undefined) => key(a) === key(b);
const item = (shape: Shape): Shape => shape.kind === 'collection' ? shape.item : unknown;
function commonShape(a: Shape, b: Shape, depth = 0): Shape {
  if (depth > 16 || a.kind !== b.kind) return unknown;
  if (a.kind === 'row' && b.kind === 'row') return a.table === b.table ? a : unknown;
  if (a.kind === 'table-reference' && b.kind === 'table-reference') return a.interface === b.interface ? a : unknown;
  if (a.kind === 'collection' && b.kind === 'collection') return { kind: 'collection', item: commonShape(a.item, b.item, depth + 1) };
  if (a.kind === 'record' && b.kind === 'record') return { kind: 'record', fields: new Map([...a.fields]
    .filter(([name]) => b.fields.has(name)).map(([name, value]) => [name, commonShape(value, b.fields.get(name)!, depth + 1)])) };
  return a;
}

/** An incomplete expression tree used only for editor context and static shapes.
 * No source is evaluated and no formula-created data is materialized.
 */
interface Node {
  kind: 'name' | 'string' | 'call' | 'lambda' | 'member' | 'array' | 'record' | 'group' | 'other';
  start: number; end: number; text: string; quoted?: boolean; children: Node[];
  params?: string[]; fields?: string[];
}
const empty = (at: number): Node => ({ kind: 'other', start: at, end: at, text: '', children: [] });

function interpolations(token: FormulaToken): Array<{ tokens: FormulaToken[]; start: number; end: number }> {
  if (token.kind !== 'string' || !token.contentOffsets) return [];
  const result: Array<{ tokens: FormulaToken[]; start: number; end: number }> = [];
  const value = token.text, offsets = token.contentOffsets;
  for (let i = 0; i < value.length;) {
    if (value.startsWith('$${', i)) { i += 3; continue; }
    if (!value.startsWith('${', i)) { i++; continue; }
    const begin = i + 2;
    let at = begin, nesting = 1, quote = '';
    for (; at < value.length; at++) {
      const ch = value[at];
      if (quote) {
        if (ch === quote) { if (value[at + 1] === quote) at++; else quote = ''; }
      } else if (ch === '"' || ch === '`') quote = ch;
      else if (ch === '{') nesting++;
      else if (ch === '}' && --nesting === 0) break;
    }
    const remap = (index: number) => offsets[begin + index] ?? token.end;
    const tokens = tokenizeFormula(value.slice(begin, at)).map(t => ({ ...t, start: remap(t.start), end: remap(t.end),
      contentOffsets: t.contentOffsets?.map(remap) }));
    result.push({ tokens, start: offsets[begin], end: offsets[at] ?? token.end });
    i = at + 1;
  }
  return result;
}

function tree(tokens: FormulaToken[], start: number, end: number, depth = 0): Node {
  if (!tokens.length || depth > 64) return empty(start);
  const levels: number[] = [];
  let level = 0;
  for (const token of tokens) {
    if (token.kind === 'punctuation' && [')', ']', '}'].includes(token.text)) level--;
    levels.push(level);
    if (token.kind === 'punctuation' && ['(', '[', '{'].includes(token.text)) level++;
  }
  const sub = (list: FormulaToken[], a: number, b: number) => tree(list, a, b, depth + 1);
  const at = (symbol: string) => tokens.findIndex((t, i) => levels[i] === 0 && t.kind === 'punctuation' && t.text === symbol);
  const arrow = at('=>');
  if (arrow >= 0) {
    const params = tokens.slice(0, arrow).filter(t => t.kind === 'name' || t.kind === 'quoted-name').map(t => t.text);
    return { kind: 'lambda', start, end, text: '', params, children: [sub(tokens.slice(arrow + 1), tokens[arrow].end, end)] };
  }
  // Keep operators outside member expressions. Unknown/binary shapes must not
  // accidentally inherit the type of their last operand.
  for (const ops of [['||'], ['&&'], ['=', '==', '!=', '<>', '<', '>', '<=', '>='], ['+', '-'], ['*', '/']]) {
    const split = tokens.findIndex((t, i) => i > 0 && levels[i] === 0 && t.kind === 'punctuation' && ops.includes(t.text));
    if (split >= 0) return { kind: 'other', start, end, text: '', children: [sub(tokens.slice(0, split), start, tokens[split].start), sub(tokens.slice(split + 1), tokens[split].end, end)] };
  }
  let dot = -1;
  for (let i = 0; i < tokens.length; i++) if (levels[i] === 0 && tokens[i].kind === 'punctuation' && tokens[i].text === '.') dot = i;
  if (dot >= 0) return { kind: 'member', start, end, text: tokens[dot + 1]?.text ?? '', children: [sub(tokens.slice(0, dot), start, tokens[dot].start), sub(tokens.slice(dot + 1), tokens[dot].end, end)] };
  const open = at('(');
  const first = tokens[0];
  const parts = (from: number, to: number, nesting: number, fromOffset: number): Node[] => {
    const result: Node[] = [];
    let begin = from, offset = fromOffset;
    for (let i = from; i < to; i++) {
      if (levels[i] === nesting && tokens[i].text === ',' && tokens[i].kind === 'punctuation') {
        result.push(sub(tokens.slice(begin, i), offset, tokens[i].start));
        begin = i + 1; offset = tokens[i].end;
      }
    }
    const endOffset = to < tokens.length ? tokens[to].start : end;
    result.push(sub(tokens.slice(begin, to), offset, endOffset));
    return result;
  };
  if (open === 1 && (first.kind === 'name' || first.kind === 'quoted-name')) {
    const close = tokens.findIndex((t, i) => i > open && levels[i] === 0 && t.text === ')' && t.kind === 'punctuation');
    return { kind: 'call', start, end, text: first.text, children: parts(open + 1, close < 0 ? tokens.length : close, 1, tokens[open].end) };
  }
  if (first.text === '(' || first.text === '[' || first.text === '{') {
    const closing = { '(': ')', '[': ']', '{': '}' }[first.text];
    const close = tokens.findIndex((t, i) => i > 0 && levels[i] === 0 && t.text === closing && t.kind === 'punctuation');
    const to = close < 0 ? tokens.length : close;
    if (first.text === '(') return { kind: 'group', start, end, text: '', children: [sub(tokens.slice(1, to), first.end, close < 0 ? end : tokens[close].start)] };
    const children = parts(1, to, 1, first.end);
    if (first.text === '{') {
      const fields: string[] = [];
      const values = children.map(child => {
        const contained = tokens.filter(t => t.start >= child.start && t.end <= child.end);
        const colon = contained.findIndex(t => t.text === ':' && t.kind === 'punctuation');
        fields.push(colon === 1 ? contained[0].text : '');
        return colon === 1 ? sub(contained.slice(2), contained[1].end, child.end) : child;
      });
      return { kind: 'record', start, end, text: '', children: values, fields };
    }
    return { kind: 'array', start, end, text: '', children };
  }
  if (tokens.length === 1) return { kind: first.kind === 'string' ? 'string' : 'name', start, end, text: first.text, quoted: first.kind === 'quoted-name',
    children: interpolations(first).map(part => sub(part.tokens, part.start, part.end)) };
  return { kind: 'other', start, end, text: '', children: [] };
}

/** Static, bounded candidate resolution. The catalog contains metadata only. */
export function completeFormula(source: string, caret: number, catalog: CompletionCatalog): FormulaCompletion | null {
  if (source.length > 65536 || !Number.isInteger(caret) || caret < 0 || caret > source.length || !source.trimStart().startsWith('=')) return null;
  const equals = source.indexOf('=');
  if (caret <= equals) return null;
  const tokens = tokenizeFormula(source.slice(equals + 1)).map(t => ({ ...t, start: t.start + equals + 1, end: t.end + equals + 1,
    contentOffsets: t.contentOffsets?.map(offset => offset + equals + 1) }));
  let contextTokens: FormulaToken[] = tokens;
  let interpolationDepth = 0;
  for (let step = 0; step < 16; step++) {
    const part = contextTokens.flatMap(interpolations).find(p => caret >= p.start && caret <= p.end);
    if (!part) break;
    contextTokens = part.tokens;
    interpolationDepth++;
  }
  const active = contextTokens.find(t => t.start < caret && caret <= t.end && t.kind !== 'punctuation');
  const preceding = contextTokens.filter(t => t.end <= caret);
  const previous = preceding[preceding.length - 1];
  if (!active && previous && (previous.kind !== 'punctuation' || [')', ']', '}'].includes(previous.text))) return null;
  const start = active?.start ?? caret;
  const end = active?.end ?? caret;
  const prefix = active ? source.slice(active.start + (active.kind === 'name' ? 0 : 1), caret).replace(/``/g, '`').replace(/""/g, '"') : '';
  const needed = new Set<string>();
  const schemas = new Map(catalog.tables.map(t => [t.uuid, t]));
  const schema = (uuid: string) => { const table = schemas.get(uuid); if ((table && !table.columns) || (!table && uuid.startsWith('interface:'))) needed.add(uuid); return table; };
  const tableIds = new Map<string, CompletionTable>();
  const tableNames = new Map<string, CompletionTable | null>();
  const tableLabels = new Map<string, CompletionTable | null>();
  const addAlias = (index: Map<string, CompletionTable | null>, name: string | undefined, table: CompletionTable) => {
    if (!name) return;
    const normalized = key(name);
    index.set(normalized, index.has(normalized) ? null : table);
  };
  for (const table of catalog.tables) {
    if (table.isInterface) continue;
    if (!tableIds.has(key(table.uuid))) tableIds.set(key(table.uuid), table);
    addAlias(tableNames, table.data_name, table);
    addAlias(tableLabels, table.display_name, table);
  }
  const namedTable = (name: string) => {
    const normalized = key(name);
    if (tableIds.has(normalized)) return tableIds.get(normalized);
    // An ambiguous internal name must not fall through to a display alias.
    if (tableNames.has(normalized)) return tableNames.get(normalized) ?? undefined;
    return tableLabels.get(normalized) ?? undefined;
  };
  const columnShape = (column: CompletionColumn): Shape => column.data_type === 'TableRef' && column.table_ref_config
    ? { kind: 'table-reference', interface: 'interface:' + column.table_ref_config.interface_uuid }
    : column.data_type === 'Reference' && column.reference_config
    ? { kind: 'row', table: column.reference_config.target_table_uuid }
    : column.data_type === 'Color' || column.data_type === 'Color32' || column.data_type === 'ColorFloat' ? { kind: 'color' } : unknown;
  const columnIndexes = new Map<string, Map<string, CompletionColumn | null>>();
  const column = (table: string, name: string) => {
    let index = columnIndexes.get(table);
    if (!index) {
      index = new Map();
      for (const column of schema(table)?.columns ?? []) {
        for (const alias of new Set([column.data_name, column.display_name].filter((name): name is string => Boolean(name)).map(key))) {
          index.set(alias, index.has(alias) ? null : column);
        }
      }
      columnIndexes.set(table, index);
    }
    return index.get(key(name)) ?? undefined;
  };
  const member = (shape: Shape, name: string): Shape => {
    if (shape.kind === 'row') { const c = column(shape.table, name); return c ? columnShape(c) : unknown; }
    if (shape.kind === 'record') return [...shape.fields].find(([n]) => eq(n, name))?.[1] ?? unknown;
    return unknown;
  };
  const bind = (env: Env, name: string, shape: Shape): Env => new Map(env).set(key(name), { name, shape });
  function callbackEnv(call: Node, env: Env, argument: number, depth: number): Env {
    let lambda = call.children[argument];
    while (lambda?.kind === 'group') lambda = lambda.children[0];
    if (lambda?.kind !== 'lambda') return env;
    const name = key(call.text), args = call.children;
    const first = args[0] ? infer(args[0], env, depth + 1) : unknown;
    const types = env.has(name) ? [] : name === 'REDUCE' && argument === 2 ? [args[1] ? infer(args[1], env, depth + 1) : unknown, item(first), unknown]
      : name === 'JOIN' && argument === 2 ? [item(first), args[1] ? item(infer(args[1], env, depth + 1)) : unknown]
        : ['MAP', 'FILTER', 'GROUPBY'].includes(name) && argument === 1 ? [item(first), unknown] : [];
    let local = env;
    for (const [i, parameter] of (lambda.params ?? []).entries()) local = bind(local, parameter, types[i] ?? unknown);
    return local;
  }
  let inferenceBudget = 8192;
  function infer(node: Node, env: Env, depth = 0): Shape {
    if (--inferenceBudget < 0 || depth > 32) return unknown;
    if (node.kind === 'group') return infer(node.children[0], env, depth + 1);
    if (node.kind === 'name') {
      if (!node.quoted && env.has(key(node.text))) return env.get(key(node.text))!.shape;
      const c = catalog.currentTable && column(catalog.currentTable, node.text);
      return c ? columnShape(c) : unknown;
    }
    if (node.kind === 'member') return member(infer(node.children[0], env, depth + 1), node.text);
    if (node.kind === 'record') return { kind: 'record', fields: new Map(node.children.map((child, i) => [node.fields?.[i] ?? '', infer(child, env, depth + 1)])) };
    if (node.kind === 'array') {
      const children = node.children.map(child => infer(child, env, depth + 1));
      return { kind: 'collection', item: children.reduce((a, b) => commonShape(a, b), children[0] ?? unknown) };
    }
    if (node.kind !== 'call') return unknown;
    const name = key(node.text), args = node.children;
    if (env.has(name)) return unknown; // User functions may shadow builtins.
    if (name === 'TABLE' && args[0] && args[0].kind !== 'string') {
      const target = infer(args[0], env, depth + 1);
      return target.kind === 'table-reference' ? { kind: 'collection', item: { kind: 'row', table: target.interface } } : unknown;
    }
    if (name === 'TABLE' && args[0]?.kind === 'string') {
      const table = namedTable(args[0].text);
      return table ? { kind: 'collection', item: { kind: 'row', table: table.uuid } } : unknown;
    }
    if (['LET', 'LETREC'].includes(name) && args[0]?.kind === 'name' && args[1] && args[2]) {
      return infer(args[2], bind(env, args[0].text, infer(args[1], env, depth + 1)), depth + 1);
    }
    if (name === 'GROUPBY' && args[0]) return { kind: 'collection', item: { kind: 'record', fields: new Map([['key', unknown], ['rows', infer(args[0], env, depth + 1)]]) } };
    if (name === 'LOOKUP' && args[0]?.kind === 'string' && args[3]?.kind === 'string') {
      const target = namedTable(args[0].text);
      const c = target && column(target.uuid, args[3].text);
      return c ? columnShape(c) : unknown;
    }
    if (name === 'FILTER' && args[0]) return infer(args[0], env, depth + 1);
    let callback = args[1];
    while (callback?.kind === 'group') callback = callback.children[0];
    if (name === 'MAP' && callback?.kind === 'lambda') return { kind: 'collection', item: infer(callback.children[0], callbackEnv(node, env, 1, depth), depth + 1) };
    if (name === 'JOIN' && args[0] && args[1]) return { kind: 'collection', item: { kind: 'record', fields: new Map([['left', item(infer(args[0], env, depth + 1))], ['right', item(infer(args[1], env, depth + 1))]]) } };
    if (name === 'COLOR32' || name === 'COLORFLOAT') return { kind: 'color' };
    return unknown;
  }
  let environment: Env = new Map();
  let receiver: Shape | undefined;
  let tableArgument = false;
  let queryColumns: string | undefined;
  let declaration = false;
  const root = tree(tokens, equals + 1, source.length);
  function visit(node: Node, env: Env, depth = 0): void {
    if (depth > 64 || caret < node.start || caret > node.end) return;
    environment = env;
    if (node.kind === 'member' && caret >= node.children[1].start) {
      receiver = infer(node.children[0], env);
      return;
    }
    if (node.kind === 'call') {
      for (const [index, child] of node.children.entries()) {
        if (caret < child.start || caret > child.end) continue;
        let local = env;
        const name = key(node.text), binding = node.children[0];
        if (!env.has(name) && (name === 'LET' || name === 'LETREC') && binding?.kind === 'name') {
          if (index === 0) declaration = true;
          if (index === 2 || (name === 'LETREC' && index === 1 && child.kind === 'lambda')) local = bind(env, binding.text, index === 2 ? infer(node.children[1], env) : unknown);
        }
        if (!env.has(name) && ['TABLE', 'LOOKUP', 'COUNTIF', 'SUMIF'].includes(name) && index === 0) tableArgument = true;
        if (!env.has(name) && ['LOOKUP', 'COUNTIF', 'SUMIF'].includes(name) && (index === 1 || index === 3) && binding?.kind === 'string') queryColumns = namedTable(binding.text)?.uuid;
        let lambda = child;
        while (lambda.kind === 'group') lambda = lambda.children[0];
        if (!env.has(name) && name === 'LETREC' && index === 1 && lambda.kind === 'lambda' && binding?.kind === 'name') local = bind(env, binding.text, unknown);
        if (lambda.kind === 'lambda') {
          if (caret < lambda.children[0].start) declaration = true;
          else visit(lambda.children[0], callbackEnv(node, local, index, depth), depth + 1);
        } else visit(child, local, depth + 1);
        return;
      }
    }
    if (node.kind === 'lambda') {
      if (caret < node.children[0].start) { declaration = true; return; }
      let local = env;
      for (const name of node.params ?? []) local = bind(local, name, unknown);
      visit(node.children[0], local, depth + 1);
      return;
    }
    for (const child of node.children) visit(child, env, depth + 1);
  }
  visit(root, new Map());
  const result: FormulaCompletion = { start, end, expected: source.slice(start, end), candidates: [], neededTables: [] };
  if (declaration || (active?.kind === 'string' && !tableArgument && !queryColumns)) return null;
  const candidates: FormulaCandidate[] = [];
  const columns = (tableId: string, kind: 'column' | 'field') => {
    const table = schema(tableId);
    for (const c of table?.columns ?? []) {
      if (tableArgument && c.data_type !== 'TableRef' && c.data_type !== 'String') continue;
      const name = [c.data_name, c.display_name].find(n => n && column(tableId, n)?.uuid === c.uuid);
      if (name) candidates.push({ kind, label: c.display_name || c.data_name, detail: c.data_name, insert: queryColumns ? quoteFormulaString(name) : quoteFormulaName(name) });
    }
  };
  if (queryColumns) columns(queryColumns, 'column');
  else if (receiver) {
    if (receiver.kind === 'row') columns(receiver.table, 'field');
    if (receiver.kind === 'record') for (const name of receiver.fields.keys()) if (name) candidates.push({ kind: 'field', label: name, detail: '', insert: quoteFormulaName(name) });
    if (receiver.kind === 'color') for (const name of ['r', 'g', 'b', 'a']) candidates.push({ kind: 'field', label: name, detail: '', insert: name });
  } else {
    if (active?.kind !== 'string') {
      for (const variable of environment.values()) candidates.push({ kind: 'variable', label: variable.name, detail: '', insert: variable.name });
      if (catalog.currentTable) columns(catalog.currentTable, 'column');
    }
    if (!tableArgument) {
      for (const name of catalog.functions) if (!environment.has(key(name))) candidates.push({ kind: 'function', label: name, detail: '', insert: source.slice(end).trimStart().startsWith('(') ? name : name + '()', caretOffset: source.slice(end).trimStart().startsWith('(') ? name.length : name.length + 1 });
    }
    for (const table of catalog.tables) {
      if (table.isInterface) continue;
      const name = namedTable(table.data_name)?.uuid === table.uuid ? table.data_name : table.uuid;
      const value = quoteFormulaString(name);
      candidates.push({ kind: 'table', label: table.display_name || table.data_name, detail: table.data_name, insert: tableArgument ? value : 'TABLE(' + value + ')' });
    }
  }
  const normalizedPrefix = key(prefix);
  result.candidates = candidates.filter(c => key(c.label).includes(normalizedPrefix) || key(c.detail).includes(normalizedPrefix))
    .sort((a, b) => Number(!key(a.label).startsWith(normalizedPrefix)) - Number(!key(b.label).startsWith(normalizedPrefix)) || a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind)).slice(0, 80);
  // Each containing string adds one layer of doubled-quote escaping. Caret
  // offsets must be transformed with the inserted text, not counted as bytes.
  for (const candidate of result.candidates) {
    for (let layer = 0; layer < interpolationDepth; layer++) {
      if (candidate.caretOffset !== undefined) candidate.caretOffset = candidate.insert.slice(0, candidate.caretOffset).replace(/"/g, '""').length;
      candidate.insert = candidate.insert.replace(/"/g, '""');
    }
  }
  result.neededTables = [...needed];
  return result;
}
