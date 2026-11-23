export interface FileSearchResult {
  path: string;
  score: number;
  indices: number[];
}

interface SubsequenceMatch {
  score: number;
  indices: number[];
}

function subsequenceMatch(value: string, query: string): SubsequenceMatch | null {
  const indices: number[] = [];
  let cursor = 0;
  let gaps = 0;
  let previous = -2;
  for (const character of query) {
    const index = value.indexOf(character, cursor);
    if (index < 0) return null;
    indices.push(index);
    if (previous >= 0) gaps += index - previous - 1;
    previous = index;
    cursor = index + 1;
  }
  return {
    score: 100 + (indices[0] ?? 0) + gaps,
    indices,
  };
}

export function searchFilePaths(
  paths: string[],
  rawQuery: string,
  limit = 100,
): FileSearchResult[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query || limit <= 0) return [];

  const matches: FileSearchResult[] = [];
  for (const filePath of paths) {
    const lowerPath = filePath.toLocaleLowerCase();
    const nameStart = lowerPath.lastIndexOf("/") + 1;
    const lowerName = lowerPath.slice(nameStart);
    let score: number | null = null;
    let indices: number[] = [];

    if (lowerName === query) {
      score = 0;
      indices = Array.from({ length: query.length }, (_, index) => nameStart + index);
    } else if (lowerName.startsWith(query)) {
      score = 10;
      indices = Array.from({ length: query.length }, (_, index) => nameStart + index);
    } else {
      const nameIndex = lowerName.indexOf(query);
      if (nameIndex >= 0) {
        score = 20 + nameIndex;
        indices = Array.from(
          { length: query.length },
          (_, index) => nameStart + nameIndex + index,
        );
      } else {
        const nameMatch = subsequenceMatch(lowerName, query);
        if (nameMatch) {
          score = nameMatch.score;
          indices = nameMatch.indices.map((index) => nameStart + index);
        } else {
          const pathIndex = lowerPath.indexOf(query);
          if (pathIndex >= 0) {
            score = 200 + pathIndex;
            indices = Array.from(
              { length: query.length },
              (_, index) => pathIndex + index,
            );
          } else {
            const pathMatch = subsequenceMatch(lowerPath, query);
            if (!pathMatch) continue;
            score = 300 + pathMatch.score;
            indices = pathMatch.indices;
          }
        }
      }
    }

    matches.push({ path: filePath, score, indices });
  }

  matches.sort(
    (left, right) =>
      left.score - right.score ||
      left.path.length - right.path.length ||
      left.path.localeCompare(right.path),
  );
  return matches.slice(0, limit);
}
