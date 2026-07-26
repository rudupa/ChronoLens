'use strict';

/**
 * ChronoLens — RTOS Scheduling & Timing Analyzer
 *
 * A single-page, vanilla-JS port of the Scheduler Timing Analyzer design:
 * simulates OS task & ISR scheduling and visualizes activations, execution,
 * preemption and interrupt interference on a Gantt timeline.
 *
 * Features:
 *   - Tasks and ISRs (ISRs preempt tasks by interrupt priority level / IPL).
 *   - Scheduling policies: Fixed-Priority Preemptive (FPP), Rate Monotonic (RM),
 *     Deadline Monotonic (DM), Earliest Deadline First (EDF).
 *   - Add / delete tasks and ISRs, edit every field inline.
 *   - Load a JSON config (AUTOSAR Os_Tasks_Isrs_Properties.json shape).
 *   - Per-entity timing stats, CPU/ISR/idle load, deadline misses, peak stack.
 *
 * Times are in microseconds (µs) internally; the timeline axis is shown in ms.
 * Everything runs client-side — nothing is uploaded.
 */

const $ = (id) => document.getElementById(id);
const EPS = 1e-6;
const US_PER_MS = 1000;

// ---------- Palettes (from the reference design) ----------
const TASK_PALETTE = [
  '#4F9DDE', '#43B98A', '#8E7DE3', '#3FBFBF', '#5C8AE6',
  '#6FB65B', '#A98BE0', '#4CB0C9', '#7CA5F0', '#57C08A',
  '#9C86D8', '#4AA6B8',
];
const ISR_PALETTE = [
  '#E4572E', '#F2913D', '#D64550', '#E8703A', '#C9455F',
  '#EF8A46', '#DA5A2A', '#F0A03C',
];
const IDLE_COLOR = '#5a5f6a';

const POLICY_LABELS = {
  FPP: 'Fixed-Priority Preemptive (AUTOSAR/OSEK)',
  RM: 'Rate Monotonic',
  DM: 'Deadline Monotonic',
  EDF: 'Earliest Deadline First',
};

// ---------- App state ----------
let entities = [];
let idSeq = 1;
let taskColorIdx = 0;
let isrColorIdx = 0;

const params = {
  policy: 'FPP',
  duration: 60000,
  higherNumberIsHigherPriority: true,
  cores: 1,
};

let activeCore = 0;
let fileName = 'built-in starter set';

// ---------- Entity helpers ----------
function nextTaskColor() { return TASK_PALETTE[taskColorIdx++ % TASK_PALETTE.length]; }
function nextIsrColor() { return ISR_PALETTE[isrColorIdx++ % ISR_PALETTE.length]; }

function makeEntity(partial) {
  const kind = partial.kind || 'task';
  const isIdle = !!partial.isIdle;
  const color = partial.color || (kind === 'isr' ? nextIsrColor() : (isIdle ? IDLE_COLOR : nextTaskColor()));
  return {
    id: `e${idSeq++}`,
    name: partial.name || (kind === 'isr' ? 'NewISR' : 'NewTask'),
    kind,
    priority: partial.priority ?? 10,
    ipl: partial.ipl ?? 4,
    period: partial.period ?? (kind === 'isr' ? 5000 : 10000),
    offset: partial.offset ?? 0,
    exec: partial.exec ?? (kind === 'isr' ? 200 : 1000),
    deadline: partial.deadline,             // may be undefined -> derived
    isIdle,
    triggerType: partial.triggerType || (kind === 'isr' ? 'event' : 'time'),
    color,
    enabled: partial.enabled ?? true,
    oneShot: partial.oneShot ?? false,
    stackSize: partial.stackSize ?? (kind === 'isr' ? 512 : 2048),
    core: partial.core ?? 0,
  };
}

/** Effective relative deadline (implicit-deadline model: D = period). */
function relDeadline(e) {
  if (e.deadline && e.deadline > 0) return e.deadline;
  return e.period > 0 ? e.period : Infinity;
}

