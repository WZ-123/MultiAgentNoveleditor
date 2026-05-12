'use strict';

/**
 * Conflict Detector — compares staging (imported) project data with
 * an existing novel project and grades conflicts by severity.
 *
 * Severity levels:
 *   - critical:   Same named entity with contradictory core attributes
 *   - normal:     Same named entity with supplementary differences
 *   - minor:      Similar named entities or style differences
 *
 * detectConflicts(staging, existingNovelDir) -> { conflicts: [...], summary: {...} }
 */

const path = require('node:path');
const fs = require('node:fs').promises;
const { novelPaths } = require('../store/paths');
const { readJson, listJsonFiles } = require('../store/jsonStore');

function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const d = editDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - d / maxLen;
}

// ---------- Character conflict detection ----------

function gradeCharacterConflict(localChar, importedChar) {
  const localName = (localChar.name || '').toLowerCase().trim();
  const importedName = (importedChar.name || '').toLowerCase().trim();

  // Same name -> compare core fields
  if (localName === importedName) {
    const coreFields = ['gender', 'role'];
    const descFields = ['appearance', 'personality', 'background'];
    let hasCritical = false;
    let hasNormal = false;

    for (const f of coreFields) {
      const lv = (localChar[f] || '').toLowerCase().trim();
      const iv = (importedChar[f] || '').toLowerCase().trim();
      if (lv && iv && lv !== iv) {
        hasCritical = true;
      }
    }
    for (const f of descFields) {
      const lv = (localChar[f] || '').toLowerCase().trim();
      const iv = (importedChar[f] || '').toLowerCase().trim();
      if (lv && iv && lv !== iv) {
        hasNormal = true;
      }
    }

    if (hasCritical) {
      return { severity: 'critical', reason: `同名角色「${importedChar.name}」的核心属性（性别/角色定位）与现有项目不一致` };
    }
    if (hasNormal) {
      return { severity: 'normal', reason: `同名角色「${importedChar.name}」的背景/外貌描述与现有项目有差异` };
    }
    return null; // No conflict
  }

  // Similar names -> minor conflict
  const sim = similarity(localName, importedName);
  if (sim > 0.6 && localName.length > 1 && importedName.length > 1) {
    return { severity: 'minor', reason: `角色「${localChar.name}」与导入角色「${importedChar.name}」名字相似（相似度 ${Math.round(sim * 100)}%）` };
  }

  return null;
}

// ---------- World conflict detection ----------

function gradeWorldConflict(localLore, importedLore) {
  if (!localLore || !importedLore) return null;
  // Simple length-based heuristic — full semantic comparison is done via AI
  const ratio = Math.max(localLore.length, importedLore.length) / (Math.min(localLore.length, importedLore.length) || 1);
  if (ratio > 3) {
    return { severity: 'normal', reason: '世界观篇幅差异较大，可能在细节程度上存在较大不同' };
  }
  return { severity: 'minor', reason: '世界观设定描述不同，建议查看详细对比' };
}

function gradePlacesConflict(localPlaces, importedPlaces) {
  if (!Array.isArray(localPlaces) || !Array.isArray(importedPlaces)) return [];
  const conflicts = [];
  for (const lp of localPlaces) {
    const lpName = (lp.name || '').toLowerCase().trim();
    if (!lpName) continue;
    for (const ip of importedPlaces) {
      const ipName = (ip.name || '').toLowerCase().trim();
      if (!ipName) continue;
      if (lpName === ipName) {
        const lDesc = (lp.description || '').slice(0, 50);
        const iDesc = (ip.description || '').slice(0, 50);
        if (lDesc && iDesc && lDesc !== iDesc) {
          conflicts.push({
            severity: 'normal',
            reason: `同名地点「${ip.name}」的描述不同`,
            detail: `现有: "${lDesc}..." → 导入: "${iDesc}..."`,
          });
        }
      } else if (similarity(lpName, ipName) > 0.7) {
        conflicts.push({
          severity: 'minor',
          reason: `地点名相似: 「${lp.name}」 ↔ 「${ip.name}」`,
        });
      }
    }
  }
  return conflicts;
}

// ---------- Outline conflict detection ----------

function gradeOutlineConflict(localOutlines, importedOutlines) {
  if (!localOutlines && !importedOutlines) return [];
  if (!localOutlines) return [];
  if (!importedOutlines) return [];
  const conflicts = [];
  const localLen = (typeof localOutlines === 'string' ? localOutlines : '').length;
  const importedLen = (typeof importedOutlines === 'string' ? importedOutlines : '').length;
  if (localLen > 0 && importedLen > 0) {
    const ratio = Math.max(localLen, importedLen) / Math.min(localLen, importedLen);
    if (ratio > 2) {
      conflicts.push({
        severity: 'normal',
        reason: '大纲内容量差异较大，可能存在剧情走向上的分歧',
      });
    } else {
      conflicts.push({
        severity: 'minor',
        reason: '大纲内容不同，建议详细对比章节结构',
      });
    }
  }
  return conflicts;
}

