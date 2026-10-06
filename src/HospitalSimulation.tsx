import { useState } from 'react'
import * as Sentry from '@sentry/react'

/**
 * Hospital simulation tab.
 *
 * Generates synthetic Sentry transactions with exact, controlled values so a
 * dashboard can be validated against known expected numbers:
 *
 *  1. AVG(transaction.duration) grouped by `hospital` + `bucket_size`
 *     -> transactions with op `hospital.simulated.load`
 *
 *  2. P95(measurements.inp) - P50(measurements.inp) grouped by `hospital`
 *     -> transactions with op `hospital.simulated.inp` carrying an `inp` measurement
 *
 * Every event is tagged with `hospital`, `bucket_size` (table 1 only),
 * `sim_kind` and `sim_run_id` so it can be filtered/isolated in Sentry.
 */

const DURATION_OP = 'hospital.simulated.load'
/** Suggested screen/transaction names (free text is also allowed). */
const SCREEN_TRANSACTIONS = [
  '/dashboard',
  '/patients',
  '/patients/:patientId',
  '/patients/:patientId/orders',
  '/patients/:patientId/medications',
  '/schedule',
  '/reports',
]
const INP_OP = 'hospital.simulated.inp'
const INP_TXN = 'Hospital Simulation - INP'

/** Delay between events so the SDK transport buffer is never overflowed. */
const SEND_INTERVAL_MS = 40

type DurationRow = {
  hospital: string
  bucketSize: string
  transaction: string
  avgMs: number
  samples: number
}

type InpRow = {
  hospital: string
  diffMs: number
  baseMs: number
  samples: number
}

/**
 * Per-screen rows. Sample counts are equal within each hospital + bucket group
 * and averages are symmetric, so the rolled-up AVG still matches the target:
 *   CCF - Avon / 101-500              -> 1.7s
 *   Metrohealth Main Campus / 101-500 -> 1.2s
 *   Metrohealth Main Campus / 1-50    -> 900ms
 */
const defaultDurationRows: DurationRow[] = [
  { hospital: 'CCF - Avon', bucketSize: '101-500', transaction: '/patients', avgMs: 2100, samples: 20 },
  { hospital: 'CCF - Avon', bucketSize: '101-500', transaction: '/patients/:patientId', avgMs: 1700, samples: 20 },
  { hospital: 'CCF - Avon', bucketSize: '101-500', transaction: '/dashboard', avgMs: 1300, samples: 20 },
  { hospital: 'Metrohealth Main Campus', bucketSize: '101-500', transaction: '/patients', avgMs: 1500, samples: 20 },
  { hospital: 'Metrohealth Main Campus', bucketSize: '101-500', transaction: '/schedule', avgMs: 900, samples: 20 },
  { hospital: 'Metrohealth Main Campus', bucketSize: '1-50', transaction: '/patients/:patientId/orders', avgMs: 1000, samples: 20 },
  { hospital: 'Metrohealth Main Campus', bucketSize: '1-50', transaction: '/dashboard', avgMs: 800, samples: 20 },
]

type RollupRow = { hospital: string; bucketSize: string; avgMs: number; samples: number; screens: number }

/** Expected weighted AVG per hospital + bucket_size (what the dashboard should show). */
function computeRollup(rows: DurationRow[]): RollupRow[] {
  const groups = new Map<
    string,
    { hospital: string; bucketSize: string; total: number; samples: number; screens: Set<string> }
  >()
  for (const row of rows) {
    const key = `${row.hospital}|${row.bucketSize}`
    const group = groups.get(key) ?? {
      hospital: row.hospital,
      bucketSize: row.bucketSize,
      total: 0,
      samples: 0,
      screens: new Set<string>(),
    }
    group.total += row.avgMs * row.samples
    group.samples += row.samples
    group.screens.add(row.transaction)
    groups.set(key, group)
  }
  return [...groups.values()].map((g) => ({
    hospital: g.hospital,
    bucketSize: g.bucketSize,
    avgMs: g.samples ? Math.round(g.total / g.samples) : 0,
    samples: g.samples,
    screens: g.screens.size,
  }))
}

