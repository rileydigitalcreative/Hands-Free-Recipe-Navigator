// Hands-free cookbook
// Hand tracking = MediaPipe


// CONFIG: working variables

const CONFIG = {

  // Poses (fist, thumbs up) 
  MIN_GESTURE_SCORE: 0.6, // how sure the model is
  DWELL_MS: 500, // hold time
  GESTURE_DROPOUT_MS: 150, // ignore quick glitches
  STILL_MAX_SPEED: 0.8, // above this = moving
  COOLDOWN_MS: 800, // wait after an action

  // point left or right to change steps

  NAV_HOLD_MS: 600, // hold time
  POINT_MAX_TILT: 0.7, // up/down slack (~35°)
  POINT_MIN_LENGTH: 0.5, // finger must stick out
  THUMB_MIN_LENGTH: 0.35, // thumb must stick out
  THUMB_MIN_REACH: 0.6, // thumb tip away from fist
  NAV_GRACE_MS: 300, // slip time allowed
  NAV_DRAG_PX: 40, // card lean amount
  HISTORY_MS: 400, // how much to remember

  //  Distance from camera 
  SCALE_SMOOTHING: 0.3, // smooths hand size
  SCALE_FACTOR_MIN: 0.4, // distance limits
  SCALE_FACTOR_MAX: 2.0, // distance limits

  //  Pinch scroll 
  PINCH_START: 0.25, // pinch starts
  PINCH_RELEASE: 0.4, // pinch ends
  PINCH_MIN_INDEX_EXTENSION: 0.9, // finger must be straight
  SCROLL_DEADZONE: 0.04, // no-scroll zone
  SCROLL_SPEED: 2200, // scroll speed
  ROW_JUMP_PX: 140, // dashboard: pinch distance per row

  //  Calibration 
  CALIB_SIZE_HOLD_MS: 2000, // palm hold time
  CALIB_EDGE_HOLD_MS: 1000, // reach hold time
  CALIB_STILL_MAX_SPEED: 0.6, // how still to stay
  CALIB_PALM_MIN_SCORE: 0.35, // palm check (easy)
  CALIB_GRACE_MS: 400, // wobble time allowed
  CALIB_MIN_REACH: 0.1, // how far to reach
  CALIB_MIN_RANGE: 0.15, // smallest allowed reach
  DEFAULT_CALIBRATION: { handScale: 0.15, left: 0.1, right: 0.9, top: 0.1, bottom: 0.9 },
  STORAGE_KEY: "handsfree-cookbook-calibration-v1",
  RECIPES_KEY: "handsfree-cookbook-recipes-v1", // loaded Budget Bytes recipes

  //  Model 

  USE_HAND_LANDMARKER: false,
  MEDIAPIPE_URL: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35",
  GESTURE_MODEL:
    "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
  HAND_MODEL:
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
};

// ================
// Recipe  - add more later

const RECIPES = [
  {
    title: "Scrambled Eggs",
    servings: 1,
    steps: [
      { text: "Crack 2 eggs into a bowl. Add a pinch of salt.", ingredients: ["2 eggs", "salt"] },
      { text: "Whisk the eggs until the yolks and whites are fully mixed.", ingredients: ["eggs"] },
      { text: "Melt 1 tbsp butter in a pan over medium-low heat.", ingredients: ["1 tbsp butter"] },
      { text: "Pour in the eggs. Stir gently with a spatula as they set.", ingredients: ["eggs"] },
      { text: "Remove from heat while still slightly glossy. Serve right away.", ingredients: [] },
    ],
  },
];

// Budget Bytes recipes loaded before, kept after a refresh
const saved = loadSavedRecipes();
RECIPES.push(...saved.recipes);

function loadSavedRecipes() {
  try {
    const data = JSON.parse(localStorage.getItem(CONFIG.RECIPES_KEY));
    const ok = (r) => r && typeof r.title === "string" && Array.isArray(r.steps) && r.steps.length &&
      r.steps.every((st) => typeof st.text === "string" && Array.isArray(st.ingredients));
    const recipes = Array.isArray(data?.recipes) ? data.recipes.filter(ok) : [];
    const index = Number.isInteger(data?.index) && data.index <= recipes.length ? data.index : 0;
    return { recipes, index };
  } catch (_) {
    return { recipes: [], index: 0 };
  }
}

function saveRecipes() {
  try {
    localStorage.setItem(CONFIG.RECIPES_KEY, JSON.stringify({ recipes: RECIPES.slice(1), index: state.recipeIndex }));
  } catch (_) {}
}

// ================
// App state

const state = {
  recipeIndex: saved.index,
  stepIndex: 0,
  view: "cook", // "dashboard" or "cook"; init() picks
  pick: { row: 0, col: 0 }, // highlighted recipe on the dashboard
  rowAcc: 0, // pinch distance saved up toward the next row jump
  completed: RECIPES.map((r) => r.steps.map(() => false)), // one done/not-done flag per step

  reading: false,
  utterance: null,
  voiceUnlocked: false, //  won't talk until the user clicks or presses a key

  debug: false,
  calibration: loadCalibration(),

  // Tracking
  handVisible: false,
  lastHandAt: 0,
  smoothedScale: null,
  scaleFactor: 1,
  history: [], // recent palm positions [{t, x, y}], newest at the end
  cooldownUntil: 0,

  // Pointing: -1 = left, 1 = right, 0 = not pointing.
  nav: { zone: 0, held: 0, lastT: 0, okAt: 0, fired: false, progress: 0, dir: 0 },
  drag: 0,
  pinch: { active: false, anchorY: 0, y: 0, ratio: 0, remainder: 0, lastT: 0 },
  pose: { name: "None", score: 0, since: 0, lastSeen: 0, fired: false, progress: 0 },
  live: {}, // latest numbers, just for the debug panel
  fps: 0,
  lastFrameT: 0,
};

const $ = (id) => document.getElementById(id);
const el = {
  title: $("recipe-title"),
  source: $("recipe-source"),
  searchForm: $("search-form"),
  searchInput: $("search-input"),
  searchResults: $("search-results"),
  resultsSection: $("results-section"),
  resultsTitle: $("results-title"),
  resultsClear: $("results-clear"),
  dashboard: $("dashboard"),
  myRecipes: $("my-recipes"),
  homeRows: $("home-rows"),
  tabHome: $("tab-home"),
  tabSaved: $("tab-saved"),
  panelHome: $("panel-home"),
  panelSaved: $("panel-saved"),
  savedCount: $("saved-count"),
  back: $("back"),
  stepCount: $("step-count"),
  progressFill: $("progress-fill"),
  stepsList: $("steps-list"),
  currentStepLabel: $("current-step-label"),


  //AI FRONT END!!=============!!
  // These only exist in redesign.html. render() skips them if they're missing.
  recipeMeta: $("recipe-meta"),
  segments: $("segments"),
  stepNum: $("step-num"),
  upNext: $("up-next"),
  card: $("card"),
  stepText: $("step-text"),
  chips: $("chips"),
  ingredientList: $("ingredient-list"),
  speaker: $("speaker"),
  calibBadge: $("calib-badge"),
  video: $("video"),
  canvas: $("overlay"),
  camStatus: $("cam-status"),
  hudLive: $("hud-live"),
  hudLast: $("hud-last"),
  debug: $("debug"),
  banner: $("banner"),
  calib: $("calib"),
  calibDots: $("calib-dots"),
  calibIcon: $("calib-icon"),
  calibTitle: $("calib-title"),
  calibText: $("calib-text"),
  calibFill: $("calib-fill"),
  calibStatus: $("calib-status"),
  calibSkip: $("calib-skip"),
  recalibrate: $("recalibrate"),
  camToggle: $("cam-toggle"),
  navRing: $("nav-ring"),
  navArc: $("nav-arc"),
  navArrow: $("nav-arrow"),
  navLabel: $("nav-label"),
};


