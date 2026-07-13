'use strict';

const { normalizeRiskProfile } = require('../../domain/chapterHarness.cjs');

function unique(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function buildChapterRiskProfile({ targetChapter, mode, editorContext, matchingNodes, diagnostics, entryState } = {}) {
  const nodes = Array.isArray(matchingNodes) ? matchingNodes : [];
  const issues = Array.isArray(diagnostics) ? diagnostics : [];
  const locations = unique(nodes.map((node) => node?.location));
  const times = unique(nodes.map((node) => node?.when));
  const cast = unique(nodes.flatMap((node) => Array.isArray(node?.characters) ? node.characters : []));
  const knowledgeCount = nodes.reduce((sum, node) => sum + (Array.isArray(node?.informationBoundaries) ? node.informationBoundaries.length : 0), 0);
  const dimensions = {
    continuity: entryState?.status === 'stale' ? 3 : entryState ? 0 : 1,
    knowledge: knowledgeCount >= 2 ? 3 : knowledgeCount ? 2 : 0,
    timeline: locations.length >= 3 || times.length >= 3 ? 3 : locations.length >= 2 || times.length >= 2 ? 2 : 0,
    cast: cast.length >= 6 ? 3 : cast.length >= 4 ? 2 : cast.length >= 2 ? 1 : 0,
    outlineConflict: issues.some((item) => item?.severity === 'blocking') ? 3 : issues.length >= 3 ? 2 : issues.length ? 1 : 0,
    revision: mode === 'revise' ? (String(editorContext?.selectedText || '').trim() ? 1 : 3) : 0,
    materials: !nodes.length ? 2 : entryState ? 0 : 1,
  };
  if (/chapter-\d+[a-z]+\.md$/iu.test(String(targetChapter?.name || ''))) dimensions.continuity = 3;
  if (nodes.length >= 3) dimensions.timeline = Math.max(dimensions.timeline, 2);
  const score = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  const level = Object.values(dimensions).some((value) => value >= 3) || score >= 10
    ? 'high'
    : score >= 5 ? 'medium' : 'low';
  const reasons = [];
  if (dimensions.continuity >= 2) reasons.push(entryState?.status === 'stale' ? '上一章状态快照已过期' : '章节插入或连续性边界复杂');
  if (dimensions.knowledge >= 2) reasons.push('存在角色知识或秘密披露边界');
  if (dimensions.timeline >= 2) reasons.push('包含多场景、跨地点或跨时间推进');
  if (dimensions.cast >= 2) reasons.push('出场角色较多');
  if (dimensions.outlineConflict >= 2) reasons.push('上下文资料存在冲突或缺失');
  if (dimensions.revision >= 2) reasons.push('正在修订完整章节');
  return normalizeRiskProfile({
    level,
    score,
    dimensions,
    reasons,
    sourceRefs: entryState?.sourceRefs || [],
  });
}

function resolveAdaptivePolicy({ riskProfile, settings = {} } = {}) {
  const level = riskProfile?.level || 'low';
  return {
    contextDepth: ['compact', 'deep'].includes(settings.contextDepth)
      ? settings.contextDepth
      : level === 'high' ? 'deep' : level === 'low' ? 'compact' : 'auto',
    sceneGeneration: ['chapter', 'scene'].includes(settings.sceneGeneration)
      ? settings.sceneGeneration
      : level === 'low' ? 'chapter' : 'scene',
    verificationLevel: ['fast', 'strict'].includes(settings.verificationLevel)
      ? settings.verificationLevel
      : level === 'high' ? 'strict' : level === 'low' ? 'fast' : 'auto',
  };
}

module.exports = { buildChapterRiskProfile, resolveAdaptivePolicy };
