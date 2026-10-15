// Hands-free cookbook server
// Serves the app + fetches Budget Bytes recipes (browsers can't, CORS)

import express from "express";
import * as cheerio from "cheerio";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = process.env.PORT || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const ALLOWED_HOST = "www.budgetbytes.com"; // only site we fetch
const USER_AGENT = "HandsFreeCookbook/1.0 (student project; reads one recipe at a time for a gesture-controlled cooking UI)";
const CACHE_MS = 60 * 60 * 1000; // 1 hour
const MIN_GAP_MS = 500; // wait between requests
const TIMEOUT_MS = 10000;
const MAX_STEP_CHARS = 200; // longer steps get split

// ================
// Polite fetching

// SSRF guard: https budgetbytes only
function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== ALLOWED_HOST || u.port || u.username || u.password) return null;
  u.hash = "";
  return u;
}

// One request at a time, with a small gap
let queue = Promise.resolve();
let lastFetchAt = 0;

function politeFetch(url) {
  const run = async () => {
    const wait = lastFetchAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFetchAt = Date.now();
    return fetchFollowingSafely(url);
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// Follow redirects by hand so they can't leave budgetbytes
async function fetchFollowingSafely(url, hops = 3) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    const next = checkUrl(new URL(res.headers.get("location"), url).href);
    if (!next || hops === 0) throw httpError(502, "Budget Bytes redirected somewhere we don't fetch");
    return fetchFollowingSafely(next.href, hops - 1);
  }
  if (!res.ok) throw httpError(502, `Budget Bytes answered ${res.status}`);
  return res;
}

const cache = new Map(); // key -> { at, data }

async function cached(key, make) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await make();
  cache.set(key, { at: Date.now(), data });
  return data;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ================
// Text cleanup

// strip tags + decode entities + tidy spaces
function cleanText(html) {
  if (html == null) return "";
  return cheerio.load(`<div>${html}</div>`)("div").text().replace(/\s+/g, " ").trim();
}