// ---------- Style conflict detection ----------

function gradeStyleConflict(localStyle, importedStyle) {
  if (!localStyle && !importedStyle) return [];
  if (!localStyle) return [];
  if (!importedStyle) return [];
  if (localStyle.length > 0 && importedStyle.length > 0) {
    return [{
      severity: 'minor',
      reason: '文风特征不同，合并后可能需要统一文风',
    }];
  }
  return [];
}

// ---------- Load existing novel data ----------

async function loadLocalChapterOutline(novelDir) {
  const np = novelPaths(novelDir);
  let outlineText = '';
  try {
    const files = await fs.readdir(np.outlines);
    for (const f of files.sort()) {
      if (f.endsWith('.md')) {
        outlineText += await fs.readFile(path.join(np.outlines, f), 'utf8') + '\n';
      }
    }
  } catch { /* ignore */ }
  return outlineText;
}

async function loadLocalCharacters(novelDir) {
  const np = novelPaths(novelDir);
  try {
    return await listJsonFiles(np.characters);
  } catch { return []; }
}

async function loadLocalWorld(novelDir) {
  const np = novelPaths(novelDir);
  let lore = '';
  let places = [];
  try {
    lore = await fs.readFile(path.join(np.world, 'lore.md'), 'utf8');
  } catch { /* ignore */ }
  try {
    const placesData = await readJson(path.join(np.world, 'places.json'), { places: [] });
    places = placesData.places || [];
  } catch { /* ignore */ }
  return { lore, places };
}

async function loadLocalStyle(novelDir) {
  const np = novelPaths(novelDir);
  try {
    return await fs.readFile(path.join(np.style, 'memory.md'), 'utf8');
  } catch { return ''; }
}

// ---------- Main detection function ----------

async function detectConflicts(stagingProject, novelDir) {
  const conflicts = [];

  // 1. Character conflicts
  if (stagingProject.characters?.length > 0) {
    const localChars = await loadLocalCharacters(novelDir);
    for (const importedChar of stagingProject.characters) {
      for (const localChar of localChars) {
        const conflict = gradeCharacterConflict(localChar, importedChar);
        if (conflict) {
          conflicts.push({
            type: 'character',
            severity: conflict.severity,
            reason: conflict.reason,
            importedTarget: importedChar.name || importedChar.id,
            localTarget: localChar.name || localChar.id,
            importedContent: JSON.stringify(importedChar, null, 2),
            localContent: JSON.stringify(localChar, null, 2),
          });
        }
      }
    }
  }

  // 2. World conflicts
  const localWorld = await loadLocalWorld(novelDir);
  if (stagingProject.world?.lore || stagingProject.world?.places?.length > 0) {
    const loreConflict = gradeWorldConflict(localWorld.lore, stagingProject.world.lore);
    if (loreConflict) {
      conflicts.push({
        type: 'world',
        severity: loreConflict.severity,
        reason: loreConflict.reason,
        importedTarget: '世界观设定',
        localTarget: '世界观设定',
        importedContent: stagingProject.world.lore?.slice(0, 2000) || '',
        localContent: localWorld.lore.slice(0, 2000),
      });
    }

    const placeConflicts = gradePlacesConflict(localWorld.places, stagingProject.world.places || []);
    for (const pc of placeConflicts) {
      conflicts.push({
        type: 'world',
        severity: pc.severity,
        reason: pc.reason,
        detail: pc.detail,
        importedTarget: '地点',
        localTarget: '地点',
        importedContent: '',
        localContent: '',
      });
    }
  }

  // 3. Outline conflicts
  const localOutline = await loadLocalChapterOutline(novelDir);
  if (stagingProject.outline) {
    const outlineConflicts = gradeOutlineConflict(localOutline, stagingProject.outline);
    for (const oc of outlineConflicts) {
      conflicts.push({
        type: 'outline',
        severity: oc.severity,
        reason: oc.reason,
        importedTarget: '大纲',
        localTarget: '大纲',
        importedContent: stagingProject.outline.slice(0, 3000),
        localContent: localOutline.slice(0, 3000),
      });
    }
  }

  // 4. Style conflicts
  const localStyle = await loadLocalStyle(novelDir);
  if (stagingProject.styleMemory) {
    const styleConflicts = gradeStyleConflict(localStyle, stagingProject.styleMemory);
    for (const sc of styleConflicts) {
      conflicts.push({
        type: 'style',
        severity: sc.severity,
        reason: sc.reason,
        importedTarget: '文风',
        localTarget: '文风',
        importedContent: stagingProject.styleMemory.slice(0, 2000),
        localContent: localStyle.slice(0, 2000),
      });
    }
  }

  // Summary
  const summary = { critical: 0, normal: 0, minor: 0, total: 0 };
  for (const c of conflicts) {
    if (c.severity === 'critical') summary.critical++;
    else if (c.severity === 'normal') summary.normal++;
    else summary.minor++;
  }
  summary.total = conflicts.length;

  return { conflicts, summary };
}

module.exports = { detectConflicts };
