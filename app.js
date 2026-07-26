'use strict';

/**
 * ChronoLens — RTOS Scheduling Simulator (starter scaffold)
 *
 * A minimal but working preemptive scheduler over a fixed tick timeline,
 * rendered as a Gantt chart. Supports Rate Monotonic (RM), Earliest Deadline
 * First (EDF), Fixed Priority (FP) and Round Robin (RR).
 *
 * Extend from here: add a task editor UI, jitter/offsets, release/response
 * time analysis, aperiodic servers, resource locking (PIP/PCP), etc.
 */

const $ = (id) => document.getElementById(id);

// Colors pulled from the shared theme (see styles.css).
const TASK_COLORS = ['#f0b429', '#3fb950', '#a371f7', '#58a6ff', '#f85149'];

// --- Default periodic task set: { name, period T, computation C, priority } ---
// Deadlines are implicit (D = T). Edit or wire up a UI to change these.
const DEFAULT_TASKS = [
  { name: 'T1', T: 4, C: 1 },
  { name: 'T2', T: 6, C: 2 },
  { name: 'T3', T: 12, C: 3 },
];

const RR_QUANTUM = 1;

let tasks = [];
let timeline = [];   // per-tick: index of running task, or -1 for idle
let missMarks = [];  // per-tick: true if a deadline miss occurred at this tick
let hyperperiod = 0;
let cursor = 0;      // current tick when stepping
let running = false;
let rafId = null;

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const lcm = (a, b) => (a * b) / gcd(a, b);

function initTasks() {
  tasks = DEFAULT_TASKS.map((t, i) => ({
    ...t,
    D: t.T,                 // implicit deadline
    color: TASK_COLORS[i % TASK_COLORS.length],
  }));
  hyperperiod = tasks.reduce((acc, t) => lcm(acc, t.T), 1);
}

/**
 * Simulate the whole hyperperiod for the chosen algorithm.
 * Produces `timeline` (running task per tick) and `missMarks`.
 */
function simulate(algo) {
  const jobs = [];   // active job instances: { taskIdx, remaining, deadline, arrival }
  timeline = new Array(hyperperiod).fill(-1);
  missMarks = new Array(hyperperiod).fill(false);
  let rrPtr = 0;
  let quantumLeft = RR_QUANTUM;

  for (let t = 0; t < hyperperiod; t++) {
    // Release new jobs at their period boundaries.
    tasks.forEach((task, idx) => {
      if (t % task.T === 0) {
        jobs.push({ taskIdx: idx, remaining: task.C, deadline: t + task.D, arrival: t });
      }
    });

    // Drop/flag jobs whose deadline has passed with work remaining.
    for (const job of jobs) {
      if (t >= job.deadline && job.remaining > 0) missMarks[t] = true;
    }

    const ready = jobs.filter((j) => j.remaining > 0);
    if (ready.length === 0) { timeline[t] = -1; continue; }

    let chosen;
    switch (algo) {
      case 'rm': // shorter period => higher priority
        chosen = ready.reduce((a, b) => (tasks[a.taskIdx].T <= tasks[b.taskIdx].T ? a : b));
        break;
      case 'edf': // earliest absolute deadline
        chosen = ready.reduce((a, b) => (a.deadline <= b.deadline ? a : b));
        break;
      case 'fp': // lower task index => higher priority
        chosen = ready.reduce((a, b) => (a.taskIdx <= b.taskIdx ? a : b));
        break;
      case 'rr': {
        rrPtr = rrPtr % ready.length;
        if (quantumLeft <= 0) { rrPtr = (rrPtr + 1) % ready.length; quantumLeft = RR_QUANTUM; }
        chosen = ready[rrPtr];
        quantumLeft--;
        break;
      }
      default:
        chosen = ready[0];
    }

    chosen.remaining -= 1;
    timeline[t] = chosen.taskIdx;
  }
}

// --- Rendering -------------------------------------------------------------

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = parseInt(canvas.getAttribute('height'), 10);
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssW, h: cssH };
}