// drop the price notes: "(150g, $0.17*)" -> "(150g)", "($0.18)" -> ""
function cleanIngredient(s) {
  return cleanText(s)
    .replace(/,?\s*\$\d+(\.\d+)?\**/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\(\s*,\s*/g, "(")
    .replace(/\s+/g, " ")
    .trim();
}

// ================
// Search + home page lists (WordPress REST API)

// Budget Bytes category ids (from /wp-json/wp/v2/categories)
const CAT = {
  recipes: 55, roundups: 28, extraBytes: 983, // roundups live under "Extra Bytes"
  quick: 770, under150: 10048,
  spring: 12640, summer: 12637, fall: 12638, winter: 12639,
};

async function listPosts(params) {
  const api = new URL(`https://${ALLOWED_HOST}/wp-json/wp/v2/posts`);
  api.search = new URLSearchParams({ ...params, _fields: "title,link,yoast_head_json.og_image" });
  const posts = await (await politeFetch(api.href)).json();
  if (!Array.isArray(posts)) throw httpError(502, "Unexpected response from Budget Bytes");
  return posts
    .filter((p) => checkUrl(p.link))
    .map((p) => ({
      title: cleanText(p.title?.rendered),
      url: p.link,
      image: p.yoast_head_json?.og_image?.[0]?.url || null,
    }));
}

function search(q) {
  return listPosts({ search: q, per_page: "12", orderby: "relevance" });
}

const recipesIn = (category, perPage) =>
  listPosts({ categories: String(category), categories_exclude: `${CAT.extraBytes},${CAT.roundups}`, per_page: String(perPage) });

// random pick, so "recommended" isn't always the newest
function sample(list, n) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function season(month = new Date().getMonth()) {
  if (month >= 2 && month <= 4) return { name: "Spring", cat: CAT.spring };
  if (month >= 5 && month <= 7) return { name: "Summer", cat: CAT.summer };
  if (month >= 8 && month <= 10) return { name: "Fall", cat: CAT.fall };
  return { name: "Winter", cat: CAT.winter };
}

// Home page rows. Fetched one after another (politeFetch), cached for an hour.
async function home() {
  const s = season();
  const latest = await recipesIn(CAT.recipes, 10);
  const seen = new Set(latest.map((r) => r.url));
  const pick = (list) => {
    const fresh = sample(list.filter((r) => !seen.has(r.url)), 10);
    fresh.forEach((r) => seen.add(r.url));
    return fresh;
  };
  return [
    { id: "new", title: "New on Budget Bytes", subtitle: "Just posted", recipes: latest },
    { id: "season", title: `${s.name} favorites`, subtitle: "Recommended for this time of year", recipes: pick(await recipesIn(s.cat, 40)) },
    { id: "quick", title: "Quick & easy", subtitle: "Recommended for busy nights", recipes: pick(await recipesIn(CAT.quick, 40)) },
    { id: "cheap", title: "Under $1.50 a serving", subtitle: "Recommended for tight budgets", recipes: pick(await recipesIn(CAT.under150, 40)) },
  ].filter((section) => section.recipes.length);
}

// ================
// Recipe parsing

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const isRecipe = (o) => o && typeof o === "object" && asArray(o["@type"]).includes("Recipe");

// Find the Recipe object anywhere in the JSON-LD (@graph, arrays, nesting)
function findRecipe(node) {
  if (!node || typeof node !== "object") return null;
  if (isRecipe(node)) return node;
  for (const child of Array.isArray(node) ? node : [node["@graph"], node.mainEntity].filter(Boolean)) {
    const found = findRecipe(child);
    if (found) return found;
  }
  return null;
}

// Strings, HowToStep, HowToSection -> flat list of step texts
function flattenInstructions(node) {
  if (node == null) return [];
  if (typeof node === "string") return [cleanStep(node)];
  if (Array.isArray(node)) return node.flatMap(flattenInstructions);
  if (node.itemListElement) return flattenInstructions(node.itemListElement);
  return [cleanStep(node.text ?? node.name ?? "")];
}

// drop footnote stars and "(See browning note)" — we don't show the notes
function cleanStep(html) {
  return cleanText(html)
    .replace(/\s*\(see [^)]*\bnotes?\)\.?/gi, "")
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Split long steps on sentence ends, packing sentences up to the limit
function splitLongStep(text) {
  if (text.length <= MAX_STEP_CHARS) return [text];
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/);
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + " " + s).length > MAX_STEP_CHARS) {
      out.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ----- matching ingredients to steps

const UNITS = new Set(`cup cups c tsp tsps teaspoon teaspoons tbsp tbsps tablespoon tablespoons oz ounce ounces
  lb lbs pound pounds g gram grams kg ml l liter liters litre quart quarts pint pints gallon pinch pinches dash dashes
  clove cloves can cans package packages pkg jar jars bunch bunches stick sticks slice slices sprig sprigs head heads
  piece pieces inch inches handful large medium small whole`.split(/\s+/));

// words that describe, rather than name, the ingredient
const DESCRIPTORS = new Set(`fresh freshly dried frozen chopped minced diced sliced shredded grated crushed ground
  melted softened warm cold room temperature boneless skinless lean extra virgin low sodium reduced fat unsalted salted
  all purpose granulated packed light dark raw cooked uncooked canned plus more to taste optional for serving divided
  finely roughly thinly about and or of the a an cooking red green yellow white black brown baby`.split(/\s+/));

// too vague to match alone (still matches as part of the full name)
const GENERIC = new Set("powder sauce extract juice paste seed leaf leave stock broth flake mix oil water".split(" "));

const stem = (w) => w.replace(/ies$/, "y").replace(/(oes|ches|shes|sses|xes)$/, (m) => m.slice(0, -2)).replace(/s$/, "");

function words(text) {
  return text.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean).map(stem);
}

// "1 cup all-purpose flour (150g)" -> phrase "all purpose flour", keys ["flour"]
// "2 cups chicken broth" -> phrase "chicken broth", keys ["broth"] (vague last word = only that counts)
function ingredientKeys(ing) {
  const base = ing.replace(/\([^)]*\)?/g, " ").split(",")[0];
  const tokens = words(base.replace(/[\d½¼¾⅓⅔⅛⅜⅝⅞⁄\/.]+/g, " ")).filter((w) => !UNITS.has(w) && w.length > 1);
  const head = tokens[tokens.length - 1];
  const keys = GENERIC.has(head) ? [head] : tokens.filter((w) => !DESCRIPTORS.has(w) && !GENERIC.has(w));
  return { phrase: tokens.join(" "), keys };
}