// ---------- Starter set ----------
function starterEntities() {
  idSeq = 1; taskColorIdx = 0; isrColorIdx = 0;
  return [
    // ISRs (preempt everything by IPL)
    makeEntity({ name: 'CounterISR', kind: 'isr', ipl: 5, period: 1000, offset: 137, exec: 40, stackSize: 256, triggerType: 'time' }),
    makeEntity({ name: 'CanRxISR', kind: 'isr', ipl: 8, period: 4000, offset: 274, exec: 220, stackSize: 512, triggerType: 'event' }),
    makeEntity({ name: 'AdcISR', kind: 'isr', ipl: 6, period: 8000, offset: 411, exec: 320, stackSize: 512, triggerType: 'event' }),
    // Tasks (higher priority number = higher priority, AUTOSAR default)
    makeEntity({ name: 'Tsk_5ms', kind: 'task', priority: 60, period: 5000, offset: 0, exec: 1000, stackSize: 2048 }),
    makeEntity({ name: 'Tsk_10ms', kind: 'task', priority: 50, period: 10000, offset: 0, exec: 2200, stackSize: 4096 }),
    makeEntity({ name: 'Tsk_20ms', kind: 'task', priority: 40, period: 20000, offset: 0, exec: 3000, stackSize: 4096 }),
    makeEntity({ name: 'Tsk_Background', kind: 'task', priority: 5, period: 50000, offset: 0, exec: 4000, stackSize: 1024 }),
    // Idle
    makeEntity({ name: 'IdleTask', kind: 'task', isIdle: true, priority: 0, period: 0, offset: 0, exec: 0, stackSize: 512 }),
  ];
}

// ---------- JSON loading (AUTOSAR Os_Tasks_Isrs_Properties.json shape) ----------
const BUILD_DEFAULTS = {
  taskExec: 300, isrExec: 60, oneShotExec: 400,
  eventPeriod: 6000, isrPeriod: 5000, systemTimerPeriod: 1000, systemTimerExec: 40,
};

function parseIpl(priority) {
  const m = /IPL_?(\d+)/i.exec(String(priority));
  return m ? parseInt(m[1], 10) : 0;
}
function pickCycle(c) {
  if (!c) return null;
  if (c.averageCycleTime > 0) return c.averageCycleTime;
  if (c.minCycleTime > 0 && c.maxCycleTime > 0) return Math.round((c.minCycleTime + c.maxCycleTime) / 2);
  if (c.minCycleTime > 0) return c.minCycleTime;
  if (c.maxCycleTime > 0) return c.maxCycleTime;
  return null;
}
function pickExecTask(e, oneShot) {
  const c = e.constraints || {};
  if (e.runtime > 0) return e.runtime;
  if (c.maxRunTime > 0) return c.maxRunTime;
  if (c.averageRunTime > 0) return c.averageRunTime;
  return oneShot ? BUILD_DEFAULTS.oneShotExec : BUILD_DEFAULTS.taskExec;
}

function buildFromRaw(config) {
  idSeq = 1; taskColorIdx = 0; isrColorIdx = 0;
  let isrIndex = 0;
  return (config.entries || []).map((e) => {
    const isIdle = /idle/i.test(e.name);
    const kind = e.type === 'isr' ? 'isr' : 'task';
    const c = e.constraints || {};
    let period, exec, oneShot = false;
    let offset = e.offset ?? 0;
    const isSystemTimer = /systemtimer|systimer|counterisr/i.test(e.name);

    if (kind === 'isr') {
      period = isSystemTimer ? BUILD_DEFAULTS.systemTimerPeriod : BUILD_DEFAULTS.isrPeriod;
      exec = e.runtime > 0 ? e.runtime : (isSystemTimer ? BUILD_DEFAULTS.systemTimerExec : BUILD_DEFAULTS.isrExec);
      if (!offset) offset = (isrIndex + 1) * 137;
      isrIndex++;
    } else if (isIdle) {
      period = 0; exec = 0;
    } else if (e.triggerType === 'event') {
      period = c.minCycleTime > 0 ? c.minCycleTime : BUILD_DEFAULTS.eventPeriod;
      exec = pickExecTask(e, false);
    } else {
      const cycle = pickCycle(c);
      if (cycle > 0) { period = cycle; } else { period = 0; oneShot = true; }
      exec = pickExecTask(e, oneShot);
    }

    const basePriority = parseInt(e.priority, 10) || 0;
    return makeEntity({
      name: e.name, kind, isIdle,
      priority: basePriority,
      ipl: kind === 'isr' ? parseIpl(e.priority) : 0,
      period, offset, exec, oneShot,
      triggerType: e.triggerType || (kind === 'isr' ? 'event' : 'time'),
      stackSize: parseInt(e.stackSize, 10) || 0,
      core: parseInt(e.core, 10) || 0,
    });
  });
}

