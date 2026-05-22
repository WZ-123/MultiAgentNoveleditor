'use strict';

function compactText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function splitIntoParagraphs(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  return raw.split(/\n\s*\n/).map((paragraph, index) => ({
    id: `p-${index}`,
    index,
    text: paragraph.trim(),
  }));
}

function candidateNames(character) {
  const aliases = Array.isArray(character?.aliases) ? character.aliases : [];
  return [character?.name, ...aliases]
    .map((item) => compactText(item))
    .filter((item, index, list) => item && list.indexOf(item) === index);
}

function characterMatchesText(character, text) {
  const haystack = compactText(text);
  if (!haystack) return false;
  return candidateNames(character).some((name) => name.length >= 2 && haystack.includes(name));
}

function simplifyCharacter(character) {
  return {
    id: character.id,
    name: character.name,
    aliases: Array.isArray(character.aliases) ? character.aliases : [],
    role: character.role || '',
    appearance: character.appearance || '',
    personality: character.personality || '',
    background: character.background || '',
    quotes: character.quotes || '',
    attributes: character.attributes || {},
  };
}

function uniqueCharacters(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((character) => {
    const id = compactText(character?.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function resolveTargetCharacters(characters, options = {}) {
  const list = Array.isArray(characters) ? characters : [];
  const focus = compactText(options.focus);
  const chapterText = compactText(options.chapterText);
  const requestedIds = Array.isArray(options.characterIds)
    ? options.characterIds.map((item) => compactText(item)).filter(Boolean)
    : [];

  if (requestedIds.length > 0) {
    return uniqueCharacters(list.filter((character) => requestedIds.includes(character.id))).slice(0, 8);
  }

  const focusMatches = uniqueCharacters(list.filter((character) => characterMatchesText(character, focus)));
  if (focusMatches.length > 0) return focusMatches.slice(0, 8);

  const chapterMatches = uniqueCharacters(list.filter((character) => characterMatchesText(character, chapterText)));
  return chapterMatches.slice(0, 8);
}

function buildCharacterConsistencyReviewPayload({ chapterName, chapterText, focus, characters }) {
  const paragraphs = splitIntoParagraphs(chapterText);
  return {
    chapterName,
    focus: compactText(focus),
    targetCharacters: uniqueCharacters(characters).map(simplifyCharacter),
    paragraphs: paragraphs.map((paragraph, index) => ({
      id: paragraph.id,
      index: paragraph.index,
      text: paragraph.text,
      prevParagraphId: index > 0 ? paragraphs[index - 1].id : null,
      prevText: index > 0 ? paragraphs[index - 1].text : '',
      nextParagraphId: index + 1 < paragraphs.length ? paragraphs[index + 1].id : null,
      nextText: index + 1 < paragraphs.length ? paragraphs[index + 1].text : '',
    })),
  };
}

function excerptParagraph(text) {
  const compacted = compactText(text);
  return compacted.length > 80 ? `${compacted.slice(0, 80)}...` : compacted;
}

function enrichCharacterConsistencyAnnotations(rawAnnotations, paragraphs, characters) {
  const paragraphMap = new Map((Array.isArray(paragraphs) ? paragraphs : []).map((paragraph) => [paragraph.id, paragraph]));
  const characterMap = new Map((Array.isArray(characters) ? characters : []).map((character) => [character.id, character]));
  const out = [];
  const seen = new Set();

  for (const annotation of Array.isArray(rawAnnotations) ? rawAnnotations : []) {
    const paragraphIds = Array.isArray(annotation?.paragraphIds)
      ? annotation.paragraphIds.map((item) => compactText(item)).filter((item) => paragraphMap.has(item))
      : [];
    const primaryParagraphId = compactText(annotation?.paragraphId);
    const targets = paragraphIds.length > 0
      ? paragraphIds
      : paragraphMap.has(primaryParagraphId)
        ? [primaryParagraphId]
        : [];
    if (!targets.length) continue;

    const paragraphIndexes = targets
      .map((paragraphId) => paragraphMap.get(paragraphId)?.index)
      .filter((index) => Number.isInteger(index));
    const firstParagraph = paragraphMap.get(targets[0]);
    const characterId = compactText(annotation?.characterId);
    const characterName = characterMap.get(characterId)?.name || '';
    const note = compactText(annotation?.note);
    const evidence = compactText(annotation?.evidence);
    const kind = compactText(annotation?.kind) || 'other';
    const key = `${targets.join(',')}::${characterId}::${kind}::${note}::${evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      paragraphId: targets[0],
      paragraphIds: targets,
      paragraphIndex: Number.isInteger(firstParagraph?.index) ? firstParagraph.index : -1,
      paragraphIndexes,
      excerpt: excerptParagraph(firstParagraph?.text || ''),
      characterId: characterId || '',
      characterName,
      kind,
      note,
      evidence,
    });
  }

  return out.sort((left, right) => left.paragraphIndex - right.paragraphIndex);
}

module.exports = {
  buildCharacterConsistencyReviewPayload,
  enrichCharacterConsistencyAnnotations,
  resolveTargetCharacters,
  splitIntoParagraphs,
};