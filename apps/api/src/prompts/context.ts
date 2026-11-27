import { Buffer } from 'node:buffer';

export const CONTEXT_PACK_MAX_BYTES = 2 * 1024;

export interface ContextPack {
  readonly decisions: readonly string[];
  readonly claims: readonly string[];
  readonly capabilities: readonly string[];
  readonly traps: readonly string[];
  readonly episodes: readonly string[];
}

export interface MemoryQuery {
  readonly projectId: string;
  readonly intentId: string;
  readonly query: string;
}

export interface MemoryContext {
  buildContextPack(query: MemoryQuery): Promise<ContextPack>;
}

export const EMPTY_CONTEXT_PACK: ContextPack = {
  decisions: [],
  claims: [],
  capabilities: [],
  traps: [],
  episodes: [],
};

export const emptyMemoryContext: MemoryContext = {
  buildContextPack: async () => EMPTY_CONTEXT_PACK,
};

interface PackSection {
  readonly title: string;
  readonly items: readonly string[];
}

const sectionsOf = (pack: ContextPack): readonly PackSection[] => [
  { title: 'Decisions', items: pack.decisions },
  { title: 'Claims', items: pack.claims },
  { title: 'Capabilities', items: pack.capabilities },
  { title: 'Traps', items: pack.traps },
  { title: 'Episodes', items: pack.episodes },
];

const render = (sections: readonly { title: string; items: string[] }[]): string =>
  sections
    .filter((section) => section.items.length > 0)
    .map((section) => [`### ${section.title}`, ...section.items.map((item) => `- ${item}`)].join('\n'))
    .join('\n\n');

export function renderContextPack(pack: ContextPack): string {
  const sections = sectionsOf(pack).map((section) => ({ title: section.title, items: [...section.items] }));
  let text = render(sections);
  while (Buffer.byteLength(text, 'utf8') > CONTEXT_PACK_MAX_BYTES) {
    const longest = sections
      .filter((section) => section.items.length > 0)
      .reduce<{ title: string; items: string[] } | null>(
        (current, section) => (current === null || section.items.length > current.items.length ? section : current),
        null,
      );
    if (longest === null) return text.slice(0, CONTEXT_PACK_MAX_BYTES);
    longest.items.pop();
    text = render(sections);
  }
  return text;
}
