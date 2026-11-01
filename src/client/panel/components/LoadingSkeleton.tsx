import { Skeleton } from './ui/skeleton.js'

export function TreeSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-3 p-3" aria-hidden="true" data-testid="tree-skeleton">
      <Skeleton className="h-4 w-24" />
      {Array.from({ length: 3 }).map((_, group) => (
        <div key={group} className="space-y-1.5">
          {/* Indentation mirrors the tree: category 0 → scenario +16 → recording +32. */}
          <Skeleton className="h-9 w-full" data-skeleton-depth="0" />
          <Skeleton className="ml-4 h-8 w-[calc(100%-1rem)]" data-skeleton-depth="1" />
          <Skeleton className="ml-8 h-12 w-[calc(100%-2rem)]" data-skeleton-depth="2" />
          <Skeleton className="ml-8 h-12 w-[calc(100%-2rem)]" data-skeleton-depth="2" />
        </div>
      ))}
    </div>
  )
}

export function DetailSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-6 p-6" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Skeleton className="aspect-video w-full rounded-xl" />
        <div className="space-y-3">
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
    </div>
  )
}
