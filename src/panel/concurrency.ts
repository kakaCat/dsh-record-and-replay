/**
 * Bounded-concurrency map used by the M2 system-wide scan paths.
 *
 * Cross-project search and the stats report scan every whitelisted project.
 * Scanning all of them at once would open an unbounded number of file
 * descriptors (each recording reads a manifest, steps head and run files), so
 * the work is fanned out to at most `limit` workers. Results keep the input
 * order, which is what makes the grouped search output deterministic.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${String(limit)}`)
  }
  if (items.length === 0) return []

  const results = new Array<R>(items.length)
  let next = 0
  const workerCount = Math.min(limit, items.length)

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index] as T, index)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
