// import * as Sentry from '@sentry/react'
//
// const FLUSH_INTERVAL_MS = 30_000
//
// let intervalId: ReturnType<typeof setInterval> | null = null
//
// export function initINPAutoFlush() {
//   if (intervalId) return
//
//   intervalId = setInterval(() => {
//     if (document.visibilityState !== 'visible') return
//
//     // Force web-vitals to finalize INP by faking a visibility change
//     Object.defineProperty(document, 'visibilityState', {
//       value: 'hidden',
//       configurable: true,
//     })
//     document.dispatchEvent(new Event('visibilitychange'))
//
//     // Restore immediately in the next microtask — before the next paint frame
//     queueMicrotask(() => {
//       Object.defineProperty(document, 'visibilityState', {
//         value: 'visible',
//         configurable: true,
//       })
//       document.dispatchEvent(new Event('visibilitychange'))
//     })
//
//     Sentry.flush(2000)
//   }, FLUSH_INTERVAL_MS)
// }
//