// ---------- Simulation engine (discrete-event) ----------
function orderLanes(list) {
  const isrs = list.filter((e) => e.kind === 'isr').sort((a, b) => b.ipl - a.ipl);
  const tasks = list.filter((e) => e.kind === 'task' && !e.isIdle).sort((a, b) => b.priority - a.priority);
  const idle = list.filter((e) => e.isIdle);
  return [...isrs, ...tasks, ...idle];
}

function releasesFor(e, endTime) {
  if (e.isIdle) return [];
  if (e.period <= 0) return e.offset < endTime ? [e.offset] : [];
  const out = [];
  for (let t = e.offset; t < endTime; t += e.period) out.push(t);
  return out;
}

function simulate(allEntities, p) {
  const endTime = p.duration;
  const ordered = orderLanes(allEntities);
  const laneNames = ordered.map((e) => e.name);
  const laneIndexOf = new Map();
  ordered.forEach((e, i) => laneIndexOf.set(e.id, i));

  const enabled = ordered.filter((e) => e.enabled);
  const rts = new Map();
  for (const e of enabled) {
    rts.set(e.id, {
      entity: e, laneIndex: laneIndexOf.get(e.id),
      queue: [], nextJobId: 0, totalCpu: 0,
      responseTimes: [], waitingTimes: [], jobsReleased: 0, jobsCompleted: 0, misses: 0,
    });
  }
  const idleEntity = enabled.find((e) => e.isIdle) || null;

  const releases = [];
  for (const e of enabled) {
    if (e.isIdle) continue;
    const rt = rts.get(e.id);
    for (const t of releasesFor(e, endTime)) releases.push({ time: t, rt });
  }
  releases.sort((a, b) => a.time - b.time);

  const segments = [], spans = [], activations = [], idleSegments = [];
  const effPriority = (e) => (p.higherNumberIsHigherPriority ? e.priority : -e.priority);

  function moreUrgent(a, b) {
    const ea = a.entity, eb = b.entity;
    switch (p.policy) {
      case 'RM': {
        const pa = ea.period > 0 ? ea.period : Infinity;
        const pb = eb.period > 0 ? eb.period : Infinity;
        return pa < pb;
      }
      case 'DM': return relDeadline(ea) < relDeadline(eb);
      case 'EDF': return a.queue[0].absDeadline < b.queue[0].absDeadline;
      case 'FPP':
      default: return effPriority(ea) > effPriority(eb);
    }
  }

  function pickRunning() {
    let bestIsr = null;
    for (const rt of rts.values()) {
      if (rt.entity.kind !== 'isr' || rt.queue.length === 0) continue;
      if (!bestIsr || rt.entity.ipl > bestIsr.entity.ipl) bestIsr = rt;
    }
    if (bestIsr) return bestIsr;
    let bestTask = null;
    for (const rt of rts.values()) {
      const e = rt.entity;
      if (e.kind !== 'task' || e.isIdle || rt.queue.length === 0) continue;
      if (!bestTask) { bestTask = rt; continue; }
      if (moreUrgent(rt, bestTask)) bestTask = rt;
    }
    if (bestTask) return bestTask;
    if (idleEntity) return rts.get(idleEntity.id);
    return null;
  }

  let t = 0, ri = 0, curSegStart = 0, current = null;

  function closeSegment(at) {
    if (current && at > curSegStart + EPS) {
      if (current.entity.isIdle) {
        idleSegments.push({ start: curSegStart, end: at });
      } else {
        segments.push({
          entityId: current.entity.id, name: current.entity.name, kind: current.entity.kind,
          laneIndex: current.laneIndex, start: curSegStart, end: at,
          jobId: current.queue.length ? current.queue[0].jobId : -1, color: current.entity.color,
        });
      }
    }
  }

  let guard = 0;
  const guardMax = (releases.length + 1) * 8 + 1000000;
  while (t < endTime - EPS) {
    if (guard++ > guardMax) break;

    while (ri < releases.length && releases[ri].time <= t + EPS) {
      const rel = releases[ri++];
      const rt = rel.rt, e = rt.entity;
      const rd = relDeadline(e);
      const job = {
        jobId: rt.nextJobId++, release: rel.time, remaining: e.exec,
        absDeadline: rel.time + (rd === Infinity ? endTime : rd), started: false,
      };
      rt.queue.push(job);
      rt.jobsReleased++;
      activations.push({ entityId: e.id, laneIndex: rt.laneIndex, time: rel.time, jobId: job.jobId, kind: e.kind });
    }

    const next = pickRunning();
    if (next !== current) { closeSegment(t); current = next; curSegStart = t; }

    const nextRelease = ri < releases.length ? releases[ri].time : Infinity;
    let completion = Infinity;
    if (current && !current.entity.isIdle && current.queue.length) {
      completion = t + current.queue[0].remaining;
    }
    const tNext = Math.min(nextRelease, completion, endTime);
    const delta = tNext - t;
    if (delta <= EPS && completion > tNext + EPS && nextRelease > tNext + EPS) break;

    if (current && !current.entity.isIdle && current.queue.length && delta > 0) {
      current.queue[0].remaining -= delta;
      current.totalCpu += delta;
    }
    t = tNext;

    if (current && !current.entity.isIdle && current.queue.length &&
        current.queue[0].remaining <= EPS && Math.abs(completion - t) <= EPS + 1e-9) {
      closeSegment(t);
      const rt = current, job = rt.queue.shift();
      const response = t - job.release;
      const waiting = Math.max(0, response - rt.entity.exec);
      rt.responseTimes.push(response);
      rt.waitingTimes.push(waiting);
      rt.jobsCompleted++;
      const missed = t > job.absDeadline + EPS;
      if (missed) rt.misses++;
      spans.push({
        entityId: rt.entity.id, laneIndex: rt.laneIndex, jobId: job.jobId,
        release: job.release, completion: t, deadline: job.absDeadline,
        responseTime: response, missed, kind: rt.entity.kind,
      });
      current = null; curSegStart = t;
    }
  }
  closeSegment(Math.min(t, endTime));

  const window = endTime || 1;
  const stats = ordered.filter((e) => rts.has(e.id) && !e.isIdle).map((e) => {
    const rt = rts.get(e.id);
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    const max = (a) => (a.length ? Math.max(...a) : 0);
    return {
      entityId: e.id, name: e.name, kind: e.kind, color: e.color,
      jobs: rt.jobsReleased, completed: rt.jobsCompleted, totalCpu: rt.totalCpu,
      utilization: (rt.totalCpu / window) * 100,
      avgResponse: avg(rt.responseTimes), maxResponse: max(rt.responseTimes),
      avgWaiting: avg(rt.waitingTimes), maxWaiting: max(rt.waitingTimes),
      deadlineMisses: rt.misses,
    };
  });

  const isrLoad = stats.filter((s) => s.kind === 'isr').reduce((s, x) => s + x.totalCpu, 0);
  const taskLoad = stats.filter((s) => s.kind === 'task').reduce((s, x) => s + x.totalCpu, 0);
  const idleTime = Math.max(0, window - taskLoad - isrLoad);
  const totalDeadlineMisses = stats.reduce((s, x) => s + x.deadlineMisses, 0);

  // Peak shared-stack usage (single-stack model; jobs nest under preemption).
  const stackById = new Map(), nameById = new Map();
  for (const e of ordered) { stackById.set(e.id, e.stackSize); nameById.set(e.id, e.name); }
  const firstStart = new Map();
  for (const seg of segments) {
    if (seg.jobId < 0) continue;
    const key = `${seg.entityId}#${seg.jobId}`;
    const prev = firstStart.get(key);
    if (prev === undefined || seg.start < prev) firstStart.set(key, seg.start);
  }
  const completionOf = new Map();
  for (const sp of spans) completionOf.set(`${sp.entityId}#${sp.jobId}`, sp.completion);
  const events = [];
  for (const [key, start] of firstStart) {
    const entityId = key.slice(0, key.lastIndexOf('#'));
    const size = stackById.get(entityId) ?? 0;
    const done = completionOf.get(key) ?? endTime;
    if (done <= start) continue;
    events.push({ time: start, delta: size, key });
    events.push({ time: done, delta: -size, key });
  }
  events.sort((a, b) => (a.time - b.time) || (a.delta - b.delta));
  let curStack = 0, peakStack = 0, peakStackTime = 0, peakActive = [];
  const active = new Set();
  for (const ev of events) {
    if (ev.delta > 0) active.add(ev.key); else active.delete(ev.key);
    curStack += ev.delta;
    if (curStack > peakStack) {
      peakStack = curStack; peakStackTime = ev.time;
      peakActive = [...active].map((k) => nameById.get(k.slice(0, k.lastIndexOf('#'))) || '');
    }
  }

  return {
    entities: ordered, laneNames, segments, spans, activations, idleSegments, endTime, stats,
    cpuUtilization: ((taskLoad + isrLoad) / window) * 100,
    isrLoad: (isrLoad / window) * 100, taskLoad: (taskLoad / window) * 100,
    idleTime, totalDeadlineMisses, peakStack, peakStackTime, peakStackChain: peakActive,
  };
}

