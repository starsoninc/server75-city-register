/* register-gate.js — v1
 *
 * The write path for the Server 75 city register.
 *
 * Everyone can read the register: it is a static file on a public site.
 * Only people holding an editor token can publish a change, and every published
 * change lands as a GitHub commit authored by the person who made it.
 *
 * The design rule this file exists to enforce:
 *
 *   THE BROWSER NEVER SAYS WHO IT IS.
 *
 * The page sends a token and a proposed register. This code decides whose token
 * that is, stamps the record entry itself, and refuses anything that would
 * rewrite what is already there. A client that sends { by: "someone else" } is
 * ignored, not trusted.
 *
 * Environment variables (Netlify → Site configuration → Environment variables):
 *
 *   EDITORS        JSON. Token → who it belongs to. The tokens ARE the
 *                  passwords, so treat this like a password list.
 *                  {
 *                    "long-random-string-1": { "name": "Emmy",  "alliance": "ŘĘĞŇ" },
 *                    "long-random-string-2": { "name": "Kaspa", "alliance": "HoG"  }
 *                  }
 *   GITHUB_TOKEN   Fine-grained PAT, Contents: read and write, on ONE repo.
 *   GITHUB_REPO    "owner/name", e.g. "starsoninc/server75-city-register"
 *   GITHUB_BRANCH  optional, default "main"
 *   GITHUB_PATH    optional, default "index.html"
 *   ANTHROPIC_API_KEY  optional. Without it the Import tab is switched off.
 *   IMPORT_MODEL       optional, default below.
 *
 * Routes:
 *   GET  /api/health   is this configured
 *   POST /api/whoami   is my token good, and who does it say I am
 *   POST /api/publish  publish a register
 *   POST /api/import   read a map screenshot and propose changes
 */

const IMPORT_DEFAULT_MODEL = "claude-sonnet-4-6";

const BEGIN = "/* REGISTER:BEGIN */";
const END = "/* REGISTER:END */";

/* ---------- helpers ---------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

/* Length-independent compare, so a wrong token cannot be found a character at
   a time by watching how long the answer takes. */
function tokenMatches(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i % x.length] || 0) ^ (y[i % y.length] || 0);
  }
  return diff === 0;
}

function whoIs(token) {
  let map;
  try { map = JSON.parse(Netlify.env.get("EDITORS") || "{}"); }
  catch { return null; }
  for (const key of Object.keys(map)) {
    if (tokenMatches(key, token)) {
      const e = map[key] || {};
      /* No role written down means the lesser role. Permissions default to
         the smaller one, never the larger. */
      const role = e.role === "keeper" ? "keeper" : "officer";
      return { name: String(e.name || "unnamed editor"), alliance: String(e.alliance || ""), role };
    }
  }
  return null;
}