const defaultInpRows: InpRow[] = [
  { hospital: 'CCF - Avon', diffMs: 1700, baseMs: 200, samples: 100 },
  { hospital: 'CCF - Weston', diffMs: 1200, baseMs: 200, samples: 100 },
  { hospital: 'Metrohealth Main Campus', diffMs: 900, baseMs: 200, samples: 100 },
]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function formatMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : `${ms}ms`
}

/**
 * Durations whose arithmetic mean is exactly `avgMs`.
 * Jitter is applied in symmetric +/- pairs so the average is preserved.
 */
function buildDurations(avgMs: number, samples: number, jitterPct: number): number[] {
  const values: number[] = []
  const maxJitter = Math.round(avgMs * (jitterPct / 100))
  for (let i = 0; i < samples; i++) {
    if (maxJitter === 0) {
      values.push(avgMs)
      continue
    }
    if (i % 2 === 0) {
      // Last element of an odd-sized set has no partner -> keep it at the mean.
      if (i === samples - 1) {
        values.push(avgMs)
      } else {
        const j = Math.round(Math.random() * maxJitter)
        values.push(avgMs + j, avgMs - j)
      }
    }
  }
  return values
}

/**
 * INP values such that P50 == base and P95 == base + diff, robust to
 * percentile interpolation / approximate quantiles:
 *   - lowest 55%  -> exactly base
 *   - next 35%    -> spread linearly between base and base + diff
 *   - highest 10% -> exactly base + diff
 * Hence P95 - P50 == diff.
 */
function buildInpValues(baseMs: number, diffMs: number, samples: number): number[] {
  const n = Math.max(samples, 20)
  const lowCount = Math.ceil(n * 0.55)
  const highCount = Math.ceil(n * 0.1)
  const midCount = n - lowCount - highCount
  const values: number[] = []
  for (let i = 0; i < lowCount; i++) values.push(baseMs)
  for (let i = 0; i < midCount; i++) {
    values.push(Math.round(baseMs + (diffMs * (i + 1)) / (midCount + 1)))
  }
  for (let i = 0; i < highCount; i++) values.push(baseMs + diffMs)
  // Shuffle so events don't arrive sorted.
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[values[i], values[j]] = [values[j], values[i]]
  }
  return values
}

function emitTransaction(options: {
  name: string
  op: string
  durationMs: number
  tags: Record<string, string>
  inpMs?: number
}) {
  const { name, op, durationMs, tags, inpMs } = options
  Sentry.startNewTrace(() => {
    Sentry.withScope((scope) => {
      scope.setTags(tags)
      const end = Date.now()
      const span = Sentry.startInactiveSpan({
        name,
        op,
        forceTransaction: true,
        startTime: (end - durationMs) / 1000,
        attributes: { ...tags },
      })
      if (inpMs !== undefined) {
        Sentry.setMeasurement('inp', inpMs, 'millisecond', span)
        span.setAttribute('inp_value_ms', inpMs)
      }
      span.end(end / 1000)
    })
  })
}

