import type { FindingClass, FindingInput, RequirementKind } from '@intentra/contracts';

export const SPEC_MAX_BYTES = 24 * 1024;

export const REQUIRED_SECTIONS = [
  'context',
  'goal',
  'non-goals',
  'scenarios',
  'constraints',
  'acceptance criteria',
  'definition of done',
  'decisions',
  'risks',
] as const;

export type SectionKey = (typeof REQUIRED_SECTIONS)[number];

export interface AcRow {
  readonly acId: string;
  readonly text: string;
  readonly kind: RequirementKind;
}

export interface DodDraft {
  readonly acId: string;
  readonly testRef: string | null;
  readonly probe: string | null;
}

export interface ParsedSpec {
  readonly sections: ReadonlyMap<SectionKey, string>;
  readonly acRows: readonly AcRow[];
  readonly dodRows: readonly DodDraft[];
}

export interface ParseResult {
  readonly parsed: ParsedSpec;
  readonly findings: readonly FindingInput[];
}

const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(?:```|~~~)/;
const SEPARATOR_CELL = /^:?-{2,}:?$/;
const AC_ID = /^AC-\d+$/;
const TEST_REF = /^[A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+(?:::.+)?$/;
const EMPTY_CELL = /^(?:-|—|–|\*|n\/a|none|нет)$/i;
const STUB_PATTERNS = [/\bTBD\b/i, /\bTODO\b/i, /\bFIXME\b/i, /\bXXX\b/, /\{\{[^}\n]{1,80}\}\}/, /\[\[[^\]\n]{1,80}\]\]/, /(?:^|\s)\.\.\.(?:\s|$)/];

const SECTION_ALIASES: Readonly<Record<string, SectionKey>> = {
  context: 'context',
  контекст: 'context',
  goal: 'goal',
  цель: 'goal',
  'non-goals': 'non-goals',
  'non goals': 'non-goals',
  'не-цели': 'non-goals',
  'не цели': 'non-goals',
  scenarios: 'scenarios',
  'use cases': 'scenarios',
  сценарии: 'scenarios',
  constraints: 'constraints',
  ограничения: 'constraints',
  'acceptance criteria': 'acceptance criteria',
  'acceptance criterion': 'acceptance criteria',
  ac: 'acceptance criteria',
  'критерии приёмки': 'acceptance criteria',
  'критерии приемки': 'acceptance criteria',
  'definition of done': 'definition of done',
  dod: 'definition of done',
  'определение готовности': 'definition of done',
  decisions: 'decisions',
  'решения и допущения': 'decisions',
  решения: 'decisions',
  risks: 'risks',
  риски: 'risks',
};

const AC_COLUMNS: Readonly<Record<'acId' | 'text' | 'kind' | 'priority', readonly string[]>> = {
  acId: ['ac', 'ac id', 'id', 'критерий'],
  text: ['text', 'описание', 'текст', 'критерий текст'],
  kind: ['type', 'тип'],
  priority: ['priority', 'приоритет'],
};

const DOD_COLUMNS: Readonly<Record<'acId' | 'testRef' | 'probe', readonly string[]>> = {
  acId: ['ac', 'ac id', 'id', 'критерий'],
  testRef: ['test ref', 'test_ref', 'test', 'тест'],
  probe: ['probe', 'проверка', 'проба'],
};

const KIND_ALIASES: Readonly<Record<string, RequirementKind>> = {
  functional: 'functional',
  'функциональный': 'functional',
  'функциональная': 'functional',
  nonfunctional: 'nonfunctional',
  'non-functional': 'nonfunctional',
  'нефункциональный': 'nonfunctional',
  'нефункциональная': 'nonfunctional',
};

const normalizeHeading = (raw: string): string =>
  raw
    .replace(/[`*_]/g, '')
    .replace(/^\d+(?:\.\d+)*[.)]?\s+/, '')
    .replace(/:$/, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const normalizeCell = (raw: string): string => raw.trim().replace(/[`*_]/g, '').trim();

const normalizeColumn = (raw: string): string => normalizeCell(raw).toLowerCase().replace(/[-\s]+/g, ' ');

const isTableRow = (line: string): boolean => line.trimStart().startsWith('|');

const isSeparatorRow = (line: string): { length: number } | null => {
  const cells = splitCells(line);
  if (cells.length === 0) return null;
  return cells.every((cell) => SEPARATOR_CELL.test(cell.replace(/\s+/g, ''))) ? { length: cells.length } : null;
};

function splitCells(line: string): string[] {
  const parts = line.split('|');
  if (parts[0]?.trim() === '') parts.shift();
  if (parts.at(-1)?.trim() === '') parts.pop();
  return parts.map((cell) => cell.trim());
}

interface Table {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

function parseTable(body: string): Table | null {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const headerLine = lines[index];
    const separatorLine = lines[index + 1];
    if (headerLine === undefined || separatorLine === undefined) continue;
    if (!isTableRow(headerLine) || isSeparatorRow(separatorLine) === null) continue;
    const header = splitCells(headerLine);
    const rows: string[][] = [];
    let cursor = index + 2;
    for (let line = lines[cursor]; line !== undefined && isTableRow(line); line = lines[cursor]) {
      rows.push(splitCells(line));
      cursor += 1;
    }
    return { header, rows };
  }
  return null;
}

function resolveColumns<K extends string>(
  header: readonly string[],
  groups: Readonly<Record<K, readonly string[]>>,
): Record<K, number> & { readonly missing: K[] } {
  const normalized = header.map(normalizeColumn);
  const resolved = {} as Record<K, number>;
  const missing: K[] = [];
  for (const key of Object.keys(groups) as K[]) {
    const synonyms = groups[key];
    const found = normalized.findIndex((column) => synonyms.includes(column));
    if (found === -1) missing.push(key);
    else resolved[key] = found;
  }
  return Object.assign(resolved, { missing });
}

const cellAt = (row: readonly string[], index: number): string => {
  const raw = row[index] ?? '';
  return normalizeCell(raw);
};

const emptyAsNull = (value: string): string | null => (value === '' || EMPTY_CELL.test(value) ? null : value);

const stubIn = (text: string): string | null => {
  for (const pattern of STUB_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
};

const finding = (
  findingClass: FindingClass,
  requirement: string,
  extra: Partial<FindingInput> = {},
): FindingInput => ({ class: findingClass, severity: 'blocking', requirement, ...extra });

function readSections(bodyMd: string): Map<SectionKey, string[]> {
  const bodies = new Map<SectionKey, string[]>();
  let inFence = false;
  let current: SectionKey | null = null;
  for (const line of bodyMd.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      if (current) bodies.get(current)?.push(line);
      continue;
    }
    if (!inFence) {
      const heading = HEADING.exec(line);
      if (heading) {
        const mapped = SECTION_ALIASES[normalizeHeading(heading[1] ?? '')];
        if (mapped) {
          current = mapped;
          if (!bodies.has(mapped)) bodies.set(mapped, []);
        }
        continue;
      }
    }
    if (current) bodies.get(current)?.push(line);
  }
  return bodies;
}

export function parseSpec(bodyMd: string): ParseResult {
  const findings: FindingInput[] = [];
  const bodies = readSections(bodyMd);
  const sections = new Map<SectionKey, string>();
  for (const [key, lines] of bodies) sections.set(key, lines.join('\n').trim());

  for (const key of REQUIRED_SECTIONS) {
    const body = sections.get(key);
    if (body === undefined) {
      findings.push(
        finding('ambiguous', `Spec is missing the "${key}" section`, {
          requiredChange: `Add a "${key}" section`,
        }),
      );
      continue;
    }
    if (body === '') {
      findings.push(
        finding('ambiguous', `Spec section "${key}" is empty`, {
          requiredChange: `Fill the "${key}" section`,
        }),
      );
      continue;
    }
    const stub = stubIn(body);
    if (stub) {
      findings.push(
        finding('ambiguous', `Spec section "${key}" contains a placeholder`, {
          evidence: stub,
          requiredChange: `Replace the placeholder in "${key}"`,
        }),
      );
    }
  }

  const acRows: AcRow[] = [];
  const seenAc = new Map<string, number>();
  const acBody = sections.get('acceptance criteria');
  if (acBody !== undefined) {
    const table = parseTable(acBody);
    if (!table) {
      findings.push(
        finding('ambiguous', 'Spec must contain an acceptance criteria markdown table', {
          requiredChange: 'Add a | AC | Text | Type | Priority | table',
        }),
      );
    } else {
      const columns = resolveColumns(table.header, AC_COLUMNS);
      if (columns.missing.length > 0) {
        findings.push(
          finding('ambiguous', `Acceptance criteria table is missing columns: ${columns.missing.join(', ')}`, {
            requiredChange: 'Use the columns | AC | Text | Type | Priority |',
          }),
        );
      } else {
        for (const row of table.rows) {
          const acId = cellAt(row, columns.acId).toUpperCase();
          const text = cellAt(row, columns.text);
          const kindCell = cellAt(row, columns.kind).toLowerCase().replace(/[-\s]+/g, ' ');
          const priority = cellAt(row, columns.priority);
          if (acId === '') {
            findings.push(finding('ambiguous', 'Acceptance criteria row has no AC id'));
            continue;
          }
          if (!AC_ID.test(acId)) {
            findings.push(
              finding('ambiguous', `Acceptance criterion "${acId}" is not named AC-<n>`, {
                acId,
                requiredChange: 'Name criteria AC-1, AC-2, ...',
              }),
            );
            continue;
          }
          const seen = seenAc.get(acId);
          if (seen !== undefined) {
            findings.push(
              finding('contradiction', `Acceptance criterion "${acId}" is declared more than once`, {
                acId,
                evidence: `row ${seen + 1} and row ${acRows.length + 2}`,
                requiredChange: 'Keep one row per AC id',
              }),
            );
            continue;
          }
          if (text === '') {
            findings.push(
              finding('missing-evidence', `Acceptance criterion "${acId}" has no text`, {
                acId,
                requiredChange: 'Describe the observable behaviour the criterion proves',
              }),
            );
          }
          if (priority === '') {
            findings.push(
              finding('ambiguous', `Acceptance criterion "${acId}" has no priority`, {
                acId,
                requiredChange: 'Set a priority (must/should/could)',
              }),
            );
          }
          const kind = KIND_ALIASES[kindCell];
          if (!kind) {
            findings.push(
              finding('ambiguous', `Acceptance criterion "${acId}" has an unknown type`, {
                acId,
                evidence: kindCell,
                requiredChange: 'Use functional or nonfunctional',
              }),
            );
            continue;
          }
          seenAc.set(acId, acRows.length);
          acRows.push({ acId, text, kind });
        }
      }
      if (table.rows.length === 0) {
        findings.push(
          finding('missing-evidence', 'Acceptance criteria table has no rows', {
            requiredChange: 'List at least one AC-1 row',
          }),
        );
      }
    }
  }

  const dodRows: DodDraft[] = [];
  const knownAc = new Set(acRows.map((row) => row.acId));
  const dodBody = sections.get('definition of done');
  if (dodBody !== undefined) {
    const table = parseTable(dodBody);
    if (!table) {
      findings.push(
        finding('missing-evidence', 'Spec must contain a definition of done markdown table', {
          requiredChange: 'Add a | AC | Test ref | Probe | table with one row per criterion',
        }),
      );
    } else {
      const columns = resolveColumns(table.header, DOD_COLUMNS);
      if (columns.missing.length > 0) {
        findings.push(
          finding('missing-evidence', `Definition of done table is missing columns: ${columns.missing.join(', ')}`, {
            requiredChange: 'Use the columns | AC | Test ref | Probe |',
          }),
        );
      } else {
        for (const row of table.rows) {
          const acId = cellAt(row, columns.acId).toUpperCase();
          const testRef = emptyAsNull(cellAt(row, columns.testRef));
          const probe = emptyAsNull(cellAt(row, columns.probe));
          if (acId === '') {
            findings.push(finding('ambiguous', 'Definition of done row has no AC id'));
            continue;
          }
          if (!knownAc.has(acId)) {
            findings.push(
              finding('contradiction', `Definition of done row references unknown acceptance criterion "${acId}"`, {
                acId,
                requiredChange: 'Reference an AC id declared in the acceptance criteria table',
              }),
            );
            continue;
          }
          if (testRef === null && probe === null) {
            findings.push(
              finding('missing-evidence', `Definition of done row for "${acId}" has neither test_ref nor probe`, {
                acId,
                requiredChange: 'Add a test_ref (path::test name) or a probe command',
              }),
            );
            continue;
          }
          if (testRef !== null && !TEST_REF.test(testRef)) {
            findings.push(
              finding('unprovable', `Test ref "${testRef}" for "${acId}" is not a test path`, {
                acId,
                evidence: testRef,
                requiredChange: 'Use path/to/file.test.ts::test name',
              }),
            );
            continue;
          }
          if (testRef !== null) {
            const stub = stubIn(testRef);
            if (stub) {
              findings.push(
                finding('ambiguous', `Test ref for "${acId}" is a placeholder`, {
                  acId,
                  evidence: stub,
                  requiredChange: 'Name the test that will prove the criterion',
                }),
              );
              continue;
            }
          }
          dodRows.push({ acId, testRef, probe });
        }
      }
    }
  }

  if (knownAc.size > 0) {
    const covered = new Set(dodRows.map((row) => row.acId));
    for (const acId of knownAc) {
      if (!covered.has(acId)) {
        findings.push(
          finding('missing-evidence', `Acceptance criterion "${acId}" has no definition of done row`, {
            acId,
            requiredChange: 'Add a DoD row with a test_ref or probe',
          }),
        );
      }
    }
  }

  return {
    parsed: { sections, acRows, dodRows },
    findings,
  };
}