/* btoa() is byte-oriented. Half this roster is spelled with stroked and
   accented letters, so the string has to be encoded to UTF-8 bytes first or
   the commit lands with mangled names. */
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function unb64(b) {
  const bin = atob(b.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* Same fingerprint the page computes. Kept in step with index.html by hand —
   if the page's canonical fields change, change them here too. */
function fingerprint(R) {
  const canon = JSON.stringify([
    R.schema, R.cycleStart, R.termDays, R.published,
    (R.pool || []).map(a => [a.tag, a.name, a.score]),
    (R.cities || []).map(c => [c.id, c.name, c.level, c.pickRank || 0, c.holder || "", !!c.rotates]),
    R.picks, R.skips, R.transfers || [], R.releases || {}, R.cityCap || 0,
    R.contributions || {}, (R.rules || {}).text || "", (R.log || []).length
  ]);
  let h = 5381;
  for (let i = 0; i < canon.length; i++) h = ((h * 33) ^ canon.charCodeAt(i)) >>> 0;
  const hex = ("00000000" + h.toString(16)).slice(-8).toUpperCase();
  return hex.slice(0, 4) + " " + hex.slice(4);
}

function extractRegister(file) {
  const i = file.indexOf(BEGIN), j = file.indexOf(END);
  if (i < 0 || j < 0 || j < i) return null;
  const body = file.slice(i + BEGIN.length, j).trim();
  const eq = body.indexOf("=");
  const semi = body.lastIndexOf("}");
  if (eq < 0 || semi < 0) return null;
  try { return JSON.parse(body.slice(eq + 1, semi + 1)); } catch { return null; }
}

function spliceRegister(file, obj) {
  const i = file.indexOf(BEGIN), j = file.indexOf(END);
  return file.slice(0, i + BEGIN.length) +
    "\nvar REGISTER = " + JSON.stringify(obj, null, 2) + ";\n" +
    file.slice(j);
}

/* ---------- GitHub ---------- */

async function gh(path, init) {
  const token = Netlify.env.get("GITHUB_TOKEN");
  const repo = Netlify.env.get("GITHUB_REPO");
  const res = await fetch("https://api.github.com/repos/" + repo + path, {
    ...init,
    headers: {
      "authorization": "Bearer " + token,
      "accept": "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "server75-city-register",
      ...(init && init.headers)
    }
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* leave null */ }
  return { ok: res.ok, status: res.status, body, text };
}

/* ---------- the integrity rules ---------- */

/* The record is append-only. An incoming register must carry the committed
   record unchanged as its opening entries; anything else is an attempt to
   edit or delete history and is refused rather than merged. Returns the
   entries that are genuinely new. */
function newLogEntries(prevLog, nextLog) {
  const prev = prevLog || [], next = nextLog || [];
  if (next.length < prev.length) return { error: "the record is shorter than the published one — entries cannot be removed" };
  for (let i = 0; i < prev.length; i++) {
    const a = { ...prev[i] }, b = { ...next[i] };
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      return { error: "record entry " + (i + 1) + " has been altered — published entries cannot be edited" };
    }
  }
  return { added: next.slice(prev.length) };
}

function eq(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }

/* Fields an officer may never touch. These are the terms of the rotation
   itself: who is in it, when turns fall, how alliances are scored. An officer
   records what happened to their own alliance; they do not set the rules that
   decide what happens next. */
const KEEPER_ONLY = ["schema", "cycleStart", "termDays", "relegationMargin", "cityCap",
                     "scoreWindow", "rulesUrl", "openQuestions", "picks", "skips", "rules"];

/* Fields frozen once a cycle is running, for everyone. Section 6 of the rules:
   a cycle finishes under the rules it started with. Enforced here rather than
   left to good intentions, because the whole value of a published schedule is
   that it cannot move once people have seen it. */
const CYCLE_LOCKED = ["cycleStart", "termDays"];

function termNow(R) {
  const p = String(R.cycleStart || "").split("-");
  const start = Date.UTC(+p[0], (+p[1] || 1) - 1, +p[2] || 1);
  const n = new Date();
  const today = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  return Math.floor((today - start) / ((R.termDays || 7) * 86400000));
}

/* What an officer changed that they had no business changing. */
function officerViolations(prev, next, who) {
  const bad = [];
  for (const k of KEEPER_ONLY) if (!eq(prev[k], next[k])) bad.push(k);
  if (!eq(prev.pool, next.pool)) bad.push("the rotation pool");

  const pc = prev.cities || [], nc = next.cities || [];
  if (pc.length !== nc.length) bad.push("the list of cities");
  else {
    for (let i = 0; i < pc.length; i++) {
      const a = { ...pc[i] }, b = { ...nc[i] };
      /* An officer may fill in facts about a city — what buff it gives, where
         it sits. Not what it is or who holds it. */
      delete a.buff; delete b.buff; delete a.coords; delete b.coords;
      if (!eq(a, b)) { bad.push("city “" + (pc[i].name || pc[i].id) + "”"); break; }
    }
  }

  const pr = prev.releases || {}, nr = next.releases || {};
  for (const term of new Set([...Object.keys(pr), ...Object.keys(nr)])) {
    const a = pr[term] || {}, b = nr[term] || {};
    for (const tag of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!eq(a[tag], b[tag]) && tag !== who.alliance) {
        bad.push("a release for " + tag + " in term " + (+term + 1));
      }
    }
  }

  /* An officer enters their own alliance's KvK and AvA and nobody else's.
     Without this, the numbers that decide pick order could be edited by the
     people they rank. */
  const pw = (prev.contributions || {}).weeks || {};
  const nw = (next.contributions || {}).weeks || {};
  for (const week of new Set([...Object.keys(pw), ...Object.keys(nw)])) {
    const a = pw[week] || {}, b = nw[week] || {};
    for (const tag of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!eq(a[tag], b[tag]) && tag !== who.alliance) {
        bad.push("contributions for " + tag + " in the week of " + week);
      }
    }
  }
  for (const k of ["window", "minWeeks", "anchor"]) {
    if (!eq((prev.contributions || {})[k], (next.contributions || {})[k])) bad.push("the scoring window settings");
  }

  const pt = prev.transfers || [], nt = next.transfers || [];
  if (nt.length < pt.length) bad.push("removing a recorded transfer");
  for (let i = 0; i < pt.length; i++) if (!eq(pt[i], nt[i])) { bad.push("an already recorded transfer"); break; }
  for (const t of nt.slice(pt.length)) {
    const city = (prev.cities || []).find(c => c.id === t.city);
    const mine = (city && city.holder === who.alliance) || t.to === who.alliance;
    if (!mine) bad.push("a transfer of a city that is not " + who.alliance + "’s");
  }
  return [...new Set(bad)];
}

