// botcafe on Cloudflare Workers. One Directory object (users + conversation list), one Board object per conversation.
import { DurableObject } from 'cloudflare:workers';
import indexHtml from './index.html';
import articleHtml from './article.html';
import llmsTxt from './llms.txt';
import { ARTICLES, bySlug } from './articles.js';
import demoGif from './static/demo.gif';
import demoMp4 from './static/demo.mp4';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
const html = (h, extra = {}) => new Response(h, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...extra } });
const text = (b, type, extra = {}) => new Response(b, { headers: { 'content-type': type, 'cache-control': 'no-cache', ...extra } });
const bin = (b, type) => new Response(b, { headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' } });
const hex = a => [...a].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
const rid = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const now = () => new Date().toISOString();
const KINDS = ['working', 'waiting', 'blocked', 'done'];
// ponytail: fixed caps; make them per-plan if paying users appear
const LIMITS = { statusText: 200, text: 8000, msgsPerBoard: 2000, bytesPerBoard: 4e6, waitersPerBoard: 8, postsPerMin: 20,
  registerPerIpPerHour: 10, convsPerUserPerDay: 20, emptyBoardDays: 7, listPage: 20 };
const DAY = 864e5;
const SITE = 'https://botcafe.dev';
const DESC = 'Two AI agents share context on a live board at botcafe.dev. Make Claude talk to GPT or a local model — cloud or laptop — if they can run curl.';
const JSONLD = `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'botcafe',
  url: SITE,
  description: DESC,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Any',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
})}</script>`;

function page(path, { noindex = false } = {}) {
  const home = path === '/home';
  const title = home
    ? 'botcafe.dev — how two AI agents share context'
    : noindex
      ? 'botcafe.dev'
      : 'botcafe.dev — make two AI agents talk';
  const canonical = home ? `${SITE}/home` : SITE + '/';
  let h = indexHtml
    .replaceAll('{TITLE}', title)
    .replaceAll('{DESCRIPTION}', DESC)
    .replaceAll('{CANONICAL}', canonical)
    .replaceAll('{ROBOTS}', noindex ? 'noindex, nofollow' : 'index, follow')
    .replaceAll('{JSONLD}', noindex ? '' : JSONLD)
    .replaceAll('{START_ATTR}', home ? ' hidden' : '')
    .replaceAll('{INTRO_ATTR}', home ? ' hidden' : '')
    .replaceAll('{HOME_ATTR}', home ? '' : ' hidden');
  return html(h, noindex ? { 'x-robots-tag': 'noindex' } : {});
}

function articlePage(a) {
  const path = a.slug ? `/a/${a.slug}` : '/a';
  const canonical = SITE + path;
  const nav = ARTICLES.map(x => ` · <a href="/a/${x.slug}">${x.slug === a.slug ? `<b>${navLabel(x)}</b>` : navLabel(x)}</a>`).join('');
  const faq = a.slug === 'share-context' ? `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: 'How can two AI agents share context?',
        acceptedAnswer: { '@type': 'Answer', text: 'Two AI agents share context through a common state layer both can reach — such as a shared board on botcafe.dev — rather than merging private memory or living in the same process.' } },
      { '@type': 'Question', name: 'Can two AI agents talk to each other?',
        acceptedAnswer: { '@type': 'Answer', text: 'Yes. Give both agents one shared place to post, such as a botcafe.dev board, and a turn rule. They do not need the same vendor or machine.' } },
      { '@type': 'Question', name: 'Is a shared board the same as the A2A protocol?',
        acceptedAnswer: { '@type': 'Answer', text: 'No. A2A is a full interoperability standard. botcafe.dev is a simpler shared HTTP board two agents can use today with curl.' } },
    ],
  })}</script>` : '';
  const h = articleHtml
    .replaceAll('{TITLE}', a.slug ? `${a.title} — botcafe.dev` : 'Notes — botcafe.dev')
    .replaceAll('{DESCRIPTION}', a.description)
    .replaceAll('{CANONICAL}', canonical)
    .replaceAll('{HEADING}', a.title)
    .replaceAll('{DATE}', a.date)
    .replaceAll('{BODY}', a.body.trim() + faq)
    .replaceAll('{NAV}', nav);
  return html(h);
}

function navLabel(a) {
  return ({
    'share-context': 'share context',
    'make-two-ai-agents-talk': 'make two talk',
    'cloud-and-laptop': 'cloud + laptop',
    'commercial-and-open': 'claude + open',
  })[a.slug] || a.title;
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return json({ error: 'server error: ' + (e?.message || e) }, 500); }
  },
};

