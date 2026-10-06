import * as Sentry from '@sentry/react'

function parseSampleRate(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '')
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.min(Math.max(parsed, 0), 1)
}

const dsn = import.meta.env.VITE_SENTRY_DSN?.trim()
const tracesSampleRate = parseSampleRate(
  import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE,
  1.0,
)
const interactionsSampleRate = parseSampleRate(
  import.meta.env.VITE_SENTRY_INTERACTIONS_SAMPLE_RATE,
  1.0,
)
const replaysSessionSampleRate = parseSampleRate(
  import.meta.env.VITE_SENTRY_REPLAY_SESSION_SAMPLE_RATE,
  1.0,
)
const replaysOnErrorSampleRate = parseSampleRate(
  import.meta.env.VITE_SENTRY_REPLAY_ERROR_SAMPLE_RATE,
  1.0,
)

if (dsn) {
  Sentry.setUser({ username: 'michel-2' })
  Sentry.init({
    dsn,
    environment: "devvv",
    integrations: [
      Sentry.browserTracingIntegration({
        enableInp: true,
        interactionsSampleRate,
      }),
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
      }),
      Sentry.captureConsoleIntegration({
        levels: ['error', 'warn'],
      }),
      Sentry.httpClientIntegration({
        failedRequestStatusCodes: [[400, 499], [500, 599]],
      }),
    ],
    tracesSampleRate,
    tracePropagationTargets: ['localhost', /^\//],
    replaysSessionSampleRate,
    replaysOnErrorSampleRate,
    attachStacktrace: true,
    maxBreadcrumbs: 100,
    includeLocalVariables: true,
  })
} else if (import.meta.env.DEV) {
  console.info('Sentry disabled: set VITE_SENTRY_DSN in your .env file.')
}