const ctx = el.canvas.getContext("2d");
const NAV_RING_LENGTH = 2 * Math.PI * 52; // length of the SVG ring (r = 52), used for the fill animation

let vision = null; // MediaPipe gets imported later so the page still works offline
let recognizer = null;
let handLandmarker = null;
let aspect = 4 / 3; // video width / height, keeps distances in real proportions
let camPaused = false; // pause button state

// ================
//  helper var

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt = (v, d = 2) => (typeof v === "number" && isFinite(v) ? v.toFixed(d) : "—");
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Scraped text goes into innerHTML, so escape it
const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

// Distance between two points
function dist(a, b) {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

function currentRecipe() {
  return RECIPES[state.recipeIndex];
}

// reach from calibration
function usableRange() {
  const c = state.calibration;
  return { w: c.right - c.left, h: c.bottom - c.top };
}

// ================
// Hand measurements

// Hand size = wrist (0) to middle knuckle (9). Bigger hand means you're closer.
function getHandScale(pts) {
  return dist(pts[0], pts[9]);
}

// Palm center 
function palmCenter(pts) {
  const ids = [0, 5, 9, 13, 17];
  let x = 0, y = 0;
  for (const i of ids) { x += pts[i].x; y += pts[i].y; }
  return { x: x / ids.length, y: y / ids.length };
}

// How fast the palm moved over last 120ms
function palmSpeed() {
  const h = state.history;
  if (h.length < 2) return { raw: 0, usable: 0 };
  const last = h[h.length - 1];
  let ref = h[0];
  for (let k = h.length - 1; k >= 0; k--) {
    if (last.t - h[k].t >= 120) { ref = h[k]; break; }
  }
  const dt = (last.t - ref.t) / 1000;
  if (dt <= 0) return { raw: 0, usable: 0 };
  const dx = last.x - ref.x, dy = last.y - ref.y;
  const r = usableRange();
  return { raw: Math.hypot(dx, dy) / dt, usable: Math.hypot(dx / r.w, dy / r.h) / dt };
}

// ================
// Gesture detectors

// Is a line from base to tip aimed sideways? -1 left, 1 right, 0 no
function sideways(base, tip, minLength, handScale) {
  const dx = (tip.x - base.x) * aspect, dy = tip.y - base.y;
  if (Math.hypot(dx, dy) < minLength * handScale) return 0; // aimed at the camera
  if (Math.abs(dy) > CONFIG.POINT_MAX_TILT * Math.abs(dx)) return 0; // too far up or down
  return Math.sign(dx);
}

// Which way the hand points: index finger first, then sideways thumb.
// Returns { dir: -1 left / 1 right / 0 none, finger: "index" | "thumb" }
function pointDirection(pts, handScale, poseName) {
  const straight = (tip, pip) => dist(pts[0], pts[tip]) > 1.15 * dist(pts[0], pts[pip]);
  // middle, ring, pinky folded (allow one to be a bit loose)
  const folded = [[12, 10], [16, 14], [20, 18]].filter(([tip, pip]) => !straight(tip, pip)).length;
  if (folded < 2) return { dir: 0 };

  // Index point
  if (straight(8, 6)) return { dir: sideways(pts[5], pts[8], CONFIG.POINT_MIN_LENGTH, handScale), finger: "index" };

  // Thumb point: rest of the hand is a fist, thumb sticks out away from it
  if (poseName === "Closed_Fist") return { dir: 0 }; // fist = read aloud, not a thumb
  const thumbOut = dist(pts[4], pts[5]) > CONFIG.THUMB_MIN_REACH * handScale;
  if (!thumbOut) return { dir: 0 };
  return { dir: sideways(pts[2], pts[4], CONFIG.THUMB_MIN_LENGTH, handScale), finger: "thumb" };
}

// Point and hold - Returns -1 or 1 on the frame it fires
function detectPointHold(pts, now, handScale, poseName) {
  const n = state.nav;
  const { dir, finger } = pointDirection(pts, handScale, poseName);
  n.dir = dir;
  if (dir) n.finger = finger;

  // Time spent pointing - Quick slips pause, longer reset it.
  const dt = n.lastT ? Math.min(100, now - n.lastT) : 0;
  n.lastT = now;
  if (dir) {
    if (dir !== n.zone) Object.assign(n, { zone: dir, held: 0, fired: false });
    n.okAt = now;
    n.held += dt;
  } else if (n.zone && now - n.okAt > CONFIG.NAV_GRACE_MS) {
    resetNav();
  }

  n.progress = n.zone && !n.fired ? clamp(n.held / CONFIG.NAV_HOLD_MS, 0, 1) : 0;
  if (n.zone && !n.fired && n.progress >= 1 && now >= state.cooldownUntil) {
    n.fired = true; // have to stop pointing to fire again
    return n.zone;
  }
  return 0;
}

function resetNav() {
  Object.assign(state.nav, { zone: 0, held: 0, fired: false, progress: 0 });
}

// Pinch scroll: 
function detectPinchScroll(pts, now, handScale, scale, poseName) {
  const p = state.pinch;
  p.ratio = dist(pts[4], pts[8]) / handScale;
  const y = (pts[4].y + pts[8].y) / 2;
  // A fist can put the thumb right next to the index tip, so don't count that as a pinch
  const indexExtended = dist(pts[0], pts[8]) > CONFIG.PINCH_MIN_INDEX_EXTENSION * dist(pts[0], pts[5]);
  const canStart = indexExtended && poseName !== "Closed_Fist" && poseName !== "Thumb_Up";

  if (!p.active && canStart && p.ratio < CONFIG.PINCH_START) {
    p.active = true;
    p.anchorY = y;
    p.remainder = 0;
    state.rowAcc = 0;
    p.lastT = now;
    el.ingredientList.classList.add("scrolling");
  } else if (p.active && p.ratio > CONFIG.PINCH_RELEASE) {
    endPinch();
  }
  if (!p.active) return p;

  p.y = y;
  const dt = Math.min(0.1, (now - p.lastT) / 1000);
  p.lastT = now;
  const offset = (y - p.anchorY) / usableRange().h / scale;
  const beyond = Math.max(0, Math.abs(offset) - CONFIG.SCROLL_DEADZONE) * Math.sign(offset);
  p.offset = offset;
  if (beyond !== 0) {
    p.remainder += beyond * CONFIG.SCROLL_SPEED * dt;
    const px = Math.trunc(p.remainder);
    p.remainder -= px;
    if (px) actions.scroll(px);
  }
  return p;
}

function endPinch() {
  state.pinch.active = false;
  state.pinch.offset = 0;
  el.ingredientList.classList.remove("scrolling");
}

// Fist and thumbs from MediaPipe's recognizer.

function detectStaticPose(name, score, now, speedUsable, scale) {
  const s = state.pose;
  if (name !== s.name) {
    // the recognizer flickers sometimes, don't let that break a hold
    if (now - s.lastSeen < CONFIG.GESTURE_DROPOUT_MS && s.name !== "None") return;
    Object.assign(s, { name, score, since: now, lastSeen: now, fired: false, progress: 0 });
  } else {
    s.lastSeen = now;
    s.score = score;
  }
  if (speedUsable > CONFIG.STILL_MAX_SPEED * scale) s.since = now;

  const pose = POSES[state.view][name];
  s.progress = pose && !s.fired ? clamp((now - s.since) / CONFIG.DWELL_MS, 0, 1) : 0;

  if (pose && !s.fired && s.progress >= 1 && now >= state.cooldownUntil) {
    s.fired = true; // have to change pose before this can fire again
    trigger(now, `${pose.label} ${fmt(score)}`, actions[pose.action]);
  }
}

// Which held pose does what, per screen
const POSES = {
  cook: {
    Closed_Fist: { label: "✊ Fist", action: "toggleRead" },
    Thumb_Up: { label: "👍 Thumbs up", action: "toggleComplete" },
    Victory: { label: "✌️ Peace", action: "backToRecipes" },
  },
  dashboard: {
    Thumb_Up: { label: "👍 Thumbs up", action: "openPicked" },
    Closed_Fist: { label: "✊ Fist", action: "switchTab" },
  },
};

function trigger(now, label, fn, cooldown = CONFIG.COOLDOWN_MS) {
  state.cooldownUntil = now + cooldown;
  const outcome = fn();
  showLastAction(`${label} → ${outcome}`);
}

// ================
// Extras + Actions: shared by the gestures and the keyboard

const actions = {
  nextStep() {
    const n = currentRecipe().steps.length;
    if (state.stepIndex >= n - 1) { bumpCard(); return "already on last step"; }
    setStep(state.stepIndex + 1, "right");
    return "next step";
  },
  prevStep() {
    if (state.stepIndex <= 0) { bumpCard(); return "already on first step"; }
    setStep(state.stepIndex - 1, "left");
    return "previous step";
  },
  toggleRead() {
    if (state.reading) { stopReading(); return "stop reading"; }
    return startReading();
  },
  toggleComplete() {
    const done = state.completed[state.recipeIndex];
    done[state.stepIndex] = !done[state.stepIndex];
    render();
    return done[state.stepIndex] ? "step complete" : "step not complete";
  },

  // Scroll the ingredients if it can scroll, otherwise just scroll the page
  // Dashboard
  pickNext() { return movePick(1); },
  pickPrev() { return movePick(-1); },
  openPicked() {
    const tile = pickedTile();
    if (!tile) return "no recipe highlighted";
    tile.click();
    return `open “${tile.querySelector(".tile-title").textContent}”`;
  },
  switchTab() {
    showTab(state.tab === "saved" ? "home" : "saved");
    return state.tab === "saved" ? "Saved tab" : "Home tab";
  },
  backToRecipes() {
    if (!el.dashboard) return "no recipe list on this page";
    showView("dashboard");
    return "all recipes";
  },

  scroll(px) {
    if (state.view === "dashboard") return pinchRows(px);
    const list = el.ingredientList;
    if (list.scrollHeight > list.clientHeight) list.scrollTop += px;
    else window.scrollBy(0, px);
  },
};

function setStep(i, direction) {
  stopReading(); // always stop when the step changes
  state.stepIndex = i;
  render(direction);
}

//  Comp read it 
function startReading() {
  if (!("speechSynthesis" in window)) return "speech not supported";
  if (!state.voiceUnlocked) {
    showBanner("Click anywhere or press a key once to allow read-aloud (browser rule), then try again.");
    return "voice blocked: click page once";
  }
  const step = currentRecipe().steps[state.stepIndex];
  const u = new SpeechSynthesisUtterance(`Step ${state.stepIndex + 1}. ${step.text}`);
  u.rate = 0.95;
  u.onend = u.onerror = () => {
    if (state.utterance !== u) return;
    state.reading = false;
    state.utterance = null;
    renderStatus();
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  state.reading = true;
  state.utterance = u;
  renderStatus();
  return "start reading";
}

function stopReading() {
  state.utterance = null;
  state.reading = false;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  renderStatus();
}

function unlockVoice() {
  if (state.voiceUnlocked || !("speechSynthesis" in window)) return;
  state.voiceUnlocked = true;
  speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  if (el.banner.dataset.kind === "voice") hideBanner();
}

// ================
// Calibration stuff

const CALIB_STEPS = [
  { key: "size", icon: "✋", title: "Stand where you will cook", text: "Hold an open palm toward the camera for 2 seconds." },
  { key: "left", icon: "⬅️", title: "Reach left", text: "Move your hand as far LEFT as is comfortable (keep it in view) and hold." },
  { key: "right", icon: "➡️", title: "Reach right", text: "Now as far RIGHT as is comfortable, and hold." },
  { key: "top", icon: "⬆️", title: "Reach up", text: "Now as far UP as is comfortable, and hold." },
  { key: "bottom", icon: "⬇️", title: "Reach down", text: "Now as far DOWN as is comfortable, and hold." },
];
const calib = { active: false, i: 0, held: 0, lastT: 0, okAt: 0, samples: [], result: {}, home: null };

function loadCalibration() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY));
    if (saved && typeof saved.handScale === "number") return saved;
  } catch (_) {}
  return { ...CONFIG.DEFAULT_CALIBRATION, calibrated: false, skipped: false };
}

