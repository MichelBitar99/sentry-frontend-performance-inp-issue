import { useCallback, useEffect, useRef } from 'react'
import * as Sentry from '@sentry/react'

type RafHandle = ReturnType<typeof requestAnimationFrame>

interface RageCallOptions {
  /**
   * Number of calls without a UI change that triggers the rage event.
   * Defaults to 7.
   */
  threshold?: number
  /**
   * Time window in ms. Calls outside this window reset the counter.
   * Defaults to 2000 ms.
   */
  windowMs?: number
  /**
   * DOM node to observe for mutations. Defaults to document.body.
   */
  observeTarget?: Node | null
  /**
   * Label shown in the Sentry event to identify which function was rage-called.
   */
  label: string
}

/**
 * Wraps a function so that if it is called `threshold` or more times
 * within `windowMs` without any DOM mutation occurring in between,
 * a custom Sentry event is captured.
 *
 * This is intentionally NOT tied to click events or DOM elements — it works
 * for any arbitrary function (e.g. a submit handler, a search trigger, etc.).
 */
export function useRageCallDetector<T extends (...args: unknown[]) => unknown>(
  fn: T,
  options: RageCallOptions,
): T {
  const { threshold = 7, windowMs = 2000, observeTarget = null, label } =
    options

  const callTimestamps = useRef<number[]>([])
  const mutationSinceLastCall = useRef(false)
  const observerRef = useRef<MutationObserver | null>(null)
  const pendingRafRef = useRef<RafHandle | null>(null)

  // Set up MutationObserver on mount, tear it down on unmount.
  useEffect(() => {
    const target =
      observeTarget ?? (typeof document !== 'undefined' ? document.body : null)
    if (!target) return

    observerRef.current = new MutationObserver(() => {
      mutationSinceLastCall.current = true
      // A UI change happened — cancel any pending rage-call capture and reset the counter.
      if (pendingRafRef.current !== null) {
        cancelAnimationFrame(pendingRafRef.current)
        pendingRafRef.current = null
      }
      callTimestamps.current = []
    })

    observerRef.current.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })

    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
      if (pendingRafRef.current !== null) {
        cancelAnimationFrame(pendingRafRef.current)
        pendingRafRef.current = null
      }
    }
  }, [observeTarget])

  const wrapped = useCallback(
    (...args: Parameters<T>): ReturnType<T> => {
      const now = Date.now()

      // Reset the flag so we can detect whether a mutation occurs after this call.
      mutationSinceLastCall.current = false

      // Evict calls outside the time window.
      callTimestamps.current = callTimestamps.current.filter(
        (t) => now - t < windowMs,
      )
      callTimestamps.current.push(now)

      if (callTimestamps.current.length >= threshold) {
        // Cancel any previous deferred check that hasn't fired yet.
        if (pendingRafRef.current !== null) {
          cancelAnimationFrame(pendingRafRef.current)
        }

        const countAtThreshold = callTimestamps.current.length

        // Reset so it doesn't fire again until the counter refills.
        callTimestamps.current = []

        // Defer by one animation frame so the MutationObserver has a chance to
        // fire for any DOM changes caused by this call. If a mutation is observed
        // before the frame runs, the pending capture will be cancelled above.
        mutationSinceLastCall.current = false
        pendingRafRef.current = requestAnimationFrame(() => {
          pendingRafRef.current = null
          if (mutationSinceLastCall.current) {
            // UI changed after the calls — not a rage-call scenario, skip.
            return
          }

          Sentry.captureMessage(`Rage call detected: ${label}`, {
            level: 'warning',
            tags: {
              rage_call: true,
              rage_call_label: label,
            },
            extra: {
              callCount: countAtThreshold,
              windowMs,
              threshold,
            },
          })

          Sentry.addBreadcrumb({
            category: 'rage-call',
            message: `${label} called ${countAtThreshold}x with no UI change`,
            level: 'warning',
            data: {
              callCount: countAtThreshold,
              windowMs,
            },
          })
        })
      }

      return fn(...args) as ReturnType<T>
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn, threshold, windowMs, label],
  )

  return wrapped as T
}
