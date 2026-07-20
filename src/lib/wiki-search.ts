import * as path from 'path';
import { loadOkfConcepts, type OkfConceptDocument, type OkfConceptSource } from './okf-wiki.js';

export interface WikiSearchOptions {
  limit?: number;
  source?: string;
}

export interface WikiSearchMatch {
  description?: string;
  path: string;
  score: number;
  snippet: string;
  sources?: OkfConceptSource[];
  tags: string[];
  title: string;
  type: string;
}

export interface WikiSearchResult {
  query: string;
  results: WikiSearchMatch[];
  source: string;
  total: number;
}

interface SearchField {
  phraseWeight: number;
  termWeight: number;
  values: string[];
}

const DEFAULT_LIMIT = 10;

/** Search a validated OKF bundle without a model or generated site index. */
export async function searchWiki(
  workingDir: string,
  query: string,
  options: WikiSearchOptions = {}
): Promise<WikiSearchResult> {
  const displayQuery = cleanDisplayText(query);
  const normalizedQuery = normalizeSearchText(displayQuery);
  if (!normalizedQuery) throw new Error('Wiki search query cannot be empty.');

  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('Wiki search limit must be a positive integer.');
  }

  const bundle = await loadOkfConcepts(workingDir, options.source ?? 'wiki');
  const terms = [...new Set(normalizedQuery.split(' '))];
  const matches = bundle.concepts
    .map((concept) => scoreConcept(bundle.root, concept, normalizedQuery, terms))
    .filter((match): match is WikiSearchMatch => match !== null)
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareStrings(left.title, right.title) ||
        compareStrings(left.path, right.path)
    );

  return {
    query: displayQuery,
    results: matches.slice(0, limit),
    source: bundle.root,
    total: matches.length,
  };
}

function scoreConcept(
  root: string,
  concept: OkfConceptDocument,
  phrase: string,
  terms: string[]
): WikiSearchMatch | null {
  const headings = extractHeadings(concept.body);
  const title = cleanDisplayText(concept.title ?? headings[0] ?? titleFromPath(concept.path));
  const description = concept.description ? cleanDisplayText(concept.description) : undefined;
  const tags = concept.tags.map(cleanDisplayText).filter(Boolean);
  const fields: SearchField[] = [
    { values: [title], phraseWeight: 80, termWeight: 20 },
    { values: tags, phraseWeight: 50, termWeight: 15 },
    { values: [description ?? ''], phraseWeight: 40, termWeight: 10 },
    { values: headings, phraseWeight: 30, termWeight: 8 },
    { values: [concept.path], phraseWeight: 24, termWeight: 6 },
    { values: [concept.type], phraseWeight: 20, termWeight: 5 },
    { values: [concept.body], phraseWeight: 16, termWeight: 2 },
  ];
  const allTokens = new Set(fields.flatMap((field) => field.values.flatMap(tokenize)));
  const matchedTerms = terms.filter((term) => allTokens.has(term));
  if (matchedTerms.length === 0) return null;

  let score = matchedTerms.length * 3;
  if (matchedTerms.length === terms.length) score += 25;
  if (normalizeSearchText(title) === phrase) score += 100;
  for (const field of fields) {
    const normalizedValues = field.values.map(normalizeSearchText).filter(Boolean);
    if (normalizedValues.some((value) => value.includes(phrase))) score += field.phraseWeight;
    const tokens = new Set(normalizedValues.flatMap((value) => value.split(' ')));
    score += terms.filter((term) => tokens.has(term)).length * field.termWeight;
  }

  return {
    path: path.posix.join(root, concept.path),
    score,
    snippet: createSnippet(concept, phrase, terms),
    ...(concept.sources?.length ? { sources: concept.sources } : {}),
    tags,
    title,
    type: cleanDisplayText(concept.type),
    ...(description ? { description } : {}),
  };
}

function createSnippet(concept: OkfConceptDocument, phrase: string, terms: string[]): string {
  const bodySegments = concept.body
    .split(/\n\s*\n/gu)
    .map(stripMarkdown)
    .filter(Boolean);
  const candidates = [
    concept.description ? cleanDisplayText(concept.description) : '',
    ...bodySegments,
    cleanDisplayText(concept.title ?? ''),
    concept.tags.map(cleanDisplayText).join(', '),
    cleanDisplayText(concept.type),
    cleanDisplayText(concept.path),
  ]
    .filter(Boolean)
    .map((value, index) => ({ index, score: snippetScore(value, phrase, terms), value }));
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = candidates[0]?.value ?? cleanDisplayText(concept.title ?? concept.path);
  return excerpt(selected, phrase, terms, 180);
}

function snippetScore(value: string, phrase: string, terms: string[]): number {
  const normalized = normalizeSearchText(value);
  const tokens = new Set(normalized.split(' '));
  return (normalized.includes(phrase) ? 10 : 0) + terms.filter((term) => tokens.has(term)).length;
}

function excerpt(value: string, phrase: string, terms: string[], maximumLength: number): string {
  const normalizedValue = value.normalize('NFKC');
  const characters = [...normalizedValue];
  if (characters.length <= maximumLength) return normalizedValue;
  const matchIndex = findSearchMatchOffset(normalizedValue, [phrase, ...terms]);
  const start = Math.max(0, (matchIndex < 0 ? 0 : matchIndex) - 40);
  const end = Math.min(characters.length, start + maximumLength);
  return `${start > 0 ? '...' : ''}${characters.slice(start, end).join('').trim()}${end < characters.length ? '...' : ''}`;
}

function findSearchMatchOffset(value: string, candidates: string[]): number {
  let searchable = '';
  const offsets: number[] = [];
  let previousWasSeparator = true;
  for (const [offset, character] of [...value].entries()) {
    const normalized = character.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ');
    for (const normalizedCharacter of normalized) {
      const separator = normalizedCharacter === ' ';
      if (separator && previousWasSeparator) continue;
      searchable += normalizedCharacter;
      offsets.push(offset);
      previousWasSeparator = separator;
    }
  }
  if (searchable.endsWith(' ')) {
    searchable = searchable.slice(0, -1);
    offsets.pop();
  }

  const searchIndex = candidates.reduce((best, candidate) => {
    const index = searchable.indexOf(candidate);
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);
  return searchIndex < 0 ? -1 : (offsets[searchIndex] ?? -1);
}

function extractHeadings(body: string): string[] {
  const headings: string[] = [];
  let fence: { character: string; length: number } | undefined;
  for (const line of body.split(/\r?\n/gu)) {
    const fenceLine = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fenceLine) {
      const [, fenceMatch, remainder] = fenceLine;
      if (!fence) {
        if (fenceMatch[0] !== '`' || !remainder.includes('`')) {
          fence = { character: fenceMatch[0], length: fenceMatch.length };
        }
      } else if (
        fenceMatch[0] === fence.character &&
        fenceMatch.length >= fence.length &&
        !remainder.trim()
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line)?.[1];
    if (heading) headings.push(stripMarkdown(heading));
  }
  return headings;
}

function stripMarkdown(value: string): string {
  return cleanDisplayText(
    value
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+\.)\s+/gmu, '')
      .replace(/[`*_~>]/gu, ' ')
  );
}

function tokenize(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return normalized ? normalized.split(' ') : [];
}

function normalizeSearchText(value: string): string {
  return cleanDisplayText(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function cleanDisplayText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const unsafeControl =
        codePoint <= 8 ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        (codePoint >= 127 && codePoint <= 159);
      return unsafeControl ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

function titleFromPath(relativePath: string): string {
  const slug = path.posix.basename(relativePath, '.md');
  return slug
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