function saveCalibration() {
  try { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state.calibration)); } catch (_) {}
}

function hasStoredCalibration() {
  try { return !!localStorage.getItem(CONFIG.STORAGE_KEY); } catch (_) { return false; }
}

function startCalibration() {
  Object.assign(calib, { active: true, i: 0, held: 0, lastT: 0, okAt: 0, samples: [], result: {}, home: null });
  stopReading();
  endPinch();
  el.calib.hidden = false;
  renderCalibration(0, "Show your hand to the camera");
}

function skipCalibration() {
  calib.active = false;
  el.calib.hidden = true;
  state.calibration = { ...CONFIG.DEFAULT_CALIBRATION, calibrated: false, skipped: true };
  saveCalibration();
  renderStatus();
  showLastAction("Calibration skipped → defaults");
}

function finishCalibration() {
  const r = calib.result, d = CONFIG.DEFAULT_CALIBRATION;
  const xOk = r.right - r.left >= CONFIG.CALIB_MIN_RANGE;
  const yOk = r.bottom - r.top >= CONFIG.CALIB_MIN_RANGE;
  state.calibration = {
    handScale: r.size || d.handScale,
    left: xOk ? r.left : d.left,
    right: xOk ? r.right : d.right,
    top: yOk ? r.top : d.top,
    bottom: yOk ? r.bottom : d.bottom,
    calibrated: true,
  };
  saveCalibration();
  calib.active = false;
  el.calib.hidden = true;
  state.smoothedScale = null;
  renderStatus();
  showLastAction(xOk && yOk ? "Calibrated ✓" : "Calibrated (range too small, used defaults for one axis)");
}