function drawGantt() {
  const canvas = $('ganttCanvas');
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const padL = 46, padT = 20, padB = 26;
  const rows = tasks.length;
  const rowH = (h - padT - padB) / rows;
  const colW = (w - padL - 10) / hyperperiod;

  // Row labels + lanes.
  ctx.font = '12px "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  tasks.forEach((task, i) => {
    const y = padT + i * rowH;
    ctx.fillStyle = '#8b98a9';
    ctx.textAlign = 'right';
    ctx.fillText(task.name, padL - 8, y + rowH / 2);
    ctx.strokeStyle = '#2b3444';
    ctx.strokeRect(padL, y, w - padL - 10, rowH);
  });

  // Execution blocks.
  for (let t = 0; t < hyperperiod; t++) {
    const idx = timeline[t];
    if (idx < 0) continue;
    const x = padL + t * colW;
    const y = padT + idx * rowH;
    ctx.fillStyle = tasks[idx].color;
    ctx.fillRect(x + 0.5, y + 3, colW - 1, rowH - 6);
  }

  // Deadline-miss markers.
  for (let t = 0; t < hyperperiod; t++) {
    if (!missMarks[t]) continue;
    const x = padL + t * colW;
    ctx.strokeStyle = '#f85149';
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, h - padB);
    ctx.stroke();
  }

  // Time axis ticks.
  ctx.fillStyle = '#8b98a9';
  ctx.textAlign = 'center';
  const stride = Math.max(1, Math.round(hyperperiod / 20));
  for (let t = 0; t <= hyperperiod; t += stride) {
    const x = padL + t * colW;
    ctx.fillText(String(t), x, h - padB / 2 + 4);
  }

  // Playhead when stepping.
  if (cursor > 0 && cursor <= hyperperiod) {
    const x = padL + cursor * colW;
    ctx.strokeStyle = '#58a6ff';
    ctx.beginPath();
    ctx.moveTo(x, padT - 6);
    ctx.lineTo(x, h - padB);
    ctx.stroke();
  }
}

function renderTaskList() {
  const el = $('taskList');
  el.innerHTML = '';
  tasks.forEach((task) => {
    const row = document.createElement('div');
    row.className = 'task-row';
    row.innerHTML =
      `<span class="swatch" style="background:${task.color}"></span>` +
      `<span>${task.name}</span>` +
      `<span class="task-meta">T=${task.T} · C=${task.C} · D=${task.D}</span>`;
    el.appendChild(row);
  });
}

function renderMetrics() {
  const util = tasks.reduce((acc, t) => acc + t.C / t.T, 0);
  const misses = missMarks.filter(Boolean).length;
  const n = tasks.length;
  const rmBound = n * (Math.pow(2, 1 / n) - 1); // Liu & Layland
  $('mUtil').textContent = (util * 100).toFixed(1) + '%';
  $('mMiss').textContent = String(misses);
  $('mSched').textContent = util <= rmBound ? `yes (≤ ${(rmBound * 100).toFixed(1)}%)` : `check (> ${(rmBound * 100).toFixed(1)}%)`;
  $('mTime').textContent = `${cursor} / ${hyperperiod}`;
}

function renderAll() { drawGantt(); renderTaskList(); renderMetrics(); }

// --- Controls --------------------------------------------------------------

function rebuild() {
  initTasks();
  simulate($('algo').value);
  cursor = hyperperiod; // show full schedule by default
  renderAll();
}

function reset() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  cursor = 0;
  simulate($('algo').value);
  renderAll();
}

function step() {
  if (cursor < hyperperiod) cursor += 1;
  renderAll();
}

function run() {
  running = !running;
  $('btnRun').textContent = running ? 'Pause' : 'Run';
  if (running) loop();
  else if (rafId) cancelAnimationFrame(rafId);
}

let lastAdvance = 0;
function loop(ts) {
  if (!running) return;
  if (!ts) ts = performance.now();
  if (ts - lastAdvance > 300) { // one tick per 300ms
    lastAdvance = ts;
    if (cursor < hyperperiod) cursor += 1;
    else { running = false; $('btnRun').textContent = 'Run'; }
    renderAll();
  }
  rafId = requestAnimationFrame(loop);
}

$('algo').addEventListener('change', rebuild);
$('btnRun').addEventListener('click', run);
$('btnStep').addEventListener('click', () => { running = false; $('btnRun').textContent = 'Run'; step(); });
$('btnReset').addEventListener('click', reset);
window.addEventListener('resize', () => renderAll());

rebuild();
