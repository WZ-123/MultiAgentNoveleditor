#!/usr/bin/env node
'use strict';

/**
 * Focused Code Quality Audit
 *
 * Detects specific bug patterns that have caused crashes:
 * 1. TDZ in React hooks: useMemo/useCallback/useEffect callbacks that
 *    reference const/let/function declarations appearing AFTER the hook.
 *    (This caused the dataTabLabel crash.)
 * 2. Unused ES imports: named/default imports never referenced.
 * 3. Circular require() / import() dependencies.
 */

const fs = require('node:fs');
const path = require('node:path');

let TOTAL_ISSUES = 0;
const ISSUES = [];

function report(file, line, type, message) {
  TOTAL_ISSUES++;
  ISSUES.push({ file, line, type, message });
  console.log(`  ❌ [${type}] ${file}:${line} — ${message}`);
}

// ── File discovery ────────────────────────────────────────────────

function findJsFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('tmp-test')) continue;
      findJsFiles(full, out);
    } else if (/\.(js|jsx|mjs)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const SRC_DIR = path.join(__dirname, '..', 'src');
const files = findJsFiles(SRC_DIR);

// ── Helpers ──────────────────────────────────────────────────────

function lineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

function extractImports(content) {
  const imports = [];
  const esRe = /^\s*import\s+(?:(\{[^}]+\})|(\*\s+as\s+\w+)|(\w+))\s+from\s+['"]([^'"]+)['"]/gm;
  let m;
  while ((m = esRe.exec(content)) !== null) {
    const names = [];
    if (m[1]) {
      const named = m[1].slice(1, -1).split(',');
      for (const n of named) {
        const parts = n.trim().split(/\s+/);
        const alias = parts[parts.length - 1];
        const original = parts[0];
        names.push({ name: alias, original });
      }
    }
    if (m[3]) names.push({ name: m[3], original: m[3] }); // default import
    imports.push({ names, source: m[4], line: lineNumber(content, m.index) });
  }
  return imports;
}

function findAllConstLetFunctionDecls(content) {
  const decls = [];
  // const/let arrow functions: const foo = () => ...
  const arrowRe = /(?:^|[;\s])(const|let)\s+(\w+)\s*=/gm;
  let m;
  while ((m = arrowRe.exec(content)) !== null) {
    decls.push({ name: m[2], kind: 'const', index: m.index });
  }
  // function declarations: function foo()
  const funcRe = /(?:^|[;\s])function\s+(\w+)\s*\(/gm;
  while ((m = funcRe.exec(content)) !== null) {
    decls.push({ name: m[1], kind: 'function', index: m.index });
  }
  // function expressions in object: foo() { ... }  (skip, inside objects)
  return decls;
}

function findHookCallbacks(content) {
  const hooks = [];
  // Only useMemo has true TDZ risk: its callback is EXECUTED during render.
  // useCallback/useEffect only CREATE the closure during render; the body
  // runs later when all const/let declarations are already initialized.
  const re = /\b(useMemo)\s*\(\s*/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const start = m.index + m[0].length;
    // Find the callback — skip to the opening brace or paren-arrow
    let pos = start;
    while (pos < content.length && /\s/.test(content[pos])) pos++;
    if (content[pos] === '(') {
      // Arrow function with parens: () => { ... } or () => ( ... )
      // Find matching paren for params
      let depth = 1;
      pos++;
      while (pos < content.length && depth > 0) {
        if (content[pos] === '(') depth++;
        if (content[pos] === ')') depth--;
        pos++;
      }
      // Skip =>
      while (pos < content.length && /\s/.test(content[pos])) pos++;
      if (content.slice(pos, pos + 2) === '=>') pos += 2;
      while (pos < content.length && /\s/.test(content[pos])) pos++;
      // Now at start of body
      if (content[pos] === '{') {
        const bodyStart = pos;
        const bodyEnd = findMatchingBrace(content, bodyStart);
        if (bodyEnd > 0) {
          hooks.push({
            name: m[1],
            body: content.slice(bodyStart + 1, bodyEnd),
            line: lineNumber(content, m.index),
            startIndex: m.index,
            endIndex: bodyEnd,
          });
        }
      }
    }
  }
  return hooks;
}

function findMatchingBrace(text, openPos) {
  let depth = 1;
  let i = openPos + 1;
  let inString = false;
  let stringChar = null;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    const prev = text[i - 1];
    if (!inString) {
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    } else {
      if (ch === stringChar && prev !== '\\') {
        inString = false;
        stringChar = null;
      }
    }
    i++;
  }
  return -1;
}

