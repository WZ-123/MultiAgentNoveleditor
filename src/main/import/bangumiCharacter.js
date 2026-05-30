'use strict';

const { networkFetchJson } = require('./networkFetch');

const API_BASE = 'https://api.bgm.tv/v0';
const API_HEADERS = {
  'User-Agent': 'MultiAgentNovelAssistant/1.0',
  Accept: 'application/json',
};

function _compactName(name) {
  return String(name || '').replace(/[·・.\s:：_~～\-()（）]/g, '').toLowerCase();
}

function _flattenInfoboxValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (entry && typeof entry === 'object') {
          const k = String(entry.k || '').trim();
          const v = String(entry.v || '').trim();
          return k ? `${k}: ${v}` : v;
        }
        return String(entry || '').trim();
      })
      .filter(Boolean)
      .join(' / ');
  }
  return String(value || '').trim();
}

function _infoboxMap(infobox) {
  const map = new Map();
  for (const item of infobox || []) {
    const key = String(item?.key || '').trim();
    if (!key) continue;
    map.set(key, _flattenInfoboxValue(item?.value));
  }
  return map;
}

function _namesFromCharacter(item) {
  const names = [];
  if (item?.name) names.push(String(item.name));
  const info = _infoboxMap(item?.infobox);
  const zh = info.get('简体中文名');
  if (zh) names.push(zh);
  const alias = info.get('别名');
  if (alias) names.push(alias);
  return names.filter(Boolean);
}

function _nameLooksRelevant(charName, item) {
  const target = _compactName(charName);
  if (!target) return true;
  return _namesFromCharacter(item).some((name) => _compactName(name).includes(target));
}

function _summaryForSearch(item) {
  const parts = [];
  const summary = String(item?.summary || '').trim();
  if (summary) parts.push(summary);
  const info = _infoboxMap(item?.infobox);
  const extras = ['身高', '体重', '生日', '血型', '种族', '能力', '职业', '身份']
    .map((key) => {
      const val = info.get(key);
      return val ? `${key}: ${val}` : '';
    })
    .filter(Boolean);
  if (extras.length) parts.push(extras.join(' | '));
  return parts.join('\n').trim();
}

function _workMatch(fanworkName, subjects = []) {
  const target = _compactName(fanworkName);
  if (!target) return false;
  return (subjects || []).some((subject) => {
    const names = [subject?.name, subject?.name_cn].filter(Boolean);
    return names.some((name) => {
      const compact = _compactName(name);
      return compact.includes(target) || target.includes(compact);
    });
  });
}

async function _fetchCharacterSubjects(charId) {
  if (!charId) return [];
  try {
    return await networkFetchJson(`${API_BASE}/characters/${charId}/subjects`, {
      headers: API_HEADERS,
      timeout: 15000,
      retries: 1,
    });
  } catch {
    return [];
  }
}

async function bangumiSearchResults(query, _fanworkName, context = {}) {
  const keyword = String(query || '').trim();
  if (!keyword) return [];
  const json = await networkFetchJson(`${API_BASE}/search/characters`, {
    method: 'POST',
    headers: {
      ...API_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ keyword, limit: 8 }),
    timeout: 20000,
    retries: 1,
  });
  const hits = Array.isArray(json?.data) ? json.data : [];
  const fanworkName = context?.fanworkName || '';
  const charName = context?.charName || keyword;

  const detailed = await Promise.all(hits.slice(0, 6).map(async (item) => {
    const subjects = await _fetchCharacterSubjects(item?.id);
    return { item, subjects };
  }));

  return detailed
    .filter(({ item }) => _nameLooksRelevant(charName, item))
    .map(({ item, subjects }) => {
      const info = _infoboxMap(item?.infobox);
      const zhName = info.get('简体中文名') || '';
      const titleName = zhName || item?.name || keyword;
      const workMatched = _workMatch(fanworkName, subjects);
      const subjectText = subjects.slice(0, 4)
        .map((subject) => subject?.name_cn || subject?.name || '')
        .filter(Boolean)
        .join(' / ');
      const snippetParts = [_summaryForSearch(item)];
      if (subjectText) snippetParts.push(`关联作品: ${subjectText}`);
      return {
        title: titleName,
        snippet: snippetParts.filter(Boolean).join('\n'),
        url: `https://chii.in/character/${item.id}`,
        source: 'bangumi',
        bangumiId: item.id,
        workMatched,
      };
    });
}

function _bangumiFieldText(detail = {}, subjects = []) {
  const lines = [];
  const info = _infoboxMap(detail?.infobox);
  const add = (label, value) => {
    const text = String(value || '').trim();
    if (text) lines.push(`${label}: ${text}`);
  };

  add('角色名', info.get('简体中文名') || detail?.name);
  add('原名', detail?.name);
  add('别名', info.get('别名'));
  add('性别', info.get('性别') || detail?.gender);
  add('生日', info.get('生日'));
  add('血型', info.get('血型') || detail?.blood_type);
  add('身高', info.get('身高'));
  add('体重', info.get('体重'));
  add('三围', info.get('BWH'));
  add('种族', info.get('种族'));
  add('能力', info.get('能力'));
  add('职业', info.get('职业'));
  add('身份', info.get('身份'));
  add('出身地', info.get('出身地'));
  add('引用来源', info.get('引用来源'));

  const summary = String(detail?.summary || '').trim();
  if (summary) lines.push(`简介: ${summary}`);

  const related = subjects
    .slice(0, 10)
    .map((subject) => {
      const name = subject?.name_cn || subject?.name || '';
      const staff = String(subject?.staff || '').trim();
      if (!name) return '';
      return staff ? `${name}（${staff}）` : name;
    })
    .filter(Boolean);
  if (related.length) lines.push(`关联作品: ${related.join('；')}`);

  return lines.join('\n');
}

async function bangumiFetchPage(_title, context = {}) {
  const charId = Number(context?.bangumiId || 0);
  if (!charId) return '';
  const detail = await networkFetchJson(`${API_BASE}/characters/${charId}`, {
    headers: API_HEADERS,
    timeout: 20000,
    retries: 1,
  });
  const subjects = await _fetchCharacterSubjects(charId);
  return _bangumiFieldText(detail, subjects);
}

module.exports = {
  bangumiSearchResults,
  bangumiFetchPage,
};
