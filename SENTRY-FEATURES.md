# Sentry Best Practices & Features for Frontend Performance POC

This guide covers critical Sentry functionality to implement for production-ready frontend performance debugging and INP tracking.

## Overview: Key Missing Pieces

Your current setup captures **INP interactions** and **basic performance**, but to truly debug frontend performance issues at scale, you need:

1. Custom transactions for complex user flows
2. Smart trace sampling (avoid quota overload)
3. Release/version tracking
4. User and device context
5. Source maps for readable stack traces
6. Automatic performance thresholds
7. User feedback integration

---

## 1. Custom Transactions (Track Complex User Flows)

### What They Are
- **Beyond page loads**: Capture multi-step user flows (checkout, form submission, data loading)
- **Named spans**: Each step within a transaction gets its own span
- **Duration tracking**: Automatically measure how long each flow takes

### Implementation Example

```typescript
// In src/App.tsx
const checkoutFlow = async () => {
  const transaction = Sentry.startTransaction({
    name: 'checkout_flow',
    op: 'user_flow',
    description: 'Complete checkout process from cart to confirmation',
  })

  try {
    // Step 1: Validate cart
    const cartSpan = transaction.startChild({
      op: 'validation',
      description: 'Validate shopping cart',
    })
    await validateCart()
    cartSpan.end()

    // Step 2: Process payment
    const paymentSpan = transaction.startChild({
      op: 'payment',
      description: 'Process credit card payment',
    })
    await processPayment()
    paymentSpan.end()

    // Step 3: Render confirmation
    const renderSpan = transaction.startChild({
      op: 'ui.render',
      description: 'Render confirmation page',
    })
    setOrderComplete(true)
    renderSpan.end()

  } finally {
    transaction.end()
  }
}
```

### For Your INP Demo

```typescript
const pingInteraction = (scenario: Scenario) => {
  const transaction = Sentry.startTransaction({
    name: `inp_${scenario.id}_interaction`,
    op: 'ui.interaction',
    description: `INP test: ${scenario.label}`,
    attributes: {
      scenario_id: scenario.id,
      expected_delay_ms: scenario.delayMs,
    }
  })

  Sentry.addBreadcrumb({
    message: `Interaction triggered for ${scenario.label}`,
    level: 'info',
  })
  Sentry.setTag('inp_scenario', scenario.id)
  
  blockMainThread(scenario.delayMs)
  
  setInteractionCount((current) => current + 1)
  setLastInteraction(`${scenario.label}: plain button click (${scenario.delayMs}ms block)`)
  
  transaction.end()
}
```

### Benefits
- ✅ Track which flows are slowest
- ✅ Identify bottlenecks within flows
- ✅ Correlate multiple INP events within same flow
- ✅ Debug complex user journeys

---

## 2. Smart Trace Sampling (Quota Management)

### The Problem
- 100% sampling = unlimited Sentry quota usage
- Production apps can have millions of interactions
- Need intelligent filtering

### Solution: TracesSampler

```typescript
// Add to src/instrument.ts

function tracesSampler(context: any): number {
  const { transactionContext } = context

  // Always sample errors (100%)
  if (context.samplingContext?.error) {
    return 1.0
  }

  // Always sample slow interactions
  if (transactionContext.op === 'ui.interaction') {
    return 1.0
  }

  // 50% of page loads
  if (transactionContext.op === 'pageload') {
    return 0.5
  }

  // 10% of everything else
  return 0.1
}

// In Sentry.init():
Sentry.init({
  tracesSampler,  // Use function instead of static rate
  // ... rest of config
})
```

### Environment-Based Sampling

```typescript
// In .env files
# .env (development)
VITE_SENTRY_TRACES_SAMPLE_RATE=1.0
VITE_SENTRY_REPLAY_SESSION_SAMPLE_RATE=1.0

# .env.production
VITE_SENTRY_TRACES_SAMPLE_RATE=0.1
VITE_SENTRY_REPLAY_SESSION_SAMPLE_RATE=0.2

# .env.staging
VITE_SENTRY_TRACES_SAMPLE_RATE=0.5
VITE_SENTRY_REPLAY_SESSION_SAMPLE_RATE=0.5
```

### Benefits
- ✅ Control quota costs
- ✅ Keep debug/staging at 100% for detailed debugging
- ✅ Sample production intelligently
- ✅ Never miss errors or slow transactions

---

## 3. Release & Build Tracking

### Why It Matters
- Know exactly which version introduced the performance regression
- Correlate issues with deployments
- Group issues by release

### Implementation

```typescript
// In src/instrument.ts

Sentry.init({
  release: import.meta.env.VITE_APP_VERSION || '0.0.0-unknown',
  dist: import.meta.env.VITE_APP_BUILD_ID,
  // ... rest of config
})
```

### Add to [.env](.env)

```bash
# From package.json or CI/CD pipeline
VITE_APP_VERSION=1.0.0-poc
VITE_APP_BUILD_ID=build_2024_06_30_001

# Or in CI (GitHub Actions example)
# VITE_APP_VERSION=${GITHUB_REF#refs/tags/v}
# VITE_APP_BUILD_ID=${GITHUB_SHA::7}
```

