// The page: what only a browser can do, around city.wasm, which does the
// rest.
//
// This file stores the sessions in localStorage and hands them back to the
// module on load, turns taps and drags into calls, shows what the module
// says in the panel, and plays the chime. What a session earns, when the
// city changes, where the camera looks, how the sky is lit and how the
// frame is drawn are all the module's (src/); gl.js only hands it WebGL.

import { webgl } from './gl.js';

const STORE = 'ode-city/v1';
const PHASE = { idle: 0, focus: 1, short: 2, long: 3 };
const EVENT = { none: 0, focusDone: 1, cycleDone: 2, breakDone: 3, roundDone: 4 };
const KIND = { building: 0, ruin: 1, park: 2 };
const SKY = { auto: 0, day: 1, night: 2 };
const TIERS = [
  { name: 'house', article: 'a' },
  { name: 'corner shop', article: 'a' },
  { name: 'apartment block', article: 'an' },
  { name: 'office block', article: 'an' },
  { name: 'skyscraper', article: 'a' },
];

const $ = (id) => document.getElementById(id);

// ?demo, or ?demo=300: a city of that many sessions to look at, made up on
// the spot and never saved, so the real one is left as it was.
const DEMO = new URLSearchParams(location.search).has('demo')
  ? Number(new URLSearchParams(location.search).get('demo')) || 400
  : 0;

let state = DEMO ? demo(DEMO) : load();
let ode;
let canvas;
let lastTick = 0;
let giveUpArmed = 0;
let wakeLock = null;
let audio = null;

boot().catch((error) => {
  console.error(error);
  $('loading').textContent = `Could not start: ${error.message}`;
});

async function boot() {
  canvas = $('scene');
  const gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
  if (!gl) {
    throw new Error('this device does not support WebGL2');
  }
  const bytes = await (await fetch('city.wasm')).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: {
      ...webgl(gl, () => ode.memory),
      sin: Math.sin,
      cos: Math.cos,
      tan: Math.tan,
      exp: Math.exp,
      pow: Math.pow,
      panic(where, message) {
        console.error('city.wasm:', text(where), text(message));
      },
    },
  });
  ode = instance.exports;

  ode.init(state.seed);
  for (const session of state.sessions) {
    ode.session_restore(session.t, session.m, session.k);
  }
  if (state.timer) {
    const t = state.timer;
    ode.timer_restore(t.mode, t.phase, t.round, t.startedAt, t.duration, t.focus, t.short, t.long, t.rounds);
  }
  applySettings();

  if (!ode.render_start()) {
    throw new Error('the shaders did not compile');
  }
  listen(canvas);

  // A page closed while hidden comes back as a new page, not as a
  // visibilitychange.
  if (state.hiddenAt) {
    ode.set_hidden_at(state.hiddenAt);
    pageReturned();
  }
  catchUp(Date.now());
  bindUi();
  render();
  requestAnimationFrame(frame);
  setTimeout(() => $('loading').classList.add('gone'), 150);
  setTimeout(() => $('loading').remove(), 900);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    watchVersion();
  }
}

// ---------------------------------------------------------------------------
// Version and updates
// ---------------------------------------------------------------------------

// Set once a newer worker has taken over: this page is the old version
// until it is reloaded.
let stale = false;

function watchVersion() {
  const worker = navigator.serviceWorker;
  worker.addEventListener('message', (event) => {
    if (event.data && event.data.version && !stale) {
      $('version').textContent = `Version ${event.data.version}`;
    }
  });
  worker.addEventListener('controllerchange', () => {
    stale = true;
    $('version').textContent = 'A new version is ready';
    $('update').textContent = 'Restart to update';
  });
  worker.ready.then(() => worker.controller && worker.controller.postMessage('version'));
}

// Asks for a newer version, and restarts into it if there is one.
async function checkForUpdate() {
  const button = $('update');
  const registration = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
  if (stale || !registration) {
    location.reload();
    return;
  }
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    await registration.update();
  } catch {
    // Offline: what is here is the latest there is to be had.
  }
  const next = registration.installing || registration.waiting;
  if (!next) {
    button.textContent = 'Up to date';
    setTimeout(() => {
      button.textContent = 'Check for updates';
      button.disabled = false;
    }, 2000);
    return;
  }
  button.textContent = 'Updating…';
  if (next.state !== 'activated') {
    await new Promise((resolve) => next.addEventListener('statechange', () => next.state === 'activated' && resolve()));
  }
  location.reload();
}