/* ---------- routes ---------- */

async function handleWhoami(request) {
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const who = whoIs(body.token || "");
  if (!who) return json({ ok: false, error: "That token is not on the editor list." }, 401);
  return json({ ok: true, name: who.name, alliance: who.alliance, role: who.role,
                repo: Netlify.env.get("GITHUB_REPO") || "" });
}

async function handlePublish(request) {
  const repo = Netlify.env.get("GITHUB_REPO");
  const ghToken = Netlify.env.get("GITHUB_TOKEN");
  if (!repo || !ghToken) {
    return json({ ok: false, code: "setup", error: "GITHUB_REPO or GITHUB_TOKEN is not set for this site, so publishing is switched off." }, 503);
  }

  let body = {};
  try { body = await request.json(); } catch {
    return json({ ok: false, error: "That request was not JSON." }, 400);
  }

  const who = whoIs(body.token || "");
  if (!who) return json({ ok: false, error: "That token is not on the editor list." }, 401);

  const next = body.register;
  if (!next || !Array.isArray(next.pool) || !Array.isArray(next.cities)) {
    return json({ ok: false, error: "That register has no pool or no cities. Nothing was published." }, 400);
  }
  const note = String(body.note || "").trim();
  if (!note) return json({ ok: false, error: "Say what you changed. The note becomes the commit message and the record entry." }, 400);

  const path = Netlify.env.get("GITHUB_PATH") || "index.html";
  const branch = Netlify.env.get("GITHUB_BRANCH") || "main";

  const cur = await gh("/contents/" + encodeURIComponent(path) + "?ref=" + encodeURIComponent(branch));
  if (!cur.ok || !cur.body || !cur.body.content) {
    return json({ ok: false, error: "Could not read " + path + " from GitHub (" + cur.status + "). Nothing was published." }, 502);
  }
  const file = unb64(cur.body.content);
  const prev = extractRegister(file);
  if (!prev) {
    return json({ ok: false, error: "The register block in " + path + " could not be read. Nothing was published." }, 500);
  }

  /* Refuse a publish built on a version that is no longer current, so two
     officers editing at once cannot silently overwrite each other. */
  if (body.basedOn && body.basedOn !== fingerprint(prev)) {
    return json({
      ok: false, code: "stale",
      error: "The register changed while you were editing — it is now " + fingerprint(prev) +
             ", you started from " + body.basedOn + ". Reload, redo your change, and publish again."
    }, 409);
  }

  const check = newLogEntries(prev.log, next.log);
  if (check.error) return json({ ok: false, error: check.error }, 400);

  if (who.role !== "keeper") {
    const bad = officerViolations(prev, next, who);
    if (bad.length) {
      return json({
        ok: false, code: "role",
        error: "Your token records changes for " + (who.alliance || "your alliance") +
               ". It cannot change: " + bad.join(", ") + ". Nothing was published."
      }, 403);
    }
  }

  /* The cycle lock. Everyone is bound by it; a keeper can override, loudly. */
  const running = termNow(prev) >= 0;
  const moved = CYCLE_LOCKED.filter(k => !eq(prev[k], next[k]));
  const poolMoved = !eq((prev.pool || []).map(a => a.tag), (next.pool || []).map(a => a.tag));
  if (running && (moved.length || poolMoved) && !body.override) {
    const what = moved.concat(poolMoved ? ["the pool order"] : []);
    return json({
      ok: false, code: "cycle-locked",
      error: "A cycle is running, and " + what.join(" and ") + " sets the published schedule. " +
             "Changing it now moves turns people have already been told about. " +
             (who.role === "keeper"
               ? "Publish again with the override ticked and a reason, and it will be recorded as an override."
               : "Only a keeper can override this.") + " Nothing was published."
    }, 409);
  }
  if (running && (moved.length || poolMoved) && body.override && who.role !== "keeper") {
    return json({ ok: false, code: "role", error: "Only a keeper can override the cycle lock. Nothing was published." }, 403);
  }
  const overrode = running && (moved.length || poolMoved) && body.override;

  /* The record is rebuilt here, not accepted from the browser. Published
     entries come from the committed file; new ones are stamped with the
     identity this code resolved from the token. Whatever the client sent in
     `by` is discarded. */
  const stamp = who.name + (who.alliance ? " (" + who.alliance + ")" : "");
  const nowIso = new Date().toISOString();
  const rebuilt = {
    ...next,
    log: (prev.log || []).concat(
      check.added.map(e => ({
        date: String(e.date || nowIso.slice(0, 10)),
        kind: String(e.kind || "Note"),
        text: String(e.text || ""),
        by: stamp,
        at: nowIso
      })),
      overrode ? [{
        date: nowIso.slice(0, 10), kind: "Override", by: stamp, at: nowIso,
        text: "Cycle lock overridden mid-cycle — " + note
      }] : [],
      [{ date: nowIso.slice(0, 10), kind: "Published", text: note, by: stamp, at: nowIso }]
    )
  };

  const fpBefore = fingerprint(prev);
  const fpAfter = fingerprint(rebuilt);
  rebuilt.published = nowIso.slice(0, 10);
  rebuilt.publishedBy = stamp;
  rebuilt.previousFingerprint = fpBefore;

  const put = await gh("/contents/" + encodeURIComponent(path), {
    method: "PUT",
    body: JSON.stringify({
      message: note + "\n\nPublished by " + stamp + "\nRegister " + fpBefore + " → " + fingerprint(rebuilt),
      content: b64(spliceRegister(file, rebuilt)),
      sha: cur.body.sha,
      branch,
      author: {
        name: who.name,
        email: (who.alliance || "editor").replace(/[^A-Za-z0-9]+/g, "").toLowerCase() + "@server75.invalid"
      }
    })
  });

  if (!put.ok) {
    const why = put.status === 409
      ? "GitHub says the file moved while this was publishing. Reload and try again."
      : "GitHub refused the commit (" + put.status + ").";
    return json({ ok: false, error: why + " Nothing was published." }, 502);
  }

  return json({
    ok: true,
    fingerprint: fingerprint(rebuilt),
    previous: fpBefore,
    by: stamp,
    overrode: !!overrode,
    commit: put.body && put.body.commit ? put.body.commit.html_url : null,
    note: "Netlify redeploys from the commit. The live page catches up in about a minute."
  });
}