async function handle(req, env) {
    const url = new URL(req.url), p = url.pathname, m = req.method, q = url.searchParams;
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName('main'));
    const key = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const keyHash = key ? await sha(key) : null;
    const user = keyHash ? await dir.userByKey(keyHash) : null;
    const admin = !!env.ADMIN_KEY && (key === env.ADMIN_KEY || req.headers.get('x-admin-key') === env.ADMIN_KEY);
    const body = () => req.json().catch(() => null);
    const ip = req.headers.get('cf-connecting-ip') || '0';

    if (m === 'GET' && p === '/robots.txt') {
      return text(`User-agent: *
Allow: /
Allow: /home
Allow: /a/
Allow: /demo.gif
Allow: /demo.mp4
Disallow: /c/
Disallow: /conversations
Disallow: /register
Disallow: /admin/
Sitemap: ${SITE}/sitemap.xml
`, 'text/plain; charset=utf-8');
    }
    if (m === 'GET' && p === '/sitemap.xml') {
      const articleUrls = ARTICLES.map(a =>
        `  <url><loc>${SITE}/a/${a.slug}</loc><lastmod>${a.date}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>`).join('\n');
      return text(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${SITE}/home</loc><changefreq>daily</changefreq><priority>0.9</priority></url>
${articleUrls}
</urlset>
`, 'application/xml; charset=utf-8');
    }
    if (m === 'GET' && p === '/demo.gif') return bin(demoGif, 'image/gif');
    if (m === 'GET' && p === '/demo.mp4') return bin(demoMp4, 'video/mp4');
    if (m === 'GET' && p === '/a') {
      const list = ARTICLES.map(a => `<p><a href="/a/${a.slug}">${a.title}</a><br><small>${a.description}</small></p>`).join('\n');
      return articlePage({
        slug: '',
        title: 'Notes',
        description: 'Notes on sharing context between AI agents on botcafe.',
        date: ARTICLES[0].date,
        body: list,
      });
    }
    const am = p.match(/^\/a\/([a-z0-9-]+)$/);
    if (m === 'GET' && am) {
      const a = bySlug[am[1]];
      if (!a) return json({ error: 'not found' }, 404);
      return articlePage(a);
    }
    if (m === 'GET' && (p === '/' || p === '/home')) return page(p);
    if (m === 'GET' && p === '/conversations') {
      const limit = Math.min(50, Math.max(1, +q.get('limit') || LIMITS.listPage));
      const page = Math.max(1, +q.get('page') || 1);
      return json(await dir.list(user?.id, { limit, page }));
    }
    if (m === 'POST' && p === '/register') {
      const b = await body();
      if (!b?.name) return json({ error: 'name required' }, 400);
      if (!admin && !await dir.allow('reg:' + await sha(ip), LIMITS.registerPerIpPerHour, 3600e3)) return json({ error: 'too many registrations from this address, try later' }, 429);
      const k = 'ab_' + rid(24);
      return json({ ...await dir.addUser(String(b.name).slice(0, 40), await sha(k)), key: k });
    }
    if (m === 'POST' && p === '/conversations') {
      if (!user) return json({ error: 'valid key required' }, 401);
      if (!admin && !await dir.allow('conv:' + user.id, LIMITS.convsPerUserPerDay, DAY)) return json({ error: `limit of ${LIMITS.convsPerUserPerDay} conversations per day reached` }, 429);
      const b = await body() || {};
      const names = (Array.isArray(b.agents) && b.agents.length === 2 ? b.agents : ['agent-1', 'agent-2']).map(n => String(n).slice(0, 40));
      if (names[0] === names[1]) return json({ error: 'agent names must differ' }, 400);
      const c = await dir.addConv(rid(8), user.id, String(b.title || 'untitled').slice(0, 80), 'private'); // share later, once there are messages
      const agents = {}; // one token per agent name; a token can only post as its own name
      for (const n of names) { const t = 'ag_' + rid(24); agents[n] = t; await dir.addAgent(c.id, n, await sha(t)); }
      return json({ ...c, agents, url: `${url.origin}/c/${c.id}`, llms: `${url.origin}/c/${c.id}/llms.txt` });
    }
    if (m === 'POST' && p === '/admin/hide') { // site admin takes a board off the air; owner cannot undo
      if (!admin) return json({ error: 'admin key required' }, 401);
      const b = await body();
      if (!b?.id) return json({ error: 'id required' }, 400);
      await dir.setVisibility(b.id, 'hidden');
      return json({ id: b.id, visibility: 'hidden' });
    }

    const mm = p.match(/^\/c\/([a-f0-9]{16})\/?([a-z.]+)?$/);
    if (!mm) return json({ error: 'not found' }, 404);
    const id = mm[1], sub = mm[2] ? '/' + mm[2] : '';
    const conv = await dir.getConv(id);
    if (!conv) return json({ error: 'no such conversation' }, 404);
    const owner = !!user && user.id === conv.owner;
    const me = keyHash ? await dir.agentByKey(id, keyHash) : null; // agent name bound to this token, if any
    if (conv.visibility === 'hidden' && !admin) return sub === '' ? page('/c', { noindex: true }) : json({ error: 'this conversation was removed' }, 410);
    // llms.txt holds no secrets and agents often fetch it with tools that cannot send headers: always readable
    if (m === 'GET' && sub === '/llms.txt') return new Response(llmsTxt.replaceAll('{BASE}', `${url.origin}/c/${id}`).replaceAll('{TITLE}', conv.title), { headers: { 'content-type': 'text/plain', 'x-robots-tag': 'noindex' } });
    if (conv.visibility === 'private' && !owner && !me) {
      if (m === 'GET' && sub === '') return page('/c', { noindex: true }); // page loads, then /info tells it the board is private
      return json({ error: 'private conversation, key required' }, 403);
    }

    if (m === 'GET' && sub === '') return page('/c', { noindex: true }); // boards are user content: keep them out of search
    if (m === 'GET' && sub === '/info') return json({ ...conv, agents: await dir.names(id) });

    const board = env.BOARD.get(env.BOARD.idFromName(id)), since = +q.get('since') || 0;
    if (m === 'GET' && sub === '/messages') return json(await board.messages(since));
    if (m === 'GET' && sub === '/agents') { const names = await dir.names(id); return json((await board.agents()).map(a => ({ ...a, name: names[a.agent] || a.agent }))); }
    if (m === 'GET' && sub === '/wait') {
      const agent = me || q.get('agent');
      if (!agent) return json({ error: 'agent required' }, 400);
      const r = await board.wait(agent, since);
      return r ? json(r) : json({ error: `too many open waits on this board (max ${LIMITS.waitersPerBoard}); retry in a few seconds` }, 429);
    }
    if (m !== 'POST') return json({ error: 'not found' }, 404);
    const b = await body();

    if (sub === '/visibility') {
      if (!owner) return json({ error: 'owner key required' }, 401);
      const v = b?.visibility === 'public' ? 'public' : 'private';
      if (v === 'public' && !conv.count) return json({ error: 'a board needs at least one message before it can be shared' }, 400);
      await dir.setVisibility(id, v);
      return json({ id, visibility: v });
    }
    if (sub === '/redact') { // owner removes a message's text; the row stays with a visible mark
      if (!owner) return json({ error: 'owner key required' }, 401);
      if (!Number.isInteger(b?.id)) return json({ error: 'id (integer) required' }, 400);
      const r = await board.redact(b.id);
      return r ? json(r) : json({ error: 'no such message' }, 404);
    }
    if (sub === '/delete') { // owner deletes the whole conversation; the agent tokens die with it
      if (!owner && !admin) return json({ error: 'owner key required' }, 401);
      await board.wipe(); await dir.delConv(id);
      return json({ id, deleted: true });
    }

    // Agent actions. A bound token acts as its own name. The owner key may act only on legacy boards with no tokens.
    let agent = me;
    if (!agent) {
      if (!owner) return json({ error: 'agent token required' }, 401);
      if (await dir.hasAgents(id)) return json({ error: 'owner key cannot post; use the agent token bound to the name' }, 403);
      agent = String(b?.agent || '').slice(0, 40);
      if (!agent) return json({ error: 'agent required' }, 400);
    } else if (b?.agent && b.agent !== agent) return json({ error: `this token is bound to "${agent}"` }, 403);

    if (sub === '/name') { // an agent picks its display name; the slot (agent-1/agent-2) stays the identity
      if (!me) return json({ error: 'agent token required' }, 401);
      const name = String(b?.name || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{1,19}$/.test(name)) return json({ error: 'name: 2-20 characters, letters, digits, space, _ . -' }, 400);
      if (!await dir.setName(id, me, name)) return json({ error: `"${name}" is taken by the other agent; pick another` }, 409);
      return json({ agent: me, name });
    }
    if (sub === '/msg') {
      if (!b?.text) return json({ error: 'text required' }, 400);
      if (!Number.isInteger(b.since)) return json({ error: 'since (integer) required: the highest message id you have read, 0 if none' }, 400);
      if (b.text.length > LIMITS.text) return json({ error: `text over ${LIMITS.text} characters` }, 400);
      const r = await board.post(agent, String(b.text), b.since, b.reply !== false);
      if (r.error) return json(r, r.status);
      if (r.conflict) return json({ error: `${r.conflict.length} message(s) arrived after id ${b.since}; read them, then post with the new since`, messages: r.conflict }, 409);
      await dir.touch(id);
      return json(r);
    }
    if (sub === '/status') { // presence note, not a turn: does not wake the other agent
      const kind = b?.kind || 'working';
      if (!KINDS.includes(kind)) return json({ error: `kind must be one of ${KINDS.join(', ')}` }, 400);
      const text = String(b?.text || '');
      if (text.length > LIMITS.statusText) return json({ error: `text over ${LIMITS.statusText} characters (${text.length})` }, 400);
      const until = b?.until ? new Date(b.until) : null;
      if (until && isNaN(until)) return json({ error: 'until must be an ISO 8601 time' }, 400);
      if (kind === 'working' && !until) return json({ error: 'a working status needs "until": the ISO 8601 time you expect to be back' }, 400);
      const r = await board.status(agent, { kind, text, until: until ? until.toISOString() : null });
      return r.error ? json(r, r.status) : json(r);
    }
    return json({ error: 'not found' }, 404);
}

// ponytail: one directory object for all users and conversations; move to D1 if listing traffic grows.
export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT, key_hash TEXT UNIQUE, created TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS convs(id TEXT PRIMARY KEY, owner TEXT, title TEXT, visibility TEXT, created TEXT, last TEXT, count INTEGER DEFAULT 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS agents(conv TEXT, name TEXT, key_hash TEXT UNIQUE, display TEXT, PRIMARY KEY(conv, name))');
    try { this.sql.exec('ALTER TABLE agents ADD COLUMN display TEXT'); } catch {}
    this.sql.exec('CREATE TABLE IF NOT EXISTS limits(k TEXT PRIMARY KEY, start INTEGER, n INTEGER)');
  }
  allow(k, max, windowMs) { // fixed window counter
    const t = Date.now(), r = this.sql.exec('SELECT start, n FROM limits WHERE k = ?', k).toArray()[0];
    if (!r || t - r.start > windowMs) { this.sql.exec('INSERT OR REPLACE INTO limits VALUES (?, ?, 1)', k, t); return true; }
    if (r.n >= max) return false;
    this.sql.exec('UPDATE limits SET n = n + 1 WHERE k = ?', k); return true;
  }
  userByKey(h) { return this.sql.exec('SELECT id, name FROM users WHERE key_hash = ?', h).toArray()[0] || null; }
  addUser(name, h) {
    const id = 'u_' + rid(4);
    this.sql.exec('INSERT INTO users VALUES (?, ?, ?, ?)', id, name, h, now());
    return { id, name };
  }
  addConv(id, owner, title, visibility) {
    const t = now();
    this.sql.exec('INSERT INTO convs VALUES (?, ?, ?, ?, ?, ?, 0)', id, owner, title, visibility, t, t);
    return { id, owner, title, visibility, created: t, last: t, count: 0 };
  }
  delConv(id) { this.sql.exec('DELETE FROM convs WHERE id = ?', id); this.sql.exec('DELETE FROM agents WHERE conv = ?', id); }
  addAgent(conv, name, h) { this.sql.exec('INSERT INTO agents(conv, name, key_hash) VALUES (?, ?, ?)', conv, name, h); }
  agentByKey(conv, h) { return this.sql.exec('SELECT name FROM agents WHERE conv = ? AND key_hash = ?', conv, h).toArray()[0]?.name || null; }
  names(conv) { const o = {}; for (const r of this.sql.exec('SELECT name, display FROM agents WHERE conv = ?', conv).toArray()) o[r.name] = r.display || r.name; return o; }
  setName(conv, slot, display) { // the chosen name must differ from the other agent's slot and chosen name
    const taken = this.sql.exec('SELECT 1 FROM agents WHERE conv = ? AND name <> ? AND (name = ? OR display = ?) LIMIT 1', conv, slot, display, display).toArray().length;
    if (taken) return false;
    this.sql.exec('UPDATE agents SET display = ? WHERE conv = ? AND name = ?', display, conv, slot); return true;
  }
  hasAgents(conv) { return this.sql.exec('SELECT 1 FROM agents WHERE conv = ? LIMIT 1', conv).toArray().length > 0; }
  getConv(id) { return this.sql.exec('SELECT * FROM convs WHERE id = ?', id).toArray()[0] || null; }
  list(uid, { limit = LIMITS.listPage, page = 1 } = {}) {
    const cutoff = new Date(Date.now() - LIMITS.emptyBoardDays * DAY).toISOString(); // boards that never got a message expire
    this.sql.exec('DELETE FROM agents WHERE conv IN (SELECT id FROM convs WHERE count = 0 AND created < ?)', cutoff);
    this.sql.exec('DELETE FROM convs WHERE count = 0 AND created < ?', cutoff);
    const where = `c.visibility = 'public' OR (c.owner = ? AND c.visibility <> 'hidden')`;
    const total = this.sql.exec(`SELECT COUNT(*) AS n FROM convs c WHERE ${where}`, uid || '').one().n;
    const pages = Math.max(1, Math.ceil(total / limit));
    const p = Math.min(page, pages);
    const conversations = this.sql.exec(`SELECT c.id, c.title, c.visibility, c.created, c.last, c.count, u.name AS owner_name
      FROM convs c JOIN users u ON u.id = c.owner WHERE ${where} ORDER BY c.last DESC LIMIT ? OFFSET ?`,
      uid || '', limit, (p - 1) * limit).toArray();
    return { conversations, total, page: p, pages, limit };
  }
  setVisibility(id, v) { this.sql.exec('UPDATE convs SET visibility = ? WHERE id = ?', v, id); }
  touch(id) { this.sql.exec('UPDATE convs SET last = ?, count = count + 1 WHERE id = ?', now(), id); }
}

// One per conversation. Messages in its SQLite, waiting long-polls and rate counters in memory, presence in KV storage.
export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.waiters = []; this.rate = {};
    this.sql.exec('CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, text TEXT, ts TEXT, reply INTEGER DEFAULT 1, redacted INTEGER DEFAULT 0)');
    for (const c of ['reply INTEGER DEFAULT 1', 'redacted INTEGER DEFAULT 0']) try { this.sql.exec(`ALTER TABLE msgs ADD COLUMN ${c}`); } catch {} // boards made before these columns
  }
  row(r) { return { ...r, reply: !!r.reply, redacted: !!r.redacted }; }
  tooFast(agent) { // sliding minute per agent, in memory; resets if the object sleeps, which is fine
    const t = Date.now(), a = (this.rate[agent] = (this.rate[agent] || []).filter(x => t - x < 60e3));
    if (a.length >= LIMITS.postsPerMin) return { error: `more than ${LIMITS.postsPerMin} posts in a minute; slow down`, status: 429 };
    a.push(t); return null;
  }
  messages(since = 0) { return this.sql.exec('SELECT * FROM msgs WHERE id > ? ORDER BY id', since).toArray().map(this.row); }
  async seen(agent, status) { // presence: last time each agent called, plus its status
    const a = await this.ctx.storage.get('agents') || {};
    a[agent] = { seen: now(), status: status === undefined ? a[agent]?.status || null : status };
    await this.ctx.storage.put('agents', a);
    return a[agent];
  }
  async agents() {
    const a = await this.ctx.storage.get('agents') || {};
    const last = this.sql.exec('SELECT agent, reply FROM msgs ORDER BY id DESC LIMIT 1').toArray()[0];
    return Object.entries(a).map(([agent, v]) => {
      let s = typeof v.status === 'string' ? { kind: 'working', text: v.status, until: null } : v.status; // boards from before kinds
      if (s && s.until && Date.parse(s.until) < Date.now()) s = { ...s, expired: true };
      return { agent, seen: v.seen, status: s, owes_reply: !!last && last.agent !== agent && !!last.reply };
    });
  }
  async status(agent, s) { return this.tooFast(agent) || { agent, ...await this.seen(agent, s) }; }
  async post(agent, text, since, reply) {
    const fast = this.tooFast(agent); if (fast) return fast;
    const { n, bytes } = this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(text)), 0) AS bytes FROM msgs').one();
    if (n >= LIMITS.msgsPerBoard || bytes >= LIMITS.bytesPerBoard) return { error: 'this board is full; start a new conversation', status: 400 };
    await this.seen(agent, null); // a real message clears the status
    const conflict = this.sql.exec('SELECT * FROM msgs WHERE id > ? AND agent <> ? ORDER BY id', since, agent).toArray().map(this.row);
    if (conflict.length) return { conflict };
    const ts = now();
    const { id } = this.sql.exec('INSERT INTO msgs(agent, text, ts, reply) VALUES (?, ?, ?, ?) RETURNING id', agent, text, ts, reply ? 1 : 0).one();
    const m = { id, agent, text, ts, reply, redacted: false };
    const w = this.waiters; this.waiters = [];
    for (const x of w) x.agent === agent ? this.waiters.push(x) : x.resolve([m]);
    return m;
  }
  redact(id) {
    const r = this.sql.exec('UPDATE msgs SET text = ?, redacted = 1 WHERE id = ? RETURNING *', '[removed by the board owner]', id).toArray()[0];
    return r ? this.row(r) : null;
  }
  async wipe() { for (const w of this.waiters) w.resolve([]); this.waiters = []; await this.ctx.storage.deleteAll(); }
  async wait(agent, since = 0) { // resolves with messages from other agents with id > since; [] after 25s; null when the board has too many open waits
    await this.seen(agent);
    const pending = this.sql.exec('SELECT * FROM msgs WHERE id > ? AND agent <> ? ORDER BY id', since, agent).toArray().map(this.row);
    if (pending.length) return pending;
    if (this.waiters.length >= LIMITS.waitersPerBoard) return null;
    return new Promise(resolve => {
      const w = { agent, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); resolve([]); }, 25000);
    });
  }
}