// How the page is laid out against the screen, shown in Settings: on iOS,
// an app on the home screen can be laid out shorter than the screen.
function fitScreen() {
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const portrait = innerHeight > innerWidth;
  const gap = standalone && portrait ? Math.max(0, screen.height - innerHeight) : 0;
  document.documentElement.style.setProperty('--screen-gap', `${gap}px`);
  const probe = getComputedStyle($('safe-probe'));
  $('screen-info').textContent = `${standalone ? 'app' : 'browser'} · page ${innerWidth}×${innerHeight}`
    + ` · screen ${screen.width}×${screen.height} · safe ${probe.paddingTop} ${probe.paddingBottom}`;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved && Array.isArray(saved.sessions)) {
      return { ...fresh(), ...saved, settings: { ...fresh().settings, ...saved.settings } };
    }
  } catch {
    // Storage blocked or corrupt: start over rather than not at all.
  }
  return fresh();
}

function fresh() {
  return {
    seed: (Math.random() * 0x7fffffff) | 0,
    sessions: [],
    settings: { mode: 0, minutes: 25, focus: 25, short: 5, long: 15, rounds: 4, strict: false, sound: true, sky: 'auto', compact: false },
    timer: null,
    hiddenAt: null,
  };
}

// `count` sessions over the past months, mostly buildings of every size.
function demo(count) {
  const state = fresh();
  state.seed = 20261028;
  let random = 1;
  const next = () => (random = (random * 16807) % 2147483647) / 2147483647;
  const minutes = [10, 15, 25, 25, 30, 45, 50, 60, 75, 90, 100, 120];
  const day = 86400000;
  const start = Date.now() - count * day / 4;
  for (let i = 0; i < count; i++) {
    const roll = next();
    const kind = roll < 0.04 ? KIND.ruin : roll < 0.12 ? KIND.park : KIND.building;
    state.sessions.push({ t: start + i * day / 4, m: minutes[Math.floor(next() * minutes.length)], k: kind });
  }
  return state;
}

// The module holds the truth; this writes it down.
function save() {
  if (DEMO) {
    return;
  }
  const sessions = [];
  for (let i = 0; i < ode.session_count(); i++) {
    sessions.push({ t: ode.session_time(i), m: ode.session_minutes(i), k: ode.session_kind(i) });
  }
  state.sessions = sessions;
  state.timer = {
    mode: ode.timer_mode(),
    phase: ode.timer_phase(),
    round: ode.timer_round(),
    startedAt: ode.timer_started_at(),
    duration: ode.timer_duration(),
    focus: ode.timer_focus(),
    short: ode.timer_short(),
    long: ode.timer_long(),
    rounds: ode.timer_rounds(),
  };
  state.hiddenAt = ode.hidden_at() || null;
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    // Private mode on old Safari: the city lasts as long as the page.
  }
}

function applySettings() {
  const s = state.settings;
  ode.set_plan(s.mode, s.minutes, s.focus, s.short, s.long, s.rounds);
  ode.set_strict(s.strict ? 1 : 0);
  ode.set_sky(SKY[s.sky] ?? SKY.auto);
}

function text(pointer) {
  if (!pointer) {
    return '';
  }
  const bytes = new Uint8Array(ode.memory.buffer, pointer);
  return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
}

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

function phase() {
  return ode.timer_phase();
}

function start() {
  unlockAudio();
  ode.timer_start(Date.now());
  keepAwake(true);
  save();
  render();
}