### In package.json (Vite)

```json
{
  "scripts": {
    "build": "export VITE_APP_VERSION=$(cat package.json | jq -r .version) && vite build"
  }
}
```

### Sentry Dashboard Queries
```
release:1.0.0-poc
release:[latest]
```

### Benefits
- ✅ Pinpoint exactly when regression started
- ✅ Rollback planning ("which version was good?")
- ✅ Team communication ("issue started in v1.2.3")

---

## 4. User & Device Context

### Identify Who Had Slow Interactions

```typescript
// In src/instrument.ts or after authentication

Sentry.setUser({
  id: 'user_12345',              // Your user ID
  email: 'user@example.com',     // Email for reference
  username: 'john_doe',          // Username
  ipAddress: '{{auto}}',         // Auto-capture IP (if allowed)
})
```

### Device & Environment Context

```typescript
// In src/instrument.ts

Sentry.setContext('device', {
  memory: performance.memory?.jsHeapSizeLimit
    ? `${(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0)}MB`
    : 'unknown',
  processor_count: navigator.hardwareConcurrency || 'unknown',
  network: (navigator as any).connection?.effectiveType || 'unknown',  // 4g, 3g, slow-2g
  language: navigator.language,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
})

Sentry.setContext('browser', {
  name: navigator.userAgent,
  mobile: /iPhone|iPad|Android/.test(navigator.userAgent),
})
```

### Sentry Dashboard Queries
```
device.network:4g AND measurements.inp:[100 TO 300]
// Shows slow INP on 4G networks

user.id:user_12345 AND measurements.inp:[200 TO *]
// Shows that specific user's slow interactions
```

### Benefits
- ✅ Correlate slow INP with poor network
- ✅ Target performance improvements to slow devices
- ✅ Debug user-specific issues
- ✅ Understand performance across user segments

---

## 5. Automatic Performance Thresholds

### Flag Slow Interactions Automatically

```typescript
// In src/instrument.ts

beforeSend(event, hint) {
  // Auto-flag INP > 100ms as warning
  if (event.measurements?.inp?.value > 100) {
    event.level = 'warning'
  }

  // Auto-flag INP > 500ms as error
  if (event.measurements?.inp?.value > 500) {
    event.level = 'error'
  }

  // Downsample low-priority events in production
  if (import.meta.env.PROD && event.level === 'info') {
    if (Math.random() > 0.1) {
      return null  // Sample to 10%
    }
  }

  return event
}
```

### INP Thresholds (Web Vitals Standard)
- **Good**: < 200ms
- **Needs Improvement**: 200ms - 500ms
- **Poor**: > 500ms

### Sentry Alert Setup
```
Alert when: INP > 200ms
Notify: #performance-team on Slack
```

### Benefits
- ✅ Auto-categorize interactions by severity
- ✅ Prioritize debugging (errors first)
- ✅ Prevent alert fatigue
- ✅ Meet Web Vitals standards

---

## 6. Error Boundaries (React Component Errors)

### Catch Component Crashes During INP

```typescript
// Create src/components/ErrorBoundary.tsx

import React from 'react'
import * as Sentry from '@sentry/react'

const ErrorBoundary = Sentry.withErrorBoundary(
  ({ children }: { children: React.ReactNode }) => (
    <div>
      {children}
    </div>
  ),
  {
    fallback: <div>Something went wrong</div>,
    showDialog: true,
    onError: (error, componentStack) => {
      console.error('Error boundary caught:', error, componentStack)
    },
  }
)

export default ErrorBoundary
```

### Use in [src/main.tsx](src/main.tsx)

```typescript
import ErrorBoundary from './components/ErrorBoundary'

root.render(
  <ErrorBoundary>
    <StrictMode>
      <App />
    </StrictMode>
  </ErrorBoundary>
)
```

### Benefits
- ✅ Catch React component crashes
- ✅ Separate error handling from Sentry global handlers
- ✅ User-friendly error UI
- ✅ Full component stack trace in Sentry

---

## 7. Source Maps (Production Stack Traces)

### Why You Need Them
- Production code is minified: `i.useState()`
- Source maps unmangle to: `React.useState()`
- Makes debugging 10x easier

### Setup

```bash
# Run Sentry wizard for your bundler
npx @sentry/wizard@latest -i sourcemaps
```

This will:
1. Create auth token in Sentry
2. Configure `.sentryclirc` file
3. Auto-upload source maps on build

### Manual Setup (if wizard doesn't work)

```bash
# Install CLI
npm install --save-dev @sentry/cli

# Configure in package.json
"scripts": {
  "build": "vite build && sentry-cli releases files upload-sourcemaps dist"
}

# Set org/project in .sentryclirc
[defaults]
org = your-org
project = your-project
auth_token = YOUR_TOKEN
```

### In [src/instrument.ts](src/instrument.ts)

```typescript
Sentry.init({
  release: '1.0.0',
  dist: 'build_001',  // Unique per build
  // ... rest of config
})
```

