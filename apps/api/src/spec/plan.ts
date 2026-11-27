import { Buffer } from 'node:buffer';
import type { FindingInput, Plan, PlanTask } from '@intentra/contracts';

export const PLAN_MAX_TASKS = 10;
export const PLAN_TASK_SPEC_MAX_BYTES = 8 * 1024;
export const PLAN_MAX_DIRECT_DEPENDENTS = 4;

const finding = (
  findingClass: FindingInput['class'],
  requirement: string,
  extra: Partial<FindingInput> = {},
): FindingInput => ({ class: findingClass, severity: 'blocking', requirement, ...extra });

export function findPlanCycle(tasks: readonly PlanTask[]): readonly string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): readonly string[] | null => {
    const current = state.get(id);
    if (current === 'done') return null;
    if (current === 'visiting') {
      const start = stack.indexOf(id);
      return [...stack.slice(start === -1 ? 0 : start), id];
    }
    const task = byId.get(id);
    if (!task) return null;
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of task.dependsOn) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return null;
}

export function validatePlan(plan: Plan, acIds: ReadonlySet<string>): readonly FindingInput[] {
  const findings: FindingInput[] = [];
  const byId = new Map<string, PlanTask>();

  if (plan.tasks.length > PLAN_MAX_TASKS) {
    findings.push(
      finding('scope', `Plan has ${plan.tasks.length} build tasks; v1 allows at most ${PLAN_MAX_TASKS}`, {
        requiredChange: 'Split the plan into at most 10 tasks or narrow the intent',
      }),
    );
  }

  for (const task of plan.tasks) {
    if (byId.has(task.id)) {
      findings.push(
        finding('contradiction', `Plan task id "${task.id}" is declared more than once`, {
          requiredChange: 'Give every build task a unique id',
        }),
      );
      continue;
    }
    byId.set(task.id, task);
    const bytes = Buffer.byteLength(task.spec, 'utf8');
    if (bytes > PLAN_TASK_SPEC_MAX_BYTES) {
      findings.push(
        finding('scope', `Plan task "${task.id}" spec is ${bytes} bytes, over the ${PLAN_TASK_SPEC_MAX_BYTES} byte budget`, {
          requiredChange: `Shorten the spec of "${task.id}"`,
        }),
      );
    }
    if (task.paths.length === 0) {
      findings.push(
        finding('ambiguous', `Plan task "${task.id}" names no paths`, {
          requiredChange: 'List the files or directories the task may touch',
        }),
      );
    }
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        findings.push(
          finding('contradiction', `Plan task "${task.id}" depends on itself`, {
            requiredChange: 'Remove the self dependency',
          }),
        );
      } else if (!plan.tasks.some((candidate) => candidate.id === dependency)) {
        findings.push(
          finding('contradiction', `Plan task "${task.id}" depends on unknown task "${dependency}"`, {
            requiredChange: 'Declare the dependency or drop it',
          }),
        );
      }
    }
    for (const acId of task.acceptance) {
      const normalized = acId.toUpperCase();
      if (!acIds.has(normalized)) {
        findings.push(
          finding('contradiction', `Plan task "${task.id}" accepts unknown criterion "${acId}"`, {
            acId: normalized,
            requiredChange: 'Reference an AC id from the current spec',
          }),
        );
      }
    }
  }

  const dependents = new Map<string, number>();
  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      dependents.set(dependency, (dependents.get(dependency) ?? 0) + 1);
    }
  }
  for (const [id, count] of dependents) {
    if (count > PLAN_MAX_DIRECT_DEPENDENTS) {
      findings.push(
        finding('scope', `Plan task "${id}" has ${count} direct dependents; the limit is ${PLAN_MAX_DIRECT_DEPENDENTS}`, {
          requiredChange: 'Freeze the shared contract in its own task and depend on that',
        }),
      );
    }
  }

  const covered = new Set<string>();
  for (const task of plan.tasks) {
    for (const acId of task.acceptance) covered.add(acId.toUpperCase());
  }
  for (const acId of acIds) {
    if (!covered.has(acId)) {
      findings.push(
        finding('missing-evidence', `Acceptance criterion "${acId}" is not covered by any plan task`, {
          acId,
          requiredChange: 'Add the criterion to a plan task acceptance list',
        }),
      );
    }
  }

  const cycle = findPlanCycle(plan.tasks);
  if (cycle) {
    findings.push(
      finding('contradiction', `Plan dependencies form a cycle: ${cycle.join(' -> ')}`, {
        evidence: cycle.join(' -> '),
        requiredChange: 'Break the cycle',
      }),
    );
  }

  return findings;
}
