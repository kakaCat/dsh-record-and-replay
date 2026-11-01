import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return '—'
  if (durationMs < 1000) return `${String(Math.round(durationMs))} ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1000)
  return `${String(minutes)}m ${String(seconds)}s`
}

const DATE_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

export function formatDate(value: string | undefined): string {
  if (value === undefined) return '—'
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  return DATE_FORMAT.format(new Date(time))
}

export function formatPercent(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0%'
  const percent = rate * 100
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`
}
