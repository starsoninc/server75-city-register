/* ============================================================================
   Server 75 City Register — weekly KvK collector (k1)

   A Netlify scheduled function. Once a week, after Saturday's KvK, it reads a
   few public lastasylum.gg pages and records, per alliance on server 75:
   members, power, and each player's total kills. The difference between two
   weekly readings is "kills gained that week" — a stand-in for who fought in
   KvK. It is NOT KvK points; the site does not publish those.

   It writes exactly one file: data/kvk.json in this repo, through the GitHub
   token the register already uses. Every write is a commit, so the KvK record
   has the same audit trail as the register itself.

   HOW IT BEHAVES, and why:
   - It runs every hour and almost always does nothing. A reading is due once
     per week: from Sunday 05:00 (Berlin) after a KvK Saturday, or straight
     away if there has never been one, so the first reading becomes the
     baseline for the next KvK.
   - A reading is about 15 pages. Scheduled functions get 30 seconds, so the
     pages are read a few per run, one at a time with a pause, and the reading
     finishes over several hourly runs. Progress is kept in the file.
   - It reads robots.txt before fetching anything and obeys it. Today the site
     keeps scripts out of /api/ and allows the pages read here. If that
     changes, the page is skipped and the status says so. Nothing tries a way
     around it.
   - It refuses rather than guesses. A page whose table does not look the way
     this was written for is not used, and the reason is kept in the file's
     status. The page parser is the dashboard collector's (c4), which was
     checked against the real pages.
   - Kills are counted per player, then summed by the alliance the player is
     in at the second reading. A player needs both readings to count, so a
     player who joins an alliance never brings their career kills with them.
     A total that went down is left out. Absence is "not known", never zero.

   ENVIRONMENT (already set for the register):
     GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH (default main)
   Optional:
     KVK_DRY_RUN=1     fetch and parse, log what would be written, write nothing
     KVK_CONTACT       an email or Discord handle, sent in the User-Agent so the
                       site owner can reach whoever runs this
   ========================================================================= */

export const VERSION = "k2";
const BASE = "https://lastasylum.gg";
const LANG = "/en";
export const SERVER = 75;
const DATA_PATH = "data/kvk.json";
const UA_TOKEN = "Server75CityRegister";
const TZ = "Europe/Berlin";

const MAX_ALLIANCES = 14;          // top alliances by kills on the server
const MIN_ALLIANCE_KILLS = 1000000; // smaller tags are left out
const PAUSE_MS = 1200;
const FETCH_TIMEOUT_MS = 7000;
const RUN_BUDGET_MS = 15000;       // stop starting new pages after this
const MAX_BYTES = 3000000;
const RETRY_AFTER_HOURS = 3;
const KEEP_WEEKS = 104;
const KEEP_ERRORS = 20;

/* ═══════════════════════════════ clock ════════════════════════════════════ */

/* The Berlin wall clock for an instant. */
export function berlin(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23"
  }).formatToParts(new Date(ms));
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[g("weekday")];
  return { date: g("year") + "-" + g("month") + "-" + g("day"), dow, hour: Number(g("hour")), minute: Number(g("minute")) };
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

/* The instant a Berlin wall-clock time happens (handles summer time). */
export function berlinInstant(isoDate, hour, minute) {
  const [y, m, d] = isoDate.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d, hour, minute || 0);
  for (let i = 0; i < 3; i++) {
    const b = berlin(guess);
    const shown = Date.UTC(...b.date.split("-").map((v, k) => (k === 1 ? Number(v) - 1 : Number(v))), b.hour, b.minute);
    const want = Date.UTC(y, m - 1, d, hour, minute || 0);
    if (shown === want) break;
    guess += want - shown;
  }
  return guess;
}

/* The most recent KvK Saturday at or before this instant (Berlin). */
export function lastSaturday(ms) {
  const b = berlin(ms);
  const back = b.dow === 6 ? 0 : b.dow === 7 ? 1 : b.dow + 1;
  return addDays(b.date, -back);
}

