# ChronoLens — RTOS Scheduling &amp; Timing Analyzer

[![Live Demo](https://img.shields.io/badge/Live%20Demo-online-3fb950?style=flat)](https://rudupa.github.io/ChronoLens/)
[![License: MIT](https://img.shields.io/badge/License-MIT-a371f7?style=flat)](LICENSE)
![Vanilla JS](https://img.shields.io/badge/Built%20with-Vanilla%20JS%20%2B%20Canvas-d29922?style=flat)

Interactive, single-page analyzer for **real-time operating system scheduling** with
**tasks and interrupt service routines (ISRs)**. Model a periodic/aperiodic workload on
one CPU, watch how it is scheduled under different policies, and see interrupt
preemption, deadline misses and shared-stack nesting on a live Gantt timeline —
with per-entity timing statistics. Built with vanilla HTML/CSS/JavaScript and HTML5
Canvas — no build step, no dependencies, nothing leaves your machine.

## Features

- **Tasks and ISRs.** ISRs preempt tasks by interrupt priority level (IPL); tasks are
  scheduled among themselves by the selected policy.
- **Scheduling policies:** Fixed-Priority Preemptive (AUTOSAR/OSEK), Rate Monotonic
  (RM), Deadline Monotonic (DM), and Earliest Deadline First (EDF).
- **Add / delete tasks &amp; ISRs** and edit every field inline (name, priority/IPL,
  offset, period, execution time, stack size, enable/disable).
- **Load a JSON config** in the AUTOSAR `Os_Tasks_Isrs_Properties.json` shape — see
  [`sample_tasks_isrs.json`](sample_tasks_isrs.json).
- **Gantt timeline:** execution segments, pending/preempted spans, activation markers,
  deadline-miss highlighting, and idle time.
- **Metrics:** CPU utilization, task load, ISR load, idle %, deadline misses, and peak
  shared-stack usage with the nesting chain.
- **Per-entity stats:** jobs released, CPU %, average/maximum response time, maximum
  waiting time, and deadline misses.

Times are entered in **microseconds (µs)**; the timeline axis is shown in **milliseconds**.

## Quick start

Open the [live demo](https://rudupa.github.io/ChronoLens/) — it runs entirely in your
browser. To run locally, just open `index.html` (no server needed).

1. The app loads with a built-in starter set of ISRs and tasks.
2. Pick a **scheduling policy** and **duration** in the sidebar.
3. **Add / delete** tasks and ISRs, or edit fields directly in the table.
4. Or click **Load JSON…** and select [`sample_tasks_isrs.json`](sample_tasks_isrs.json)
   (or your own AUTOSAR export) to drive the simulation.

## JSON format

A configuration is a JSON object with an `entries` array. Each entry describes a task or
ISR:

```json
{
  "counts": { "tasks": 5, "isrs": 3 },
  "entries": [
    {
      "name": "CanRxISR",
      "type": "isr",
      "priority": "IPL_9",
      "triggerType": "event",
      "stackSize": 512,
      "constraints": { "minCycleTime": 4000, "maxCycleTime": 20000, "averageCycleTime": 8000, "averageRunTime": 180, "maxRunTime": 240 },
      "offset": 0,
      "runtime": 220
    }
  ]
}
```

- `type`: `"task"` or `"isr"`.
- `priority`: task priority as a number, or ISR level as `"IPL_x"`.
- `triggerType`: `"time"` (periodic) or `"event"`.
- `constraints`: cycle-time and run-time bounds (µs) used to derive period/execution.
- Any entry whose name matches `idle` becomes the idle task.

## Roadmap

- [ ] Response-time analysis (worst-case response time per task).
- [ ] Resource sharing: priority inheritance / priority ceiling.
- [ ] Sporadic tasks and aperiodic servers.
- [ ] Export schedule as CSV/PNG.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page structure, controls, tables |
| `styles.css` | Dark theme |
| `app.js` | Simulation engine + Gantt rendering |
| `sample_tasks_isrs.json` | Example AUTOSAR-style task &amp; ISR config |

## Author

**Ritesh Udupa** — [LinkedIn](https://www.linkedin.com/in/ritesh-udupa-4b694619/) · [GitHub](https://github.com/rudupa)

## License

MIT — see [LICENSE](LICENSE).