/* ---------- reading a map screenshot ----------
 *
 * The model is never asked to spell anything. It is handed the 87 city names
 * and the 17 alliance tags that exist, and asked to choose from them. Anything
 * it returns that is not on those lists is dropped here, not shown to a person
 * as though it were a finding. Half these tags are spelled with stroked and
 * accented letters that vision models reliably mangle, so a closed list is the
 * difference between a useful tool and a confident liar.
 *
 * Nothing this endpoint returns is written to the register. It comes back as a
 * proposal for someone to tick.
 */
async function handleImport(request) {
  const key = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ ok: false, code: "setup", error: "No ANTHROPIC_API_KEY on this site, so the Import tab is switched off." }, 503);

  let body = {};
  try { body = await request.json(); } catch {
    return json({ ok: false, error: "That request was not JSON." }, 400);
  }
  const who = whoIs(body.token || "");
  if (!who) return json({ ok: false, error: "That token is not on the editor list." }, 401);

  const images = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
  if (!images.length) return json({ ok: false, error: "No images were attached." }, 400);

  const cities = Array.isArray(body.cities) ? body.cities : [];
  const tags = Array.isArray(body.tags) ? body.tags : [];
  if (!cities.length || !tags.length) return json({ ok: false, error: "The page did not send the city and alliance lists." }, 400);

  const cityNames = cities.map(c => c.name);
  const known = new Map(cities.map(c => [c.name, c]));
  const tagSet = new Set(tags);

  const system =
    "You are reading screenshots of the world map in a mobile strategy game, to check them against a register of who holds which city.\n\n" +
    "RULES:\n" +
    "1. Only ever choose city names from CITIES and alliance tags from ALLIANCES. Never invent, correct, translate or re-spell either. If what you see resembles nothing on the lists, put it in `unreadable` verbatim and move on.\n" +
    "2. Report a change only where you can actually read the holder tag. Blurry, cropped or partly covered is not a reading — say nothing rather than guess.\n" +
    "3. `notSeen` must list every city from CITIES you did not clearly see in these images. An absence is not a vacancy; it means the image did not cover it.\n" +
    "4. Reply with JSON only. No prose, no markdown fences.\n\n" +
    "SHAPE:\n" +
    '{"changes":[{"city":"<from CITIES>","to":"<from ALLIANCES, or \"\" if unclaimed>","confidence":"high|low","note":"<what you saw>"}],' +
    '"notSeen":["<from CITIES>"],"unreadable":["<verbatim>"]}\n\n' +
    "CITIES:\n" + cityNames.join("\n") + "\n\nALLIANCES:\n" + tags.join("\n") + "\n\n" +
    "CURRENT REGISTER (city = holder):\n" +
    cities.map(c => c.name + " = " + (c.holder || "unclaimed")).join("\n");

  const content = images.map(im => ({
    type: "image",
    source: { type: "base64", media_type: String(im.media_type || "image/png"), data: String(im.data || "") }
  }));
  content.push({ type: "text", text: String(body.hint || "Compare these against the register and report only what differs.") });

  let data;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: Netlify.env.get("IMPORT_MODEL") || IMPORT_DEFAULT_MODEL,
        max_tokens: 4000,
        system,
        messages: [{ role: "user", content }]
      })
    });
    if (!res.ok) {
      const t = await res.text();
      return json({ ok: false, error: "The reading service returned " + res.status + ". " + t.slice(0, 200) }, 502);
    }
    data = await res.json();
  } catch (e) {
    return json({ ok: false, error: "Could not reach the reading service." }, 502);
  }

  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  let parsed;
  try { parsed = JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()); }
  catch { return json({ ok: false, error: "The reading came back in a shape this page could not use. Nothing was changed." }, 502); }

  /* Everything below this line is the model being checked, not trusted. */
  const accepted = [], rejected = [];
  for (const c of (Array.isArray(parsed.changes) ? parsed.changes : [])) {
    const city = known.get(c && c.city);
    if (!city) { rejected.push({ why: "no such city", raw: c && c.city }); continue; }
    const to = String((c && c.to) || "");
    if (to && !tagSet.has(to)) { rejected.push({ why: "no such alliance", raw: to, city: city.name }); continue; }
    if ((city.holder || "") === to) continue;
    accepted.push({
      city: city.name, id: city.id, level: city.level,
      from: city.holder || "", to,
      confidence: c.confidence === "high" ? "high" : "low",
      note: String(c.note || "").slice(0, 160)
    });
  }
  const notSeen = (Array.isArray(parsed.notSeen) ? parsed.notSeen : []).filter(n => known.has(n));

  return json({
    ok: true,
    by: who.name,
    changes: accepted,
    notSeen,
    coverage: cityNames.length - notSeen.length,
    total: cityNames.length,
    unreadable: (Array.isArray(parsed.unreadable) ? parsed.unreadable : []).slice(0, 20).map(String),
    rejected
  });
}