/* KvK starts Saturday 16:00 Berlin. Every KvK that started after `fromMs` and
   by `toMs`: those are the matches a reading pair covers. */
export function kvkBetween(fromMs, toMs) {
  const out = [];
  let sat = lastSaturday(toMs);
  for (let i = 0; i < 60; i++) {
    const start = berlinInstant(sat, 16, 0);
    if (start <= fromMs) break;
    if (start <= toMs) out.unshift(sat);
    sat = addDays(sat, -7);
  }
  return out;
}

/* Is a reading due? Once there is a reading, the next is due from Sunday
   05:00 after a KvK that the latest reading does not yet cover. */
export function readingDue(data, nowMs) {
  const fail = data.collector && data.collector.failAt ? Date.parse(data.collector.failAt) : NaN;
  if (isFinite(fail) && nowMs - fail < RETRY_AFTER_HOURS * 3600000) return { due: false, why: "waiting after a failed run" };
  if (data.pending) return { due: true, why: "a reading is in progress" };
  const last = data.latest && data.latest.at ? Date.parse(data.latest.at) : NaN;
  if (!isFinite(last)) return { due: true, why: "no reading yet — this one becomes the baseline" };
  const sat = lastSaturday(nowMs);
  const after = berlinInstant(addDays(sat, 1), 5, 0);
  if (nowMs >= after && last < after) return { due: true, why: "the KvK of " + sat + " is not covered yet" };
  return { due: false, why: "nothing due" };
}

/* ═══════════════════════════════ robots.txt ═══════════════════════════════ */

export function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  String(text || "").split(/\r?\n/).forEach((line) => {
    const l = line.replace(/#.*$/, "").trim();
    if (!l) return;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(l);
    if (!m) return;
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (!cur) return;
    if ((field === "allow" || field === "disallow") && value) cur.rules.push({ allow: field === "allow", path: value });
  });
  return groups;
}

function robotsMatch(pattern, path) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = "^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : "");
  return new RegExp(re).test(path);
}

/* Stricter than the standard on purpose: a path closed in ANY group that
   applies to us (the "*" group or one naming us) counts as closed. */
export function robotsAllows(groups, agents, path) {
  const mine = agents.map((a) => a.toLowerCase());
  const applicable = groups.filter((g) => g.agents.some((a) => a === "*" || mine.some((m) => m.includes(a) || a.includes(m))));
  for (const g of applicable) {
    let best = null;
    g.rules.forEach((r) => {
      if (!robotsMatch(r.path, path)) return;
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    });
    if (best && !best.allow) return false;
  }
  return true;
}

/* ═══════════════════════════════ HTML ═════════════════════════════════════
   Ported unchanged in behaviour from the dashboard collector (c4). */

