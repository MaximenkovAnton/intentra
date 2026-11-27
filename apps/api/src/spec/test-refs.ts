export interface TestRefChecker {
  exists(ref: string): boolean;
}

export const formatOnlyTestRefChecker: TestRefChecker = { exists: () => true };

export const knownTestRefChecker = (refs: Iterable<string>): TestRefChecker => {
  const known = new Set(refs);
  return { exists: (ref) => known.has(ref) };
};
