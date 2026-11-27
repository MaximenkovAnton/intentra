import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import type { IntentCard } from '@intentra/contracts';
import {
  assembleFrontOfficePrompt,
  frontOfficePrompt,
  specCriticPrompt,
  specWriterPrompt,
} from '../src/prompts/templates.js';
import {
  CONTEXT_PACK_MAX_BYTES,
  renderContextPack,
  type ContextPack,
  type MemoryContext,
} from '../src/prompts/context.js';

const CARD: IntentCard = {
  objective: 'Give a product owner a reviewed spec from a conversation.',
  users: ['product owner', 'engineer'],
  jobs: ['turn an intent into a spec', 'review the spec without a human'],
  inScope: ['intent state machine', 'mechanical spec critic'],
  outOfScope: ['runner', 'UI'],
  constraints: ['control plane only', 'no LLM calls in the control plane'],
  successSignals: ['a spec is rejected when its DoD is missing'],
  assumptions: ['Postgres stores everything'],
  risks: ['mechanical critic false positives'],
  openQuestions: ['which context pack size'],
};

const PACK: ContextPack = {
  decisions: ['Use OIDC only'],
  claims: ['auth: OIDC verified at apps/api/src/auth/oidc.ts:1'],
  capabilities: ['intents CRUD'],
  traps: ['pino bans console'],
  episodes: ['previous intent shipped'],
};

const messages = Array.from({ length: 21 }, (_, index) => ({
  role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
  body: `message ${index + 1}`,
}));

describe('prompt templates', () => {
  it('renders the front office prompt with the last twenty messages', () => {
    const prompt = frontOfficePrompt({
      title: 'Intent-driven flow',
      statement: 'Turn intents into reviewed specs',
      messages,
      contextPack: PACK,
      capabilities: ['intents', 'spec'],
    });
    expect(prompt).toContain('assistant: message 2');
    expect(prompt).not.toContain('user: message 1\n');
    expect(prompt).toContain('submit_intent_card');
    expect(prompt).toMatchSnapshot();
  });

  it('renders the spec writer prompt from an intent card', () => {
    const prompt = specWriterPrompt({
      card: CARD,
      acceptedDecisions: [{ question: 'Which DB?', answer: 'Postgres' }],
      contextPack: PACK,
      findings: [
        {
          class: 'missing-evidence',
          severity: 'blocking',
          requirement: 'Spec is missing DoD rows',
          requiredChange: 'Add one DoD row per acceptance criterion',
        },
      ],
    });
    expect(prompt).toContain('AC-1');
    expect(prompt).toContain('Spec is missing DoD rows');
    expect(prompt).toContain('-> fix: Add one DoD row per acceptance criterion');
    expect(prompt).toContain('Type is exactly functional or nonfunctional');
    expect(prompt).toMatchSnapshot();
  });

  it('renders the spec critic prompt bound to the spec sha', () => {
    const prompt = specCriticPrompt({
      specMd: '# Spec\n\n## Context\n\nSomething',
      specSha256: 'a'.repeat(64),
      acceptedDecisions: [{ question: 'Which DB?', answer: 'Postgres' }],
      contextPack: PACK,
    });
    expect(prompt).toContain('a'.repeat(64));
    expect(prompt).toMatchSnapshot();
  });

  it('caps the context pack at two kilobytes', () => {
    const huge: ContextPack = {
      decisions: Array.from({ length: 40 }, (_, index) => `decision ${index} ${'x'.repeat(200)}`),
      claims: [],
      capabilities: [],
      traps: [],
      episodes: [],
    };
    const rendered = renderContextPack(huge);
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(CONTEXT_PACK_MAX_BYTES);
    expect(rendered).toContain('decision 0');
    expect(rendered).not.toContain('decision 39');
  });

  it('loads the context pack through the memory port', async () => {
    const seen: string[] = [];
    const memory: MemoryContext = {
      buildContextPack: async (query) => {
        seen.push(`${query.projectId}:${query.intentId}:${query.query}`);
        return PACK;
      },
    };
    const prompt = await assembleFrontOfficePrompt(memory, {
      projectId: 'project-1',
      intentId: 'intent-1',
      title: 'Intent-driven flow',
      statement: 'Turn intents into reviewed specs',
      messages: [],
      capabilities: [],
    });
    expect(seen).toEqual(['project-1:intent-1:Turn intents into reviewed specs']);
    expect(prompt).toContain('### Decisions');
  });
});