function chr(code) {
  if (!isFinite(code) || code < 0 || code > 0x10ffff) return "";
  return String.fromCodePoint(code);
}
function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => chr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => chr(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function textOf(html) {
  return decode(String(html)
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t\r\n\f ]+/g, " ").trim();
}
function hrefsOf(html) {
  const out = [], re = /href\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(html))) out.push(decode(m[2] !== undefined ? m[2] : m[3]));
  return out;
}
function header(text) {
  return String(text).replace(/[▲▼↑↓⇅]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
export function tables(html) {
  html = String(html).replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const out = [];
  const tre = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let t;
  while ((t = tre.exec(html))) {
    const rows = [];
    const rre = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let r;
    while ((r = rre.exec(t[1]))) {
      const cells = [];
      const cre = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let c;
      while ((c = cre.exec(r[1]))) cells.push({ th: c[1].toLowerCase() === "th", text: textOf(c[2]), hrefs: hrefsOf(c[2]) });
      if (cells.length) rows.push(cells);
    }
    let headers = null;
    const body = [];
    rows.forEach((row) => {
      if (!headers && row.every((c) => c.th)) headers = row.map((c) => header(c.text));
      else body.push(row);
    });
    out.push({ headers: headers || [], rows: body });
  }
  return out;
}
function findTable(ts, required) {
  for (const t of ts) {
    const col = {};
    if (required.every((name) => { const at = t.headers.indexOf(name); if (at === -1) return false; col[name] = at; return true; })) return { table: t, col };
  }
  return null;
}
export function int(text) {
  const t = String(text || "").replace(/[\s  ]/g, "");
  if (!/^\d+$/.test(t) && !/^\d{1,3}(,\d{3})+$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return isFinite(n) ? n : null;
}
function count(text) {
  const t = String(text || "").trim();
  if (t === "-" || t === "–" || t === "—" || t === "") return { value: null, ok: true };
  const n = int(t);
  return n === null ? { value: null, ok: false } : { value: n, ok: true };
}
function idFrom(hrefs, kind) {
  const re = new RegExp("/leaderboard/" + kind + "/(\\d+)");
  for (const h of hrefs) { const m = re.exec(h); if (m) return m[1]; }
  return null;
}
function tagName(text) {
  const m = /^\[([^\]]*)\]\s*([\s\S]*)$/.exec(String(text || "").trim());
  return m ? { tag: m[1].trim(), name: m[2].trim() } : { tag: "", name: String(text || "").trim() };
}
function title(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? textOf(m[1]) : "";
}
function refuse(error) { return { ok: false, error }; }
function serverInTitle(html, server) {
  const m = /server\s*#(\d+)/i.exec(title(html));
  if (m && Number(m[1]) !== Number(server)) return "the page is for server #" + m[1] + ", not #" + server;
  return null;
}

/* Server 75's alliances by kills: which alliance pages to read. */
export function parseAllianceList(html) {
  const wrong = serverInTitle(html, SERVER);
  if (wrong) return refuse(wrong);
  const found = findTable(tables(html), ["#", "alliance", "kills"]);
  if (!found) return refuse("no table with the columns #, alliance, kills — the page layout has changed");
  const { col } = found;
  const rows = [], bad = [];
  found.table.rows.forEach((cells, i) => {
    const rank = int(cells[col["#"]] && cells[col["#"]].text);
    const ac = cells[col.alliance];
    const aid = ac ? idFrom(ac.hrefs, "alliance") : null;
    const tn = tagName(ac ? ac.text : "");
    const kills = int(cells[col.kills] && cells[col.kills].text);
    if (!rank || !aid || kills === null) { bad.push(i + 1); return; }
    rows.push({ rank, aid, tag: tn.tag, name: tn.name, kills });
  });
  if (bad.length) return refuse(bad.length + " row(s) could not be read (rows " + bad.slice(0, 5).join(", ") + ")");
  if (!rows.length) return refuse("the alliance list is empty");
  for (let i = 0; i < rows.length; i++) if (rows[i].rank !== i + 1) return refuse("rank " + (i + 1) + " is missing or out of place");
  return { ok: true, rows };
}

const ALLIANCE_COLS = ["#", "player", "rank", "power", "kills", "castle", "activity", "joined"];

/* One alliance page: every member with id, power and kills. */
export function parseAlliance(html) {
  const found = findTable(tables(html), ALLIANCE_COLS);
  if (!found) return refuse("no member table with the columns " + ALLIANCE_COLS.join(", ") + " — the page layout has changed");
  const { col } = found;
  const rows = [], bad = [];
  found.table.rows.forEach((cells, i) => {
    if (cells.length < ALLIANCE_COLS.length) return;
    const pc = cells[col.player];
    const name = pc.text, pid = idFrom(pc.hrefs, "player");
    const rank = String(cells[col.rank].text).trim().toUpperCase();
    const power = int(cells[col.power].text);
    const kills = count(cells[col.kills].text);
    const problems = [];
    if (!name) problems.push("no name");
    if (!pid) problems.push("no player link");
    if (!/^R[1-5]$/.test(rank)) problems.push('rank "' + cells[col.rank].text + '"');
    if (!power || power <= 0) problems.push('power "' + cells[col.power].text + '"');
    if (!kills.ok) problems.push('kills "' + cells[col.kills].text + '"');
    if (problems.length) { bad.push("row " + (i + 1) + (name ? " (" + name + ")" : "") + ": " + problems.join(", ")); return; }
    rows.push({ pid, name, power, kills: kills.value });
  });
  if (bad.length) return refuse(bad.length + " row(s) could not be read — " + bad.slice(0, 3).join("; "));
  if (!rows.length) return refuse("the member table is empty");
  if (rows.length > 100) return refuse(rows.length + " members is more than an alliance can hold");
  const seen = new Set();
  for (const r of rows) { if (seen.has(r.pid)) return refuse("player id " + r.pid + " is listed twice"); seen.add(r.pid); }
  const ttl = title(html);
  const srv = /server\s*#(\d+)/i.exec(ttl);
  if (srv && Number(srv[1]) !== SERVER) return refuse("this alliance is now on server #" + srv[1] + ", not #" + SERVER);
  const tn = tagName((/^(\[[^\]]*\][^·]*)/.exec(ttl) || [])[1] || "");
  const text = textOf(html);
  const sm = /(\d[\d,]*)\s*Power\s*(\d[\d,]*)\s*Members\s*(\d[\d,]*)\s*Alliance level\s*(\d[\d,]*)\s*Kills/i.exec(text);
  const summary = sm ? { power: int(sm[1]), members: int(sm[2]), kills: int(sm[4]) } : null;
  if (summary && summary.members !== null && summary.members !== rows.length) {
    return refuse("the page says " + summary.members + " members but " + rows.length + " rows were read");
  }
  return {
    ok: true, rows, tag: tn.tag, name: tn.name,
    power: summary && summary.power !== null ? summary.power : rows.reduce((s, r) => s + r.power, 0),
    warnings: [srv ? null : "the page title does not name the server", summary ? null : "no summary above the table to cross-check the member count"].filter(Boolean)
  };
}

/* One Saturday's Royal City captures, kept only where #75 is involved. */
export function parseCaptures(html) {
  const found = findTable(tables(html), ["royal city", "taken by", "alliance", "king of battle"]);
  if (!found) return refuse("no capture table with the expected columns — the page layout has changed");
  const { col } = found;
  const rows = [];
  let bad = 0;
  found.table.rows.forEach((cells) => {
    const city = /#(\d+)/.exec(cells[col["royal city"]].text);
    const by = /#(\d+)/.exec(cells[col["taken by"]].text);
    if (!city || !by) { bad++; return; }
    const tn = tagName(cells[col.alliance].text);
    rows.push({ city: Number(city[1]), takenBy: Number(by[1]), tag: tn.tag, alliance: tn.name, king: cells[col["king of battle"]].text });
  });
  if (bad) return refuse(bad + " row(s) could not be read");
  return { ok: true, rows: rows.filter((r) => r.city === SERVER || r.takenBy === SERVER), total: rows.length };
}

/* ═══════════════════════════════ the record ═══════════════════════════════ */

/* Which alliance pages a reading covers: the server's biggest by kills. */
export function chooseAlliances(list) {
  return list.filter((r) => r.kills >= MIN_ALLIANCE_KILLS).slice(0, MAX_ALLIANCES)
    .map((r) => ({ aid: r.aid, tag: r.tag, name: r.name }));
}

/* A finished reading compared with the one before it: per alliance, kills
   gained by players read both times, summed by the alliance they are in now.
   k2: killsBefore is those same players' kill total at the first reading, so
   kills / killsBefore is the alliance's kill growth over the week, counted on
   exactly the players it is measured on. */
export function weekFrom(prev, cur) {
  const kvk = kvkBetween(Date.parse(prev.at), Date.parse(cur.at));
  const alliances = {};
  Object.keys(cur.alliances).forEach((aid) => {
    const a = cur.alliances[aid];
    const was = prev.alliances[aid];
    alliances[aid] = { tag: a.tag, name: a.name, members: a.members, power: a.power,
      powerBefore: was ? was.power : null, kills: 0, killsBefore: 0, fighters: 0, readBoth: 0, odd: 0 };
  });
  Object.keys(cur.players).forEach((pid) => {
    const [aid, kNow] = cur.players[pid];
    const before = prev.players[pid];
    const row = alliances[aid];
    if (!row) return;
    if (!before || typeof before[1] !== "number" || typeof kNow !== "number") return;
    const d = kNow - before[1];
    if (d < 0) { row.odd++; return; }
    row.readBoth++;
    row.kills += d;
    row.killsBefore += before[1];
    if (d > 0) row.fighters++;
  });
  return { from: prev.at, to: cur.at, kvk, alliances };
}

export function emptyData() {
  return { v: 1, server: SERVER, matches: [], weeks: [], latest: null, pending: null, captures: {}, collector: {} };
}

/* ═══════════════════════════════ one run ══════════════════════════════════ */

function env(name) {
  try { if (typeof Netlify !== "undefined" && Netlify.env) { const v = Netlify.env.get(name); if (v !== undefined) return v; } } catch (e) { /* not on Netlify */ }
  return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
}

function userAgent() {
  const contact = (env("KVK_CONTACT") || "").trim();
  return UA_TOKEN + "/1.0 (server " + SERVER + " city register; weekly script, about 15 pages a week" + (contact ? "; contact: " + contact : "") + ")";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(path, fetchImpl) {
  const res = await fetchImpl(BASE + path, {
    headers: { "user-agent": userAgent(), accept: "text/html,text/plain" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  const body = await res.text();
  return { code: res.status, body: body.length > MAX_BYTES ? "" : body, tooBig: body.length > MAX_BYTES };
}

/* Does the work for one run against `data` (changed in place) and says what
   happened. Pure apart from fetchImpl and the clock, so tests can drive it. */
export async function runOnce(data, opts) {
  const nowMs = opts.now;
  const fetchImpl = opts.fetch;
  const pause = opts.pauseMs === undefined ? PAUSE_MS : opts.pauseMs;
  const started = Date.now();
  const report = { at: new Date(nowMs).toISOString(), version: VERSION, pages: [], notes: [], changed: false };
  data.collector = data.collector || {};
  data.captures = data.captures || {};
  data.weeks = data.weeks || [];

  const due = readingDue(data, nowMs);
  report.due = due.why;
  if (!due.due) return report;

  const fail = (msg) => {
    report.ok = false;
    report.notes.push(msg);
    data.collector.failAt = report.at;
    const errs = (data.collector.errors || []).concat([{ at: report.at, error: msg }]);
    data.collector.errors = errs.slice(-KEEP_ERRORS);
    data.collector.lastRun = { at: report.at, ok: false, note: msg };
    report.changed = true;
    return report;
  };

  // robots.txt, every run that fetches
  let rules;
  try {
    const r = await fetchPage("/robots.txt", fetchImpl);
    if (r.code === 200) rules = parseRobots(r.body);
    else if (r.code === 404) rules = [];
    else return fail("robots.txt answered HTTP " + r.code + " — nothing was read");
  } catch (e) {
    return fail("robots.txt could not be fetched (" + String(e).slice(0, 120) + ") — nothing was read");
  }
  const agents = [UA_TOKEN];
  let fetched = 0;
  const get = async (path) => {
    if (!robotsAllows(rules, agents, path)) return { closed: true };
    if (fetched > 0 && pause) await sleep(pause);
    fetched++;
    try { return await fetchPage(path, fetchImpl); }
    catch (e) { return { error: "could not be fetched: " + String(e).slice(0, 140) }; }
  };
  const pageError = (r) => r.closed ? "closed to scripts by robots.txt — skipped" : r.error ? r.error :
    r.code !== 200 ? "HTTP " + r.code : r.tooBig ? "page too large — not read" : null;

  // Start a reading: the alliance list decides which pages it covers.
  if (!data.pending) {
    const path = LANG + "/leaderboard/servers/" + SERVER + "/alliance-kills";
    const r = await get(path);
    const err = pageError(r);
    report.pages.push({ path, ok: !err, error: err || undefined });
    if (err) return fail("alliance list: " + err);
    const list = parseAllianceList(r.body);
    if (!list.ok) return fail("alliance list: " + list.error);
    const chosen = chooseAlliances(list.rows);
    const queue = chosen.map((a) => ({ type: "alliance", aid: a.aid, tag: a.tag, name: a.name }));
    const sat = lastSaturday(nowMs);
    if (data.latest && !data.captures[sat]) queue.push({ type: "captures", sat });
    data.pending = { startedAt: report.at, queue, alliances: {}, players: {}, skipped: [] };
    report.notes.push("started a reading of " + chosen.length + " alliance pages");
  }

  const p = data.pending;
  while (p.queue.length && Date.now() - started < RUN_BUDGET_MS) {
    const item = p.queue[0];
    if (item.type === "alliance") {
      const path = LANG + "/leaderboard/alliance/" + item.aid;
      const r = await get(path);
      const err = pageError(r);
      if (err && !r.closed && (r.error || r.code === 429 || r.code >= 500)) {
        report.pages.push({ path, ok: false, error: err });
        return fail(path + ": " + err + " — the reading continues in " + RETRY_AFTER_HOURS + " hours");
      }
      p.queue.shift();
      if (err) { p.skipped.push({ aid: item.aid, tag: item.tag, why: err }); report.pages.push({ path, ok: false, error: err }); continue; }
      const out = parseAlliance(r.body);
      if (!out.ok) { p.skipped.push({ aid: item.aid, tag: item.tag, why: out.error }); report.pages.push({ path, ok: false, error: out.error }); continue; }
      p.alliances[item.aid] = { tag: out.tag || item.tag, name: out.name || item.name, members: out.rows.length, power: out.power };
      out.rows.forEach((row) => { p.players[row.pid] = [item.aid, row.kills, row.power]; });
      report.pages.push({ path, ok: true, rows: out.rows.length, warnings: out.warnings.length ? out.warnings : undefined });
    } else if (item.type === "captures") {
      const path = LANG + "/leaderboard/kings/kvk?w=" + item.sat;
      const r = await get(path);
      const err = pageError(r);
      p.queue.shift();
      if (err) { report.pages.push({ path, ok: false, error: err }); continue; }
      const out = parseCaptures(r.body);
      if (!out.ok) { report.pages.push({ path, ok: false, error: out.error }); continue; }
      data.captures[item.sat] = { readAt: report.at, rows: out.rows };
      report.pages.push({ path, ok: true, rows: out.rows.length });
    } else {
      p.queue.shift();
    }
  }
  report.changed = true;

  if (p.queue.length) {
    report.notes.push(p.queue.length + " page(s) left for the next run");
    data.collector.lastRun = { at: report.at, ok: true, note: "reading in progress, " + p.queue.length + " left" };
    return Object.assign(report, { ok: true });
  }

  // Finished.
  const read = Object.keys(p.alliances).length;
  if (!read) {
    data.pending = null;
    return fail("no alliance page could be read — " + p.skipped.map((s) => s.tag + ": " + s.why).slice(0, 3).join("; "));
  }
  const cur = { at: p.startedAt, finishedAt: report.at, alliances: p.alliances, players: p.players, skipped: p.skipped };
  if (data.latest && data.latest.players) {
    data.weeks.push(weekFrom(data.latest, cur));
    data.weeks = data.weeks.slice(-KEEP_WEEKS);
    report.notes.push("week recorded: " + data.weeks[data.weeks.length - 1].kvk.join(", "));
  } else {
    report.notes.push("baseline reading stored; the first week appears after the next KvK");
  }
  data.latest = cur;
  data.pending = null;
  delete data.collector.failAt;
  data.collector.lastRun = { at: report.at, ok: true, note: "reading finished: " + read + " alliances" + (p.skipped.length ? ", " + p.skipped.length + " skipped" : "") };
  data.collector.lastOkAt = report.at;
  report.ok = true;
  return report;
}

/* ═══════════════════════════════ GitHub ═══════════════════════════════════ */

async function gh(path, init) {
  const res = await fetch("https://api.github.com/repos/" + env("GITHUB_REPO") + path, {
    ...init,
    headers: {
      authorization: "Bearer " + env("GITHUB_TOKEN"),
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "server75-city-register-kvk"
    }
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* leave null */ }
  return { ok: res.ok, status: res.status, body };
}

async function readData(branch) {
  const r = await gh("/contents/" + DATA_PATH + "?ref=" + encodeURIComponent(branch));
  if (r.status === 404) return { data: emptyData(), sha: null };
  if (!r.ok) throw new Error("GitHub read failed: HTTP " + r.status);
  const raw = Buffer.from(String(r.body.content || "").replace(/\n/g, ""), "base64").toString("utf8");
  return { data: JSON.parse(raw), sha: r.body.sha };
}

async function writeData(data, sha, branch, message) {
  const content = Buffer.from(JSON.stringify(data, null, 1) + "\n", "utf8").toString("base64");
  const r = await gh("/contents/" + DATA_PATH, {
    method: "PUT",
    body: JSON.stringify({ message, content, branch, ...(sha ? { sha } : {}) })
  });
  if (!r.ok) throw new Error("GitHub write failed: HTTP " + r.status + (r.body && r.body.message ? " — " + r.body.message : ""));
}

export function commitMessage(report, data) {
  if (data.pending) return "KvK data: reading in progress (" + data.pending.queue.length + " pages left)";
  if (report.ok === false) return "KvK data: collector run failed — " + (report.notes[0] || "see status");
  const w = data.weeks[data.weeks.length - 1];
  return w && w.to === (data.latest && data.latest.at) ? "KvK data: week recorded (" + (w.kvk.join(", ") || "no KvK in range") + ")" : "KvK data: baseline reading stored";
}

export default async function kvkCollect() {
  const branch = env("GITHUB_BRANCH") || "main";
  const dry = env("KVK_DRY_RUN") === "1";
  if (!env("GITHUB_TOKEN") || !env("GITHUB_REPO")) {
    console.log("kvk-collect: GITHUB_TOKEN or GITHUB_REPO is not set — nothing done");
    return new Response("not configured", { status: 500 });
  }
  let file;
  try { file = await readData(branch); }
  catch (e) { console.log("kvk-collect: " + e.message); return new Response(e.message, { status: 502 }); }

  const report = await runOnce(file.data, { now: Date.now(), fetch });
  console.log("kvk-collect " + VERSION + (dry ? " DRY RUN" : "") + ": " + report.due);
  report.pages.forEach((pg) => console.log("  " + (pg.ok ? "ok   " : "FAIL ") + pg.path + (pg.rows !== undefined ? " — " + pg.rows + " rows" : "") + (pg.error ? " — " + pg.error : "") + (pg.warnings ? " — note: " + pg.warnings.join("; ") : "")));
  report.notes.forEach((n) => console.log("  note: " + n));

  if (!report.changed) return new Response("nothing due", { status: 200 });
  if (dry) {
    const w = file.data.weeks[file.data.weeks.length - 1];
    if (file.data.latest && !file.data.pending) {
      Object.values(file.data.latest.alliances).slice(0, 14).forEach((a) => console.log("  [" + a.tag + "] " + a.members + " members, power " + a.power));
    }
    if (w) console.log("  latest week: " + JSON.stringify(w).slice(0, 600));
    console.log("DRY RUN — nothing was written.");
    return new Response("dry run", { status: 200 });
  }
  try {
    await writeData(file.data, file.sha, branch, commitMessage(report, file.data));
    console.log("  written: " + DATA_PATH);
  } catch (e) {
    console.log("kvk-collect: " + e.message + " — this run's reading is lost and will be repeated");
    return new Response(e.message, { status: 502 });
  }
  return new Response("ok", { status: 200 });
}

/* Every hour at :17. Almost every run returns at once; see readingDue. */
export const config = { schedule: "17 * * * *" };