// Runs every frame during calibration. f is null when there's no hand.

function updateCalibration(f, now) {
  const step = CALIB_STEPS[calib.i];
  const hold = step.key === "size" ? CONFIG.CALIB_SIZE_HOLD_MS : CONFIG.CALIB_EDGE_HOLD_MS;
  const dt = calib.lastT ? Math.min(100, now - calib.lastT) : 0;
  calib.lastT = now;
  let why = "";

  if (!f) why = "Show your hand to the camera";
  else if (step.key === "size" && !f.palmOpen) why = "Open your palm toward the camera";
  else if (step.key !== "size" && !reachedEdge(step.key, f.center)) why = "Keep reaching…";
  else if (f.rawSpeed > CONFIG.CALIB_STILL_MAX_SPEED) why = "Hold still…";

  if (why) {
    if (now - calib.okAt > CONFIG.CALIB_GRACE_MS) {
      calib.held = 0;
      calib.samples = [];
    }
    renderCalibration(Math.min(1, calib.held / hold), why);
    return;
  }

  calib.okAt = now;
  calib.held += dt;
  if (step.key === "size") {
    calib.samples.push({ v: f.handScale, x: f.center.x, y: f.center.y });
  } else {
    calib.samples.push({ v: step.key === "left" || step.key === "right" ? f.center.x : f.center.y });
  }
  const progress = calib.held / hold;
  renderCalibration(Math.min(1, progress), "Holding…");

  if (progress >= 1) {
    calib.result[step.key] = median(calib.samples.map((s) => s.v));
    if (step.key === "size") {
      calib.home = { x: median(calib.samples.map((s) => s.x)), y: median(calib.samples.map((s) => s.y)) };
    }
    calib.i++;
    calib.held = 0;
    calib.okAt = 0;
    calib.samples = [];
    if (calib.i >= CALIB_STEPS.length) finishCalibration();
    else renderCalibration(0, "");
  }
}

// Is the palm open - fix

function isPalmOpen(pts, top) {
  if (top && top.categoryName === "Open_Palm" && top.score >= CONFIG.CALIB_PALM_MIN_SCORE) return true;
  let extended = 0;
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    if (dist(pts[0], pts[tip]) > 1.1 * dist(pts[0], pts[pip])) extended++;
  }
  return extended >= 3;
}

//edge detection

function reachedEdge(key, c) {
  const home = calib.home, m = CONFIG.CALIB_MIN_REACH;
  if (key === "left") return c.x < home.x - m;
  if (key === "right") return c.x > home.x + m;
  if (key === "top") return c.y < home.y - m;
  return c.y > home.y + m;
}

function renderCalibration(progress, status) {
  const step = CALIB_STEPS[calib.i];
  el.calibIcon.textContent = step.icon;
  el.calibTitle.textContent = step.title;
  el.calibText.textContent = step.text;
  el.calibFill.style.width = `${progress * 100}%`;
  el.calibStatus.textContent = status;
  el.calibDots.innerHTML = CALIB_STEPS.map((_, k) =>
    `<span class="${k < calib.i ? "done" : k === calib.i ? "now" : ""}"></span>`).join("");
}

// ================
// Camera + pipe setup 

async function setupCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    const err = new Error("Camera API not available");
    err.name = "NotSupportedError";
    throw err;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" },
    audio: false,
  });
  const loaded = new Promise((res) => el.video.addEventListener("loadeddata", res, { once: true }));
  el.video.srcObject = stream;
  await loaded;
  await el.video.play();
  aspect = el.video.videoWidth / el.video.videoHeight;
  el.canvas.width = el.video.videoWidth;
  el.canvas.height = el.video.videoHeight;
}

// Pause = really stop the stream so the camera light goes off
function stopCamera() {
  el.video.srcObject?.getTracks().forEach((t) => t.stop());
  el.video.srcObject = null;
}

async function toggleCamera() {
  if (!recognizer || (!camPaused && !el.video.srcObject)) return showLastAction("Camera isn't running");
  if (!camPaused) {
    camPaused = true;
    stopCamera();
    onNoHand(performance.now());
    ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    setCamStatus("⏸ Camera paused");
    showLastAction("Camera paused");
  } else {
    el.camToggle.disabled = true;
    setCamStatus("Starting camera…");
    try {
      await setupCamera();
      camPaused = false;
      lastVideoTime = -1;
      setCamStatus("No hand detected: raise a hand ✋");
      showLastAction("Camera resumed");
    } catch (err) {
      console.error(err);
      showCameraError(err);
    }
    el.camToggle.disabled = false;
  }
  el.camToggle.textContent = camPaused ? "▶ Resume camera" : "⏸ Pause camera";
  el.camToggle.classList.toggle("paused", camPaused);
}

async function setupRecognizer() {
  vision = await import(`${CONFIG.MEDIAPIPE_URL}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${CONFIG.MEDIAPIPE_URL}/wasm`);
  const common = { runningMode: "VIDEO", numHands: 1 };

  const make = (delegate) =>
    vision.GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: CONFIG.GESTURE_MODEL, delegate },
      ...common,
    });
  try {
    recognizer = await make("GPU");
  } catch (e) {
    console.warn("GPU delegate failed, falling back to CPU", e);
    recognizer = await make("CPU");
  }

  if (CONFIG.USE_HAND_LANDMARKER) {
    handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: CONFIG.HAND_MODEL, delegate: "GPU" },
      ...common,
    });
  }
}

function showCameraError(err) {
  const messages = {
    NotAllowedError: "Camera permission was denied. Allow camera access in the address bar and reload. Keyboard controls still work: ← → change step, Space reads aloud, Enter marks done.",
    NotFoundError: "No webcam was found. Keyboard controls still work: ← → change step, Space reads aloud, Enter marks done.",
    NotReadableError: "The webcam is in use by another app. Close it and reload. Keyboard controls still work meanwhile.",
    NotSupportedError: "This browser can't access the camera here. Open the app from http://localhost (not file://) in Chrome.",
  };
  showBanner(messages[err.name] || `Couldn't start the camera (${err.message}). Keyboard controls still work.`, "error");
  setCamStatus("📷 Camera unavailable");
}

// ================
// Main 

let lastVideoTime = -1;