// ---------- Rendering: Gantt (canvas) ----------
const SPAN_COLOR = 'rgba(255,255,255,0.10)';
const SPAN_MISS_COLOR = 'rgba(228,87,46,0.22)';
const IDLE_SPAN_COLOR = 'rgba(120,128,140,0.18)';
const ACTIVATION_COLOR = '#f5d442';
const PAD_L = 172, PAD_R = 22, PAD_T = 14, PAD_B = 40;
const LANE_H = 30;

function toMs(us) { return us / US_PER_MS; }

// Rebuild one titled canvas per core and draw each core's schedule.
function drawAllGantts(results) {
  const stack = $('ganttStack');
  if (stack.childElementCount !== results.length) {
    stack.innerHTML = results.map((_, c) =>
      `<div class="core-gantt"><div class="core-gantt-title" data-core="${c}">Core ${c}</div>` +
      `<div class="canvas-wrap"><canvas class="gantt-canvas" data-core="${c}"></canvas></div></div>`
    ).join('');
  }
  results.forEach((res, c) => {
    const canvas = stack.querySelector(`canvas[data-core="${c}"]`);
    const title = stack.querySelector(`.core-gantt-title[data-core="${c}"]`);
    if (title) title.textContent = `Core ${c} — CPU ${res.cpuUtilization.toFixed(0)}%`;
    if (canvas) drawGantt(canvas, res);
  });
}

