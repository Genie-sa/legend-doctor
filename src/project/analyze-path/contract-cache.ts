export function cached(cache: Map<string, boolean>, key: string, compute: () => boolean): boolean {
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const value = compute();
  cache.set(key, value);
  return value;
}