function loop() {
  if (!camPaused && el.video.readyState >= 2 && el.video.currentTime !== lastVideoTime) {
    lastVideoTime = el.video.currentTime;
    const now = performance.now();
    try {
      const res = recognizer.recognizeForVideo(el.video, now);
      let landmarks = res.landmarks?.[0];
      if (handLandmarker) landmarks = handLandmarker.detectForVideo(el.video, now).landmarks?.[0];
      const top = res.gestures?.[0]?.[0]; // best guess for the first hand

      if (state.lastFrameT) state.fps = state.fps * 0.9 + (1000 / (now - state.lastFrameT)) * 0.1;
      state.lastFrameT = now;

      processFrame(landmarks, top, now);
    } catch (err) {
      console.error(err); // log it and keep going if a single frame fails
    }
  }
  requestAnimationFrame(loop);
}

function processFrame(landmarks, top, now) {
  if (!landmarks) {
    onNoHand(now);
    if (calib.active) updateCalibration(null, now);
    drawOverlay(null);
    renderDebug();
    return;
  }

  // Mirror x so moving right on camera feels like moving right on screen
  const pts = landmarks.map((p) => ({ x: 1 - p.x, y: p.y }));
  if (!state.handVisible) {
    state.handVisible = true;
    setCamStatus("");
  }
  state.lastHandAt = now;

  // Use apparent hand size to guess how far you are from the camera
  const handScale = getHandScale(pts);
  state.smoothedScale = state.smoothedScale == null
    ? handScale
    : state.smoothedScale + CONFIG.SCALE_SMOOTHING * (handScale - state.smoothedScale);
  const scale = clamp(state.smoothedScale / state.calibration.handScale, CONFIG.SCALE_FACTOR_MIN, CONFIG.SCALE_FACTOR_MAX);
  state.scaleFactor = scale;

  // Keep a short palm history so we can tell when the hand is still
  const center = palmCenter(pts);
  state.history.push({ t: now, x: center.x, y: center.y });
  while (state.history.length && now - state.history[0].t > CONFIG.HISTORY_MS) state.history.shift();
  const speed = palmSpeed();

  const poseName = top && top.score >= CONFIG.MIN_GESTURE_SCORE ? top.categoryName : "None";
  const poseScore = top ? top.score : 0;
  el.hudLive.textContent = top ? `${top.categoryName} (${fmt(top.score)})` : "hand, no pose";
  Object.assign(state.live, { handScale, speed: speed.usable, rawSpeed: speed.raw });

  if (calib.active) {
    updateCalibration({ center, handScale, palmOpen: isPalmOpen(pts, top), rawSpeed: speed.raw }, now);
    drawOverlay(pts, center);
    renderDebug();
    return;
  }


  const pinch = detectPinchScroll(pts, now, handScale, scale, poseName);
  if (pinch.active) {
    resetNav(); // no step changes while scrolling
    state.pose.since = now;
    el.hudLive.textContent = `${state.view === "dashboard" ? "Pinch rows" : "Pinch scroll"} (${fmt(pinch.ratio)})`;
  } else {
    const dir = detectPointHold(pts, now, handScale, poseName);
    if (dir) {
      const how = state.nav.finger === "thumb" ? "Thumb" : "Point";
      const label = dir > 0 ? `👉 ${how} right` : `👈 ${how} left`;
      const dash = state.view === "dashboard";
      trigger(now, label, dir > 0 ? (dash ? actions.pickNext : actions.nextStep) : (dash ? actions.pickPrev : actions.prevStep));
    }
    if (state.nav.zone) state.pose.since = now;
    else detectStaticPose(poseName, poseScore, now, speed.usable, scale);
  }
  renderNav();

  drawOverlay(pts, center);
  renderDebug();
}

function onNoHand(now) {
  if (state.handVisible) {
    state.handVisible = false;
    state.history = [];
    endPinch();
    Object.assign(state.pose, { name: "None", fired: false, progress: 0 });
  }
 
  state.nav.lastT = 0; // don't count time when there's no hand
  if (state.nav.zone && now - state.lastHandAt > CONFIG.NAV_GRACE_MS) {
    resetNav();
    renderNav();
  }
  el.hudLive.textContent = "no hand";
  if (now - state.lastHandAt > 400) setCamStatus("No hand detected: raise a hand ✋");
}

// ================
// Rendering

function render(direction) {
  const recipe = currentRecipe();
  const step = recipe.steps[state.stepIndex];
  const n = recipe.steps.length;
  const done = state.completed[state.recipeIndex][state.stepIndex];

  el.title.textContent = recipe.title;
  if (el.source) {
    el.source.hidden = !recipe.source;
    if (recipe.source) el.source.href = recipe.source;
  }
  el.stepCount.textContent = `Step ${state.stepIndex + 1} of ${n}`;
  if (el.progressFill) el.progressFill.style.width = `${((state.stepIndex + 1) / n) * 100}%`;
  el.currentStepLabel.textContent = `Current · Step ${state.stepIndex + 1}`;
  el.stepText.textContent = step.text;
  if (el.recipeMeta) 
  el.recipeMeta.textContent = `Serves ${recipe.servings} · ${n} steps`;
  if (el.stepNum) el.stepNum.textContent = String(state.stepIndex + 1).padStart(2, "0");
  if (el.segments) { // one segment per step: done, current, or still to come
    const doneList = state.completed[state.recipeIndex];
    el.segments.innerHTML = recipe.steps.map((_, k) => {
      const cls = [doneList[k] ? "done" : "", k === state.stepIndex ? "current" : ""].join(" ").trim();
      return `<li class="${cls}"></li>`;
    }).join("");
  }
  if (el.upNext) {
    const next = recipe.steps[state.stepIndex + 1];
    el.upNext.innerHTML = next ? `<span>Up next</span> ${escapeHtml(next.text)}` : `<span>Last step</span> Enjoy your meal.`;
  }
  el.card.classList.toggle("complete", done);

  el.chips.innerHTML = step.ingredients.length
    ? step.ingredients.map((i) => `<li class="chip">${escapeHtml(i)}</li>`).join("")
    : `<li class="chips-empty">No ingredients in this step</li>`;


  // Every ingredient, plus which steps use it (full list if the recipe has one)
  const used = new Map((recipe.allIngredients || []).map((ing) => [ing, []]));
  recipe.steps.forEach((s, k) => s.ingredients.forEach((ing) => {
    if (!used.has(ing)) used.set(ing, []);
    used.get(ing).push(k + 1);
  }));
  el.ingredientList.innerHTML = [...used].map(([ing, steps]) => {
    const current = step.ingredients.includes(ing) ? " current" : "";
    const where = steps.length ? `step ${steps.join(", ")}` : "";
    return `<li class="ingredient${current}"><span>${escapeHtml(ing)}</span><small>${where}</small></li>`;
  }).join("");

  const stepCards = recipe.steps.map((item, index) => {
    if (index === state.stepIndex) return el.card;
    const complete = state.completed[state.recipeIndex][index];
    const preview = document.createElement("article");
    preview.className = `step-preview${complete ? " complete" : ""}`;
    preview.setAttribute("aria-label", `Step ${index + 1}${complete ? ", complete" : ""}`);
    preview.innerHTML = `<span class="step-label">Step ${index + 1}${complete ? " · Complete" : ""}</span><p></p>`;
    preview.querySelector("p").textContent = item.text;
    return preview;
  });
  el.stepsList.replaceChildren(...stepCards);
  if (direction) {
    const listRect = el.stepsList.getBoundingClientRect();
    const cardRect = el.card.getBoundingClientRect();
    const cardOffset = cardRect.top - listRect.top + el.stepsList.scrollTop;
    el.stepsList.scrollTop = Math.max(
      0,
      cardOffset - Math.max(0, (el.stepsList.clientHeight - el.card.offsetHeight) / 2),
    );
  }

  if (direction) {
    el.card.classList.remove("enter-left", "enter-right", "bump");
    void el.card.offsetWidth;
    el.card.classList.add(direction === "right" ? "enter-right" : "enter-left");
  }
  renderStatus();
}


