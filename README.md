# ChronoLens — RTOS Scheduling Simulator

[![Live Demo](https://img.shields.io/badge/Live%20Demo-online-3fb950?style=flat)](https://rudupa.github.io/ChronoLens/)
[![License: MIT](https://img.shields.io/badge/License-MIT-a371f7?style=flat)](LICENSE)
![Vanilla JS](https://img.shields.io/badge/Built%20with-Vanilla%20JS%20%2B%20Canvas-d29922?style=flat)

Interactive, single-page visualizer for **real-time operating system scheduling**.
Watch how a periodic task set is scheduled on one CPU under different policies —
**Rate Monotonic (RM)**, **Earliest Deadline First (EDF)**, **Fixed Priority (FP)**,
and **Round Robin (RR)** — on a live Gantt chart, with CPU-utilization and
deadline-miss analysis. Built with vanilla HTML/CSS/JavaScript and HTML5 Canvas —
no build step, no dependencies.

## Features

- Preemptive scheduling over a full hyperperiod, rendered as a Gantt chart.
- Four policies: RM, EDF, FP, RR (configurable quantum).
- Per-tick deadline-miss detection with visual markers.
- Metrics: CPU utilization, deadline misses, Liu & Layland RM schedulability bound.
- Run / Step / Reset controls with a playhead.

## Roadmap

- [ ] Editable task set (add/remove tasks, set T/C/D, offsets, jitter).
- [ ] Response-time analysis (worst-case response time per task).
- [ ] Resource sharing: priority inheritance / priority ceiling.
- [ ] Aperiodic/sporadic tasks and servers.
- [ ] Export schedule as CSV/PNG.

## Run it

Open the [live demo](https://rudupa.github.io/ChronoLens/) — runs entirely in your
browser. To run locally, just open `index.html` (no server needed).

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page structure and controls |
| `styles.css` | Dark theme |
| `app.js` | Scheduler + Gantt rendering |

## Author

**Ritesh Udupa** — [LinkedIn](https://www.linkedin.com/in/ritesh-udupa-4b694619/) · [GitHub](https://github.com/rudupa)

## License

MIT — see [LICENSE](LICENSE).