function HospitalSimulation() {
  const [durationRows, setDurationRows] = useState<DurationRow[]>(defaultDurationRows)
  const [inpRows, setInpRows] = useState<InpRow[]>(defaultInpRows)
  const [jitterPct, setJitterPct] = useState(20)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ sent: 0, total: 0 })
  const [log, setLog] = useState<string[]>([])
  const [lastRunId, setLastRunId] = useState<string | null>(null)

  const appendLog = (line: string) =>
    setLog((current) => [`${new Date().toLocaleTimeString()} ${line}`, ...current].slice(0, 50))

  const updateDurationRow = (index: number, patch: Partial<DurationRow>) =>
    setDurationRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const updateInpRow = (index: number, patch: Partial<InpRow>) =>
    setInpRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const run = async (jobs: Array<() => void>, label: string, runId: string) => {
    setRunning(true)
    setLastRunId(runId)
    setProgress({ sent: 0, total: jobs.length })
    appendLog(`Started "${label}" (sim_run_id=${runId}, ${jobs.length} events)`)
    for (let i = 0; i < jobs.length; i++) {
      jobs[i]()
      setProgress({ sent: i + 1, total: jobs.length })
      await sleep(SEND_INTERVAL_MS)
    }
    await Sentry.flush(5000)
    appendLog(`Finished "${label}" - flushed to Sentry`)
    setRunning(false)
  }

  const buildDurationJobs = (runId: string) =>
    durationRows.flatMap((row) =>
      buildDurations(row.avgMs, row.samples, jitterPct).map((durationMs) => () =>
        emitTransaction({
          name: row.transaction.trim() || '/unknown',
          op: DURATION_OP,
          durationMs,
          tags: {
            hospital: row.hospital,
            bucket_size: row.bucketSize,
            sim_kind: 'transaction_duration',
            sim_run_id: runId,
          },
        }),
      ),
    )

  const buildInpJobs = (runId: string) =>
    inpRows.flatMap((row) =>
      buildInpValues(row.baseMs, row.diffMs, row.samples).map((inpMs) => () =>
        emitTransaction({
          name: INP_TXN,
          op: INP_OP,
          // Duration of the interaction transaction mirrors the INP value.
          durationMs: inpMs,
          inpMs,
          tags: {
            hospital: row.hospital,
            sim_kind: 'inp',
            sim_run_id: runId,
          },
        }),
      ),
    )

  const newRunId = () => `run-${Date.now().toString(36)}`

  return (
    <section className="hospital-sim">
      <p>
        Sends synthetic transactions with exact values so your Sentry dashboard widgets can be
        checked against the expected tables below. All events carry the tags{' '}
        <code>hospital</code>, <code>sim_kind</code> and <code>sim_run_id</code>.
      </p>

      {/* ---------------- Table 1 ---------------- */}
      <article className="card sim-card">
        <h2>Table 1 - AVG transaction duration</h2>
        <p className="meta">
          op: <code>{DURATION_OP}</code> · transaction: per row (screen) · group by{' '}
          <code>hospital</code>, <code>bucket_size</code> (optionally <code>transaction</code>) ·
          Y-axis <code>avg(transaction.duration)</code>
        </p>
        <datalist id="screen-transactions">
          {SCREEN_TRANSACTIONS.map((txn) => (
            <option key={txn} value={txn} />
          ))}
        </datalist>
        <table className="sim-table">
          <thead>
            <tr>
              <th>Hospital</th>
              <th>Bucket Size</th>
              <th>Transaction (screen)</th>
              <th>AVG Duration (ms)</th>
              <th>Samples</th>
              <th>Expected</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {durationRows.map((row, index) => (
              <tr key={index}>
                <td>
                  <input
                    value={row.hospital}
                    onChange={(e) => updateDurationRow(index, { hospital: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    value={row.bucketSize}
                    onChange={(e) => updateDurationRow(index, { bucketSize: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    list="screen-transactions"
                    placeholder="/your/route"
                    value={row.transaction}
                    onChange={(e) => updateDurationRow(index, { transaction: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    value={row.avgMs}
                    onChange={(e) => updateDurationRow(index, { avgMs: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    value={row.samples}
                    onChange={(e) => updateDurationRow(index, { samples: Number(e.target.value) })}
                  />
                </td>
                <td>{formatMs(row.avgMs)}</td>
                <td>
                  <button
                    type="button"
                    className="secondary"
                    disabled={running}
                    onClick={() => setDurationRows((rows) => rows.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="actions">
          <label className="inline-field">
            Jitter ±%
            <input
              type="number"
              min={0}
              max={90}
              value={jitterPct}
              onChange={(e) => setJitterPct(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={running}
            onClick={() =>
              setDurationRows((rows) => [
                ...rows,
                { hospital: 'New Hospital', bucketSize: '1-50', transaction: '/patients', avgMs: 1000, samples: 20 },
              ])
            }
          >
            Add row
          </button>
          <button
            type="button"
            id="hospital-sim-send-duration"
            disabled={running}
            onClick={() => {
              const runId = newRunId()
              void run(buildDurationJobs(runId), 'AVG transaction duration', runId)
            }}
          >
            Send duration transactions
          </button>
        </div>

        <h3 className="sim-subtitle">Expected dashboard result (grouped by hospital + bucket_size)</h3>
        <table className="sim-table">
          <thead>
            <tr>
              <th>Hospital</th>
              <th>Bucket Size</th>
              <th>AVG Transaction Duration</th>
              <th>Screens</th>
              <th>Samples</th>
            </tr>
          </thead>
          <tbody>
            {computeRollup(durationRows).map((r) => (
              <tr key={`${r.hospital}-${r.bucketSize}`}>
                <td>{r.hospital}</td>
                <td>{r.bucketSize}</td>
                <td>
                  <strong>{formatMs(r.avgMs)}</strong>
                </td>
                <td>{r.screens}</td>
                <td>{r.samples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>

      {/* ---------------- Table 2 ---------------- */}
      <article className="card sim-card">
        <h2>Table 2 - P95(INP) - P50(INP)</h2>
        <p className="meta">
          op: <code>{INP_OP}</code> · transaction: <code>{INP_TXN}</code> · group by{' '}
          <code>hospital</code> · equation <code>p95(measurements.inp) - p50(measurements.inp)</code>
        </p>
        <table className="sim-table">
          <thead>
            <tr>
              <th>Hospital</th>
              <th>P95 - P50 (ms)</th>
              <th>P50 base (ms)</th>
              <th>Samples</th>
              <th>Expected P50 / P95</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {inpRows.map((row, index) => (
              <tr key={index}>
                <td>
                  <input
                    value={row.hospital}
                    onChange={(e) => updateInpRow(index, { hospital: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={0}
                    value={row.diffMs}
                    onChange={(e) => updateInpRow(index, { diffMs: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    value={row.baseMs}
                    onChange={(e) => updateInpRow(index, { baseMs: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={20}
                    value={row.samples}
                    onChange={(e) => updateInpRow(index, { samples: Number(e.target.value) })}
                  />
                </td>
                <td>
                  {formatMs(row.baseMs)} / {formatMs(row.baseMs + row.diffMs)} →{' '}
                  <strong>{formatMs(row.diffMs)}</strong>
                </td>
                <td>
                  <button
                    type="button"
                    className="secondary"
                    disabled={running}
                    onClick={() => setInpRows((rows) => rows.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={running}
            onClick={() =>
              setInpRows((rows) => [
                ...rows,
                { hospital: 'New Hospital', diffMs: 500, baseMs: 200, samples: 100 },
              ])
            }
          >
            Add row
          </button>
          <button
            type="button"
            id="hospital-sim-send-inp"
            disabled={running}
            onClick={() => {
              const runId = newRunId()
              void run(buildInpJobs(runId), 'P95(INP) - P50(INP)', runId)
            }}
          >
            Send INP transactions
          </button>
        </div>
      </article>

      <div className="actions">
        <button
          type="button"
          id="hospital-sim-send-all"
          disabled={running}
          onClick={() => {
            const runId = newRunId()
            void run([...buildDurationJobs(runId), ...buildInpJobs(runId)], 'All tables', runId)
          }}
        >
          Send everything
        </button>
      </div>

      <section className="status" aria-live="polite">
        <p>
          <strong>Status:</strong>{' '}
          {running ? `Sending ${progress.sent}/${progress.total}…` : 'Idle'}
        </p>
        {lastRunId && (
          <p>
            <strong>Last run filter:</strong> <code>sim_run_id:{lastRunId}</code>
          </p>
        )}
        <ul className="sim-log">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </section>
    </section>
  )
}

export default HospitalSimulation