function extractCallbackParams(content, hookStart) {
  // Extract params from () => or function() just before the hook body
  const before = content.slice(hookStart - 100, hookStart);
  const match = before.match(/\(([^)]*)\)\s*=>/);
  if (!match) return [];
  return match[1].split(',').map((p) => {
    const name = p.trim().split(/\s*=/)[0].trim();
    return name.replace(/^\.\.\./, '');
  }).filter(Boolean);
}

function extractAllLocalParams(body) {
  const params = new Set();
  // Multi-param arrow functions: (a, b) => or (a) =>
  // Require captured text to start with a valid identifier char so we
  // don't start matching at the outer call paren (e.g. forEach((entry) =>).
  const multiRe = /\(\s*([a-zA-Z_$][a-zA-Z0-9_$\s,]*)\s*\)\s*=>/g;
  let m;
  while ((m = multiRe.exec(body)) !== null) {
    m[1].split(',').forEach((p) => {
      const name = p.trim().split(/\s+/)[0];
      if (name) {
        params.add(name.replace(/^\.\.\./, ''));
      }
    });
  }
  // Single-param arrow functions without parens: word =>
  const singleRe = /(?:^|[^\w.])(\w+)\s*=>/g;
  while ((m = singleRe.exec(body)) !== null) {
    params.add(m[1]);
  }
  return params;
}

function extractIdentifiers(text) {
  const ids = new Set();
  // Match identifiers, exclude property accesses
  const re = /(?<![.\w$])([a-zA-Z_$][a-zA-Z0-9_$]*)(?!\s*:)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

// ── Check 1: TDZ in React hooks ─────────────────────────────────

const GLOBALS = new Set([
  'window','document','console','fetch','setTimeout','setInterval','clearTimeout','clearInterval',
  'Promise','Array','Object','String','Number','Date','Math','JSON','RegExp','Error','Map','Set',
  'Symbol','BigInt','process','require','module','exports','Buffer',
  'useState','useEffect','useMemo','useCallback','useRef','useContext','useReducer',
  'useLayoutEffect','useImperativeHandle','useDebugValue','useId','useTransition',
  'useDeferredValue','useSyncExternalStore','useInsertionEffect',
  'true','false','null','undefined','NaN','Infinity','this','arguments','super',
  'import','export','default','return','if','else','for','while','do','switch','case',
  'break','continue','try','catch','finally','throw','new','typeof','instanceof',
  'in','of','void','delete','await','async','yield','const','let','var','function',
  'class','extends','static','get','set','constructor','debugger','with',
  'alert','confirm','prompt','location','history','navigator','screen',
  'localStorage','sessionStorage','indexedDB','Event','CustomEvent',
  'requestAnimationFrame','cancelAnimationFrame',
  'btoa','atob','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
  'parseInt','parseFloat','isNaN','isFinite',
  // React globals commonly used in JSX
  'React','Fragment','Suspense','lazy','memo','forwardRef','createElement','cloneElement',
  'Children','StrictMode','Profiler',
]);

function checkTdz(file, content) {
  // Only check React components (files with hooks)
  if (!/\buseMemo\b|\buseCallback\b|\buseEffect\b/.test(content)) return;

  const hooks = findHookCallbacks(content);
  // Only consider declarations OUTSIDE all hook callbacks
  const decls = findAllConstLetFunctionDecls(content).filter((d) =>
    !hooks.some((h) => d.index > h.startIndex && d.index < h.endIndex)
  );

  for (const hook of hooks) {
    const params = extractCallbackParams(content, hook.startIndex);
    const localParams = extractAllLocalParams(hook.body);
    const paramSet = new Set([...params, ...localParams]);
    const ids = extractIdentifiers(hook.body);

    for (const id of ids) {
      if (GLOBALS.has(id)) continue;
      if (paramSet.has(id)) continue;
      if (id === hook.name) continue;

      // Find if id is declared AFTER this hook (must be after hook end, not inside callback)
      const laterDecl = decls.find((d) => d.name === id && d.index > hook.endIndex);
      if (!laterDecl) continue;

      // Skip function declarations — they are hoisted and don't have TDZ
      if (laterDecl.kind === 'function') continue;

      // Find if id is also declared BEFORE this hook (in which case the later one is a re-declaration)
      const earlierDecl = decls.find((d) => d.name === id && d.index < hook.startIndex);
      if (earlierDecl) continue;

      // Skip identifiers that are property names in the body (heuristic: surrounded by . or ?.)
      const positions = [];
      let pos = hook.body.indexOf(id);
      while (pos !== -1) {
        positions.push(pos);
        pos = hook.body.indexOf(id, pos + 1);
      }
      let isProperty = false;
      for (const p of positions) {
        const prev = hook.body[p - 1];
        if (prev === '.' || (prev === '?' && hook.body[p - 2] === '.')) {
          isProperty = true;
          break;
        }
      }
      if (isProperty) continue;

      report(file, hook.line, 'TDZ', `${hook.name} callback references "${id}" which is declared at line ${lineNumber(content, laterDecl.index)} (after the hook)`);
    }
  }
}

// ── Check 2: Unused imports ─────────────────────────────────────

function checkUnusedImports(file, content) {
  const imports = extractImports(content);
  for (const imp of imports) {
    for (const { name, original } of imp.names) {
      // Count references excluding the import declaration line
      const lines = content.split('\n');
      let refCount = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i === imp.line - 1) continue; // skip import line
        // Simple word-boundary check
        const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        if (re.test(line)) refCount++;
      }
      if (refCount === 0) {
        report(file, imp.line, 'UNUSED_IMPORT', `imported "${original}${original !== name ? ` as ${name}` : ''}" from "${imp.source}" is never used`);
      }
    }
  }
}

