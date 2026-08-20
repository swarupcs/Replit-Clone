/** Subsequence match, the way editor quick-opens behave: "arc" matches
 *  "src/**A**pp.tsx" via scattered characters, not just a substring.
 *
 *  Returns a score (lower is better) or null for no match. Consecutive
 *  characters and matches in the filename rather than the directory score
 *  better, so "App" ranks `src/App.tsx` above `src/app/deep/other.ts`. */
export function fuzzyScore(candidate: string, query: string): number | null {
  if (!query) return 0;

  const haystack = candidate.toLowerCase();
  let score = 0;
  let cursor = 0;
  let previousIndex = -1;

  for (const character of query.toLowerCase()) {
    const index = haystack.indexOf(character, cursor);
    if (index === -1) return null;

    // Gaps cost; adjacency is free.
    if (previousIndex !== -1) score += index - previousIndex - 1;
    previousIndex = index;
    cursor = index + 1;
  }

  // Prefer matches that land in the basename.
  const slash = haystack.lastIndexOf("/");
  if (previousIndex > slash) score -= 10;

  return score + candidate.length * 0.05;
}
