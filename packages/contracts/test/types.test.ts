import { expectTypeOf, it } from 'vitest';
import type {
  ErrorCode,
  EscalationOption,
  Locale,
  Me,
  Project,
  ProjectRole,
  RunnerToCenterMessage,
} from '../src/index.js';

it('keeps absence explicit in the user contract', () => {
  expectTypeOf<Me['avatarUrl']>().toEqualTypeOf<string | null>();
  expectTypeOf<Locale>().toEqualTypeOf<'ru' | 'en'>();
});

it('keeps roles and error codes closed', () => {
  expectTypeOf<ProjectRole>().toEqualTypeOf<'owner' | 'editor' | 'viewer'>();
  expectTypeOf<ErrorCode>().toEqualTypeOf<
    | 'AUTH_REQUIRED'
    | 'FORBIDDEN'
    | 'VALIDATION'
    | 'CONFLICT'
    | 'NOT_FOUND'
    | 'LIMIT'
    | 'RUNNER_OFFLINE'
    | 'ESCALATION_EXPIRED'
    | 'INTERNAL'
  >();
});

it('narrows the runner protocol by its type tag', () => {
  const narrow = (message: RunnerToCenterMessage): string => {
    if (message.type === 'hello') {
      expectTypeOf(message.protocolVersion).toEqualTypeOf<1>();
      expectTypeOf(message.workspaces).toEqualTypeOf<string[]>();
      return message.runnerVersion;
    }
    if (message.type === 'heartbeat') {
      expectTypeOf(message.activeJobs).toEqualTypeOf<number>();
      return String(message.activeJobs);
    }
    return message.type;
  };
  expectTypeOf(narrow).toBeFunction();
});

it('models optional escalation metadata as optional', () => {
  expectTypeOf<EscalationOption['meaning']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<EscalationOption['reversible']>().toEqualTypeOf<boolean | undefined>();
});

it('keeps archived projects distinguishable from active ones', () => {
  expectTypeOf<Project['archivedAt']>().toEqualTypeOf<string | null>();
});