### Benefits
- ✅ Readable stack traces in production
- ✅ Exact line numbers where errors occur
- ✅ See original variable names
- ✅ Debug production issues like local dev

---

## 8. User Feedback Integration

### Let Users Report Slow Interactions

```typescript
// In src/instrument.ts integrations:

Sentry.feedbackIntegration({
  colorScheme: 'light',
  triggerLabel: 'Report Performance Issue',
  tags: { component: 'inp-demo' },
})
```

### Programmatic Reporting

```typescript
// In src/App.tsx - add to status section:

<button
  type="button"
  onClick={() => {
    Sentry.captureUserFeedback({
      name: 'User',
      email: '',
      comments: 'This interaction felt slow',
      eventId: Sentry.lastEventId(),
    })
  }}
>
  Report Slow Interaction
</button>
```

### Benefits
- ✅ Users tell you about problems they notice
- ✅ Feedback tied to session replays
- ✅ Correlate with INP measurements
- ✅ Real-world impact data

---

## 9. Console Capture (Warnings & Errors)

### Already Configured
```typescript
Sentry.captureConsoleIntegration({
  levels: ['error', 'warn'],
})
```

### What This Captures
```typescript
console.error('Failed to load')     // ✅ Captured
console.warn('Deprecated API')      // ✅ Captured
console.log('Debug info')           // ❌ Skipped
```

### Benefits
- ✅ Catch errors devs logged
- ✅ Warnings appear as breadcrumbs
- ✅ Diagnose issues faster

---

## 10. HTTP Request Monitoring

### Already Configured
```typescript
Sentry.httpClientIntegration({
  failedRequestStatusCodes: [[400, 499], [500, 599]],
})
```

### What This Tracks
- All fetch/XHR requests
- Failed requests (4xx, 5xx)
- Request duration
- Auto-includes in transactions

### Correlation with INP
```
User clicks button
  → Blocks main thread 320ms (INP)
  → API request hangs (slow network)
    → Shows in spans under same transaction
    → Correlates INP with backend delay
```

### Benefits
- ✅ See which API calls caused slow INP
- ✅ Frontend↔Backend correlation
- ✅ Network timeout detection
- ✅ Distributed tracing

---

## 11. Advanced: Custom Metrics

### Track App-Specific KPIs

```typescript
// In src/App.tsx

const pingInteraction = (scenario: Scenario) => {
  // ... existing code ...

  // Capture custom metric
  Sentry.captureMetric(
    'inp_interaction_duration',
    scenario.delayMs,
    'milliseconds',
    {
      scenario: scenario.id,
      action: 'button_click',
    }
  )
}
```

### Dashboard Query
```
// Show average INP by scenario
SELECT avg(measurements.inp) BY tags.inp_scenario
```

### Benefits
- ✅ Track INP by scenario type
- ✅ Identify which features are slowest
- ✅ Set performance budgets

---

## 12. Production Checklist

Before deploying to production:

- [ ] Set `VITE_APP_VERSION` from package.json
- [ ] Configure `tracesSampler` for production sampling
- [ ] Set `beforeSend` to auto-flag slow interactions
- [ ] Upload source maps with `@sentry/cli`
- [ ] Enable release tracking
- [ ] Set user context after authentication
- [ ] Test error boundary with a thrown error
- [ ] Verify session replays record correctly
- [ ] Configure Sentry alerts in dashboard
- [ ] Set up on-call rotation for INP alerts

---

## Implementation Priority

### Phase 1 (Essential - Do Now)
1. Smart sampling (`tracesSampler`)
2. Release tracking
3. Source maps upload
4. User/device context

### Phase 2 (Important - This Week)
1. Custom transactions for key flows
2. Performance thresholds (`beforeSend`)
3. Error boundaries
4. User feedback integration

### Phase 3 (Nice to Have - Next Sprint)
1. Custom metrics
2. Distributed tracing (if backend integration)
3. Profiling (continuous profiling)
4. Advanced dashboards

---

## Sentry Dashboard Setup

### Recommended Alerts
```
1. INP > 500ms AND user:NOT_bot
   → Severity: High
   → Notify: #critical-performance

2. Error rate > 1%
   → Severity: Medium
   → Notify: #errors

3. Release deployed
   → Severity: Low
   → Notify: #deployments
```

### Recommended Dashboards
```
1. INP Health
   - Graph: Avg INP by scenario
   - Heatmap: INP distribution
   - Table: Slowest interactions

2. Performance Summary
   - Web Vitals (INP, LCP, CLS)
   - User Sessions
   - Error Rate

3. Release Tracking
   - Issues by release
   - Performance regressions
   - Error count trend
```

---

## Resources

- [Sentry React Docs](https://docs.sentry.io/platforms/javascript/guides/react/)
- [Web Vitals Guide](https://docs.sentry.io/product/dashboards/sentry-dashboards/frontend/web-vitals/)
- [Performance Monitoring](https://docs.sentry.io/product/performance/)
- [Source Maps](https://docs.sentry.io/platforms/javascript/guides/react/sourcemaps/)
