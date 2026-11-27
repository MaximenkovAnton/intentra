import type { PlanTask } from '@intentra/contracts';

export function planPrompt(specMd: string, acIds: readonly string[]): string {
  return [
    'You are planner for Intentra. Turn the spec into at most 10 build tasks a runner can execute.',
    'Every task: id (slug), title, spec under 8 KB, dependsOn, paths, acceptance (AC ids from the spec), reviewLens.',
    'Every AC id must be covered by at least one task; no task may have more than 4 direct dependents; no cycles.',
    '',
    `## Acceptance criteria\n${acIds.map((acId) => `- ${acId}`).join('\n')}`,
    '',
    `## Spec\n${specMd}`,
    '',
    'Call submit_plan with the plan; do not return it any other way.',
    '',
    '## submit_plan input schema\n{"plan":{"tasks":[{"id":"api","title":"...","spec":"...","dependsOn":[],"paths":["apps/api/src"],"acceptance":["AC-1"],"reviewLens":"code-reviewer"}]}}',
  ].join('\n');
}

export function buildPrompt(task: PlanTask, specMd: string): string {
  return [
    'You are the build agent for Intentra. Implement the task in the repository worktree.',
    'Run the project gates; return a commit, a diff summary and a link through job.diff_summary and job.link.',
    'Do not return file contents or logs: the centre stores statuses, metadata and summaries only.',
    '',
    `## Task ${task.id}: ${task.title}`,
    task.spec,
    '',
    `## Acceptance criteria\n${task.acceptance.map((acId) => `- ${acId}`).join('\n')}`,
    '',
    `## Review lens\n${task.reviewLens}`,
    '',
    `## Spec (context)\n${specMd}`,
  ].join('\n');
}

export function reviewPrompt(
  task: PlanTask,
  specMd: string,
  diffSummaries: readonly string[],
): string {
  return [
    `You are the review lens "${task.reviewLens}" for Intentra. Review the diff summary against the task and its AC.`,
    'Blocking findings need evidence; report them through job.findings, then a verdict through job.verdict.',
    'At most two rounds. A changed verdict sends the intent back to build.',
    '',
    `## Task ${task.id}: ${task.title}`,
    task.spec,
    '',
    `## Acceptance criteria\n${task.acceptance.map((acId) => `- ${acId}`).join('\n')}`,
    '',
    `## Diff summary\n${diffSummaries.length === 0 ? '(no diff summary)' : diffSummaries.join('\n')}`,
    '',
    `## Spec\n${specMd}`,
  ].join('\n');
}

export function verifyPrompt(criteria: readonly string[]): string {
  return [
    'Run the project gates and claim checks in the worktree, then call submit_report with:',
    '{"gates":[{"criterion":"build","status":"pass","durationMs":0,"exitCode":0}],"claims":[{"statement":"...","status":"fresh"}]}',
    'Report only statuses, durations, exit codes and hashes; never return command output or file contents.',
    '',
    `## Gates\n${criteria.map((criterion) => `- ${criterion}`).join('\n')}`,
  ].join('\n');
}