function drawGantt(canvas, result) {
  const lanes = result.laneNames.length || 1;
  const cssH = PAD_T + PAD_B + lanes * LANE_H;
  const cssW = canvas.clientWidth || 900;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.height = cssH + 'px';
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const plotW = cssW - PAD_L - PAD_R;
  const end = result.endTime || 1;
  const x = (tt) => PAD_L + (tt / end) * plotW;
  const laneY = (i) => PAD_T + i * LANE_H;
  const isIsr = result.entities.map((e) => e.kind === 'isr');

  // Lane backgrounds + labels
  ctx.font = '11px "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < lanes; i++) {
    const y = laneY(i);
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.015)' : 'transparent';
    ctx.fillRect(PAD_L, y, plotW, LANE_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.moveTo(PAD_L, y + LANE_H); ctx.lineTo(PAD_L + plotW, y + LANE_H); ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillStyle = isIsr[i] ? '#f0a03c' : '#c7cdd8';
    const label = (isIsr[i] ? '⚡ ' : '') + result.laneNames[i];
    ctx.fillText(label.length > 24 ? label.slice(0, 23) + '…' : label, 8, y + LANE_H / 2);
  }

  // Vertical time grid (every 5 ms major)
  ctx.textAlign = 'center';
  const majorUs = 5 * US_PER_MS;
  for (let tt = 0; tt <= end + EPS; tt += majorUs) {
    const px = x(tt);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.moveTo(px, PAD_T); ctx.lineTo(px, PAD_T + lanes * LANE_H); ctx.stroke();
    ctx.fillStyle = '#8b93a4';
    ctx.fillText(String(toMs(tt)), px, PAD_T + lanes * LANE_H + 14);
  }
  ctx.fillStyle = '#8b93a4';
  ctx.textAlign = 'right';
  ctx.fillText('time (ms)', cssW - PAD_R, PAD_T + lanes * LANE_H + 28);

  // Idle spans
  const idleLane = result.entities.findIndex((e) => e.isIdle);
  if (idleLane >= 0) {
    for (const s of result.idleSegments) {
      const y = laneY(idleLane);
      ctx.fillStyle = IDLE_SPAN_COLOR;
      ctx.fillRect(x(s.start), y + LANE_H * 0.14, Math.max(x(s.end) - x(s.start), 0.5), LANE_H * 0.72);
    }
  }

  // Pending / preempted spans (release -> completion)
  for (const s of result.spans) {
    const y = laneY(s.laneIndex);
    ctx.fillStyle = s.missed ? SPAN_MISS_COLOR : SPAN_COLOR;
    ctx.fillRect(x(s.release), y + LANE_H * 0.14, Math.max(x(s.completion) - x(s.release), 0.5), LANE_H * 0.72);
  }

  // Execution segments
  for (const s of result.segments) {
    const y = laneY(s.laneIndex);
    ctx.fillStyle = s.color;
    ctx.fillRect(x(s.start), y + LANE_H * 0.26, Math.max(x(s.end) - x(s.start), 0.6), LANE_H * 0.48);
  }

  // Activation markers (downward triangles at top of lane)
  ctx.fillStyle = ACTIVATION_COLOR;
  for (const a of result.activations) {
    const y = laneY(a.laneIndex);
    const px = x(a.time);
    ctx.beginPath();
    ctx.moveTo(px - 4, y + 1); ctx.lineTo(px + 4, y + 1); ctx.lineTo(px, y + 8);
    ctx.closePath(); ctx.fill();
  }
}

