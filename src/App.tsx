import { useMemo, useState } from 'react'
import * as Sentry from '@sentry/react'
import './App.css'

type Scenario = {
  id: 'fast' | 'medium' | 'slow'
  label: string
  delayMs: number
  description: string
}

const scenarios: Scenario[] = [
  {
    id: 'fast',
    label: 'Low INP',
    delayMs: 0,
    description: 'No intentional blocking. This should stay low.',
  },
  {
    id: 'medium',
    label: 'Medium INP (~300ms)',
    delayMs: 320,
    description: 'Blocks the main thread for about 320ms before UI updates.',
  },
  {
    id: 'slow',
    label: 'High INP (~1000ms)',
    delayMs: 1100,
    description: 'Blocks the main thread for about 1100ms before UI updates.',
  },
]

function blockMainThread(delayMs: number) {
  if (delayMs <= 0) {
    return
  }

  const start = performance.now()
  while (performance.now() - start < delayMs) {
    // Busy loop on purpose: this intentionally worsens INP.
  }
}

function App() {
  const [openModalId, setOpenModalId] = useState<Scenario['id'] | null>(null)
  const [interactionCount, setInteractionCount] = useState(0)
  const [lastInteraction, setLastInteraction] = useState('No interactions yet')

  const openModal = (scenario: Scenario) => {
    Sentry.addBreadcrumb({
      message: `Modal opened for ${scenario.label}`,
      level: 'info',
      data: {
        scenario: scenario.id,
        delay: scenario.delayMs,
      },
    })
    Sentry.setTag('inp_scenario', scenario.id)
    Sentry.setTag('inp_action', 'open_modal')
    Sentry.setContext('inp_test', {
      delay_ms: scenario.delayMs,
      scenario_id: scenario.id,
      scenario_label: scenario.label,
    })

    blockMainThread(scenario.delayMs)
    setOpenModalId(scenario.id)
    setInteractionCount((current) => current + 1)
    setLastInteraction(
      `${scenario.label}: open modal click (${scenario.delayMs}ms block)`,
    )
  }

  const closeModal = (scenario: Scenario) => {
    Sentry.addBreadcrumb({
      message: `Modal closed for ${scenario.label}`,
      level: 'info',
      data: {
        scenario: scenario.id,
        delay: scenario.delayMs,
      },
    })
    Sentry.setTag('inp_scenario', scenario.id)
    Sentry.setTag('inp_action', 'close_modal')
    Sentry.setContext('inp_test', {
      delay_ms: scenario.delayMs,
      scenario_id: scenario.id,
      scenario_label: scenario.label,
    })

    blockMainThread(scenario.delayMs)
    setOpenModalId(null)
    setInteractionCount((current) => current + 1)
    setLastInteraction(
      `${scenario.label}: close modal click (${scenario.delayMs}ms block)`,
    )
  }

  const pingInteraction = (scenario: Scenario) => {
    Sentry.addBreadcrumb({
      message: `Interaction triggered for ${scenario.label}`,
      level: 'info',
      data: {
        scenario: scenario.id,
        delay: scenario.delayMs,
      },
    })
    Sentry.setTag('inp_scenario', scenario.id)
    Sentry.setTag('inp_action', 'button_click')
    Sentry.setContext('inp_test', {
      delay_ms: scenario.delayMs,
      scenario_id: scenario.id,
      scenario_label: scenario.label,
    })

    blockMainThread(scenario.delayMs)
    setInteractionCount((current) => current + 1)
    setLastInteraction(`${scenario.label}: plain button click (${scenario.delayMs}ms block)`)
  }

  const activeScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === openModalId) ?? null,
    [openModalId],
  )

  return (
    <main className="page">
      <section className="intro">
        <h1>Sentry INP Demo</h1>
        <p>
          Use the controls below to trigger interactions with intentional main-thread
          blocking.
        </p>
      </section>

      <section className="grid" aria-label="INP scenarios">
        {scenarios.map((scenario) => (
          <article className="card" key={scenario.id}>
            <h2>{scenario.label}</h2>
            <p>{scenario.description}</p>
            <p className="meta">Configured delay: {scenario.delayMs}ms</p>

            <div className="actions">
              <button type="button" id={`${scenario.label}-ping`} onClick={() => pingInteraction(scenario)}>
                Trigger interaction
              </button>
              <button
                type="button"
                id={`${scenario.label}-open-modal`}
                className="secondary"
                onClick={() => openModal(scenario)}
              >
                Open modal
              </button>
            </div>
          </article>
        ))}
      </section>

      <section className="status" aria-live="polite">
        <p>
          <strong>Total interactions:</strong> {interactionCount}
        </p>
        <p>
          <strong>Last interaction:</strong> {lastInteraction}
        </p>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            Sentry.captureException(new Error('Test error from INP demo'))
          }}
          style={{ marginTop: '12px' }}
        >
          Throw Test Error
        </button>
      </section>

      {activeScenario && (
        <div className="overlay" role="presentation" onClick={() => closeModal(activeScenario)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="modal-title">{activeScenario.label} modal</h2>
            <p>
              Closing this modal also blocks the main thread for {activeScenario.delayMs}
              ms to create another measurable INP event.
            </p>
            <div className="actions">
              <button type="button" onClick={() => pingInteraction(activeScenario)}>
                Trigger interaction in modal
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => closeModal(activeScenario)}
              >
                Close modal
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App

// AUTOMATIC ID INJECTION
// Option 1: Vite Plugin (Compile-Time, Full Auto)
// Automatically injects IDs into all interactive elements at build time
// File: vite-plugin-auto-id.ts
// Already configured in vite.config.ts
// Requires: yarn add --dev @babel/core @babel/preset-react @babel/preset-typescript @babel/traverse @babel/types
// Best for: Large apps, zero manual work, existing code