// ── Check 3: Circular dependencies ──────────────────────────────

function extractRequires(content) {
  const reqs = [];
  const re = /require\(['"]([^'"]+)['"]\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    reqs.push(m[1]);
  }
  return reqs;
}

function resolveRelative(baseDir, relPath) {
  const candidates = [
    path.join(baseDir, relPath),
    path.join(baseDir, relPath + '.js'),
    path.join(baseDir, relPath + '.jsx'),
    path.join(baseDir, relPath, 'index.js'),
    path.join(baseDir, relPath, 'index.jsx'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.relative(SRC_DIR, c);
  }
  return null;
}

function checkCircularDeps(files) {
  const graph = new Map();
  for (const file of files) {
    const rel = path.relative(SRC_DIR, file);
    const content = fs.readFileSync(file, 'utf8');
    const baseDir = path.dirname(file);
    const deps = new Set();
    for (const src of extractRequires(content)) {
      if (src.startsWith('.')) {
        const resolved = resolveRelative(baseDir, src);
        if (resolved) deps.add(resolved);
      }
    }
    for (const imp of extractImports(content)) {
      if (imp.source.startsWith('.')) {
        const resolved = resolveRelative(baseDir, imp.source);
        if (resolved) deps.add(resolved);
      }
    }
    graph.set(rel, [...deps]);
  }

  const visited = new Set();
  const stack = new Set();
  const cycles = [];

  function dfs(node, path) {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) cycles.push(path.slice(cycleStart).concat([node]));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    for (const dep of (graph.get(node) || [])) {
      if (dep.endsWith('.js') || dep.endsWith('.jsx')) dfs(dep, path.concat([node]));
    }
    stack.delete(node);
  }

  for (const node of graph.keys()) dfs(node, []);

  for (const cycle of cycles) {
    report(cycle[0], 1, 'CIRCULAR_DEP', cycle.join(' → '));
  }
}

// ── Run ──────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════');
console.log(' Code Quality Audit');
console.log('═══════════════════════════════════════════');
console.log(`Scanning ${files.length} JS/JSX files...\n`);

for (const file of files) {
  const rel = path.relative(SRC_DIR, file);
  try {
    const content = fs.readFileSync(file, 'utf8');
    checkTdz(rel, content);
    checkUnusedImports(rel, content);
  } catch (err) {
    console.error(`  ⚠️  Parse error in ${rel}: ${err.message}`);
  }
}

console.log('\n[Checking circular dependencies...]');
checkCircularDeps(files);

console.log('\n═══════════════════════════════════════════');
if (TOTAL_ISSUES === 0) {
  console.log(' ✅ No issues found');
} else {
  console.log(` ❌ Found ${TOTAL_ISSUES} issue(s):`);
  const byType = {};
  for (const i of ISSUES) byType[i.type] = (byType[i.type] || 0) + 1;
  for (const [type, count] of Object.entries(byType).sort()) {
    console.log(`   ${type}: ${count}`);
  }
}
console.log('═══════════════════════════════════════════');

process.exit(TOTAL_ISSUES > 0 ? 1 : 0);