// ---------- Rendering: metrics + stats ----------
function pct(v) { return `${v.toFixed(1)}%`; }
function bytesFmt(v) { return v >= 1024 ? `${(v / 1024).toFixed(v % 1024 === 0 ? 0 : 1)} KB` : `${v} B`; }

function renderSummary(results) {
  const nCores = results.length || 1;
  const window = (results[0] ? results[0].endTime : 0) || 1;
  const cpu = results.reduce((s, r) => s + r.cpuUtilization, 0) / nCores;
  const taskL = results.reduce((s, r) => s + r.taskLoad, 0) / nCores;
  const isrL = results.reduce((s, r) => s + r.isrLoad, 0) / nCores;
  const idleT = results.reduce((s, r) => s + r.idleTime, 0);
  const idlePct = (idleT / (window * nCores)) * 100;
  const misses = results.reduce((s, r) => s + r.totalDeadlineMisses, 0);
  // Peak stack: worst core (stacks are per-core in a shared-stack model).
  let peakCore = results[0] || { peakStack: 0, peakStackTime: 0, peakStackChain: [] };
  for (const r of results) if (r.peakStack > peakCore.peakStack) peakCore = r;
  const peakMs = (peakCore.peakStackTime || 0) / 1000;

  const cpuLabel = nCores > 1 ? 'CPU util (avg)' : 'CPU utilization';
  const metrics = [
    { label: cpuLabel, value: pct(cpu), cls: cpu > 100 ? 'bad' : 'ok' },
    { label: 'Task load', value: pct(taskL), cls: '' },
    { label: 'ISR load', value: pct(isrL), cls: 'isr' },
    { label: 'Idle', value: pct(idlePct), cls: '' },
    { label: 'Deadline misses', value: String(misses), cls: misses > 0 ? 'bad' : 'ok' },
    { label: `Peak stack @ ${peakMs.toFixed(peakMs >= 10 ? 0 : 2)} ms`, value: bytesFmt(peakCore.peakStack), cls: 'isr' },
  ];
  $('metrics').innerHTML = metrics.map((m) =>
    `<div class="metric ${m.cls}"><div class="metric-value">${m.value}</div><div class="metric-label">${m.label}</div></div>`
  ).join('');

  const chain = peakCore.peakStackChain || [];
  $('stackChain').innerHTML = chain.length
    ? `<span class="stack-chain-label">Peak nesting (${chain.length}):</span> ${chain.join(' ▸ ')}`
    : '';
  $('stackChain').style.display = chain.length ? 'block' : 'none';
}

// ---------- Rendering: core tabs ----------
function renderCoreTabs() {
  const bar = $('coreTabs');
  bar.innerHTML = Array.from({ length: params.cores }, (_, c) => {
    const n = entities.filter((e) => (e.core || 0) === c && !(e.kind === 'task' && e.isIdle)).length;
    return `<button class="core-tab ${c === activeCore ? 'active' : ''}" data-core="${c}">Core ${c}<span class="tab-count">${n}</span></button>`;
  }).join('');
}