// Full name in the step = strong match. A key word alone = weak match,
// dropped if a strong match already claimed that word ("olive oil" beats "cooking oil").
function matchIngredients(stepText, ingredients) {
  const w = words(stepText);
  const set = new Set(w);
  const joined = ` ${w.join(" ")} `;
  const found = ingredients.map((ing) => {
    const { phrase, keys } = ingredientKeys(ing);
    const strong = phrase.includes(" ") && joined.includes(` ${phrase} `);
    return { ing, strong, hits: keys.filter((k) => set.has(k)), words: phrase.split(" ") };
  });
  const claimed = new Set(found.filter((f) => f.strong).flatMap((f) => f.words));
  return found
    .filter((f) => f.strong || (f.hits.length && !f.hits.every((k) => claimed.has(k))))
    .map((f) => f.ing)
    .filter((ing, k, all) => all.indexOf(ing) === k); // same line listed twice
}

function parseServings(yieldVal) {
  for (const y of asArray(yieldVal)) {
    const m = String(y).match(/\d+/);
    if (m) return Number(m[0]);
  }
  return 1;
}

async function loadRecipe(url) {
  const html = await (await politeFetch(url)).text();
  const $ = cheerio.load(html);
  let recipe = null;
  $('script[type="application/ld+json"]').each((_, node) => {
    if (recipe) return;
    try { recipe = findRecipe(JSON.parse($(node).text())); } catch { /* skip bad JSON */ }
  });
  if (!recipe) throw httpError(422, "No recipe found on that page (it might be a roundup or article, not a single recipe).");

  const allIngredients = asArray(recipe.recipeIngredient).map(cleanIngredient).filter(Boolean);
  const steps = flattenInstructions(recipe.recipeInstructions)
    .filter(Boolean)
    .flatMap(splitLongStep)
    .map((text) => ({ text, ingredients: matchIngredients(text, allIngredients) }));
  if (!steps.length) throw httpError(422, "That recipe has no instructions we can read.");

  return {
    // page heading first: the JSON-LD name is sometimes all lowercase
    title: cleanText($("h1.entry-title").first().text()) ||
      cleanText($('meta[property="og:title"]').attr("content")).replace(/\s*[-|–]\s*Budget Bytes$/i, "") ||
      cleanText(recipe.name) || "Untitled recipe",
    servings: parseServings(recipe.recipeYield),
    source: url,
    allIngredients,
    steps,
  };
}

// ================
// Routes

const app = express();

app.get("/api/search", async (req, res, next) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: "Type something to search for." });
  try {
    res.json(await cached(`search:${q.toLowerCase()}`, () => search(q)));
  } catch (err) { next(err); }
});

app.get("/api/home", async (req, res, next) => {
  try {
    res.json(await cached("home", home));
  } catch (err) { next(err); }
});

app.get("/api/recipe", async (req, res, next) => {
  const u = checkUrl(String(req.query.url || ""));
  if (!u) return res.status(400).json({ error: `Only https://${ALLOWED_HOST} recipe links are allowed.` });
  try {
    res.json(await cached(`recipe:${u.href}`, () => loadRecipe(u.href)));
  } catch (err) { next(err); }
});

// don't serve server-side stuff
app.use(["/node_modules", "/server.js", "/package.json", "/package-lock.json"], (req, res) => res.sendStatus(404));
app.use(express.static(ROOT));

app.use((err, req, res, next) => {
  const status = err.status || (err.name === "TimeoutError" ? 504 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 500 ? "Something went wrong on the server." : err.message });
});

// only listen when run directly (tests import the helpers)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`Cookbook running at http://localhost:${PORT}`));
  cached("home", home).catch((err) => console.warn("Couldn't preload home page:", err.message)); // warm it up
}

export { findRecipe, flattenInstructions, splitLongStep, matchIngredients, parseServings, checkUrl, cleanIngredient };
