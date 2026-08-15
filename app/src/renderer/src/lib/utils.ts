import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * A recorded moment, in this Mac's own language and time zone. To the minute:
 * a bootstrap that happened months ago is answering "when, roughly", and
 * seconds would be precision nobody reads.
 */
export function moment(timestamp: string): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
}
