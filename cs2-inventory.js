#!/usr/bin/env node
'use strict';
/**
 * CS2 Inventory Counter
 * Counts skins, stickers & co. in the inventory AND in all storage units.
 * Storage unit contents are only available through the CS2 Game Coordinator (GC),
 * so the script logs in like a Steam client (steam-user + globaloffensive).
 *
 *   node cs2-inventory.js                 log in with username/password + Steam Guard
 *   node cs2-inventory.js --remember      also save a login token → next start without password/code
 *   node cs2-inventory.js --forget        delete the saved token
 *   node cs2-inventory.js --refresh-data  reload the item name database now
 *
 * Optional: environment variables STEAM_USER / STEAM_PASS.
 * Important: CS2 must be closed on the account, otherwise Steam blocks the GC connection.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const APP_ID = 730;
const BASE_DIR = __dirname;
const CACHE_DIR = path.join(BASE_DIR, 'cache');
const EXPORT_ROOT = path.join(BASE_DIR, 'export');
const TOKEN_FILE = path.join(BASE_DIR, '.steam-token');
const NAMES_FILE = path.join(CACHE_DIR, 'names.json');
const NAMES_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const DATA_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/';

const ARGS = new Set(process.argv.slice(2));
const OPT = {
  remember: ARGS.has('--remember'),
  forget: ARGS.has('--forget'),
  refreshData: ARGS.has('--refresh-data'),
};

// def_index from items_game.txt
const DEF = {
  STORAGE_UNIT: 1201,
  STICKER: 1209,
  MUSIC_KIT: 1314,
  SEALED_GRAFFITI: 1348,
  GRAFFITI: 1349,
  CHARM: 1355,
  PATCH: 4609,
};
// Attribute IDs from items_game.txt (all stored as uint32)
const ATTR = {
  MUSIC_ID: 166,
  SPRAY_TINT: 233,
  CHARM_ID: 299, // keychain slot 0 id
  CHARM_SEED: 306, // keychain slot 0 seed
  CHARM_HIGHLIGHT: 314, // souvenir charm (highlight reel)
  CHARM_SLAB_STICKER: 321, // sticker inside a sticker slab
};
const KEYCHAIN_STICKER_SLAB = 37;
const NO_APPLIED_STICKERS = new Set([DEF.STICKER, DEF.PATCH, DEF.SEALED_GRAFFITI, DEF.GRAFFITI]);

// ───────────────────────────── Name database ─────────────────────────────

async function buildNames() {
  const files = ['skins', 'stickers', 'patches', 'graffiti', 'keychains', 'highlights', 'music_kits',
    'crates', 'agents', 'keys', 'collectibles', 'tools', 'base_weapons'];
  const data = {};
  await Promise.all(files.map(async (f) => {
    const res = await fetch(DATA_URL + f + '.json');
    if (!res.ok) throw new Error(`${f}.json: HTTP ${res.status}`);
    data[f] = await res.json();
  }));

  const n = {
    created: new Date().toISOString(),
    skins: {}, phases: {}, vanilla: {}, base: {}, stickers: {}, stickerMeta: {}, patches: {}, graffiti: {},
    keychains: {}, highlights: {}, musicKits: {}, defs: {},
  };
  const label = (x) => x.market_hash_name || x.name;

  for (const s of data.skins) {
    const def = s.weapon && s.weapon.weapon_id;
    if (def == null) continue;
    if (!s.paint_index || s.paint_index === '0') { n.vanilla[def] = s.name; continue; } // e.g. "★ Karambit"
    const key = `${def}_${s.paint_index}`;
    n.skins[key] = s.name;
    if (s.phase) n.phases[key] = s.phase; // Doppler phases
  }
  for (const b of data.base_weapons) n.base[b.def_index] = b.name;
  for (const s of data.stickers) { // key = sticker kit ID
    n.stickers[s.def_index] = label(s);
    n.stickerMeta[s.def_index] = [s.tournament ? s.tournament.name : '', s.type || '', s.effect || ''];
  }
  for (const p of data.patches) n.patches[p.def_index] = label(p);
  for (const g of data.graffiti) n.graffiti[g.id.replace(/^graffiti-/, '')] = label(g); // "1697" or "1697_<tint>"
  for (const k of data.keychains) n.keychains[k.def_index] = label(k);
  for (const h of data.highlights) n.highlights[h.def_index] = label(h);
  for (const m of data.music_kits) {
    if (m.id.endsWith('_st')) continue; // StatTrak variant, the prefix comes from the item quality
    n.musicKits[m.def_index] = m.name.startsWith('Music Kit |') ? m.name : `Music Kit | ${m.name}`;
  }
  const addDefs = (list, cat) => {
    for (const x of list) {
      const isVariant = /_[a-z]+$/i.test(x.id); // e.g. crate-5120_highlight shares the def_index
      if (isVariant && n.defs[x.def_index]) continue;
      n.defs[x.def_index] = { name: label(x), cat };
    }
  };
  addDefs(data.crates, 'Container');
  addDefs(data.agents, 'Agent');
  addDefs(data.keys, 'Key');
  addDefs(data.collectibles, 'Collectible');
  addDefs(data.tools, 'Tool');
  return n;
}

async function loadNames() {
  let cached = null;
  if (fs.existsSync(NAMES_FILE)) {
    try { cached = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')); } catch { cached = null; }
  }
  const fresh = cached && Date.now() - new Date(cached.created).getTime() < NAMES_MAX_AGE_MS;
  if (fresh && !OPT.refreshData) return cached;

  console.log('Loading item names (ByMykel/CSGO-API, approx. 40 MB, cached for 7 days) …');
  try {
    const names = await buildNames();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(NAMES_FILE, JSON.stringify(names));
    return names;
  } catch (err) {
    if (cached) {
      console.warn(`⚠ Download failed (${err.message}) – using the existing cache.`);
      return cached;
    }
    throw new Error(`Could not load item names: ${err.message}`);
  }
}

// ───────────────────────────── Resolving items ─────────────────────────────

function attrU32(raw, id) {
  const a = (raw.attribute || []).find((x) => Number(x.def_index) === id);
  if (!a || !a.value_bytes) return undefined;
  const buf = Buffer.isBuffer(a.value_bytes) ? a.value_bytes : Buffer.from(a.value_bytes);
  return buf.length >= 4 ? buf.readUInt32LE(0) : undefined;
}

function wearName(f) {
  if (f == null) return null;
  if (f < 0.07) return 'Factory New';
  if (f < 0.15) return 'Minimal Wear';
  if (f < 0.38) return 'Field-Tested';
  if (f < 0.45) return 'Well-Worn';
  return 'Battle-Scarred';
}

function stickerInfo(names, kit) {
  const [event, kind, effect] = (names.stickerMeta && names.stickerMeta[kit]) || ['', '', ''];
  return { event: event || null, kind: kind || null, effect: effect === 'Other' ? 'Paper' : (effect || null) };
}

function resolveCharm(raw, names) {
  const kc = attrU32(raw, ATTR.CHARM_ID);
  const seed = attrU32(raw, ATTR.CHARM_SEED);
  if (kc === KEYCHAIN_STICKER_SLAB) {
    const sid = attrU32(raw, ATTR.CHARM_SLAB_STICKER);
    const sticker = names.stickers[sid] || `Unknown #${sid}`;
    return { slab: true, name: `Sticker Slab | ${sticker.replace(/^Sticker \| /, '')}`, seed, info: stickerInfo(names, sid) };
  }
  const hl = attrU32(raw, ATTR.CHARM_HIGHLIGHT);
  if (hl !== undefined && names.highlights[hl]) return { slab: false, name: names.highlights[hl], seed };
  return { slab: false, name: names.keychains[kc] || `Charm | Unknown #${kc}`, seed };
}

function resolveItem(raw, names) {
  const def = raw.def_index;
  const paint = raw.paint_index ? Math.round(raw.paint_index) : 0;
  const kit0 = raw.stickers && raw.stickers[0] ? raw.stickers[0].sticker_id : undefined;
  const stattrak = raw.quality === 9 || raw.kill_eater_value !== undefined;
  const souvenir = raw.quality === 12;

  const r = {
    id: String(raw.id), category: 'Other', name: null,
    float: raw.paint_wear ?? null, pattern: raw.paint_seed ?? null,
    nameTag: raw.custom_name || null, applied: [], charm: null,
  };

  if (paint) {
    // weapons, knives, gloves
    const key = `${def}_${paint}`;
    r.category = 'Skin';
    let name = names.skins[key];
    if (!name) {
      r.name = `Unknown skin (def ${def}, paint ${paint})`;
    } else {
      if (stattrak) name = name.startsWith('★ ') ? name.replace('★ ', '★ StatTrak™ ') : `StatTrak™ ${name}`;
      else if (souvenir) name = `Souvenir ${name}`;
      const wear = wearName(raw.paint_wear);
      if (wear) name += ` (${wear})`;
      if (names.phases[key]) name += ` [${names.phases[key]}]`;
      r.name = name;
    }
  } else if (def === DEF.STICKER) {
    r.category = 'Sticker';
    r.name = names.stickers[kit0] || `Sticker | Unknown #${kit0}`;
    Object.assign(r, stickerInfo(names, kit0));
  } else if (def === DEF.PATCH) {
    r.category = 'Patch';
    r.name = names.patches[kit0] || `Patch | Unknown #${kit0}`;
  } else if (def === DEF.SEALED_GRAFFITI || def === DEF.GRAFFITI) {
    r.category = 'Graffiti';
    const tint = attrU32(raw, ATTR.SPRAY_TINT);
    let name = names.graffiti[`${kit0}_${tint}`] || names.graffiti[kit0] || `Sealed Graffiti | Unknown #${kit0}`;
    if (def === DEF.GRAFFITI) name = name.replace(/^Sealed Graffiti/, 'Graffiti');
    r.name = name;
  } else if (def === DEF.MUSIC_KIT) {
    r.category = 'Music Kit';
    const id = attrU32(raw, ATTR.MUSIC_ID);
    r.name = (stattrak ? 'StatTrak™ ' : '') + (names.musicKits[id] || `Music Kit | Unknown #${id}`);
  } else if (def === DEF.CHARM) {
    const c = resolveCharm(raw, names);
    r.category = c.slab ? 'Sticker Slab' : 'Charm';
    r.name = c.name;
    r.pattern = c.seed ?? null;
    if (c.slab) Object.assign(r, c.info);
  } else if (def === DEF.STORAGE_UNIT) {
    r.category = 'Storage Unit';
    r.name = 'Storage Unit';
  } else if (names.defs[def]) {
    r.category = names.defs[def].cat;
    r.name = names.defs[def].name;
  } else if (names.vanilla[def] || names.base[def]) {
    r.category = 'Skin';
    let name = names.vanilla[def] || names.base[def];
    if (stattrak) name = name.startsWith('★ ') ? name.replace('★ ', '★ StatTrak™ ') : `StatTrak™ ${name}`;
    r.name = name;
  } else {
    r.name = `Unknown item (def ${def})`;
  }

  // applied stickers (weapons) or patches (agents)
  if (raw.stickers && !NO_APPLIED_STICKERS.has(def)) {
    const isAgent = r.category === 'Agent';
    r.applied = raw.stickers.map((s) => ({
      slot: s.slot,
      name: isAgent
        ? (names.patches[s.sticker_id] || `Patch | Unknown #${s.sticker_id}`)
        : (names.stickers[s.sticker_id] || `Sticker | Unknown #${s.sticker_id}`),
      scrape: s.wear || 0,
    }));
  }
  // charm on a weapon
  if (def !== DEF.CHARM && attrU32(raw, ATTR.CHARM_ID) !== undefined) r.charm = resolveCharm(raw, names).name;
  return r;
}

// ───────────────────────────── Report & export ─────────────────────────────

const nf = new Intl.NumberFormat('en-US');
const fmt = (n) => nf.format(n);
const cut = (s, w) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));
const heading = (t) => console.log('\n' + `══ ${t} `.padEnd(100, '═'));
const scrapeText = (s) => (s.scrape > 0 ? ` (${Math.round(s.scrape * 100)}% scraped)` : '');

function pivot(items, filter) {
  const map = new Map();
  for (const it of items) {
    if (!filter(it)) continue;
    let row = map.get(it.name);
    if (!row) map.set(it.name, (row = { name: it.name, category: it.category, first: it, total: 0, byLoc: {} }));
    row.total++;
    row.byLoc[it.loc] = (row.byLoc[it.loc] || 0) + 1;
  }
  return [...map.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function distribution(row) {
  return Object.entries(row.byLoc).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}: ${fmt(c)}`).join(', ');
}

function printRows(rows, limit, csvName) {
  for (const r of rows.slice(0, limit)) {
    console.log(`${fmt(r.total).padStart(7)}  ${cut(r.name, 58)}  ${cut(distribution(r), 45).trimEnd()}`);
  }
  if (rows.length > limit) console.log(`        … ${fmt(rows.length - limit)} more → ${csvName}`);
}

function csvCell(v) {
  if (v == null) return '';
  let s = typeof v === 'number' && !Number.isInteger(v) ? String(v).replace('.', ',') : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, header, rows) {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(';'));
  fs.writeFileSync(file, '﻿' + lines.join('\r\n'), 'utf8'); // BOM + ";" + decimal comma → Excel with German/European regional settings opens it correctly as is
}

function timestamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

function report(items, locations, warnings) {
  const isSticker = (i) => i.category === 'Sticker';
  const isSkin = (i) => i.category === 'Skin';

  heading('Overview');
  console.log(`${'Location'.padEnd(40)}${'Items'.padStart(8)}${'Stickers'.padStart(9)}${'Skins'.padStart(8)}`);
  for (const loc of locations) {
    const inLoc = items.filter((i) => i.loc === loc);
    console.log(`${cut(loc, 40)}${fmt(inLoc.length).padStart(8)}${fmt(inLoc.filter(isSticker).length).padStart(9)}${fmt(inLoc.filter(isSkin).length).padStart(8)}`);
  }
  console.log('─'.repeat(65));
  console.log(`${'Total'.padEnd(40)}${fmt(items.length).padStart(8)}${fmt(items.filter(isSticker).length).padStart(9)}${fmt(items.filter(isSkin).length).padStart(8)}`);

  const cats = {};
  for (const i of items) cats[i.category] = (cats[i.category] || 0) + 1;
  console.log('\nBy category: ' + Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${fmt(n)}`).join(' · '));

  const stickerRows = pivot(items, isSticker);
  heading(`Stickers: ${fmt(items.filter(isSticker).length)} total, ${fmt(stickerRows.length)} unique`);
  const summary = (key, empty) => {
    const acc = {};
    for (const i of items) if (isSticker(i)) acc[i[key] || empty] = (acc[i[key] || empty] || 0) + 1;
    return Object.entries(acc).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${fmt(n)}`).join(' · ');
  };
  if (stickerRows.length) {
    console.log(`By tournament: ${summary('event', 'no tournament')}`);
    console.log(`By variant:    ${summary('effect', '?')}\n`);
  }
  printRows(stickerRows, 250, 'stickers.csv');

  const slabRows = pivot(items, (i) => i.category === 'Sticker Slab');
  if (slabRows.length) {
    heading(`Sticker Slabs: ${fmt(slabRows.reduce((s, r) => s + r.total, 0))} total`);
    printRows(slabRows, 50, 'stickers.csv');
  }

  const skinRows = pivot(items, isSkin);
  if (skinRows.length) {
    heading(`Skins: ${fmt(items.filter(isSkin).length)} total, ${fmt(skinRows.length)} unique (top 30)`);
    printRows(skinRows, 30, 'items_grouped.csv');
  }

  const applied = new Map();
  for (const it of items) {
    for (const s of it.applied) {
      let a = applied.get(s.name);
      if (!a) applied.set(s.name, (a = { name: s.name, count: 0, on: [] }));
      a.count++;
      a.on.push(`${it.name} [${it.loc}]${scrapeText(s)}`);
    }
  }
  const appliedRows = [...applied.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  if (appliedRows.length) {
    const total = appliedRows.reduce((s, r) => s + r.count, 0);
    heading(`Applied stickers/patches: ${fmt(total)} total (top 30)`);
    for (const r of appliedRows.slice(0, 30)) console.log(`${fmt(r.count).padStart(7)}  ${cut(r.name, 58)}  on ${cut(r.on[0], 40).trimEnd()}${r.on.length > 1 ? ' …' : ''}`);
  }

  // Export
  const dir = path.join(EXPORT_ROOT, timestamp());
  fs.mkdirSync(dir, { recursive: true });
  const pivotRows = (rows) => rows.map((r) => [r.name, r.category, r.total, ...locations.map((l) => r.byLoc[l] || 0)]);

  writeCsv(path.join(dir, 'stickers.csv'), ['Name', 'Form', 'Tournament', 'Type', 'Variant', 'Total', ...locations],
    [...stickerRows, ...slabRows].map((r) => [r.name, r.category, r.first.event, r.first.kind, r.first.effect, r.total,
      ...locations.map((l) => r.byLoc[l] || 0)]));
  writeCsv(path.join(dir, 'items_grouped.csv'), ['Name', 'Category', 'Total', ...locations], pivotRows(pivot(items, () => true)));
  writeCsv(path.join(dir, 'items_individual.csv'),
    ['Location', 'Category', 'Name', 'Float', 'Pattern', 'Name tag', 'Applied', 'Charm', 'Item ID'],
    items.map((i) => [i.loc, i.category, i.name, i.float, i.pattern, i.nameTag,
      i.applied.map((s) => s.name + scrapeText(s)).join(' + '), i.charm, i.id]));
  writeCsv(path.join(dir, 'applied_stickers.csv'), ['Sticker/Patch', 'Count', 'On items'],
    appliedRows.map((r) => [r.name, r.count, r.on.join(' / ')]));
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify(items, null, 2));

  for (const w of warnings) console.log(`⚠ ${w}`);
  console.log(`\n✔ Export: ${dir}`);
  console.log('   stickers.csv · items_grouped.csv · items_individual.csv · applied_stickers.csv · items.json');
}

function loadCasket(csgo, id, tries = 2) {
  return new Promise((resolve, reject) => {
    csgo.getCasketContents(id, (err, items) => (err ? reject(err) : resolve(items)));
  }).catch(async (err) => {
    if (tries <= 1) throw err;
    await sleep(3000);
    return loadCasket(csgo, id, tries - 1);
  });
}

async function run(csgo, names) {
  const inventory = csgo.inventory.filter((i) => !i.casket_id); // items inside storage units also show up in csgo.inventory once loaded
  const units = inventory.filter((i) => i.def_index === DEF.STORAGE_UNIT)
    .sort((a, b) => (a.custom_name ? 0 : 1) - (b.custom_name ? 0 : 1) || (a.custom_name || '').localeCompare(b.custom_name || ''));
  console.log(`✔ Connected to the CS2 Game Coordinator – ${fmt(inventory.length)} items in the inventory, ${units.length} storage unit${units.length === 1 ? '' : 's'}`);

  const labels = new Map();
  const seen = new Map();
  for (const u of units) {
    const base = u.custom_name ? `SU: ${u.custom_name}` : 'SU: (unnamed)';
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    labels.set(u.id, n === 1 ? base : `${base} #${n}`);
  }

  const warnings = [];
  const unitItems = new Map();
  for (const u of units) {
    const expected = u.casket_contained_item_count || 0;
    const prefix = `  ↳ ${labels.get(u.id)} (${fmt(expected)})`;
    if (!expected) { unitItems.set(u.id, []); console.log(`${prefix} empty`); continue; }
    try {
      const items = await loadCasket(csgo, u.id);
      unitItems.set(u.id, items);
      const ok = items.length === expected;
      if (!ok) warnings.push(`${labels.get(u.id)}: only ${items.length}/${expected} items loaded`);
      console.log(`${prefix} ${ok ? 'ok' : `⚠ ${items.length}/${expected}`}`);
    } catch (err) {
      unitItems.set(u.id, []);
      warnings.push(`${labels.get(u.id)}: could not be loaded (${err.message}) – missing from the report`);
      console.log(`${prefix} ✖ ${err.message}`);
    }
    await sleep(750); // don't flood the GC
  }

  const items = inventory.map((raw) => ({ loc: 'Inventory', ...resolveItem(raw, names) }));
  for (const u of units) {
    for (const raw of unitItems.get(u.id)) items.push({ loc: labels.get(u.id), ...resolveItem(raw, names) });
  }
  const unknown = items.filter((i) => /Unknown #|^Unknown (skin|item) \(def /.test(i.name)).length;
  if (unknown) warnings.push(`${unknown} items without a name – try --refresh-data to update the name database`);

  report(items, ['Inventory', ...units.map((u) => labels.get(u.id))], warnings);
}

// ───────────────────────────── Login & main flow ─────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function askHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  return new Promise((resolve) => {
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') { buf = buf.slice(0, -1); continue; }
        buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`✖ Node.js 18 or newer required (installed: ${process.versions.node}).`);
    process.exit(1);
  }
  if (ARGS.has('--help') || ARGS.has('-h')) {
    // \r? because a Windows git checkout may turn the line endings into CRLF
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*\r?\n/, '').replace(/^ \* ?/gm, ''));
    return;
  }
  if (OPT.forget) {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    console.log('✔ Saved login token deleted.');
    return;
  }

  const names = await loadNames();

  const SteamUser = require('steam-user');
  const GlobalOffensive = require('globaloffensive');
  const user = new SteamUser({ renewRefreshTokens: true });
  const csgo = new GlobalOffensive(user);

  let usedToken = false;
  let details;
  if (fs.existsSync(TOKEN_FILE)) {
    details = { refreshToken: fs.readFileSync(TOKEN_FILE, 'utf8').trim() };
    usedToken = true;
    console.log('Found a saved login token – logging in with it.');
  } else {
    const accountName = process.env.STEAM_USER || await ask('Steam username: ');
    const password = process.env.STEAM_PASS || await askHidden('Password (hidden): ');
    details = { accountName, password };
  }

  let exiting = false;
  const shutdown = (code) => {
    if (exiting) return;
    exiting = true;
    try { user.gamesPlayed([]); user.logOff(); } catch { /* ignore */ }
    setTimeout(() => process.exit(code), 1500);
  };
  process.on('SIGINT', () => shutdown(130));

  let gcTimer = null;
  const armGcTimer = () => {
    clearTimeout(gcTimer);
    gcTimer = setTimeout(() => {
      console.error('✖ No connection to the CS2 Game Coordinator (3 min). Is CS2 still running somewhere, or is the GC down right now?');
      shutdown(1);
    }, 180000);
  };

  user.on('steamGuard', async (domain, callback, lastCodeWrong) => {
    if (lastCodeWrong) console.log('Code wrong or already used – wait for the next code in the app.');
    callback(await ask(domain ? `Steam Guard code (email to …@${domain}): ` : 'Steam Guard code (mobile app): '));
  });

  user.on('refreshToken', (token) => {
    // With a token login, renewal invalidates the old token → always save the new one
    if (OPT.remember || usedToken) {
      fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
      if (OPT.remember && !usedToken) console.log(`✔ Login token saved (${path.basename(TOKEN_FILE)}) – treat it like a password.`);
    }
  });

  user.on('loggedOn', () => {
    console.log(`✔ Logged in to Steam (${user.steamID.getSteamID64()}) – connecting to CS2 …`);
    armGcTimer();
    user.gamesPlayed([APP_ID]);
  });

  user.on('playingState', (blocked, playingApp) => {
    if (blocked) {
      clearTimeout(gcTimer);
      console.log(`⚠ A game (AppID ${playingApp}) is currently running on this account in another session – please close it there, waiting …`);
    } else if (!csgo.haveGCSession && playingApp !== APP_ID) {
      armGcTimer();
      user.gamesPlayed([APP_ID]);
    }
  });

  user.on('error', (err) => {
    const tokenDead = [SteamUser.EResult.AccessDenied, SteamUser.EResult.InvalidPassword,
      SteamUser.EResult.Expired, SteamUser.EResult.Revoked].includes(err.eresult);
    if (usedToken && tokenDead) {
      try { fs.unlinkSync(TOKEN_FILE); } catch { /* ignore */ }
      console.error('✖ The saved token is invalid and has been deleted – please restart and log in with your password.');
    } else {
      console.error(`✖ Steam error: ${err.message}`);
    }
    process.exit(1);
  });

  csgo.on('error', (err) => { console.error(`✖ GC error: ${err.message}`); shutdown(1); });

  csgo.once('connectedToGC', async () => {
    clearTimeout(gcTimer);
    try {
      await run(csgo, names);
      shutdown(0);
    } catch (err) {
      console.error('✖', err);
      shutdown(1);
    }
  });

  user.logOn(details);
}

if (require.main === module) {
  main().catch((err) => { console.error('✖', err.message || err); process.exit(1); });
}

module.exports = { resolveItem, buildNames, run, report };