// ---------- Rendering: combined entity editor + per-entity timing table ----------
function coreOptions(sel) {
  return Array.from({ length: params.cores }, (_, c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
}

function renderEntityTable() {
  $('entityTable').classList.toggle('single-core', params.cores === 1);
  const body = $('entityBody');
  body.innerHTML = entities.filter((e) => (e.core || 0) === activeCore).map((e) => {
    const off = e.isIdle ? 'disabled' : '';
    const prioTitle = e.kind === 'isr' ? 'Interrupt priority level (IPL)' : 'Task priority';
    const prioVal = e.kind === 'isr' ? e.ipl : e.priority;
    const typeLabel = e.kind === 'isr' ? '⚡ ISR' : (e.isIdle ? 'idle' : 'task');
    return `<tr data-id="${e.id}" class="${e.enabled ? '' : 'row-off'}">
      <td><input type="checkbox" data-f="enabled" ${e.enabled ? 'checked' : ''}></td>
      <td><span class="dot" style="background:${e.color}"></span><input class="name-in" type="text" data-f="name" value="${e.name}" ${off}></td>
      <td>${typeLabel}</td>
      <td class="col-core"><select class="mini mini-select" data-f="core" title="Assign to core">${coreOptions(e.core || 0)}</select></td>
      <td><input class="mini" type="number" min="0" data-f="prio" value="${prioVal}" title="${prioTitle}" ${off}></td>
      <td><input class="mini" type="number" min="0" data-f="offset" value="${e.offset}" ${off}></td>
      <td><input class="mini" type="number" min="0" data-f="period" value="${e.period}" ${off}></td>
      <td><input class="mini" type="number" min="0" data-f="exec" value="${e.exec}" ${off}></td>
      <td><input class="mini" type="number" min="0" data-f="deadline" value="${e.deadline ?? ''}" placeholder="=period" title="Relative deadline (blank = period)" ${off}></td>
      <td><input class="mini" type="number" min="0" step="128" data-f="stack" value="${e.stackSize}"></td>
      <td class="st st-sep st-jobs">·</td>
      <td class="st st-cpu">·</td>
      <td class="st st-ravg">·</td>
      <td class="st st-rmax">·</td>
      <td class="st st-wmax">·</td>
      <td class="st st-miss">·</td>
      <td><button class="row-del" data-del="${e.id}" title="Delete">✕</button></td>
    </tr>`;
  }).join('');
}

// Update only the computed stat cells in place (keeps input focus while editing).
function renderRowStats(results) {
  const byId = new Map();
  for (const r of results) for (const s of r.stats) byId.set(s.entityId, s);
  const rows = $('entityBody').querySelectorAll('tr[data-id]');
  rows.forEach((tr) => {
    const set = (cls, val) => { const td = tr.querySelector('.' + cls); if (td) td.textContent = val; };
    const s = byId.get(tr.dataset.id);
    if (!s) {
      ['st-jobs', 'st-cpu', 'st-ravg', 'st-rmax', 'st-wmax', 'st-miss'].forEach((c) => set(c, '·'));
      tr.classList.remove('row-bad');
      return;
    }
    set('st-jobs', s.jobs);
    set('st-cpu', s.utilization.toFixed(1));
    set('st-ravg', toMs(s.avgResponse).toFixed(2));
    set('st-rmax', toMs(s.maxResponse).toFixed(2));
    set('st-wmax', toMs(s.maxWaiting).toFixed(2));
    set('st-miss', s.deadlineMisses > 0 ? s.deadlineMisses : '·');
    tr.classList.toggle('row-bad', s.deadlineMisses > 0);
  });
}

// ---------- Recompute pipeline ----------
function recompute() {
  const results = [];
  for (let c = 0; c < params.cores; c++) {
    const coreEntities = entities.filter((e) => (e.core || 0) === c);
    results.push(simulate(coreEntities, params));
  }
  drawAllGantts(results);
  renderSummary(results);
  renderRowStats(results);
  const taskCount = entities.filter((e) => e.kind === 'task' && !e.isIdle).length;
  const isrCount = entities.filter((e) => e.kind === 'isr').length;
  $('badgeTasks').textContent = `${taskCount} tasks`;
  $('badgeIsrs').textContent = `${isrCount} ISRs`;
  window._lastResults = results;
}

function refreshAll() {
  if (activeCore >= params.cores) activeCore = 0;
  renderCoreTabs();
  renderEntityTable();
  recompute();
}

// ---------- Event wiring ----------
function setError(msg) {
  const el = $('errorBanner');
  if (msg) { el.textContent = msg; el.style.display = 'block'; }
  else { el.style.display = 'none'; }
}

$('policy').addEventListener('change', (e) => { params.policy = e.target.value; recompute(); });
$('duration').addEventListener('change', (e) => { params.duration = Math.max(1000, Number(e.target.value) || 1000); recompute(); });
$('prioOrder').addEventListener('change', (e) => { params.higherNumberIsHigherPriority = e.target.checked; recompute(); });
$('cores').addEventListener('change', (e) => {
  const n = Math.max(1, Math.min(8, Math.round(Number(e.target.value) || 1)));
  params.cores = n;
  e.target.value = n;
  entities.forEach((en) => { if ((en.core || 0) >= n) en.core = 0; });
  if (activeCore >= n) activeCore = 0;
  refreshAll();
});

$('coreTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.core-tab');
  if (!btn) return;
  activeCore = Number(btn.dataset.core) || 0;
  renderCoreTabs();
  renderEntityTable();
  if (window._lastResults) renderRowStats(window._lastResults);
});

