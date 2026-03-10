import { useEffect, useState } from 'react'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeWithDefaults<T>(defaults: T, stored: unknown): T {
  if (Array.isArray(defaults)) {
    return (Array.isArray(stored) ? stored : defaults) as T
  }

  if (isPlainObject(defaults)) {
    const storedObject = isPlainObject(stored) ? stored : {}
    const mergedEntries = Object.entries(defaults).map(([key, value]) => [
      key,
      mergeWithDefaults(value, storedObject[key]),
    ])

    for (const [key, value] of Object.entries(storedObject)) {
      if (!(key in defaults)) {
        mergedEntries.push([key, value])
      }
    }

    return Object.fromEntries(mergedEntries) as T
  }

  return (stored ?? defaults) as T
}

export function useLocalStorageState<T>(storageKey: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) {
        return initialValue
      }

      return mergeWithDefaults(initialValue, JSON.parse(raw))
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value))
    } catch {
      // ignore local storage errors in restricted environments
    }
  }, [storageKey, value])

  return [value, setValue] as const
}