// At the first or last step the ring goes grey
function renderNav() {
  const n = state.nav;
  const dash = state.view === "dashboard";
  const steps = currentRecipe().steps.length;
  const blocked = !!n.zone && (dash
    ? !pickedTile() || (n.zone > 0 ? pickIsLast() : pickIsFirst())
    : (n.zone > 0 && state.stepIndex >= steps - 1) || (n.zone < 0 && state.stepIndex <= 0));
  const what = dash ? "recipe" : "step";

  el.navRing.hidden = !n.zone;
  if (n.zone) {
    el.navRing.classList.toggle("left", n.zone < 0);
    el.navRing.classList.toggle("right", n.zone > 0);
    el.navRing.classList.toggle("blocked", blocked);
    el.navRing.classList.toggle("done", n.fired);
    el.navArc.style.strokeDashoffset = NAV_RING_LENGTH * (1 - (n.fired ? 1 : n.progress));
    el.navArrow.textContent = n.zone > 0 ? "→" : "←";
    el.navLabel.textContent = n.fired
      ? "Lower your finger"
      : blocked
        ? n.zone > 0 ? `Last ${what}` : `First ${what}`
        : n.zone > 0 ? `Next ${what}` : `Previous ${what}`;
  }

  const px = blocked ? 0 : Math.round(n.zone * n.progress * CONFIG.NAV_DRAG_PX);
  if (px !== state.drag) {
    state.drag = px;
    el.card.style.setProperty("--drag", `${px}px`);
  }
}

function bumpCard() {
  el.card.classList.remove("enter-left", "enter-right", "bump");
  void el.card.offsetWidth;
  el.card.classList.add("bump");
}

function renderStatus() {
  el.speaker.hidden = !state.reading;
  const c = state.calibration;
  el.calibBadge.textContent = c.calibrated ? "✓ Calibrated" : "Default calibration";
  el.calibBadge.classList.toggle("ok", !!c.calibrated);
}

function showLastAction(text) {
  el.hudLast.textContent = `Last action: ${text}`;
  el.hudLast.classList.remove("flash");
  void el.hudLast.offsetWidth;
  el.hudLast.classList.add("flash");
}

function setCamStatus(text) {
  el.camStatus.textContent = text;
}

function showBanner(text, kind = "voice") {
  el.banner.textContent = text;
  el.banner.dataset.kind = kind;
  el.banner.classList.toggle("error", kind === "error");
  el.banner.hidden = false;
}

function hideBanner() {
  el.banner.hidden = true;
}

