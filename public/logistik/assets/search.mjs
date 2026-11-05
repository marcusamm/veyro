import { TOOLS } from './registry.mjs';

/** Match Danish text without changing the original, human-readable content. */
export function normalizeSearch(value) {
  if (typeof value !== 'string') return '';
  return value.slice(0, 500).toLocaleLowerCase('da-DK')
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

const compact = (value) => value.replace(/ /g, '');
const stopWords = new Set(['og', 'eller', 'en', 'et', 'den', 'det', 'de', 'der', 'er', 'i', 'pa', 'af', 'til', 'for', 'med', 'jeg', 'mit', 'mine', 'min', 'vi', 'vores', 'skal', 'kan', 'hvordan', 'hvilken', 'hvilke', 'hvad', 'at', 'the', 'a', 'an', 'of', 'and', 'in', 'to']);
const meaningfulWords = (text) => text.split(' ').filter((word) => word.length > 1 && !stopWords.has(word));

const index = TOOLS.filter((tool) => tool.status === 'published').map((tool, order) => ({
  tool,
  order,
  names: [tool.title, tool.shortTitle, tool.englishName].map(normalizeSearch),
  abbreviations: tool.abbreviations.map(normalizeSearch),
  aliases: tool.synonyms.map(normalizeSearch),
  questions: tool.questions.map(normalizeSearch),
}));

/** Bounded optimal-string-alignment distance also accepts one swapped letter. */
function editDistance(a, b, maximum) {
  if (Math.abs(a.length - b.length) > maximum) return maximum + 1;
  let beforePrevious;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], beforePrevious[j - 2] + 1);
      }
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

function nearWord(queryWord, word) {
  if (queryWord === word) return true;
  // Short abbreviations are exact-only; a single unrelated letter must not match.
  if (queryWord.length < 5 || word.length < 5) return false;
  const limit = Math.min(queryWord.length, word.length) >= 10 ? 2 : 1;
  return editDistance(queryWord, word, limit) <= limit;
}

function scoreEntry(entry, query) {
  if (entry.abbreviations.some((value) => compact(value) === compact(query))) return { score: 130, reason: 'Præcis forkortelse' };
  if (entry.names.includes(query)) return { score: 120, reason: 'Præcist navn' };
  if (entry.aliases.includes(query)) return { score: 110, reason: 'Match på betegnelse' };
  if (entry.questions.includes(query)) return { score: 100, reason: 'Passer til dit spørgsmål' };

  // Spaces and hyphens can be inserted in compounds without losing the match.
  if (query.length >= 4 && [...entry.names, ...entry.aliases].some((value) => compact(value) === compact(query))) {
    return { score: 95, reason: 'Match på betegnelse' };
  }

  const words = meaningfulWords(query);
  if (words.length === 0) return null;
  const terms = [...entry.names, ...entry.aliases];
  // Suggestions while typing, including the final incomplete word of a phrase.
  if (query.length >= 2 && terms.some((value) => value.startsWith(query))) {
    return { score: 85, reason: 'Navn eller relateret betegnelse' };
  }

  const candidates = [...terms, ...entry.questions].map(meaningfulWords);
  if (candidates.some((candidate) => words.every((word) => candidate.includes(word)))) {
    return { score: 75, reason: 'Passer til emnet' };
  }

  // Every meaningful query word must match the same candidate phrase. This avoids
  // returning a tool just because one ordinary word in a long query matches.
  if (candidates.some((candidate) => words.every((word) => candidate.some((part) => nearWord(word, part))))) {
    return { score: 55, reason: 'Nært stavematch' };
  }
  return null;
}

/** No network, user-data storage, autoplay or external search service involved. */
export function searchTools(value) {
  const query = normalizeSearch(value);
  if (!query || query.length < 2) return [];
  return index.map((entry) => {
    const match = scoreEntry(entry, query);
    return match ? { tool: entry.tool, ...match, order: entry.order } : null;
  }).filter(Boolean)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ order, ...result }) => result);
}