// Takes every event the module has to give, saying what each one earned.
function catchUp(now) {
  let event;
  while ((event = ode.timer_tick(now)) !== EVENT.none) {
    const minutes = ode.last_minutes();
    const tier = TIERS[ode.tier_of(minutes)];
    if (event === EVENT.focusDone) {
      toast(`Your ${tier.name} is finished. <strong>+${ode.residents_of(minutes)}</strong> residents moved in.`, 5200);
      chime([523.25, 659.25, 783.99]);
    } else if (event === EVENT.cycleDone) {
      toast(`Pomodoro cycle complete! Your ${tier.name} is up, and <strong>a park</strong> opened next door.`, 5200);
      chime([523.25, 659.25, 783.99, 1046.5]);
    } else if (event === EVENT.roundDone) {
      const built = TIERS[ode.tier_of(ode.build_minutes())];
      const up = Math.round(ode.build_progress(now) * 100);
      toast(`Round ${ode.timer_round()} of ${ode.timer_rounds()} done. Your ${built.name} is <strong>${up}% up</strong>. Take a break.`, 5200);
      chime([523.25, 659.25]);
    } else if (event === EVENT.breakDone) {
      toast('Break is over. Ready for the next round?');
      chime([659.25, 523.25]);
    }
    if (phase() === PHASE.idle) {
      keepAwake(false);
    }
    save();
    render();
  }
}

function abandoned(message) {
  toast(message ?? 'The construction was abandoned. <strong>A ruin</strong> marks the spot.');
  keepAwake(false);
  save();
  render();
}

document.addEventListener('visibilitychange', () => {
  if (!ode) {
    return;
  }
  if (document.hidden) {
    ode.page_hidden(Date.now());
    save();
    return;
  }
  pageReturned();
  catchUp(Date.now());
  if (phase() !== PHASE.idle) {
    keepAwake(true);
  }
  render();
});

function pageReturned() {
  if (ode.page_returned(Date.now())) {
    abandoned('You left the app during focus, so <strong>the construction collapsed</strong>.');
  }
  save();
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

let previous = performance.now();

function frame(time) {
  const dt = Math.min((time - previous) / 1000, 0.1);
  previous = time;
  const now = Date.now();
  if (now - lastTick > 250) {
    lastTick = now;
    catchUp(now);
    renderClock(now);
  }

  const [width, height] = resize();
  const local = new Date(now);
  const hours = local.getHours() + local.getMinutes() / 60 + local.getSeconds() / 3600;
  ode.frame(now, dt, width, height, hours, time / 1000);
  requestAnimationFrame(frame);
}

// The canvas's size in pixels, matched to how big it is drawn.
function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.floor(canvas.clientWidth * ratio);
  const height = Math.floor(canvas.clientHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return [width, height];
}

// Drag to turn, pinch or scroll to zoom: the module moves the camera.
function listen(target) {
  const pointers = new Map();
  let pinch = 0;
  // A press that barely moves and lets go soon is a tap, which picks.
  let press = null;
  target.addEventListener('pointerdown', (event) => {
    target.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    press = pointers.size === 1 ? { x: event.clientX, y: event.clientY, at: Date.now() } : null;
  });
  target.addEventListener('pointermove', (event) => {
    const before = pointers.get(event.pointerId);
    if (!before) {
      return;
    }
    const now = [event.clientX, event.clientY];
    pointers.set(event.pointerId, now);
    if (pointers.size === 1) {
      ode.camera_drag(now[0] - before[0], now[1] - before[1], Date.now());
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const spread = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch > 0) {
        ode.camera_zoom(pinch / spread, Date.now());
      }
      pinch = spread;
    }
  });
  const release = (event) => {
    pointers.delete(event.pointerId);
    pinch = 0;
    if (press && event.type === 'pointerup'
        && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 8 && Date.now() - press.at < 500) {
      const box = target.getBoundingClientRect();
      inspect(ode.pick(
        ((event.clientX - box.left) / box.width) * 2 - 1,
        1 - ((event.clientY - box.top) / box.height) * 2,
      ));
    }
    press = null;
  };
  target.addEventListener('pointerup', release);
  target.addEventListener('pointercancel', release);
  target.addEventListener('wheel', (event) => {
    event.preventDefault();
    ode.camera_zoom(Math.exp(event.deltaY * 0.0012), Date.now());
  }, { passive: false });
}

