import React, { useMemo } from 'react';
import { diff_match_patch } from 'diff-match-patch';

const dmp = new diff_match_patch();

/**
 * Compute paragraph-level diffs between left and right text.
 * Returns array of segments: { type: 'equal'|'delete'|'insert', text }
 */
function computeDiff(left, right) {
  if (!left && !right) return [{ type: 'equal', text: '' }];
  if (!left) return [{ type: 'insert', text: right }];
  if (!right) return [{ type: 'delete', text: left }];

  // Use the diff library at paragraph level by splitting first
  const diffs = dmp.diff_main(left, right);
  dmp.diff_cleanupSemantic(diffs);
  return diffs.map(([op, text]) => ({
    type: op === 0 ? 'equal' : op === -1 ? 'delete' : 'insert',
    text,
  }));
}

const diffColors = {
  equal: 'text-gray-300',
  delete: 'text-red-300 bg-red-900/30',
  insert: 'text-green-300 bg-green-900/30',
};

const diffLabel = {
  equal: '',
  delete: '仅导入版',
  insert: '仅现有版',
};

export function MergeDiffView({ leftContent, rightContent, leftLabel, rightLabel }) {
  const diffs = useMemo(() => computeDiff(leftContent || '', rightContent || ''), [leftContent, rightContent]);

  // Split diff segments into left-only, right-only content
  const leftParts = [];
  const rightParts = [];
  let leftIdx = 0;
  let rightIdx = 0;

  for (const seg of diffs) {
    if (seg.type === 'equal') {
      leftParts.push({ text: seg.text, type: 'equal' });
      rightParts.push({ text: seg.text, type: 'equal' });
    } else if (seg.type === 'delete') {
      leftParts.push({ text: seg.text, type: 'delete' });
    } else if (seg.type === 'insert') {
      rightParts.push({ text: seg.text, type: 'insert' });
    }
  }

  const renderContent = (parts, label, side) => (
    <div className="flex flex-col h-full">
      <div className="px-2 py-1 text-[11px] font-semibold text-gray-400 border-b border-vscode-panel-border bg-vscode-sidebar/50 shrink-0">
        {label || (side === 'left' ? '导入版本' : '现有版本')}
      </div>
      <div className="flex-1 overflow-y-auto p-2 text-xs font-mono whitespace-pre-wrap leading-relaxed">
        {parts.length === 0 && (
          <div className="text-gray-600 italic">（无内容）</div>
        )}
        {parts.map((part, i) => (
          <span
            key={i}
            className={`${diffColors[part.type] || 'text-gray-300'} ${part.type !== 'equal' ? 'rounded px-0.5' : ''}`}
          >
            {part.text}
          </span>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex h-full border border-vscode-panel-border rounded overflow-hidden">
      <div className="flex-1 w-1/2 border-r border-vscode-panel-border overflow-hidden">
        {renderContent(leftParts, leftLabel, 'left')}
      </div>
      <div className="flex-1 w-1/2 overflow-hidden">
        {renderContent(rightParts, rightLabel, 'right')}
      </div>
    </div>
  );
}