$('btnAddTask').addEventListener('click', () => {
  const n = entities.filter((x) => x.kind === 'task' && !x.isIdle).length + 1;
  const idleIdx = entities.findIndex((x) => x.isIdle);
  const ent = makeEntity({ name: `Tsk_${n}`, kind: 'task', priority: 30, period: 10000, exec: 1000, core: activeCore });
  if (idleIdx >= 0) entities.splice(idleIdx, 0, ent); else entities.push(ent);
  refreshAll();
});
$('btnAddIsr').addEventListener('click', () => {
  const n = entities.filter((x) => x.kind === 'isr').length + 1;
  entities.push(makeEntity({ name: `ISR_${n}`, kind: 'isr', ipl: 4, period: 5000, exec: 200, core: activeCore }));
  refreshAll();
});

$('entityBody').addEventListener('input', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const ent = entities.find((x) => x.id === tr.dataset.id);
  if (!ent) return;
  const f = e.target.dataset.f;
  if (f === 'enabled') { ent.enabled = e.target.checked; tr.classList.toggle('row-off', !ent.enabled); recompute(); return; }
  if (f === 'name') { ent.name = e.target.value; recompute(); return; }
  if (f === 'core') { ent.core = Number(e.target.value) || 0; refreshAll(); return; }
  if (f === 'deadline') { ent.deadline = e.target.value === '' ? undefined : Math.max(0, Number(e.target.value) || 0); recompute(); return; }
  const num = Math.max(0, Number(e.target.value) || 0);
  if (f === 'prio') { if (ent.kind === 'isr') ent.ipl = num; else ent.priority = num; }
  else if (f === 'offset') ent.offset = num;
  else if (f === 'period') ent.period = num;
  else if (f === 'exec') ent.exec = num;
  else if (f === 'stack') ent.stackSize = num;
  recompute();
});

$('entityBody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  entities = entities.filter((x) => x.id !== btn.dataset.del);
  refreshAll();
});

$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!parsed.entries || !Array.isArray(parsed.entries)) throw new Error('JSON must contain an "entries" array.');
      entities = buildFromRaw(parsed);
      fileName = file.name;
      $('fileName').textContent = fileName;
      setError(null);
      refreshAll();
    } catch (err) {
      setError(`Failed to load: ${err.message}`);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

$('btnReset').addEventListener('click', () => {
  entities = starterEntities();
  params.policy = 'FPP'; params.duration = 60000; params.higherNumberIsHigherPriority = true; params.cores = 1;
  activeCore = 0;
  $('policy').value = 'FPP'; $('duration').value = '60000'; $('prioOrder').checked = true; $('cores').value = '1';
  fileName = 'built-in starter set';
  $('fileName').textContent = fileName;
  setError(null);
  refreshAll();
});

window.addEventListener('resize', () => { if (window._lastResults) drawAllGantts(window._lastResults); });

// ---------- Init ----------
$('fileName').textContent = fileName;
entities = starterEntities();
refreshAll();