function handleHealth() {
  let editors = 0, keepers = 0;
  try {
    const m = JSON.parse(Netlify.env.get("EDITORS") || "{}");
    editors = Object.keys(m).length;
    keepers = Object.keys(m).filter(k => m[k] && m[k].role === "keeper").length;
  } catch { editors = -1; }
  return json({
    ok: true,
    gate: "register-v1",
    github: !!Netlify.env.get("GITHUB_TOKEN") && !!Netlify.env.get("GITHUB_REPO"),
    branch: Netlify.env.get("GITHUB_BRANCH") || "main",
    path: Netlify.env.get("GITHUB_PATH") || "index.html",
    editors: editors < 0 ? "EDITORS is not valid JSON" : editors,
    keepers: editors < 0 ? null : keepers,
    officers: editors < 0 ? null : editors - keepers,
    repo: Netlify.env.get("GITHUB_REPO") || null,
    imports: !!Netlify.env.get("ANTHROPIC_API_KEY"),
    importModel: Netlify.env.get("IMPORT_MODEL") || IMPORT_DEFAULT_MODEL
  });
}

export default async function registerGate(request) {
  const url = new URL(request.url);
  const p = url.pathname;

  if (p === "/api/health") return handleHealth();
  if (p === "/api/whoami") {
    if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
    return handleWhoami(request);
  }
  if (p === "/api/import") {
    if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
    return handleImport(request);
  }
  if (p === "/api/publish") {
    if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
    return handlePublish(request);
  }
  return json({ ok: false, error: "No such endpoint." }, 404);
}

export const config = { path: "/api/*" };
