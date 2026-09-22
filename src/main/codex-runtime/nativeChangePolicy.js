'use strict';

const { hash } = require('./contracts');

function patchError(message) {
  const error = new Error(message);
  error.code = 'unverifiable_native_diff';
  return error;
}

function splitLines(value) {
  return String(value).replaceAll('\r\n', '\n').split('\n');
}

function applyUnifiedDiff(original, diff) {
  const source = splitLines(original);
  const lines = splitLines(diff);
  const output = [];
  let sourceIndex = 0;
  let foundHunk = false;
  let index = 0;
  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[index]);
    const nativeHeader = lines[index] === '@@' || /^@@ [^+-]/u.test(lines[index]);
    if (!header && nativeHeader) {
      // Native apply_patch hunks have context rather than line coordinates.
      // Only a unique, exact match can serve as approval evidence.
      let end = index + 1;
      const before = [];
      const after = [];
      while (end < lines.length && !lines[end].startsWith('@@')) {
        const line = lines[end];
        if (line === '' && end === lines.length - 1) break;
        if (![' ', '-', '+'].includes(line[0])) throw patchError('原生更新差异包含未知行类型');
        if (line[0] !== '+') before.push(line.slice(1));
        if (line[0] !== '-') after.push(line.slice(1));
        end += 1;
      }
      if (!before.length) throw patchError('无行号补丁缺少定位上下文');
      const matches = [];
      for (let at = sourceIndex; at <= source.length - before.length; at += 1) {
        if (before.every((line, offset) => source[at + offset] === line)) matches.push(at);
      }
      if (matches.length !== 1) throw patchError('原生更新差异无法唯一定位到原文，请提供更多上下文');
      output.push(...source.slice(sourceIndex, matches[0]), ...after);
      sourceIndex = matches[0] + before.length;
      foundHunk = true;
      index = end;
      continue;
    }
    if (!header) {
      if (!foundHunk && (/^(?:---|\+\+\+) /u.test(lines[index]) || lines[index] === '')) { index += 1; continue; }
      if (foundHunk && index === lines.length - 1 && lines[index] === '') break;
      throw patchError('原生更新差异包含无法验证的格式');
    }
    foundHunk = true;
    const oldStart = Number(header[1]);
    const oldCount = header[2] == null ? 1 : Number(header[2]);
    const newCount = header[4] == null ? 1 : Number(header[4]);
    const hunkStart = oldStart === 0 ? 0 : oldStart - 1;
    if (hunkStart < sourceIndex || hunkStart > source.length) throw patchError('原生更新差异的行号超出原文');
    output.push(...source.slice(sourceIndex, hunkStart));
    sourceIndex = hunkStart;
    let consumed = 0;
    let produced = 0;
    index += 1;
    while (index < lines.length && !lines[index].startsWith('@@')) {
      const line = lines[index];
      if (line === '\\ No newline at end of file') { index += 1; continue; }
      if (line === '' && index === lines.length - 1) break;
      const marker = line[0];
      const text = line.slice(1);
      if (marker === ' ') {
        if (source[sourceIndex] !== text) throw patchError('原生更新差异的上下文已与原文不一致');
        output.push(text);
        sourceIndex += 1;
        consumed += 1;
        produced += 1;
      } else if (marker === '-') {
        if (source[sourceIndex] !== text) throw patchError('原生更新差异删除的文字已与原文不一致');
        sourceIndex += 1;
        consumed += 1;
      } else if (marker === '+') {
        output.push(text);
        produced += 1;
      } else {
        throw patchError('原生更新差异包含未知行类型');
      }
      index += 1;
    }
    if (consumed !== oldCount || produced !== newCount) throw patchError('原生更新差异的行数声明不一致');
  }
  if (!foundHunk) throw patchError('原生更新差异缺少可验证的 hunk');
  output.push(...source.slice(sourceIndex));
  return output.join('\n');
}

function normalizedKind(change) {
  return String(change?.kind?.type || '').toLowerCase();
}

function evidenceForNativeChanges(workspace, nativeChanges) {
  return nativeChanges.map((change) => {
    const before = workspace.snapshots.get(change.resourceRef) || null;
    const kind = normalizedKind(change);
    let mode;
    let after;
    if (kind === 'add') {
      if (before) throw patchError(`新增资源已经存在：${change.resourceRef}`);
      mode = 'create';
      after = String(change.diff || '');
    } else if (kind === 'update') {
      if (!before) throw patchError(`更新资源不存在：${change.resourceRef}`);
      mode = 'replace';
      after = applyUnifiedDiff(before.content, change.diff);
    } else if (kind === 'delete') {
      if (!before) throw patchError(`删除资源不存在：${change.resourceRef}`);
      mode = 'delete';
      after = null;
    } else {
      throw patchError(`原生差异类型无法验证：${kind || 'unknown'}`);
    }
    // Native apply_patch terminates non-empty output with a newline for every
    // file type, including JSON and lore. Predict those exact bytes before
    // approval; do not trim/normalize actual content during commit validation.
    if (after != null && after && !after.endsWith('\n')) after += '\n';
    return {
      resourceRef: change.resourceRef,
      mode,
      beforeHash: before?.sourceHash || hash(null),
      afterHash: after == null ? hash(null) : hash(after),
      beforeContent: before?.content || '',
      afterContent: after,
    };
  });
}

function nativeChangeFingerprint(nativeChanges) {
  return hash(nativeChanges.map((change) => ({
    resourceRef: change.resourceRef,
    kind: normalizedKind(change),
    movePath: change?.kind?.move_path || null,
    diff: String(change.diff || ''),
  })));
}

function isAuthorizedProseAppend(evidence) {
  return evidence.length > 0 && evidence.every((change) => {
    if (!change.resourceRef.startsWith('chapter:')) return false;
    if (change.mode === 'create') return true;
    return change.mode === 'replace'
      && change.afterContent.length > change.beforeContent.length
      && change.afterContent.startsWith(change.beforeContent);
  });
}

function assertSelectionChange(selectionState, change) {
  if (!selectionState || change.resourceRef !== selectionState.resourceRef) return selectionState;
  const before = selectionState.content;
  if (hash(before) !== change.beforeHash) throw patchError('选区绑定的章节版本已经变化，请重新选择后再编辑');
  if (change.mode !== 'replace' || change.afterContent == null) throw patchError('局部编辑不能创建或删除章节');
  const { start, end } = selectionState.range;
  if (change.afterContent.slice(0, start) !== before.slice(0, start)) throw patchError('补丁修改了当前选区之前的正文');
  const suffix = before.slice(end);
  if (!change.afterContent.endsWith(suffix)) throw patchError('补丁修改了当前选区之后的正文');
  const replacementEnd = change.afterContent.length - suffix.length;
  if (replacementEnd < start) throw patchError('局部编辑产生了无效选区');
  return { ...selectionState, content: change.afterContent, range: { start, end: replacementEnd } };
}

module.exports = {
  applyUnifiedDiff,
  assertSelectionChange,
  evidenceForNativeChanges,
  isAuthorizedProseAppend,
  nativeChangeFingerprint,
};