// Draw hand and gesture feedback over the preview
function drawOverlay(pts, center) {
  const W = el.canvas.width, H = el.canvas.height;
  ctx.clearRect(0, 0, W, H);

  // calibrated reach
  const c = state.calibration;
  ctx.setLineDash([8, 8]);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(c.left * W, c.top * H, (c.right - c.left) * W, (c.bottom - c.top) * H);
  ctx.setLineDash([]);

  if (!pts) return;

  const P = (i) => [pts[i].x * W, pts[i].y * H];
  ctx.strokeStyle = "#ffb070";
  ctx.lineWidth = 3;
  for (const { start, end } of vision.GestureRecognizer.HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(...P(start));
    ctx.lineTo(...P(end));
    ctx.stroke();
  }
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < pts.length; i++) {
    ctx.beginPath();
    ctx.arc(...P(i), 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pinch: line between thumb and index
  const pinching = state.pinch.active;
  ctx.strokeStyle = pinching ? "#4be37d" : "rgba(255,255,255,0.5)";
  ctx.lineWidth = pinching ? 6 : 2;
  ctx.beginPath();
  ctx.moveTo(...P(4));
  ctx.lineTo(...P(8));
  ctx.stroke();
  if (pinching) {
    const x = ((pts[4].x + pts[8].x) / 2) * W;
    ctx.strokeStyle = "#4be37d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 30, state.pinch.anchorY * H);
    ctx.lineTo(x + 30, state.pinch.anchorY * H);
    ctx.moveTo(x, state.pinch.anchorY * H);
    ctx.lineTo(x, state.pinch.y * H);
    ctx.stroke();
  }

  // Pointing: thick line along the index finger
  if (state.nav.zone) {
    ctx.strokeStyle = "#ffb070";
    ctx.lineWidth = 8;
    ctx.beginPath();
    const thumb = state.nav.finger === "thumb";
    ctx.moveTo(...P(thumb ? 2 : 5));
    ctx.lineTo(...P(thumb ? 4 : 8));
    ctx.stroke();
  }

  // progress ring around the palm
  const ring = Math.max(state.pose.progress, state.nav.progress);
  if (center && ring > 0) {
    ctx.strokeStyle = state.nav.progress > 0 ? "#ffb070" : "#4be37d";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(center.x * W, center.y * H, 34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ring);
    ctx.stroke();
  }
}

function renderDebug() {
  if (!state.debug) return;
  const L = state.live, c = state.calibration, p = state.pinch, s = state.pose;
  const cooldown = Math.max(0, state.cooldownUntil - performance.now());
  el.debug.textContent = [
    `fps            ${fmt(state.fps, 0)}`,
    `hand visible   ${state.handVisible}`,
    `hand scale     ${fmt(L.handScale, 3)} (smoothed ${fmt(state.smoothedScale, 3)})`,
    `scale factor   ${fmt(state.scaleFactor)}  (base ${fmt(c.handScale, 3)})`,
    `pointing       ${state.nav.dir ? `${state.nav.dir > 0 ? "RIGHT" : "LEFT"} (${state.nav.finger})` : "—"}`,
    `point hold     ${state.nav.zone ? (state.nav.zone > 0 ? "RIGHT" : "LEFT") : "—"}  ${fmt(state.nav.progress)}${state.nav.fired ? " (fired)" : ""}`,
    `palm speed     ${fmt(L.speed)} usable/s`,
    `pinch ratio    ${fmt(p.ratio)}  ${p.active ? "PINCHED" : ""}  offset ${fmt(p.offset)}`,
    `pose           ${s.name} ${fmt(s.score)}  dwell ${fmt(s.progress)}${s.fired ? " (fired)" : ""}`,
    `cooldown       ${fmt(cooldown, 0)} ms`,
    `range x        ${fmt(c.left)}–${fmt(c.right)}  y ${fmt(c.top)}–${fmt(c.bottom)}`,
    `calibration    ${calib.active ? `step ${calib.i + 1}/5` : c.calibrated ? "saved" : "defaults"}`,
  ].join("\n");
}

// ================
// Budget Bytes search

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

// One recipe card for the dashboard grids (built with DOM calls, so scraped text stays text)
function recipeTile({ title, image, meta, metaDone, onOpen, onRemove }) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "recipe-tile";
  if (image) {
    const img = document.createElement("img");
    Object.assign(img, { className: "tile-img", src: image, alt: "", loading: "lazy", referrerPolicy: "no-referrer" });
    btn.append(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "tile-img";
    ph.textContent = "🍳";
    btn.append(ph);
  }
  const body = document.createElement("div");
  body.className = "tile-body";
  const t = document.createElement("span");
  t.className = "tile-title";
  t.textContent = title;
  body.append(t);
  if (meta) {
    const m = document.createElement("span");
    m.className = metaDone ? "tile-meta done" : "tile-meta";
    m.textContent = meta;
    body.append(m);
  }
  btn.append(body);
  btn.addEventListener("click", () => onOpen(btn));
  li.append(btn);
  if (onRemove) {
    const x = document.createElement("button");
    Object.assign(x, { type: "button", className: "tile-remove", textContent: "✕", title: "Remove recipe" });
    x.setAttribute("aria-label", `Remove ${title}`);
    x.addEventListener("click", onRemove);
    li.append(x);
  }
  return li;
}

// Saved tab: the default plus everything you've opened
function renderDashboard() {
  if (!el.myRecipes) return;
  el.savedCount.textContent = RECIPES.length;
  el.myRecipes.replaceChildren(...RECIPES.map((r, i) => {
    const n = r.steps.length;
    const done = state.completed[i].filter(Boolean).length;
    const meta = done === n ? `✓ All ${n} steps done` : done ? `${done} of ${n} steps done` : `${n} steps · serves ${r.servings}`;
    return recipeTile({
      title: r.title,
      image: r.image,
      meta,
      metaDone: done === n,
      onOpen: () => openRecipe(i),
      onRemove: i === 0 ? null : () => removeRecipe(i), // keep the default recipe
    });
  }));
}

function showView(view) {
  state.view = view;
  document.body.dataset.view = view;
  if (view === "dashboard") {
    stopReading();
    endPinch();
    resetNav();
    renderNav();
    renderDashboard();
    renderResults();
    renderHome();
  }
  window.scrollTo(0, 0);
  applyPick();
}

let lastResults = []; // kept so tiles can show "Saved"
let homeSections = null; // rows from /api/home

// Tile for a Budget Bytes listing (search results + home rows)
function listingTile(r) {
  const have = RECIPES.some((x) => x.source === r.url);
  return recipeTile({
    title: r.title,
    image: r.image,
    meta: have ? "✓ Saved" : "Budget Bytes",
    metaDone: have,
    onOpen: (btn) => loadRecipe(r.url, r.image, btn),
  });
}

function renderResults() {
  if (!el.searchResults || !lastResults.length) return;
  el.searchResults.replaceChildren(...lastResults.map(listingTile));
  applyPick();
}

// Home tab: "New" + recommended rows
async function loadHome() {
  if (!el.homeRows) return;
  try {
    homeSections = await getJson("/api/home");
    renderHome();
  } catch (err) {
    console.error(err);
    el.homeRows.innerHTML = `<p class="grid-note">Couldn't load recipes from Budget Bytes (${escapeHtml(err.message)}). Search still works if the server is running.</p>`;
  }
}

function renderHome() {
  if (!el.homeRows || !homeSections) return;
  el.homeRows.replaceChildren(...homeSections.map((sec) => {
    const section = document.createElement("section");
    section.className = "dash-section";
    const h = document.createElement("h2");
    h.textContent = sec.title;
    const sub = document.createElement("p");
    sub.className = "row-sub";
    sub.textContent = sec.subtitle;
    const row = document.createElement("ul");
    row.className = "recipe-row";
    row.append(...sec.recipes.map(listingTile));
    section.append(h, sub, row);
    return section;
  }));
  applyPick();
}

function showTab(tab) {
  if (!el.tabHome) return;
  if (tab !== state.tab) state.pick = { row: 0, col: 0 };
  state.tab = tab;
  const home = tab === "home";
  el.tabHome.setAttribute("aria-selected", home);
  el.tabSaved.setAttribute("aria-selected", !home);
  el.panelHome.hidden = !home;
  el.panelSaved.hidden = home;
  applyPick();
}

// ----- Highlighted recipe (gestures + arrow keys)

// Visible tiles as rows: each home strip is one row, grids split by line
function tileRows() {
  const panel = state.tab === "saved" ? el.panelSaved : el.panelHome;
  if (!panel || state.view !== "dashboard") return [];
  const rows = [];
  let lastKey = null;
  for (const tile of panel.querySelectorAll(".recipe-tile")) {
    if (!tile.offsetParent) continue; // hidden
    const list = tile.closest("ul");
    const key = list.classList.contains("recipe-row") ? list : `${list.id}:${Math.round(tile.getBoundingClientRect().top)}`;
    if (key !== lastKey) rows.push([]);
    rows[rows.length - 1].push(tile);
    lastKey = key;
  }
  return rows;
}

function pickedTile() {
  const { row, col } = state.pick;
  return tileRows()[row]?.[col] || null;
}

const pickIsFirst = () => state.pick.row === 0 && state.pick.col === 0;
function pickIsLast() {
  const rows = tileRows();
  return state.pick.row === rows.length - 1 && state.pick.col === rows[rows.length - 1].length - 1;
}

// Clamp the pick to what's on screen, mark it, and scroll it into view
function applyPick(scroll = false) {
  document.querySelectorAll(".recipe-tile.picked").forEach((t) => t.classList.remove("picked"));
  const rows = tileRows();
  if (!rows.length) return null;
  const p = state.pick;
  p.row = clamp(p.row, 0, rows.length - 1);
  p.col = clamp(p.col, 0, rows[p.row].length - 1);
  const tile = rows[p.row][p.col];
  tile.classList.add("picked");
  if (scroll) tile.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  return tile;
}

// Left/right: next tile, wrapping onto the next row
function movePick(d) {
  const rows = tileRows();
  if (!rows.length) return "no recipes on screen";
  const p = state.pick;
  if (d > 0 && pickIsLast()) return "already on last recipe";
  if (d < 0 && pickIsFirst()) return "already on first recipe";
  p.col += d;
  if (p.col >= rows[p.row].length) { p.row++; p.col = 0; }
  if (p.col < 0) { p.row--; p.col = rows[p.row].length - 1; }
  const tile = applyPick(true);
  return tile.querySelector(".tile-title").textContent;
}

// Up/down: row above/below, same column if it exists
function moveRow(d) {
  const rows = tileRows();
  const row = state.pick.row + d;
  if (!rows.length || row < 0 || row >= rows.length) return d > 0 ? "already on last row" : "already on first row";
  state.pick.row = row;
  const tile = applyPick(true);
  return tile.querySelector(".tile-title").textContent;
}

// Pinch + move: every ROW_JUMP_PX of "scroll" = one row
function pinchRows(px) {
  state.rowAcc += px;
  while (Math.abs(state.rowAcc) >= CONFIG.ROW_JUMP_PX) {
    const d = Math.sign(state.rowAcc);
    state.rowAcc -= d * CONFIG.ROW_JUMP_PX;
    showLastAction(`🤏 Pinch ${d > 0 ? "down" : "up"} → ${moveRow(d)}`);
  }
}

async function runSearch(q) {
  q = q.trim();
  if (!q) return;
  const list = el.searchResults;
  const button = el.searchForm.querySelector("button");
  button.disabled = true;
  showTab("home"); // results live on the Home tab
  el.resultsSection.hidden = false;
  el.resultsTitle.textContent = `Results for “${q}”`;
  list.innerHTML = `<li class="grid-note">Searching Budget Bytes…</li>`;
  try {
    lastResults = await getJson(`/api/search?q=${encodeURIComponent(q)}`);
    state.pick = { row: 0, col: 0 };
    renderResults();
    if (!lastResults.length) list.innerHTML = `<li class="grid-note">No recipes found for “${escapeHtml(q)}”.</li>`;
  } catch (err) {
    console.error(err);
    list.innerHTML = `<li class="grid-note">Search failed: ${escapeHtml(err.message)}</li>`;
    showBanner("Search failed. Is the server running? Start it with: npm start", "error");
  } finally {
    button.disabled = false;
  }
}

async function loadRecipe(url, image, tile) {
  // already loaded? just switch to it
  const existing = RECIPES.findIndex((r) => r.source === url);
  if (existing !== -1) return openRecipe(existing);

  showLastAction("Loading recipe…");
  if (tile) tile.disabled = true;
  try {
    const recipe = await getJson(`/api/recipe?url=${encodeURIComponent(url)}`);
    if (image) recipe.image = image; // thumbnail for the dashboard
    RECIPES.push(recipe);
    state.completed.push(recipe.steps.map(() => false));
    openRecipe(RECIPES.length - 1);
  } catch (err) {
    console.error(err);
    showLastAction("Couldn't load that recipe");
    showBanner(`Couldn't load that recipe: ${err.message}`, "error");
  } finally {
    if (tile) tile.disabled = false;
  }
}

function openRecipe(i) {
  if (i !== state.recipeIndex) state.stepIndex = 0; // same recipe = pick up where you left off
  state.recipeIndex = i;
  stopReading();
  hideBanner();
  render();
  saveRecipes();
  showView("cook");
  showLastAction(`Opened “${currentRecipe().title}”`);
}

function removeRecipe(i) {
  RECIPES.splice(i, 1);
  state.completed.splice(i, 1);
  if (state.recipeIndex === i) Object.assign(state, { recipeIndex: 0, stepIndex: 0 });
  else if (state.recipeIndex > i) state.recipeIndex--;
  saveRecipes();
  renderDashboard();
  renderResults();
  renderHome();
  applyPick();
}

// ================
// Keyboard fallbacks

function bindInput() {
  window.addEventListener("pointerdown", unlockVoice);
  window.addEventListener("keydown", (e) => {
    unlockVoice();
    // typing in the search box shouldn't trigger shortcuts
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
    const run = (label, fn) => showLastAction(`⌨️ ${label} → ${fn()}`);
    // Dashboard: arrows move the highlight, Enter opens it (unless a button has focus)
    if (state.view === "dashboard") {
      const onButton = t instanceof HTMLButtonElement;
      switch (e.key) {
        case "ArrowRight": e.preventDefault(); return run("→", actions.pickNext);
        case "ArrowLeft": e.preventDefault(); return run("←", actions.pickPrev);
        case "ArrowDown": e.preventDefault(); return run("↓", () => moveRow(1));
        case "ArrowUp": e.preventDefault(); return run("↑", () => moveRow(-1));
        case "Enter": if (onButton) return; e.preventDefault(); return run("Enter", actions.openPicked);
        case " ": return; // let Space click a focused button
      }
    }
    switch (e.key) {
      case "ArrowRight": e.preventDefault(); run("→", actions.nextStep); break;
      case "ArrowLeft": e.preventDefault(); run("←", actions.prevStep); break;
      case " ": e.preventDefault(); run("Space", actions.toggleRead); break;
      case "Enter": e.preventDefault(); run("Enter", actions.toggleComplete); break;
      case "c": case "C": recalibrate(); break;
      case "p": case "P": toggleCamera(); break;
      case "d": case "D":
        state.debug = !state.debug;
        el.debug.hidden = !state.debug;
        renderDebug();
        break;
      case "Escape":
        if (calib.active) skipCalibration();
        else if (state.view === "cook" && el.dashboard) showView("dashboard");
        break;
    }
  });
  el.calibSkip.addEventListener("click", () => {
    el.calibSkip.blur(); 
    skipCalibration();
  });
  el.recalibrate.addEventListener("click", () => {
    el.recalibrate.blur();
    recalibrate();
  });
  el.back?.addEventListener("click", () => showView("dashboard"));
  el.tabHome?.addEventListener("click", () => showTab("home"));
  el.tabSaved?.addEventListener("click", () => showTab("saved"));
  el.resultsClear?.addEventListener("click", () => {
    el.resultsSection.hidden = true;
    el.searchResults.replaceChildren();
    el.searchInput.value = "";
    lastResults = [];
  });
  el.searchForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(el.searchInput.value);
  });
  el.camToggle.addEventListener("click", () => {
    el.camToggle.blur();
    toggleCamera();
  });
}

function recalibrate() {
  if (recognizer) startCalibration();
  else showLastAction("Calibration needs the camera");
}

async function init() {
  render();
  if (el.dashboard) { // redesign.html has no dashboard
    showView("dashboard");
    loadHome();
  }
  bindInput();
  setCamStatus("Starting camera & loading hand model…");

  const [cam, model] = await Promise.allSettled([setupCamera(), setupRecognizer()]);
  if (cam.status === "rejected") {
    console.error(cam.reason);
    showCameraError(cam.reason);
    return;
  }
  if (model.status === "rejected") {
    console.error(model.reason);
    showBanner("Couldn't load the hand-tracking model (are you online?). Keyboard controls still work.", "error");
    setCamStatus("Hand tracking unavailable");
    return;
  }

  setCamStatus("No hand detected: raise a hand ✋");
  if (!hasStoredCalibration()) startCalibration(); // only on the first visit
  requestAnimationFrame(loop);
}

// console tweakin
window.cookbook = { CONFIG, state, actions, processFrame, startCalibration };

init();
