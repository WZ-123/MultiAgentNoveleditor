'use strict';

function ineligibleCharacters(characters) {
  return (characters || []).filter((character) => character?.isOriginal !== false);
}

function assertFanworkCharacters(characters) {
  const ineligible = ineligibleCharacters(characters);
  if (!ineligible.length) return characters;
  const names = ineligible.map((character) => character?.name || character?.id || '?').join('、');
  throw new Error(`以下角色未标记为二创，已停止补全：${names}。请先编辑角色卡，选择“二创角色”并填写原作。`);
}

module.exports = { ineligibleCharacters, assertFanworkCharacters };