// What stands on lot `index` -- the session's that built it -- in a card;
// -1 puts the card away.
function inspect(index) {
  const card = $('inspect');
  if (index < 0) {
    card.classList.remove('show');
    return;
  }
  const kind = ode.session_kind(index);
  const minutes = ode.session_minutes(index);
  const when = new Date(ode.session_time(index)).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const storeys = Math.max(1, Math.round(ode.lot_storeys(index)));
  let title;
  let rows;
  if (kind === KIND.park) {
    title = 'Park';
    rows = [['Opened', when], ['For', 'a full pomodoro cycle']];
  } else if (kind === KIND.ruin) {
    title = 'Ruin';
    rows = [['Planned', `${duration(minutes)} of focus`], ['Abandoned', when]];
  } else {
    const tier = TIERS[ode.tier_of(minutes)].name;
    title = tier[0].toUpperCase() + tier.slice(1);
    rows = [
      ['Focus', duration(minutes)],
      ['Residents', ode.residents_of(minutes).toLocaleString()],
      ['Height', `${storeys} ${storeys === 1 ? 'storey' : 'storeys'}`],
      ['Built', when],
    ];
  }
  $('inspect-title').textContent = title;
  $('inspect-number').textContent = `No. ${index + 1} of ${ode.session_count()}`;
  const list = $('inspect-rows');
  list.replaceChildren();
  for (const [name, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = name;
    const detail = document.createElement('dd');
    detail.textContent = value;
    list.append(term, detail);
  }
  card.classList.add('show');
}

function duration(minutes) {
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes} min`;
  }
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

function changeSettings(change) {
  change(state.settings);
  applySettings();
  save();
  render();
}

function bindUi() {
  $('inspect-close').addEventListener('click', () => inspect(ode.select(-1)));
  $('update').addEventListener('click', checkForUpdate);
  fitScreen();
  addEventListener('resize', fitScreen);
  $('collapse').addEventListener('click', () => setCompact(true));
  $('mini').addEventListener('click', () => setCompact(false));
  setCompact(state.settings.compact);

  $('tab-timer').addEventListener('click', () => setMode(0));
  $('tab-pomodoro').addEventListener('click', () => setMode(1));

  const slider = $('minutes');
  slider.value = state.settings.minutes;
  slider.addEventListener('input', () => changeSettings((s) => {
    s.minutes = Number(slider.value);
  }));

  for (const stepper of document.querySelectorAll('.stepper')) {
    const key = stepper.dataset.key;
    const [less, more] = stepper.querySelectorAll('button');
    const step = Number(stepper.dataset.step);
    const change = (by) => changeSettings((s) => {
      s[key] = Math.min(Number(stepper.dataset.max), Math.max(Number(stepper.dataset.min), s[key] + by * step));
    });
    less.addEventListener('click', () => change(-1));
    more.addEventListener('click', () => change(1));
  }

  $('primary').addEventListener('click', () => {
    const p = phase();
    if (p === PHASE.idle) {
      start();
    } else if (p === PHASE.focus) {
      // Giving up takes a second tap, so a stray one costs nothing.
      if (Date.now() - giveUpArmed < 3000) {
        giveUpArmed = 0;
        if (ode.timer_give_up(Date.now())) {
          abandoned();
        }
      } else {
        giveUpArmed = Date.now();
        render();
        setTimeout(render, 3100);
      }
    } else {
      ode.timer_give_up(Date.now());
      keepAwake(false);
      save();
      render();
    }
  });

  // Abandoning a half-built cycle costs its building, so it asks first.
  $('secondary').addEventListener('click', () => {
    const tier = TIERS[ode.tier_of(ode.build_minutes())];
    if (!confirm(`Abandon this cycle? Your half-built ${tier.name} will collapse into a ruin.`)) {
      return;
    }
    if (ode.timer_reset_cycle(Date.now())) {
      abandoned();
    } else {
      save();
      render();
    }
  });

  const settings = $('settings');
  $('open-settings').addEventListener('click', () => {
    $('strict').checked = state.settings.strict;
    $('sound').checked = state.settings.sound;
    renderSky();
    renderHistory();
    settings.showModal();
  });
  $('strict').addEventListener('change', (event) => changeSettings((s) => {
    s.strict = event.target.checked;
  }));
  $('sound').addEventListener('change', (event) => changeSettings((s) => {
    s.sound = event.target.checked;
  }));
  for (const button of $('sky').querySelectorAll('button')) {
    button.addEventListener('click', () => {
      changeSettings((s) => {
        s.sky = button.dataset.sky;
      });
      renderSky();
    });
  }
  $('new-city').addEventListener('click', () => {
    if (!confirm('Start a new city? Your current city and its history will be cleared.')) {
      return;
    }
    const kept = state.settings;
    state = fresh();
    state.settings = kept;
    ode.init(state.seed);
    applySettings();
    keepAwake(false);
    save();
    render();
    settings.close();
  });
  settings.addEventListener('click', (event) => {
    if (event.target === settings) {
      settings.close();
    }
  });
}

// Minimized, the panel gives way to a pill with the clock, so the city
// can be seen whole.
function setCompact(on) {
  state.settings.compact = on;
  document.body.classList.toggle('compact', on);
  const mini = $('mini');
  mini.setAttribute('aria-hidden', String(!on));
  mini.tabIndex = on ? 0 : -1;
  $('panel').inert = on;
  if (DEMO) {
    return;
  }
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    // The choice lasts as long as the page.
  }
}

function setMode(mode) {
  if (phase() !== PHASE.idle || ode.cycle_underway() === 1 || state.settings.mode === mode) {
    return;
  }
  changeSettings((s) => {
    s.mode = mode;
  });
}

function render() {
  const p = phase();
  const s = state.settings;
  const pomodoro = s.mode === 1;
  const running = p !== PHASE.idle;
  document.body.classList.toggle('focus', p === PHASE.focus);
  document.body.classList.toggle('break', p === PHASE.short || p === PHASE.long);

  $('tab-timer').setAttribute('aria-selected', String(!pomodoro));
  $('tab-pomodoro').setAttribute('aria-selected', String(pomodoro));
  const locked = running || ode.cycle_underway() === 1;
  $('tab-timer').disabled = locked && pomodoro;
  $('tab-pomodoro').disabled = locked && !pomodoro;
  $('timer-controls').hidden = pomodoro;
  // A cycle keeps the plan it started with, so its controls go away until
  // it ends.
  const underway = ode.cycle_underway() === 1;
  $('pomodoro-controls').hidden = !pomodoro || underway;

  $('minutes').style.setProperty('--fill', `${((s.minutes - 10) / 110) * 100}%`);
  const chosen = ode.tier_of(s.minutes);
  $('tiers').querySelectorAll('span').forEach((label, i) => label.classList.toggle('on', i === chosen));
  for (const stepper of document.querySelectorAll('.stepper')) {
    stepper.querySelector('.value').textContent = s[stepper.dataset.key];
  }

  const tier = TIERS[ode.tier_of(ode.build_minutes())];
  const round = ode.timer_round();
  const cycleRounds = running || underway ? ode.timer_rounds() : s.rounds;
  const focus = ode.focus_minutes();
  const up = Math.round(ode.build_progress(Date.now()) * 100);
  const full = ode.city_full() === 1;
  const caption = $('caption');
  if (p === PHASE.focus && pomodoro) {
    caption.innerHTML = `Round ${round + 1} of ${cycleRounds}: building ${tier.article} <strong>${tier.name}</strong>.`;
  } else if (p === PHASE.focus) {
    caption.innerHTML = `Building ${tier.article} <strong>${tier.name}</strong>. Stay focused.`;
  } else if (p === PHASE.short) {
    caption.innerHTML = `Short break. Your ${tier.name} is <strong>${up}% up</strong>.`;
  } else if (p === PHASE.long) {
    caption.innerHTML = '<strong>Long break.</strong> You earned it.';
  } else if (full) {
    caption.innerHTML = 'Your city has filled the valley. Start a new one in settings.';
  } else if (underway) {
    caption.innerHTML = `Your ${tier.name} is <strong>${up}% up</strong>. ${cycleRounds - round} ${cycleRounds - round === 1 ? 'round' : 'rounds'} to go.`;
  } else if (pomodoro) {
    caption.innerHTML = `${cycleRounds} × ${focus} minutes builds ${tier.article} <strong>${tier.name}</strong>`;
  } else {
    caption.innerHTML = `${focus} minutes builds ${tier.article} <strong>${tier.name}</strong>`;
  }
  const name = tier.name[0].toUpperCase() + tier.name.slice(1);
  $('mini-label').textContent = p === PHASE.focus ? `Building ${tier.article} ${tier.name}`
    : p === PHASE.short ? `Short break · ${up}% up`
      : p === PHASE.long ? 'Long break'
        : underway ? `${name} · ${up}% up` : `${name} · tap to start`;

  const rounds = $('rounds');
  rounds.hidden = !pomodoro;
  if (pomodoro) {
    rounds.innerHTML = '';
    for (let i = 0; i < cycleRounds; i++) {
      const dot = document.createElement('span');
      if (i < round) {
        dot.className = 'done';
      } else if (i === round && p === PHASE.focus) {
        dot.className = 'now';
      }
      rounds.append(dot);
    }
  }

  const primary = $('primary');
  primary.classList.remove('quiet', 'warn');
  primary.disabled = full && !running;
  if (p === PHASE.idle) {
    primary.textContent = underway ? `Start round ${round + 1} of ${cycleRounds}` : 'Start building';
  } else if (p === PHASE.focus) {
    const armed = Date.now() - giveUpArmed < 3000;
    primary.textContent = armed ? 'Tap again to give up' : 'Give up';
    primary.classList.add(armed ? 'warn' : 'quiet');
  } else {
    primary.textContent = 'Skip break';
    primary.classList.add('quiet');
  }
  $('secondary').hidden = !(underway && p === PHASE.idle);

  renderStats();
  renderClock(Date.now());
}

function renderClock(now) {
  const p = phase();
  const seconds = Math.ceil(ode.clock_remaining(now) / 1000);
  const shown = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const clock = $('clock');
  if (clock.textContent !== shown) {
    clock.textContent = shown;
    document.title = p === PHASE.idle ? 'Ode City' : `${shown} · Ode City`;
  }
  const progress = p === PHASE.idle ? 0 : ode.timer_progress(now);
  $('bar').style.width = `${progress * 100}%`;
  $('mini-clock').textContent = shown;
  $('mini-ring').style.strokeDashoffset = String(97.4 * (1 - progress));
}

function renderStats() {
  const now = Date.now();
  const offset = new Date().getTimezoneOffset();
  $('stat-buildings').textContent = ode.building_count();
  $('stat-population').textContent = ode.city_population().toLocaleString();
  const minutes = ode.minutes_today(now, offset);
  const rest = minutes % 60 ? String(minutes % 60).padStart(2, '0') : '';
  $('stat-today').textContent = minutes >= 60 ? `${Math.floor(minutes / 60)}h${rest}` : `${minutes}m`;
  $('stat-streak').textContent = ode.streak_days(now, offset);
}

function renderSky() {
  for (const button of $('sky').querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.sky === state.settings.sky);
  }
}

function renderHistory() {
  const list = $('history');
  list.innerHTML = '';
  const count = ode.session_count();
  if (count === 0) {
    list.innerHTML = '<li class="empty">No sessions yet. Your first building is waiting.</li>';
    return;
  }
  for (let i = count - 1; i >= Math.max(0, count - 30); i--) {
    const kind = ode.session_kind(i);
    const minutes = ode.session_minutes(i);
    const item = document.createElement('li');
    const name = TIERS[ode.tier_of(minutes)].name;
    const what = kind === KIND.ruin ? 'Ruin' : kind === KIND.park ? 'Park' : name[0].toUpperCase() + name.slice(1);
    if (kind === KIND.ruin) {
      item.className = 'ruin';
    }
    const when = new Date(ode.session_time(i)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    item.innerHTML = `<span class="what">${what}${kind === KIND.park ? '' : ` · ${minutes}m`}</span><span>${when}</span>`;
    list.append(item);
  }
}

let toastTimer = 0;

function toast(html, duration = 4000) {
  const element = $('toast');
  element.innerHTML = html;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), duration);
}

// ---------------------------------------------------------------------------
// Sound and the screen
// ---------------------------------------------------------------------------

// iOS lets a page play sound only once a tap has started it.
function unlockAudio() {
  if (!audio && (window.AudioContext || window.webkitAudioContext)) {
    audio = new (window.AudioContext || window.webkitAudioContext)();
  }
  audio?.resume?.();
}

function chime(notes) {
  if (!state.settings.sound || !audio) {
    return;
  }
  const start = audio.currentTime + 0.02;
  notes.forEach((frequency, i) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    const at = start + i * 0.16;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 1.1);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + 1.2);
  });
}

// Keeps the screen on while a session runs, where the browser allows it.
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
