import { useState, useEffect, useRef } from "react";

import mapsText from "./mvm_maps.txt?raw";
const MAPS = mapsText
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);
  
import spawnsText from "./mvm_spawns.txt?raw";
const MAP_SPAWNS = (() => {
  const out = {};
  const blocks = spawnsText.trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) out[lines[0]] = lines.slice(1);
  }
  return out;
})();

function getSpawnsForMap(map) {
  return MAP_SPAWNS[map] && MAP_SPAWNS[map].length ? MAP_SPAWNS[map] : ["spawnbot"];
}

function resolveSpawn(map, where) {
  const opts = getSpawnsForMap(map);
  if (where && opts.includes(where)) return where;
  if (opts.includes("spawnbot")) return "spawnbot";
  return opts[0];
}



// ---- Minimal .pop -> form parser (WaveSchedule / Mission / Wave / WaveSpawn) ----
function stripQuotes(s) {
  s = String(s || "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function tokenizePop(src) {
  // Comment-aware tokenizer: "//" only starts a comment outside of quoted strings
  const text = String(src || "");
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "{" || c === "}") { tokens.push(c); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < n) { out += text[j + 1]; j += 2; continue; }
        out += text[j]; j++;
      }
      tokens.push(out);
      i = j < n ? j + 1 : j;
      continue;
    }
    let j = i;
    while (j < n && !/[\s{}"]/.test(text[j]) && !(text[j] === "/" && text[j + 1] === "/")) j++;
    tokens.push(text.slice(i, j));
    i = j;
  }
  return tokens;
}

function parseBlock(tokens, start) {
  // tokens[start] should be "{". Returns [object, indexAfterClosing]
  // _kv: [key, value], _blocks: [name, child], _seq: every entry in original order
  const obj = { _kv: [], _blocks: [], _seq: [] };
  let i = start + 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "}") return [obj, i + 1];
    if (t === "{") {
      const [, ni] = parseBlock(tokens, i); // anonymous block — skip
      i = ni;
      continue;
    }
    const key = t;
    const next = tokens[i + 1];
    if (next === "{") {
      const [child, ni] = parseBlock(tokens, i + 1);
      obj._blocks.push([key, child]);
      obj._seq.push({ k: key, child });
      i = ni;
    } else if (next === undefined || next === "}") {
      obj._kv.push([key, ""]);
      obj._seq.push({ k: key, v: "" });
      i += 1;
    } else {
      obj._kv.push([key, next]);
      obj._seq.push({ k: key, v: next });
      i += 2;
    }
  }
  return [obj, i];
}

function kvMap(block) {
  const m = {};
  for (const [k, v] of block._kv) {
    if (!(k in m)) m[k] = v; // first wins
  }
  return m;
}

function blocksNamed(block, name) {
  return block._blocks.filter(([n]) => n === name).map(([, b]) => b);
}

function firstBlock(block, name) {
  const list = blocksNamed(block, name);
  return list.length ? list[0] : null;
}

const numOr = (v, d) => (v != null && v !== "" && !isNaN(Number(v)) ? Number(v) : d);

function quoteIfNeeded(v) {
  v = String(v == null ? "" : v);
  if (v === "" || /[\s"{}]|\/\//.test(v)) return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  return v;
}

// Write a parsed block back out as pop-file lines, in original order.
// skip(key, isBlock) -> true to leave an entry out (because the form handles it itself).
function serializeSeq(block, ind, skip) {
  const p = " ".repeat(ind);
  const L = [];
  for (const e of block._seq) {
    if (skip && skip(e.k, !!e.child)) continue;
    if (e.child) {
      L.push(p + quoteIfNeeded(e.k), p + "{");
      L.push(...serializeSeq(e.child, ind + 4));
      L.push(p + "}");
    } else {
      L.push(p + quoteIfNeeded(e.k) + " " + quoteIfNeeded(e.v));
    }
  }
  return L;
}

// One TFBot { ... } block -> bot object. Handles "Template X" AND "Class X" bots.
// Skill + Attributes go into form fields; everything else (Tag, BehaviorModifiers,
// Name, MaxVisionRange, ItemAttributes, ...) is kept verbatim in `extra`.
function parseTFBotBlock(tf) {
  const b = makeBot();
  const m = kvMap(tf);
  const useClass = m.Template == null && m.Class != null;
  if (m.Template != null) b.template = stripQuotes(m.Template);
  else if (m.Class != null) b.template = "Class " + stripQuotes(m.Class);
  b.skill = m.Skill != null ? stripQuotes(m.Skill) : "";
  b.attributes = tf._kv.filter(([k]) => k === "Attributes").map(([, v]) => stripQuotes(v));
  b.extra = serializeSeq(tf, 0, (k, isBlk) => !isBlk && (k === "Attributes" || k === "Template" || k === "Skill" || (k === "Class" && useClass)));
  return b;
}

function collectBots(block) {
  const out = [];
  for (const [name, child] of block._blocks) {
    if (name === "TFBot") out.push(parseTFBotBlock(child));
    else if (name === "Squad" || name === "RandomChoice") out.push(...collectBots(child));
  }
  return out;
}

const WS_STRUCT = ["TFBot", "Squad", "RandomChoice", "Tank"];
const WS_KNOWN = ["Name", "Where", "TotalCount", "MaxActive", "SpawnCount", "WaitBeforeStarting", "WaitBetweenSpawns", "WaitBetweenSpawnsAfterDeath", "TotalCurrency", "Support", "WaitForAllDead", "WaitForAllSpawned"];
const TANK_KNOWN = ["Health", "Speed", "Name", "StartingPathTrackNode", "Path", "Skin"];

// Can the form represent this WaveSpawn without losing structure?
function spawnIsRepresentable(spBlock) {
  const st = spBlock._blocks.filter(([n]) => WS_STRUCT.includes(n));
  if (st.length !== 1) return false;
  const [name, child] = st[0];
  if (name === "Squad" || name === "RandomChoice") {
    if (child._kv.length || !child._blocks.length) return false;
    if (child._blocks.some(([n]) => n !== "TFBot")) return false;
  }
  return true;
}

function parseWaveSpawnBlock(spBlock) {
  const m = kvMap(spBlock);
  // Game defaults for keys that are absent (not the UI's "new spawn" defaults)
  const afterDeath = m.WaitBetweenSpawns == null && m.WaitBetweenSpawnsAfterDeath != null;
  const sp = {
    id: mkId(),
    type: "single",
    name: m.Name != null ? stripQuotes(m.Name) : "",
    where: m.Where != null ? stripQuotes(m.Where) : "spawnbot",
    totalCount: numOr(m.TotalCount, 0),
    maxActive: numOr(m.MaxActive, 999),
    spawnCount: numOr(m.SpawnCount, 1),
    waitBefore: numOr(m.WaitBeforeStarting, 0),
    waitBetween: numOr(afterDeath ? m.WaitBetweenSpawnsAfterDeath : m.WaitBetweenSpawns, 0),
    betweenAfterDeath: afterDeath,
    totalCurrency: numOr(m.TotalCurrency, 0),
    support: m.Support != null ? (String(m.Support).toLowerCase() === "limited" ? "limited" : (String(m.Support) === "1" || String(m.Support).toLowerCase() === "true" ? "1" : "none")) : "none",
    waitDead: m.WaitForAllDead != null ? stripQuotes(m.WaitForAllDead) : "",
    waitSpawned: m.WaitForAllSpawned != null ? stripQuotes(m.WaitForAllSpawned) : "",
    bots: [makeBot()],
    squadBots: [makeBot(), makeBot()],
    randomBots: [makeBot(), makeBot()],
    tank: { health: 30000, speed: 75, name: "Tank", path: "boss_path_1", skin: 0 },
    // every other key / block in the WaveSpawn (FirstSpawnOutput, LastSpawnOutput, sounds, ...)
    extra: serializeSeq(spBlock, 0, (k, isBlk) => (isBlk ? WS_STRUCT.includes(k) : WS_KNOWN.includes(k))),
    override: "",
  };

  const tank = firstBlock(spBlock, "Tank");
  const squad = firstBlock(spBlock, "Squad");
  const random = firstBlock(spBlock, "RandomChoice");
  if (tank) {
    sp.type = "tank";
    sp.fromTank = true;
    sp.tankKeep = { total: numOr(m.TotalCount, 1), max: numOr(m.MaxActive, 999), spawn: numOr(m.SpawnCount, 1), between: numOr(m.WaitBetweenSpawns, 0) };
    const tm = kvMap(tank);
    sp.tank = {
      health: numOr(tm.Health, 30000),
      speed: numOr(tm.Speed, 75),
      name: tm.Name != null ? stripQuotes(tm.Name) : "Tank",
      path: tm.StartingPathTrackNode != null ? stripQuotes(tm.StartingPathTrackNode) : (tm.Path != null ? stripQuotes(tm.Path) : "boss_path_1"),
      skin: numOr(tm.Skin, 0),
      extra: serializeSeq(tank, 0, (k, isBlk) => !isBlk && TANK_KNOWN.includes(k)), // OnKilledOutput etc.
    };
  } else if (squad) {
    sp.type = "squad";
    const bots = collectBots(squad);
    sp.squadBots = bots.length ? bots : [makeBot()];
  } else if (random) {
    sp.type = "random";
    const bots = collectBots(random);
    sp.randomBots = bots.length ? bots : [makeBot(), makeBot()];
  } else {
    const tf = firstBlock(spBlock, "TFBot");
    sp.bots = [tf ? parseTFBotBlock(tf) : makeBot()];
  }

  // Structures the form can't model (nested Squad in RandomChoice, several top-level
  // TFBots, ...): keep the exact original text so nothing is lost on save.
  if (!spawnIsRepresentable(spBlock)) {
    sp.override = ["WaveSpawn", "{", ...serializeSeq(spBlock, 4), "}"].join("\n");
    sp.rawKept = true;
  }
  return sp;
}

function parseMissionBlock(mb) {
  const m = kvMap(mb);
  const tf = firstBlock(mb, "TFBot");
  let tmpl = "T_TFBot_SentryBuster", skill = "", extra = [];
  if (tf) {
    const bot = parseTFBotBlock(tf);
    if (kvMap(tf).Template != null || kvMap(tf).Class != null) tmpl = bot.template;
    skill = bot.skill;
    // keep Attributes + Name + MaxVisionRange + anything else on the mission bot
    extra = serializeSeq(tf, 0, (k, isBlk) => !isBlk && (k === "Template" || k === "Skill" || (k === "Class" && kvMap(tf).Template == null)));
  }
  return {
    id: mkId(),
    obj: m.Objective != null ? stripQuotes(m.Objective) : "DestroySentries",
    ic: numOr(m.InitialCooldown, 0),
    where: m.Where != null ? stripQuotes(m.Where) : "spawnbot",
    bw: numOr(m.BeginAtWave, 1),
    rw: numOr(m.RunForThisManyWaves, 1),
    ct: numOr(m.CooldownTime, 0),
    dc: m.DesiredCount != null ? numOr(m.DesiredCount, 1) : "", // "" = key absent, not written back
    tmpl,
    skill,
    extra,
    mextra: serializeSeq(mb, 0, (k, isBlk) => (isBlk ? k === "TFBot" : ["Objective", "InitialCooldown", "Where", "BeginAtWave", "RunForThisManyWaves", "CooldownTime", "DesiredCount"].includes(k))),
  };
}

function parsePop(text) {
  const tokens = tokenizePop(text);
  let wsIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "WaveSchedule" && tokens[i + 1] === "{") {
      wsIdx = i + 1;
      break;
    }
  }
  if (wsIdx < 0) return null;
  const [root] = parseBlock(tokens, wsIdx);
  const top = kvMap(root);

  const bases = [];
  String(text || "").replace(/^[ \t]*#base[ \t]+(\S+)/gim, (_, f) => { bases.push(f); return ""; });

  const atk = top.CanBotsAttackWhileInSpawnRoom != null ? stripQuotes(top.CanBotsAttackWhileInSpawnRoom).toLowerCase() : "no";
  const g = {
    money: numOr(top.StartingCurrency, 800),
    respawn: numOr(top.RespawnWaveTime, 6),
    attack: ["yes", "1", "true"].includes(atk) ? "yes" : "no",
    adv: numOr(top.Advanced, 0),
    map: "mvm_coaltown",
    bases,
    // any other top-level setting (EventPopfile, FixedRespawnWaveTime, ...) lands in the Extra box
    extra: serializeSeq(root, 0, (k, isBlk) => (isBlk ? ["Mission", "Wave", "Templates"].includes(k) : ["StartingCurrency", "RespawnWaveTime", "CanBotsAttackWhileInSpawnRoom", "Advanced"].includes(k))).join("\n"),
  };

  const mis = blocksNamed(root, "Mission").map(parseMissionBlock);

  // Templates { ... } -> custom bot templates (kept verbatim through `override`)
  const cust = [];
  blocksNamed(root, "Templates").forEach((tb) => {
    for (const [name, child] of tb._blocks) {
      const cm = kvMap(child);
      const c = makeCustomBot();
      c.tName = name;
      c.cls = cm.Class != null ? stripQuotes(cm.Class) : "Scout";
      c.dName = cm.Name != null ? stripQuotes(cm.Name) : name;
      c.skill = cm.Skill != null ? stripQuotes(cm.Skill) : "";
      c.override = [name, "{", ...serializeSeq(child, 4), "}"].join("\n");
      cust.push(c);
    }
  });

  let rawCount = 0;
  const wavs = blocksNamed(root, "Wave").map((wb) => {
    const spawns = blocksNamed(wb, "WaveSpawn").map(parseWaveSpawnBlock);
    rawCount += spawns.filter((x) => x.rawKept).length;
    return {
      id: mkId(),
      spawns: spawns.length ? spawns : [makeWS()],
      // StartWaveOutput / DoneOutput / WaitWhenDone / Checkpoint / anything else, verbatim
      extra: serializeSeq(wb, 0, (k, isBlk) => isBlk && k === "WaveSpawn"),
    };
  });

  return {
    g,
    mis,
    cust,
    rawCount,
    wavs: wavs.length ? wavs : [{ id: mkId(), spawns: [makeWS()] }],
  };
}

// ---- File system bridge (Electron via window.mpcFs, browser fallback via localStorage) ----
const SAVES_PREFIX = "mpc_save_";

async function mpcEnsureDirs() {
  if (window.mpcFs && typeof window.mpcFs.ensureDirs === "function") {
    return window.mpcFs.ensureDirs();
  }
  // Browser / no bridge: nothing to create on disk
  return true;
}

async function mpcListSaves() {
  if (window.mpcFs && typeof window.mpcFs.listSaves === "function") {
    return window.mpcFs.listSaves();
  }
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(SAVES_PREFIX)) out.push(k.slice(SAVES_PREFIX.length));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function mpcWriteSave(filename, content) {
  if (window.mpcFs && typeof window.mpcFs.writeSave === "function") {
    return window.mpcFs.writeSave(filename, content);
  }
  localStorage.setItem(SAVES_PREFIX + filename, content);
  return true;
}

async function mpcReadSave(filename) {
  if (window.mpcFs && typeof window.mpcFs.readSave === "function") {
    return window.mpcFs.readSave(filename);
  }
  return localStorage.getItem(SAVES_PREFIX + filename);
}

function sanitizePopName(name) {
  return String(name || "")
    .trim()
    .replace(/[^\w\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "Untitled";
}

function saveFilename(map, popName) {
  return map + "_" + sanitizePopName(popName) + ".pop";
}


function botLabel(tmpl) {
  if (!tmpl) return "?";
  return tmpl
    .replace(/^T_TFBot_/, "")
    .replace(/^T_TFGateBot_/, "GB:")
    .replace(/^Class /, "")
    .replace(/_/g, " ");
}

function spawnSummary(sp) {
  if (sp.name && String(sp.name).trim()) return String(sp.name).trim();
  if (sp.type === "tank") return (sp.tank && sp.tank.name) || "Tank";
  let bots = [];
  if (sp.type === "single") bots = sp.bots || [];
  else if (sp.type === "squad") bots = sp.squadBots || [];
  else if (sp.type === "random") bots = sp.randomBots || [];
  const seen = new Set();
  const labels = [];
  for (const b of bots) {
    const l = botLabel(b.template);
    if (!seen.has(l)) { seen.add(l); labels.push(l); }
  }
  return labels.length ? labels.join(", ") : (sp.type || "WaveSpawn");
}

const TEMPLATES = {
  Scout:["Class Scout","T_TFBot_Scout_Melee","T_TFBot_Scout_Bonk","T_TFBot_Scout_Sandman","T_TFBot_Scout_Sandman_FastCharge","T_TFBot_Scout_FAN","T_TFBot_Scout_Shortstop","T_TFBot_Scout_Jumping_Sandman","T_TFBot_Scout_Scattergun_SlowFire","T_TFBot_Scout_SunStick","T_TFBot_Scout_Wrap_Assassin"],
  Soldier:["Class Soldier","T_TFBot_Soldier_RocketShotgun","T_TFBot_Soldier_RocketPush","T_TFBot_Soldier_Buff_Banner","T_TFBot_Soldier_Extended_Buff_Banner","T_TFBot_Soldier_Extended_Concheror","T_TFBot_Soldier_Extended_Battalion"],
  Pyro:["Class Pyro","T_TFBot_Pyro","T_TFBot_Pyro_Flaregun","T_TFBot_ScorchShot","T_TFBot_ScorchShot_FastShot"],
  Demoman:["Class Demoman","T_TFBot_Demoman","T_TFBot_Demoman_Knight","T_TFBot_Demoman_Samurai","T_TFBot_Demo_Burst"],
  Heavy:["Class Heavyweapons","T_TFBot_Heavyweapons_Fist","T_TFBot_Heavy_IronFist_Airblast","T_TFBot_Heavyweapons_Heavyweight_Champ","T_TFBot_Heavyweapons_Heavyweight_Champ_Fast","T_TFBot_Heavyweapons_Shotgun","T_TFBot_Heavyweapons_Gnome","T_TFBot_Heavyweapons_Heater"],
  Medic:["T_TFBot_Medic","T_TFBot_Medic_SlowRecharge","T_TFBot_Medic_QuickUber","T_TFBot_Medic_QuickFix","T_TFBot_Medic_BigHeal","T_TFBot_Medic_Vaccinator_Bullet","T_TFBot_Medic_Vaccinator_Blast","T_TFBot_Medic_Vaccinator_Fire"],
  Sniper:["T_TFBot_Sniper_Huntsman","T_TFBot_Sniper_Huntsman_Spammer","T_TFBot_Sniper","T_TFBot_Sniper_Razorback","T_TFBot_Sniper_Sydney_Sleeper"],
  Spy:["T_TFBot_Spy","Class Spy"],
  Engineer:["T_TFBot_Engineer_Sentry_Teleporter","T_TFBot_Engineer_Sentry_Battle_TeleIn","T_TFBot_Engineer_Sentry_Battle"],
  "Giant Scout":["T_TFBot_Giant_Scout","T_TFBot_Giant_Scout_Fast","T_TFBot_Giant_Scout_FAN","T_TFBot_Giant_Scout_Bonk","T_TFBot_Giant_Scout_Baseball","T_TFBot_Giant_Scout_Baseball_Armored","T_TFBot_Giant_Major_League"],
  "Giant Soldier":["T_TFBot_Giant_Soldier","T_TFBot_Giant_Soldier_Crit","T_TFBot_Giant_Soldier_Spammer","T_TFBot_Giant_Soldier_SlowBarrage","T_TFBot_Giant_Soldier_Extended_Buff_Banner","T_TFBot_Giant_Soldier_Extended_Concheror","T_TFBot_Giant_Soldier_Extended_Battalion","T_TFBot_Giant_Soldier_RocketPush","T_TFBot_Giant_Soldier_RocketShotgun","T_TFBot_Soldier_BurstFire"],
  "Giant Pyro":["T_TFBot_Giant_Pyro","T_TFBot_Giant_Pyro_Pusher","T_TFBot_Giant_Pyro_Flare_Spammer"],
  "Giant Demo":["T_TFBot_Giant_Demoman","T_TFBot_Giant_Demo_RapidFire","T_TFBot_Giant_Demo_Burst","T_TFBot_Giant_DemoMan_PrinceTavish","T_TFBot_Giant_Metalbeard"],
  "Giant Heavy":["T_TFBot_Giant_Heavyweapons","T_TFBot_Giant_Heavyweapons_Deflector","T_TFBot_Giant_Heavyweapons_Shotgun","T_TFBot_Giant_Heavyweapons_HealOnKill","T_TFBot_Giant_Heavyweapons_BrassBeast","T_TFBot_Giant_Boxing_Heavy"],
  "Giant Medic":["T_TFBot_Giant_Medic","T_TFBot_Giant_Medic_Regen"],
  Chief:["T_TFBot_Chief_Soldier","T_TFBot_Chief_Pyro","T_TFBot_Chief_Demo_Atomic","T_TFBot_Chief_Tavish","T_TFBot_Chief_Gauntlet","T_TFBot_Chief_Heavyweapons_HealOnKill"],
  "\u26A1 Gatebot Scout":["T_TFGateBot_Scout_Normal","T_TFGateBot_Scout_Hard","T_TFGateBot_Scout_FAN","T_TFGateBot_Scout_FAN_Crit","T_TFGateBot_Scout_Melee","T_TFGateBot_Scout_Sandman_FastCharge"],
  "\u26A1 Gatebot Soldier":["T_TFGateBot_Soldier_Easy","T_TFGateBot_Soldier_Normal","T_TFGateBot_Soldier_Hard","T_TFGateBot_Soldier_Normal_DirectHit_Crit","T_TFGateBot_Soldier_Extended_Concheror_Normal","T_TFGateBot_Soldier_Extended_Concheror_Normal_Crit","T_TFGateBot_Soldier_Extended_Battalion_Hard","T_TFGateBot_Soldier_RocketPush","T_TFGateBot_Soldier_RocketShotgun_Expert"],
  "\u26A1 Gatebot Pyro":["T_TFGateBot_Pyro_Normal","T_TFGateBot_Pyro_Hard","T_TFGateBot_Pyro_Expert","T_TFGateBot_Pyro_AlwaysFireWeapon","T_TFGateBot_Pyro_Flaregun"],
  "\u26A1 Gatebot Demoman":["T_TFGateBot_Demoman_Easy","T_TFGateBot_Demoman_Normal","T_TFGateBot_Demoman_Hard","T_TFGateBot_Demo_Burst_Normal","T_TFGateBot_Demo_Burst_Normal_Crit"],
  "\u26A1 Gatebot Heavy":["T_TFGateBot_Heavy_Easy","T_TFGateBot_Heavy_Normal","T_TFGateBot_Heavy_Normal_Crit","T_TFGateBot_Heavy_Hard","T_TFGateBot_Heavy_Expert_Crit","T_TFGateBot_Heavy_IronFist","T_TFGateBot_Heavy_IronFist_Crit","T_TFGateBot_Heavy_IronFist_Airblast","T_TFGateBot_Heavyweapons_Shotgun"],
  "\u26A1 Gatebot Sniper":["T_TFGateBot_Sniper_Huntsman_Spammer_Crit"],
  "\u26A1 Gatebot Giant Scout":["T_TFGateBot_Giant_Scout_FAN"],
  "\u26A1 Gatebot Giant Soldier":["T_TFGateBot_Giant_Soldier","T_TFGateBot_Giant_Soldier_Spammer","T_TFGateBot_Giant_Soldier_Spammer_Crit","T_TFGateBot_Giant_Soldier_Spammer_Reload","T_TFGateBot_Giant_Soldier_SlowBarrage","T_TFGateBot_Giant_Soldier_SlowCritBarrage","T_TFGateBot_Giant_Soldier_BurstFire","T_TFGateBot_Giant_Soldier_BurstFire_Crit","T_TFGateBot_Giant_Soldier_Extended_Concheror","T_TFGateBot_Giant_Soldier_Extended_Concheror_Crit","T_TFGateBot_Giant_Soldier_RocketPush","T_TFGateBot_Giant_Soldier_RocketShotgun"],
  "\u26A1 Gatebot Giant Pyro":["T_TFGateBot_Giant_Pyro_AlwaysFire","T_TFGateBot_Giant_Pyro_AlwaysFire_Crit"],
  "\u26A1 Gatebot Giant Demo":["T_TFGateBot_Giant_Demo_Burst","T_TFGateBot_Giant_Demo_Burst_Crit"],
  "\u26A1 Gatebot Giant Heavy":["T_TFGateBot_Giant_Heavyweapons_Deflector","T_TFGateBot_Giant_Heavyweapons_HealOnKill","T_TFGateBot_Giant_Heavyweapons_Heater","T_TFGateBot_Giant_Heavyweapons_Shotgun","T_TFGateBot_Giant_Heavyweapons_Shotgun_Crit"],
  "\u26A1 Gatebot Chief":["T_TFGateBot_Chief_Soldier_SlowCritBarrage","T_TFGateBot_Chief_Heavyweapons_HealOnKill"],
  "Sentry Buster":["T_TFBot_SentryBuster"],
};

const IC = "./icons/leaderboard_class_";
const ICON_MAP = {
  "Class Scout":IC+"scout.png","Class Soldier":IC+"soldier.png","Class Pyro":IC+"pyro.png",
  "Class Demoman":IC+"demo.png","Class Heavyweapons":IC+"heavy.png","Class Spy":IC+"spy.png",
  "Class Sniper":IC+"sniper.png","Class Medic":IC+"medic.png","Class Engineer":IC+"engineer.png",
  "T_TFBot_Scout_Melee":IC+"scout_bat.png","T_TFBot_Scout_Bonk":IC+"scout_bonk.png",
  "T_TFBot_Scout_Sandman":IC+"scout_stun.png","T_TFBot_Scout_Sandman_FastCharge":IC+"scout_stun.png",
  "T_TFBot_Scout_FAN":IC+"scout_fan.png","T_TFBot_Scout_Shortstop":IC+"scout_shortstop.png",
  "T_TFBot_Scout_Jumping_Sandman":IC+"scout_jumping.png","T_TFBot_Scout_Scattergun_SlowFire":IC+"scout.png",
  "T_TFBot_Scout_SunStick":IC+"scout_bat.png","T_TFBot_Scout_Wrap_Assassin":IC+"scout_bat.png",
  "T_TFBot_Scout_Fish":IC+"scout_bat.png",
  "T_TFBot_Soldier_RocketShotgun":IC+"soldier_blackbox.png","T_TFBot_Soldier_RocketPush":IC+"soldier_libertylauncher.png",
  "T_TFBot_Soldier_Buff_Banner":IC+"soldier_buff.png","T_TFBot_Soldier_Extended_Buff_Banner":IC+"soldier_buff.png",
  "T_TFBot_Soldier_Extended_Concheror":IC+"soldier_conch.png","T_TFBot_Soldier_Extended_Battalion":IC+"soldier_backup.png",
  "T_TFBot_Soldier_BurstFire":IC+"soldier_burstfire.png",
  "T_TFBot_Pyro":IC+"pyro.png","T_TFBot_Pyro_Flaregun":IC+"pyro_flare.png",
  "T_TFBot_ScorchShot":IC+"pyro_flare.png","T_TFBot_ScorchShot_FastShot":IC+"pyro_flare.png",
  "T_TFBot_Demoman":IC+"demo.png","T_TFBot_Demoman_Knight":IC+"demoknight.png",
  "T_TFBot_Demoman_Samurai":IC+"demoknight_samurai.png","T_TFBot_Demo_Burst":IC+"demo_burst.png",
  "T_TFBot_Heavyweapons_Fist":IC+"heavy_steelfist.png","T_TFBot_Heavy_IronFist_Airblast":IC+"heavy_steelfist.png",
  "T_TFBot_Heavyweapons_Heavyweight_Champ":IC+"heavy_champ.png",
  "T_TFBot_Heavyweapons_Heavyweight_Champ_Fast":IC+"heavy_gru.png",
  "T_TFBot_Heavyweapons_Shotgun":IC+"heavy_shotgun.png","T_TFBot_Heavyweapons_Gnome":IC+"heavy_mittens.png",
  "T_TFBot_Heavyweapons_Heater":IC+"heavy_heater.png",
  "T_TFBot_Medic":IC+"medic_uber.png","T_TFBot_Medic_SlowRecharge":IC+"medic_uber.png",
  "T_TFBot_Medic_QuickUber":IC+"medic_uber.png","T_TFBot_Medic_QuickFix":IC+"medic.png",
  "T_TFBot_Medic_BigHeal":IC+"medic.png",
  "T_TFBot_Medic_Vaccinator_Bullet":IC+"medic.png","T_TFBot_Medic_Vaccinator_Blast":IC+"medic.png",
  "T_TFBot_Medic_Vaccinator_Fire":IC+"medic.png",
  "T_TFBot_Sniper_Huntsman":IC+"sniper_bow.png","T_TFBot_Sniper_Huntsman_Spammer":IC+"sniper_bow_multi.png",
  "T_TFBot_Sniper":IC+"sniper.png","T_TFBot_Sniper_Razorback":IC+"sniper.png",
  "T_TFBot_Sniper_Sydney_Sleeper":IC+"sniper_sydneysleeper.png",
  "T_TFBot_Spy":IC+"spy.png",
  "T_TFBot_Engineer_Sentry_Teleporter":IC+"engineer.png","T_TFBot_Engineer_Sentry_Battle_TeleIn":IC+"engineer.png",
  "T_TFBot_Engineer_Sentry_Battle":IC+"engineer.png",
  "T_TFBot_Giant_Scout":IC+"scout.png","T_TFBot_Giant_Scout_Fast":IC+"scout_giant_fast.png",
  "T_TFBot_Giant_Scout_FAN":IC+"scout_fan.png","T_TFBot_Giant_Scout_Bonk":IC+"scout_bonk.png",
  "T_TFBot_Giant_Scout_Baseball":IC+"scout_stun.png","T_TFBot_Giant_Scout_Baseball_Armored":IC+"scout_stun_armored.png",
  "T_TFBot_Giant_Major_League":IC+"scout_stun.png","T_TFBot_Giant_Scout_Jumping_Sandman":IC+"scout_jumping.png",
  "T_TFBot_Giant_Soldier":IC+"soldier.png","T_TFBot_Giant_Soldier_Crit":IC+"soldier_crit.png",
  "T_TFBot_Giant_Soldier_Spammer":IC+"soldier_spammer.png","T_TFBot_Giant_Soldier_Spammer_Reload":IC+"soldier_spammer.png",
  "T_TFBot_Giant_Soldier_SlowBarrage":IC+"soldier_barrage.png",
  "T_TFBot_Giant_Soldier_Extended_Buff_Banner":IC+"soldier_buff.png",
  "T_TFBot_Giant_Soldier_Extended_Concheror":IC+"soldier_conch.png",
  "T_TFBot_Giant_Soldier_Extended_Battalion":IC+"soldier_backup.png",
  "T_TFBot_Giant_Soldier_RocketPush":IC+"soldier_libertylauncher.png",
  "T_TFBot_Giant_Soldier_RocketShotgun":IC+"soldier_blackbox.png",
  "T_TFBot_Giant_Pyro":IC+"pyro.png","T_TFBot_Giant_Pyro_Pusher":IC+"pyro.png",
  "T_TFBot_Giant_Pyro_Flare_Spammer":IC+"pyro_flare.png",
  "T_TFBot_Giant_Demoman":IC+"demo.png","T_TFBot_Giant_Demo_RapidFire":IC+"demo.png",
  "T_TFBot_Giant_Demo_Burst":IC+"demo_burst.png","T_TFBot_Giant_DemoMan_PrinceTavish":IC+"demoknight.png",
  "T_TFBot_Giant_Metalbeard":IC+"demoknight.png","T_TFBot_Giant_Demo_Spammer_Reload_Chief":IC+"demo.png",
  "T_TFBot_Giant_Heavyweapons":IC+"heavy.png","T_TFBot_Giant_Heavyweapons_Deflector":IC+"heavy_deflector.png",
  "T_TFBot_Giant_Heavyweapons_Shotgun":IC+"heavy_shotgun.png",
  "T_TFBot_Giant_Heavyweapons_HealOnKill":IC+"heavy_deflector_healonkill.png",
  "T_TFBot_Giant_Heavyweapons_BrassBeast":IC+"heavy.png",
  "T_TFBot_Giant_Heavyweapons_Natascha":IC+"heavy.png","T_TFBot_Giant_Boxing_Heavy":IC+"heavy_champ.png",
  "T_TFBot_Giant_Medic":IC+"medic.png","T_TFBot_Giant_Medic_Regen":IC+"medic.png",
  "T_TFBot_Chief_Soldier":IC+"soldier_sergeant_crits.png","T_TFBot_Chief_Pyro":IC+"pyro.png",
  "T_TFBot_Chief_Demo_Atomic":IC+"demo_bomber.png","T_TFBot_Chief_Tavish":IC+"demoknight.png",
  "T_TFBot_Chief_Gauntlet":IC+"heavy_chief.png","T_TFBot_Chief_Heavyweapons_HealOnKill":IC+"heavy_deflector_healonkill.png",
  "T_TFBot_Chief_Soldier_Atomic":IC+"soldier_sergeant_crits.png",
  "T_TFBot_Chief_Soldier_SlowCrit":IC+"soldier_sergeant_crits.png",
  "T_TFBot_Chief_Soldier_RocketPush":IC+"soldier_libertylauncher.png",
  "T_TFBot_Chief_Soldier_Extended_Concheror":IC+"soldier_conch.png",
  "T_TFBot_SentryBuster":IC+"sentry_buster.png",
};
// Gatebots use same icons as their base class
["T_TFGateBot_Scout_Normal","T_TFGateBot_Scout_Hard"].forEach(k=>{ICON_MAP[k]=IC+"scout.png";});
["T_TFGateBot_Scout_FAN","T_TFGateBot_Scout_FAN_Crit"].forEach(k=>{ICON_MAP[k]=IC+"scout_fan.png";});
ICON_MAP["T_TFGateBot_Scout_Melee"]=IC+"scout_bat.png";
ICON_MAP["T_TFGateBot_Scout_Sandman_FastCharge"]=IC+"scout_stun.png";
["T_TFGateBot_Soldier_Easy","T_TFGateBot_Soldier_Normal","T_TFGateBot_Soldier_Hard"].forEach(k=>{ICON_MAP[k]=IC+"soldier.png";});
ICON_MAP["T_TFGateBot_Soldier_Normal_DirectHit_Crit"]=IC+"soldier_crit.png";
["T_TFGateBot_Soldier_Extended_Concheror_Normal","T_TFGateBot_Soldier_Extended_Concheror_Normal_Crit"].forEach(k=>{ICON_MAP[k]=IC+"soldier_conch.png";});
ICON_MAP["T_TFGateBot_Soldier_Extended_Battalion_Hard"]=IC+"soldier_backup.png";
ICON_MAP["T_TFGateBot_Soldier_RocketPush"]=IC+"soldier_libertylauncher.png";
ICON_MAP["T_TFGateBot_Soldier_RocketShotgun_Expert"]=IC+"soldier_blackbox.png";
["T_TFGateBot_Pyro_Normal","T_TFGateBot_Pyro_Hard","T_TFGateBot_Pyro_Expert","T_TFGateBot_Pyro_AlwaysFireWeapon"].forEach(k=>{ICON_MAP[k]=IC+"pyro.png";});
ICON_MAP["T_TFGateBot_Pyro_Flaregun"]=IC+"pyro_flare.png";
["T_TFGateBot_Demoman_Easy","T_TFGateBot_Demoman_Normal","T_TFGateBot_Demoman_Hard"].forEach(k=>{ICON_MAP[k]=IC+"demo.png";});
["T_TFGateBot_Demo_Burst_Normal","T_TFGateBot_Demo_Burst_Normal_Crit"].forEach(k=>{ICON_MAP[k]=IC+"demo_burst.png";});
["T_TFGateBot_Heavy_Easy","T_TFGateBot_Heavy_Normal","T_TFGateBot_Heavy_Normal_Crit","T_TFGateBot_Heavy_Hard","T_TFGateBot_Heavy_Expert_Crit"].forEach(k=>{ICON_MAP[k]=IC+"heavy.png";});
["T_TFGateBot_Heavy_IronFist","T_TFGateBot_Heavy_IronFist_Crit","T_TFGateBot_Heavy_IronFist_Airblast"].forEach(k=>{ICON_MAP[k]=IC+"heavy_steelfist.png";});
ICON_MAP["T_TFGateBot_Heavyweapons_Shotgun"]=IC+"heavy_shotgun.png";
ICON_MAP["T_TFGateBot_Sniper_Huntsman_Spammer_Crit"]=IC+"sniper_bow_multi.png";
ICON_MAP["T_TFGateBot_Giant_Scout_FAN"]=IC+"scout_fan.png";
["T_TFGateBot_Giant_Soldier","T_TFGateBot_Giant_Soldier_Spammer","T_TFGateBot_Giant_Soldier_Spammer_Crit","T_TFGateBot_Giant_Soldier_Spammer_Reload"].forEach(k=>{ICON_MAP[k]=IC+"soldier_spammer.png";});
["T_TFGateBot_Giant_Soldier_SlowBarrage","T_TFGateBot_Giant_Soldier_SlowCritBarrage"].forEach(k=>{ICON_MAP[k]=IC+"soldier_barrage.png";});
["T_TFGateBot_Giant_Soldier_BurstFire","T_TFGateBot_Giant_Soldier_BurstFire_Crit"].forEach(k=>{ICON_MAP[k]=IC+"soldier_burstfire.png";});
["T_TFGateBot_Giant_Soldier_Extended_Concheror","T_TFGateBot_Giant_Soldier_Extended_Concheror_Crit"].forEach(k=>{ICON_MAP[k]=IC+"soldier_conch.png";});
ICON_MAP["T_TFGateBot_Giant_Soldier_RocketPush"]=IC+"soldier_libertylauncher.png";
ICON_MAP["T_TFGateBot_Giant_Soldier_RocketShotgun"]=IC+"soldier_blackbox.png";
["T_TFGateBot_Giant_Pyro_AlwaysFire","T_TFGateBot_Giant_Pyro_AlwaysFire_Crit"].forEach(k=>{ICON_MAP[k]=IC+"pyro.png";});
["T_TFGateBot_Giant_Demo_Burst","T_TFGateBot_Giant_Demo_Burst_Crit"].forEach(k=>{ICON_MAP[k]=IC+"demo_burst.png";});
["T_TFGateBot_Giant_Heavyweapons_Deflector"].forEach(k=>{ICON_MAP[k]=IC+"heavy_deflector.png";});
ICON_MAP["T_TFGateBot_Giant_Heavyweapons_HealOnKill"]=IC+"heavy_deflector_healonkill.png";
ICON_MAP["T_TFGateBot_Giant_Heavyweapons_Heater"]=IC+"heavy_heater.png";
["T_TFGateBot_Giant_Heavyweapons_Shotgun","T_TFGateBot_Giant_Heavyweapons_Shotgun_Crit"].forEach(k=>{ICON_MAP[k]=IC+"heavy_shotgun.png";});
ICON_MAP["T_TFGateBot_Chief_Soldier_SlowCritBarrage"]=IC+"soldier_sergeant_crits.png";
ICON_MAP["T_TFGateBot_Chief_Heavyweapons_HealOnKill"]=IC+"heavy_deflector_healonkill.png";

function getIcon(tmpl) { return ICON_MAP[tmpl] || null; }
 
const UNKNOWN_COLORS = ["#f0c020","#4fc3f7","#f0c020","#4caf50","#ce93d8","#ff8a65","#81d4fa","#aed581","#f48fb1","#ffcc80"];
function unknownColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return UNKNOWN_COLORS[Math.abs(h) % UNKNOWN_COLORS.length];
}
 
const SKILLS = ["Easy","Normal","Hard","Expert"];
const WS_ATTRS = ["AlwaysCrit","AlwaysFireWeapon","SpawnWithFullCharge","IgnoreFlag","AutoJump"];
const ALL_ATTRS = ["AlwaysCrit","AlwaysFireWeapon","SpawnWithFullCharge","MiniBoss","IgnoreFlag","IgnoreEnemies","HoldFireUntilFullReload","UseBossHealthBar","Parachute","ProjectileShield","AutoJump","BulletImmune","BlastImmune","FireImmune","Aggressive","DisableDodge","SuppressFire","AirChargeOnly","VaccinatorBullets","VaccinatorBlast","VaccinatorFire"];
const CLASSES = ["Scout","Soldier","Pyro","Demoman","Heavyweapons","Engineer","Medic","Sniper","Spy"];
 
 
let _id = 0;
const mkId = () => "id" + (++_id) + "_" + Date.now();
 
function makeBot() {
  return { id: mkId(), template: "Class Scout", skill: "Hard", attributes: [] };
}
function makeWS() {
  return { 
    id: mkId(), 
    name: "", 
    where: "spawnbot", 
    totalCount: 20, 
    maxActive: 8, 
    spawnCount: 4, 
    waitBefore: 0, 
    waitBetween: 8, 
    totalCurrency: 100, 
    waitDead: "", 
    waitSpawned: "", 
    support: "none", 
    type: "single", 
    bots: [makeBot()], 
    squadBots: [makeBot()], 
    randomBots: [makeBot(), makeBot()], 
    tank: { health: 20000, speed: 75, name: "tankboss", skin: 0, path: "boss_path_a1" }, 
    override: "" 
  };
}
function makeCustomBot() {
  return { id: mkId(), tName: "MyCustomBot", cls: "Scout", dName: "Custom Bot", skill: "Hard", health: "", scale: "", icon: "", wr: "", bm: "", mvr: "", items: [""], attrs: [], cAttrs: [{ k: "", v: "" }], iAttrs: [{ item: "", rows: [{ k: "", v: "" }] }], override: "" };
}
 
const INLINE_BOTS = {
  "T_TFBot_Giant_Heavyweapons_HealOnKill": [
    'Class Heavyweapons',
    'Name "Giant Heal-on-Kill Heavy"',
    'ClassIcon heavy_deflector_healonkill',
    'Skill Expert',
    'Item "The Tungsten Toque"',
    'Item "Deflector"',
    'Health 5500',
    'MaxVisionRange 1600',
    'Attributes UseBossHealthBar',
    'WeaponRestrictions PrimaryOnly',
    'Attributes MiniBoss',
    'ItemAttributes',
    '{',
    '    ItemName "Deflector"',
    '    "damage bonus" 1.2',
    '    "attack projectiles" 2',
    '    "heal on kill" 5000',
    '}',
    'CharacterAttributes',
    '{',
    '    "move speed bonus" 0.4',
    '    "damage force reduction" 0.3',
    '    "airblast vulnerability multiplier" 0.4',
    '    "airblast vertical vulnerability multiplier" 0.1',
    '    "rage giving scale" 0.9',
    '    "override footstep sound set" 2',
    '}',
  ],
};

function genBotCode(b, ind) {
  const p = " ".repeat(ind);
  const L = [p + "TFBot", p + "{"];
  if (INLINE_BOTS[b.template]) {
    INLINE_BOTS[b.template].forEach(line => L.push(p + "    " + line));
  } else if (b.template.startsWith("Class ")) {
    L.push(p + "    Class " + b.template.slice(6));
    if (b.skill) L.push(p + "    Skill " + b.skill);
  } else {
    L.push(p + "    Template " + b.template);
    if (b.skill) L.push(p + "    Skill " + b.skill);
  }
  b.attributes.forEach(a => L.push(p + "    Attributes " + a));
  (b.extra || []).forEach(line => L.push(p + "    " + line));
  L.push(p + "}");
  return L.join("\n");
}
 
function genWSCode(sp) {
  const L = ["WaveSpawn", "{"];
  if (sp.name && String(sp.name).trim()) {
    L.push('    Name "' + String(sp.name).trim() + '"');
  }
  if (sp.waitDead && String(sp.waitDead).trim()) {
    L.push('    WaitForAllDead "' + String(sp.waitDead).trim() + '"');
  }
  if (sp.waitSpawned && String(sp.waitSpawned).trim()) {
    L.push('    WaitForAllSpawned "' + String(sp.waitSpawned).trim() + '"');
  }
  
  if (sp.type === "tank") {
    const k = sp.fromTank && sp.tankKeep ? sp.tankKeep : { total: 1, max: 1, spawn: 1, between: 0 };
    L.push("    TotalCount " + k.total, "    MaxActive " + k.max, "    SpawnCount " + k.spawn, "    WaitBeforeStarting " + sp.waitBefore, "    WaitBetweenSpawns " + k.between, "    TotalCurrency " + sp.totalCurrency);
    (sp.extra || []).forEach(x => L.push("    " + x));
    if (!sp.fromTank) L.push("", "    FirstSpawnOutput", "    {", "        Target boss_spawn_relay", "        Action Trigger", "    }");
    L.push("", "    Tank", "    {", '        Name "' + sp.tank.name + '"', "        Health " + sp.tank.health, "        Speed " + sp.tank.speed);
    if (sp.tank.skin) L.push("        Skin " + sp.tank.skin);
    L.push('        StartingPathTrackNode "' + sp.tank.path + '"');
    if (sp.fromTank && sp.tank.extra) sp.tank.extra.forEach(x => L.push("        " + x));
    else L.push("", "        OnKilledOutput", "        {", "            Target boss_dead_relay", "            Action Trigger", "        }", "        OnBombDroppedOutput", "        {", "            Target boss_deploy_relay", "            Action Trigger", "        }");
    L.push("    }");
  } else {
    L.push("    Where " + sp.where, "    TotalCount " + sp.totalCount, "    MaxActive " + sp.maxActive, "    SpawnCount " + sp.spawnCount, "    WaitBeforeStarting " + sp.waitBefore, "    " + (sp.betweenAfterDeath ? "WaitBetweenSpawnsAfterDeath " : "WaitBetweenSpawns ") + sp.waitBetween, "    TotalCurrency " + sp.totalCurrency);
    if (sp.support === "1") L.push("    Support 1");
    if (sp.support === "limited") L.push("    Support Limited");
    (sp.extra || []).forEach(x => L.push("    " + x));
    if (sp.type === "single") L.push("", genBotCode(sp.bots[0], 4));
    else if (sp.type === "squad") { L.push("", "    Squad", "    {"); sp.squadBots.forEach(b => L.push(genBotCode(b, 8))); L.push("    }"); }
    else if (sp.type === "random") { L.push("", "    RandomChoice", "    {"); sp.randomBots.forEach(b => L.push(genBotCode(b, 8))); L.push("    }"); }
  }
  L.push("}");
  return L.join("\n");
}
 
function genCustom(c) {
  const L = [c.tName, "{"];
  L.push('    Name "' + c.dName + '"', "    Class " + c.cls, "    Skill " + c.skill);
  if (c.health) L.push("    Health " + c.health);
  if (c.scale) L.push("    Scale " + c.scale);
  if (c.icon) L.push("    ClassIcon " + c.icon);
  if (c.wr) L.push("    WeaponRestrictions " + c.wr);
  if (c.bm) L.push("    BehaviorModifiers " + c.bm);
  if (c.mvr) L.push("    MaxVisionRange " + c.mvr);
  c.items.filter(Boolean).forEach(i => L.push('    Item "' + i + '"'));
  c.attrs.forEach(a => L.push("    Attributes " + a));
  const ca = c.cAttrs.filter(r => r.k && r.v);
  if (ca.length) { L.push("    CharacterAttributes", "    {"); ca.forEach(r => L.push('        "' + r.k + '" ' + r.v)); L.push("    }"); }
  c.iAttrs.forEach(ia => {
    const rows = ia.rows.filter(r => r.k && r.v);
    if (ia.item && rows.length) { L.push("    ItemAttributes", "    {"); L.push('        ItemName "' + ia.item + '"'); rows.forEach(r => L.push('        "' + r.k + '" ' + r.v)); L.push("    }"); }
  });
  L.push("}");
  return L.join("\n");
}
 
function genPop(g, mis, wavs, cust) {
  const bases = ["robot_giant.pop", "robot_standard.pop", "robot_gatebot.pop"];
  (g.bases || []).forEach(f => { if (!bases.includes(f)) bases.push(f); });
  const L = bases.map(f => "#base " + f);
  L.push("", "WaveSchedule", "{", "    StartingCurrency " + g.money, "    RespawnWaveTime " + g.respawn, "    CanBotsAttackWhileInSpawnRoom " + g.attack, "    Advanced " + g.adv);
  if (g.extra) g.extra.split("\n").filter(x => x.trim()).forEach(x => L.push("    " + x.trim()));
  if (cust.length) {
    L.push("", "    Templates", "    {");
    cust.forEach(c => { L.push(""); const code = c.override || genCustom(c); code.split("\n").forEach(x => L.push("        " + x)); });
    L.push("    }");
  }
  L.push("");
  mis.forEach((m) => {
    L.push("    Mission", "    {", "        Objective " + m.obj, "        InitialCooldown " + m.ic, "        Where " + m.where, "        BeginAtWave " + m.bw, "        RunForThisManyWaves " + m.rw, "        CooldownTime " + m.ct);
    if (m.dc !== "" && m.dc != null) L.push("        DesiredCount " + m.dc);
    (m.mextra || []).forEach(x => L.push("        " + x));
    const tm = String(m.tmpl || "");
    L.push("", "        TFBot", "        {", tm.startsWith("Class ") ? "            Class " + tm.slice(6) : "            Template " + tm);
    if (m.skill) L.push("            Skill " + m.skill);
    (m.extra || []).forEach(x => L.push("            " + x));
    L.push("        }", "    }", "");
  });
  wavs.forEach((wave) => {
    L.push("    Wave", "    {");
    if (wave.extra) wave.extra.forEach(x => L.push("        " + x));
    else L.push("        StartWaveOutput", "        {", "            Target wave_start_relay", "            Action Trigger", "        }", "        DoneOutput", "        {", "            Target wave_finished_relay", "            Action Trigger", "        }");
    L.push("");
    wave.spawns.forEach(sp => {
      const code = sp.override ? sp.override : genWSCode(sp);
      code.split("\n").forEach(x => L.push(x ? "        " + x : x));
      L.push("");
    });
    L.push("    }", "");
  });
  L.push("}");
  return L.join("\n");
}
 
// ── Styles ──
const dark = { bg: "#0a0a0a", card: "#141414", ci: "#0d0d0d", bd: "#2a2a2a", ac: "#f0c020", ac2: "#f5a623", tx: "#e0e0e0", txd: "#777", ib: "#1a1a1a", it: "#e0e0e0", ibd: "#333" };
const light = { bg: "#f2f0ed", card: "#fff", ci: "#f7f6f4", bd: "#d4d0ca", ac: "#c9a227", ac2: "#d48c1a", tx: "#1a1a1a", txd: "#888", ib: "#fff", it: "#1a1a1a", ibd: "#ccc" };
 
function Inp({ t, label, value, onChange, type, width }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <label style={{ fontSize: 10, color: t.txd, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 700 }}>{label}</label>
      <input type={type || "number"} value={value} onChange={e => onChange(type === "text" ? e.target.value : Number(e.target.value))} style={{ background: t.ib, color: t.it, border: "1px solid " + t.ibd, borderRadius: 4, padding: "6px 8px", fontSize: 13, fontFamily: "monospace", width: width || 80 }} />
    </div>
  );
}
 
function Sel({ t, label, value, onChange, children, width }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <label style={{ fontSize: 10, color: t.txd, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 700 }}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} style={{ background: t.ib, color: t.it, border: "1px solid " + t.ibd, borderRadius: 4, padding: "6px 8px", fontSize: 13, fontFamily: "monospace", cursor: "pointer", minWidth: width || 120 }}>{children}</select>
    </div>
  );
}
 
function BotDropdown({ t, value, onChange, customBots }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const customNames = (customBots || []).map(c => c.tName).filter(Boolean);
  const display = value.replace("T_TFBot_", "").replace("T_TFGateBot_", "GB: ").replace("Class ", "\u2B21 ");
  const icon = getIcon(value);
 
  const allItems = [];
  if (customNames.length > 0) {
    allItems.push({ cat: "\u2B50 Custom Bots", items: customNames.map(n => ({ val: n, label: n, icon: null })), color: "#4fc3f7" });
  }
  Object.entries(TEMPLATES).forEach(([cat, list]) => {
    const isGiant = cat.startsWith("Giant");
    const isChief = cat === "Chief" || cat.indexOf("Gatebot Chief") >= 0;
    const isGate = cat.indexOf("Gatebot") >= 0 && !isChief;
    const color = isChief ? "#f0c020" : isGate ? "#f0c020" : isGiant ? "#4caf50" : t.it;
    allItems.push({
      cat, color,
      items: list.map(tm => ({
        val: tm,
        label: tm.replace("T_TFBot_", "").replace("T_TFGateBot_", "GB: ").replace("Class ", "\u2B21 "),
        icon: getIcon(tm)
      }))
    });
  });
 
  const filtered = search ? allItems.map(g => ({
    ...g,
    items: g.items.filter(it => it.label.toLowerCase().includes(search.toLowerCase()) || it.val.toLowerCase().includes(search.toLowerCase()))
  })).filter(g => g.items.length > 0) : allItems;
 
  return (
    <div style={{ position: "relative", minWidth: 220 }}>
      <div onClick={() => setOpen(!open)} style={{ background: t.ib, border: "1px solid " + t.ibd, borderRadius: 4, padding: "5px 8px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontFamily: "monospace", color: t.it }}>
        {icon ? <img src={icon} alt="" style={{ width: 20, height: 20, imageRendering: "pixelated" }} /> : <span style={{ fontSize: 16, fontWeight: 900, color: unknownColor(value), lineHeight: 1 }}>?</span>}
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{display}</span>
        <span style={{ fontSize: 10, opacity: 0.5 }}>{open ? "\u25B2" : "\u25BC"}</span>
      </div>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 999, background: t.ib, border: "1px solid " + t.ibd, borderRadius: "0 0 4px 4px", maxHeight: 350, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
          <div style={{ position: "sticky", top: 0, background: t.ib, padding: 4, borderBottom: "1px solid " + t.ibd }}>
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." style={{ width: "100%", background: t.bg, color: t.it, border: "1px solid " + t.ibd, borderRadius: 3, padding: "4px 6px", fontSize: 12, fontFamily: "monospace", outline: "none" }} />
          </div>
          {filtered.map(g => (
            <div key={g.cat}>
              <div style={{ padding: "4px 8px", fontSize: 10, fontWeight: 700, color: g.color, textTransform: "uppercase", letterSpacing: 0.5, background: t.bg, position: "sticky", top: 32 }}>{g.cat}</div>
              {g.items.map(it => (
                <div key={it.val} onClick={() => { onChange(it.val); setOpen(false); setSearch(""); }}
                  style={{ padding: "4px 8px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontFamily: "monospace", color: g.color, background: it.val === value ? (t.bg === "#0a0a0a" ? "#222" : "#e8e4df") : "transparent" }}
                  onMouseEnter={e => { e.currentTarget.style.background = t.bg === "#0a0a0a" ? "#1a1a1a" : "#ede9e4"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = it.val === value ? (t.bg === "#0a0a0a" ? "#222" : "#e8e4df") : "transparent"; }}>
                  {it.icon ? <img src={it.icon} alt="" style={{ width: 18, height: 18, imageRendering: "pixelated" }} /> : <span style={{ fontSize: 14, fontWeight: 900, color: unknownColor(it.val), width: 18, textAlign: "center" }}>?</span>}
                  <span>{it.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ClassIconDropdown({ t, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  
  // Extract all unique icon keys from ICON_MAP
  const allIcons = Object.keys(ICON_MAP).map(k => ICON_MAP[k]).reduce((acc, path) => {
    // Find keys matching this path or build a clean list from ICON_MAP entries
    return acc;
  }, []);

  const iconEntries = Object.entries(ICON_MAP).map(([tmpl, path]) => {
    // Derive a clean icon token name from the path or key
    const iconName = path.replace(IC, "").replace(".png", "");
    return { val: iconName, path };
  });

  // Deduplicate by icon filename token
  const uniqueIcons = [];
  const seenPaths = new Set();
  for (const entry of iconEntries) {
    if (!seenPaths.has(entry.path)) {
      seenPaths.add(entry.path);
      uniqueIcons.push(entry);
    }
  }

  const filtered = search 
    ? uniqueIcons.filter(it => it.val.toLowerCase().includes(search.toLowerCase()))
    : uniqueIcons;

  const currentPath = value ? IC + value + ".png" : null;

  return (
    <div style={{ position: "relative", minWidth: 180 }}>
      <div onClick={() => setOpen(!open)} style={{ background: t.ib, border: "1px solid " + t.ibd, borderRadius: 4, padding: "5px 8px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontFamily: "monospace", color: t.it }}>
        {currentPath ? <img src={currentPath} alt="" style={{ width: 20, height: 20, imageRendering: "pixelated", onError: (e) => { e.target.style.display = 'none'; } }} /> : <span style={{ fontSize: 14, fontWeight: 900, color: t.txd, lineHeight: 1 }}>?</span>}
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value || "Select icon..."}</span>
        <span style={{ fontSize: 10, opacity: 0.5 }}>{open ? "\u25B2" : "\u25BC"}</span>
      </div>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 999, background: t.ib, border: "1px solid " + t.ibd, borderRadius: "0 0 4px 4px", maxHeight: 250, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
          <div style={{ position: "sticky", top: 0, background: t.ib, padding: 4, borderBottom: "1px solid " + t.ibd }}>
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search icon..." style={{ width: "100%", background: t.bg, color: t.it, border: "1px solid " + t.ibd, borderRadius: 3, padding: "4px 6px", fontSize: 12, fontFamily: "monospace", outline: "none" }} />
          </div>
          <div onClick={() => { onChange(""); setOpen(false); setSearch(""); }} style={{ padding: "4px 8px", cursor: "pointer", fontSize: 12, fontFamily: "monospace", color: t.txd, borderBottom: "1px solid " + t.ibd }}>
            (None / Default)
          </div>
          {filtered.map(it => (
            <div key={it.val} onClick={() => { onChange(it.val); setOpen(false); setSearch(""); }}
              style={{ padding: "4px 8px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontFamily: "monospace", color: t.it, background: it.val === value ? (t.bg === "#0a0a0a" ? "#222" : "#e8e4df") : "transparent" }}
              onMouseEnter={e => { e.currentTarget.style.background = t.bg === "#0a0a0a" ? "#1a1a1a" : "#ede9e4"; }}
              onMouseLeave={e => { e.currentTarget.style.background = it.val === value ? (t.bg === "#0a0a0a" ? "#222" : "#e8e4df") : "transparent"; }}>
              <img src={it.path} alt="" style={{ width: 18, height: 18, imageRendering: "pixelated" }} />
              <span>{it.val}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
 
function BotPicker({ t, bot, onChange, label, attrList, customBots }) {
  const isCl = bot.template.startsWith("Class ");
  const attrs = attrList || WS_ATTRS;
  return (
    <div style={{ background: t.ci, borderRadius: 6, padding: 10, marginBottom: 8, border: "1px solid " + t.bd }}>
      {label && <div style={{ fontSize: 11, color: t.txd, marginBottom: 6, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
        <BotDropdown t={t} value={bot.template} customBots={customBots} onChange={nv => {
          onChange({ ...bot, template: nv, skill: nv.startsWith("Class ") ? (bot.skill || "Hard") : "" });
        }} />
        {isCl ? (
          <select value={bot.skill || "Hard"} onChange={e => onChange({ ...bot, skill: e.target.value })} style={{ background: t.ib, color: t.it, border: "1px solid " + t.ibd, borderRadius: 4, padding: "6px 8px", fontSize: 13, fontFamily: "monospace", width: 90 }}>
            {SKILLS.map(s => <option key={s}>{s}</option>)}
          </select>
        ) : (
          <select value={bot.skill || ""} onChange={e => onChange({ ...bot, skill: e.target.value })} style={{ background: t.ib, color: t.it, border: "1px solid " + t.ibd, borderRadius: 4, padding: "6px 8px", fontSize: 13, fontFamily: "monospace", width: 120, opacity: bot.skill ? 1 : 0.6 }}>
            <option value="">Default Skill</option>
            {SKILLS.map(s => <option key={s} value={s}>{"Override: " + s}</option>)}
          </select>
        )}
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {attrs.map(a => {
          const on = bot.attributes.includes(a);
          return (
            <label key={a} style={{ fontSize: 11, color: on ? t.ac : t.txd, cursor: "pointer", display: "flex", alignItems: "center", gap: 2 }}>
              <input type="checkbox" checked={on} onChange={e => onChange({ ...bot, attributes: e.target.checked ? [...bot.attributes, a] : bot.attributes.filter(x => x !== a) })} style={{ width: 12, height: 12 }} />{a}
            </label>
          );
        })}
      </div>
    </div>
  );
}
 
function isGiantTemplate(tmpl) {
  return tmpl && (tmpl.indexOf("Giant") >= 0 || tmpl.indexOf("Chief") >= 0);
}
 
function getBotsFromSpawn(sp) {
  // Returns array of { tmpl, icon, crit, giant, count }
  if (sp.type === "tank") return [{ tmpl: "__tank__", icon: IC + "tank.png", crit: false, giant: true, count: sp.fromTank && sp.tankKeep ? sp.tankKeep.total : 1 }];
  const count = sp.totalCount;
  const isBig = (b) => isGiantTemplate(b.template) || (b.attributes || []).includes("MiniBoss");
  if (sp.type === "single" && sp.bots[0]) {
    const b = sp.bots[0];
    return [{ tmpl: b.template, icon: getIcon(b.template), crit: (b.attributes || []).includes("AlwaysCrit"), giant: isBig(b), count }];
  }
  if (sp.type === "squad") {
    const perMember = Math.max(1, Math.floor(count / (sp.squadBots || []).length));
    return (sp.squadBots || []).map(b => ({
      tmpl: b.template, icon: getIcon(b.template), crit: (b.attributes || []).includes("AlwaysCrit"), giant: isBig(b), count: perMember
    }));
  }
  if (sp.type === "random" && sp.randomBots && sp.randomBots.length) {
    // RandomChoice picks uniformly, so each entry gets an equal share of TotalCount (expected value)
    const n = sp.randomBots.length;
    const groups = [];
    sp.randomBots.forEach(b => {
      const key = b.template + "|" + (b.attributes || []).slice().sort().join(",");
      const ex = groups.find(g => g.key === key);
      if (ex) ex.n++; else groups.push({ key, bot: b, n: 1 });
    });
    return groups.map(g => ({
      tmpl: g.bot.template, icon: getIcon(g.bot.template), crit: (g.bot.attributes || []).includes("AlwaysCrit"),
      giant: isBig(g.bot), count: Math.round(count * g.n / n)
    }));
  }
  return [];
}
 
function WaveBar({ wave, t, missions, waveIndex }) {
  const normal = [];
  const support = [];
 
  wave.spawns.forEach(sp => {
    const isSupport = sp.support === "1" || sp.support === "limited";
    const target = isSupport ? support : normal;
    const bots = getBotsFromSpawn(sp);
    bots.forEach(b => {
      const key = (b.icon || ("?" + b.tmpl)) + (b.crit ? ":crit" : "") + (b.giant ? ":giant" : "");
      const existing = target.find(e => e.key === key);
      if (existing) {
        existing.count += b.count;
      } else {
        target.push({ key, icon: b.icon, crit: b.crit, giant: b.giant, count: b.count, tmpl: b.tmpl });
      }
    });
  });
 
  // Add mission bots (sentry busters, spies, snipers, engineers) to support
  const wi = waveIndex + 1; // missions use 1-based wave numbers
  (missions || []).forEach(m => {
    if (wi >= m.bw && wi < m.bw + m.rw) {
      const icon = getIcon(m.tmpl);
      const tmpl = m.tmpl;
      const key = (icon || ("?" + tmpl)) + ":mission";
      const existing = support.find(e => e.key === key);
      if (!existing) {
        support.push({ key, icon, crit: false, giant: false, count: null, tmpl, isMission: true });
      }
    }
  });
 
  normal.sort((a, b) => (b.giant ? 1 : 0) - (a.giant ? 1 : 0));
  support.sort((a, b) => (b.giant ? 1 : 0) - (a.giant ? 1 : 0));

  const renderGroup = (items) => items.map((it, i) => {
    const borderColor = it.crit ? "#4fc3f7" : t.bd;
    const bgColor = it.giant ? "#6b1c1c" : t.ci;
    return (
      <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
        <div style={{ width: 32, height: 32, borderRadius: 4, border: "2px solid " + borderColor, background: bgColor, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {it.icon ? (
            <img src={it.icon} alt="" style={{ width: 24, height: 24, imageRendering: "pixelated" }} />
          ) : (
            <span style={{ fontSize: 18, fontWeight: 900, color: unknownColor(it.tmpl || it.key), lineHeight: 1 }}>?</span>
          )}
        </div>
        {it.count != null && <span style={{ fontSize: 11, fontWeight: 700, color: t.it }}>{it.count}</span>}
      </div>
    );
  });
 
  if (normal.length === 0 && support.length === 0) return null;
 
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, padding: "8px 0", flexWrap: "wrap" }}>
      {renderGroup(normal)}
      {support.length > 0 && (
        <>
          <div style={{ width: 2, height: 36, background: t.bd, margin: "0 4px", alignSelf: "center" }} />
          {renderGroup(support)}
          <span style={{ fontSize: 10, fontWeight: 700, color: t.txd, textTransform: "uppercase", alignSelf: "center" }}>Support</span>
        </>
      )}
    </div>
  );
}
 
export default function App() {
  const [g, sg] = useState({ money: 800, respawn: 6, attack: "no", adv: 1, map: "mvm_coaltown", extra: "" });
  const [mis, smis] = useState([{ id: mkId(), obj: "DestroySentries", ic: 20, where: "spawnbot", bw: 1, rw: 7, ct: 20, dc: 1, tmpl: "T_TFBot_SentryBuster" }]);
  const [wavs, swavs] = useState([{ id: mkId(), spawns: [makeWS()] }]);
  const [cust, scust] = useState([]);
  const [tab, stab] = useState("waves");
  const [aw, saw] = useState(0);
  const [prev, sprev] = useState(false);
  const [lm, slm] = useState(false);
  const [wsOpen, setWsOpen] = useState({});
  const isWsOpen = (id) => !!wsOpen[id];
  const toggleWs = (id) => setWsOpen((o) => ({ ...o, [id]: !o[id] }));

  // File session
  const [fileOpen, setFileOpen] = useState(false);
  const [popName, setPopName] = useState("");
  const [popOverride, setPopOverride] = useState(null); // raw .pop text when loaded/edited; null = use genPop
  const [previewEditing, setPreviewEditing] = useState(false);
  const [previewDraft, setPreviewDraft] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [saveList, setSaveList] = useState([]);
  const [loadConfirm, setLoadConfirm] = useState(null); // filename pending confirm
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [fsReady, setFsReady] = useState(false);
  const [toast, setToast] = useState("");
  const previewWrapRef = useRef(null);
  const filesMenuRef = useRef(null);

  const t = lm ? light : dark;
  const btn = { background: t.ac, color: "#fff", border: "none", borderRadius: 4, padding: "6px 14px", fontSize: 12, cursor: "pointer", fontWeight: 700 };
  const btn2 = { ...btn, background: t.bd, color: t.tx };
  const btnX = { ...btn, background: "#6b1c1c", padding: "4px 10px", fontSize: 11 };

  const currentWaveSpawns = wavs[aw] ? wavs[aw].spawns : [];
  const allNames = currentWaveSpawns.map(s => s.name).filter(Boolean);
  const generatedPf = genPop(g, mis, wavs, cust);
  const pf = popOverride != null ? popOverride : generatedPf;
  const wm = wavs[aw] ? wavs[aw].spawns.reduce((s, sp) => s + sp.totalCurrency, 0) : 0;

  // Create mpc_medallium (+ saves) on startup; warn if Electron bridge is missing
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!window.mpcFs) {
          console.warn(
            "[mpc] window.mpcFs is missing. preload.cjs was not loaded. " +
            "Saves will use localStorage only (not disk). Rebuild with preload.cjs in package.json build.files."
          );
        } else {
          const info = await mpcEnsureDirs();
          console.log("[mpc] dirs ready", info);
        }
      } catch (e) {
        console.warn("ensureDirs:", e);
      }
      if (!cancelled) setFsReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Close menus / cancel preview edit on outside click
  useEffect(() => {
    function onDoc(e) {
      if (filesMenuRef.current && !filesMenuRef.current.contains(e.target)) {
        setFilesOpen(false);
        setLoadOpen(false);
      }
      if (previewEditing && previewWrapRef.current && !previewWrapRef.current.contains(e.target)) {
        setPreviewEditing(false);
        setPreviewDraft("");
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [previewEditing]);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  }

  async function refreshSaveList() {
    try {
      const list = await mpcListSaves();
      setSaveList(list.filter((f) => String(f).toLowerCase().endsWith(".pop")));
    } catch (e) {
      console.warn(e);
      setSaveList([]);
    }
  }

  function resetProjectDefaults() {
    sg({ money: 800, respawn: 6, attack: "no", adv: 1, map: "mvm_coaltown", extra: "" });
    smis([{ id: mkId(), obj: "DestroySentries", ic: 20, where: "spawnbot", bw: 1, rw: 7, ct: 20, dc: 1, tmpl: "T_TFBot_SentryBuster" }]);
    swavs([{ id: mkId(), spawns: [makeWS()] }]);
    scust([]);
    saw(0);
    stab("waves");
    setWsOpen({});
    setPopOverride(null);
    setPreviewEditing(false);
    setPreviewDraft("");
    sprev(false);
  }

  function createNewPop() {
    const name = sanitizePopName(createName);
    if (!name) {
      alert("Please enter a name for the pop file.");
      return;
    }
    resetProjectDefaults();
    setPopName(name);
    setFileOpen(true);
    setCreateOpen(false);
    setCreateName("");
    setFilesOpen(false);
    showToast("Created " + name);
  }

  async function saveCurrentPop() {
    if (!fileOpen || !popName) {
      alert("No pop file is open.");
      return;
    }
    const filename = saveFilename(g.map, popName);
    const content = pf;
    try {
      await mpcEnsureDirs();
      const result = await mpcWriteSave(filename, content);
      const where = window.mpcFs
        ? (result && result.path ? result.path : filename)
        : ("localStorage (no disk bridge): " + filename);
      showToast("Saved " + where);
      setFilesOpen(false);
    } catch (e) {
      alert("Failed to save: " + (e && e.message ? e.message : e));
    }
  }

  async function openLoadMenu() {
    await refreshSaveList();
    setLoadOpen(true);
    setFilesOpen(true);
  }

  function requestLoad(filename) {
    setLoadConfirm(filename);
    setLoadOpen(false);
  }

  async function confirmLoadYes() {
    const filename = loadConfirm;
    setLoadConfirm(null);
    if (!filename) return;
    try {
      const content = await mpcReadSave(filename);
      if (content == null || content === "") {
        alert("Could not read " + filename);
        return;
      }
      const raw = String(content);

      // Derive display name + map from filename: mvm_coaltown_Name.pop -> map + Name
      let display = filename.replace(/\.pop$/i, "");
      let loadedMap = null;
      for (const m of MAPS) {
        if (display.startsWith(m + "_")) {
          loadedMap = m;
          display = display.slice(m.length + 1);
          break;
        }
      }

      // Parse .pop into form state (waves, missions, globals)
      const parsed = parsePop(raw);
      if (parsed) {
        const nextG = {
          ...parsed.g,
          map: loadedMap || parsed.g.map || g.map,
        };
        // Normalize spawns for the map
        nextG.map = MAPS.includes(nextG.map) ? nextG.map : (MAPS[0] || "mvm_coaltown");
        const fixedMis = (parsed.mis || []).map((m) => ({
          ...m,
          where: resolveSpawn(nextG.map, m.where),
        }));
        const fixedWavs = (parsed.wavs || []).map((w) => ({
          ...w,
          spawns: (w.spawns || []).map((sp) => ({
            ...sp,
            where: resolveSpawn(nextG.map, sp.where),
          })),
        }));
        sg(nextG);
        scust(parsed.cust || []);
        smis(fixedMis.length ? fixedMis : []);
        swavs(fixedWavs.length ? fixedWavs : [{ id: mkId(), spawns: [makeWS()] }]);
        saw(0);
        setWsOpen({});
      }

      setPopName(sanitizePopName(display) || "Loaded");
      // If we parsed into the form, drop the raw override so Waves/Missions drive
      // Preview + Save. If parse failed, keep the raw text in Preview only.
      setPopOverride(parsed ? null : raw);
      setFileOpen(true);
      setPreviewEditing(false);
      setPreviewDraft("");
      sprev(true);
      setFilesOpen(false);
      showToast(parsed
        ? ("Loaded " + filename + " into form" + (parsed.rawCount ? " (" + parsed.rawCount + " complex WaveSpawn" + (parsed.rawCount > 1 ? "s" : "") + " kept as raw text)" : ""))
        : ("Loaded " + filename + " (preview only — could not parse WaveSchedule)"));
    } catch (e) {
      alert("Failed to load: " + (e && e.message ? e.message : e));
    }
  }

  function startPreviewEdit() {
    setPreviewDraft(pf);
    setPreviewEditing(true);
  }

  function savePreviewEdit() {
    setPopOverride(previewDraft);
    setPreviewEditing(false);
    setPreviewDraft("");
    showToast("Preview changes saved");
  }

  function cancelPreviewEdit() {
    setPreviewEditing(false);
    setPreviewDraft("");
  }


  return (
    <div style={{ background: t.bg, color: t.tx, fontFamily: "system-ui, sans-serif", minHeight: "100vh" }}>
      <style>{`* { box-sizing: border-box; } button:hover { filter: brightness(1.15); } select { cursor: pointer; } ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-thumb { background: #555; border-radius: 3px; }`}</style>
 
      <div style={{ borderBottom: "2px solid " + t.ac, padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: t.ac, letterSpacing: 1.5, textTransform: "uppercase" }}>
          MvM Popfile Creator: Medallium{fileOpen && popName ? " (" + popName + ")" : ""}
        </h1>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => slm(!lm)} style={{ ...btn2, fontSize: 16, padding: "4px 10px" }} title="Toggle theme">{lm ? "\uD83C\uDF19" : "\u2600\uFE0F"}</button>
          <button
            onClick={() => { if (!fileOpen) { sprev(true); return; } sprev(!prev); }}
            style={{ ...btn, background: prev ? t.ac : t.bd, color: prev ? "#fff" : t.tx }}
          >
            {prev ? "Editor" : "Preview"}
          </button>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 20, right: 20, background: t.ac, color: "#111", padding: "10px 16px", borderRadius: 8, fontWeight: 700, fontSize: 13, zIndex: 9999, boxShadow: "0 4px 20px rgba(0,0,0,0.4)" }}>
          {toast}
        </div>
      )}

      {/* Create New dialog */}
      {createOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9000 }}>
          <div style={{ background: t.card, border: "1px solid " + t.bd, borderRadius: 10, padding: 20, width: 360, maxWidth: "90vw" }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12, color: t.ac }}>Create New Pop File</div>
            <label style={{ fontSize: 11, color: t.txd, textTransform: "uppercase", fontWeight: 700 }}>Name</label>
            <input
              autoFocus
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createNewPop(); if (e.key === "Escape") setCreateOpen(false); }}
              placeholder="e.g. BucketsAndBolts"
              style={{ width: "100%", marginTop: 4, marginBottom: 14, background: t.ib, color: t.it, border: "1px solid " + t.ibd, borderRadius: 4, padding: "8px 10px", fontSize: 14, fontFamily: "monospace" }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setCreateOpen(false)} style={btn2}>Cancel</button>
              <button onClick={createNewPop} style={btn}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Load confirm dialog */}
      {loadConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9000 }}>
          <div style={{ background: t.card, border: "1px solid " + t.bd, borderRadius: 10, padding: 20, width: 400, maxWidth: "90vw" }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8, color: t.tx }}>Do you want to load this .pop?</div>
            <div style={{ fontFamily: "monospace", fontSize: 13, color: t.ac, marginBottom: 16, wordBreak: "break-all" }}>{loadConfirm}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setLoadConfirm(null)} style={btn2}>No</button>
              <button onClick={confirmLoadYes} style={btn}>Yes</button>
            </div>
          </div>
        </div>
      )}

      {prev ? (
        <div ref={previewWrapRef} style={{ margin: 16 }}>
          {!fileOpen ? (
            <div style={{ background: t.ci, border: "1px solid " + t.bd, borderRadius: 8, padding: 40, textAlign: "center", color: t.txd, fontSize: 14 }}>
              No .pop file open
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                {!previewEditing ? (
                  <button onClick={startPreviewEdit} style={btn2}>Edit</button>
                ) : (
                  <>
                    <button onClick={savePreviewEdit} style={btn}>Save</button>
                    <button onClick={cancelPreviewEdit} style={btn2}>Cancel</button>
                    <span style={{ fontSize: 12, color: t.txd }}>Editing preview — click outside to cancel</span>
                  </>
                )}
                {popOverride != null && !previewEditing && (
                  <button onClick={() => { setPopOverride(null); showToast("Using form-generated pop"); }} style={{ ...btn2, fontSize: 11 }}>Reset to form-generated</button>
                )}
              </div>
              {previewEditing ? (
                <textarea
                  value={previewDraft}
                  onChange={(e) => setPreviewDraft(e.target.value)}
                  style={{ width: "100%", minHeight: "70vh", background: t.ci, border: "1px solid " + t.ac, borderRadius: 8, padding: 16, fontSize: 12, fontFamily: "monospace", color: t.tx, resize: "vertical", whiteSpace: "pre" }}
                />
              ) : (
                <pre style={{ margin: 0, background: t.ci, border: "1px solid " + t.bd, borderRadius: 8, padding: 16, fontSize: 12, fontFamily: "monospace", color: t.tx, overflow: "auto", maxHeight: "80vh", whiteSpace: "pre" }}>{pf}</pre>
              )}
            </>
          )}
        </div>
      ) : !fileOpen ? (
        <div style={{ padding: 16 }}>
          <div style={{ display: "flex", gap: 2, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }} ref={filesMenuRef}>
            <div style={{ position: "relative" }}>
              <button onClick={() => { setFilesOpen(!filesOpen); setLoadOpen(false); }} style={{ ...btn, background: filesOpen ? t.ac : t.card, color: filesOpen ? "#fff" : t.tx, borderRadius: "6px 6px 0 0", padding: "8px 16px", border: "1px solid " + t.bd }}>
                Files ▾
              </button>
              {filesOpen && (
                <div style={{ position: "absolute", top: "100%", left: 0, background: t.card, border: "1px solid " + t.bd, borderRadius: 6, minWidth: 200, zIndex: 50, boxShadow: "0 8px 24px rgba(0,0,0,0.45)", overflow: "hidden" }}>
                  <button onClick={() => { setCreateOpen(true); setFilesOpen(false); }} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: t.tx, padding: "10px 14px", cursor: "pointer", fontSize: 13 }}>
                    Create New Pop File
                  </button>
                  <button onClick={openLoadMenu} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: t.tx, padding: "10px 14px", cursor: "pointer", fontSize: 13, borderTop: "1px solid " + t.bd }}>
                    Load ▸
                  </button>
                  {loadOpen && (
                    <div style={{ borderTop: "1px solid " + t.bd, maxHeight: 240, overflow: "auto", background: t.ci }}>
                      {saveList.length === 0 && (
                        <div style={{ padding: "10px 14px", color: t.txd, fontSize: 12 }}>No .pop files in saves/</div>
                      )}
                      {saveList.map((f) => (
                        <button key={f} onClick={() => requestLoad(f)} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: t.tx, padding: "8px 14px", cursor: "pointer", fontSize: 12, fontFamily: "monospace" }}>
                          {f}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div style={{ background: t.card, border: "1px solid " + t.bd, borderRadius: 8, padding: 48, textAlign: "center", color: t.txd }}>
            <div style={{ fontSize: 16, marginBottom: 8 }}>No .pop file open</div>
            <div style={{ fontSize: 13 }}>Use <b style={{ color: t.ac }}>Files</b> to create a new pop or load one from mpc_medallium/saves</div>
          </div>
        </div>
      ) : (
        <div style={{ padding: 16 }}>
          <div style={{ display: "flex", gap: 2, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ position: "relative" }} ref={filesMenuRef}>
              <button onClick={() => { setFilesOpen(!filesOpen); setLoadOpen(false); }} style={{ ...btn, background: filesOpen ? t.ac : t.card, color: filesOpen ? "#fff" : t.tx, borderRadius: "6px 6px 0 0", padding: "8px 16px", border: "1px solid " + t.bd }}>
                Files ▾
              </button>
              {filesOpen && (
                <div style={{ position: "absolute", top: "100%", left: 0, background: t.card, border: "1px solid " + t.bd, borderRadius: 6, minWidth: 220, zIndex: 50, boxShadow: "0 8px 24px rgba(0,0,0,0.45)", overflow: "hidden" }}>
                  <button onClick={() => { setCreateOpen(true); setFilesOpen(false); }} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: t.tx, padding: "10px 14px", cursor: "pointer", fontSize: 13 }}>
                    Create New Pop File
                  </button>
                  <button onClick={openLoadMenu} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: t.tx, padding: "10px 14px", cursor: "pointer", fontSize: 13, borderTop: "1px solid " + t.bd }}>
                    Load ▸
                  </button>
                  {loadOpen && (
                    <div style={{ borderTop: "1px solid " + t.bd, maxHeight: 240, overflow: "auto", background: t.ci }}>
                      {saveList.length === 0 && (
                        <div style={{ padding: "10px 14px", color: t.txd, fontSize: 12 }}>No .pop files in saves/</div>
                      )}
                      {saveList.map((f) => (
                        <button key={f} onClick={() => requestLoad(f)} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: t.tx, padding: "8px 14px", cursor: "pointer", fontSize: 12, fontFamily: "monospace" }}>
                          {f}
                        </button>
                      ))}
                    </div>
                  )}
                  <button onClick={saveCurrentPop} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: t.tx, padding: "10px 14px", cursor: "pointer", fontSize: 13, borderTop: "1px solid " + t.bd }}>
                    Save
                  </button>
                </div>
              )}
            </div>
            {["waves", "missions", "bots", "globals"].map(tb => (
              <button key={tb} onClick={() => stab(tb)} style={{ ...btn, background: tab === tb ? t.ac : t.card, color: tab === tb ? "#fff" : t.tx, borderRadius: "6px 6px 0 0", padding: "8px 16px", border: "1px solid " + t.bd }}>
                {tb === "globals" ? "Settings" : tb === "missions" ? "Mission" : tb === "bots" ? "Bot Creator (" + cust.length + ")" : "Wave (" + wavs.length + ")"}
              </button>
            ))}
          </div>
 
          {tab === "globals" && (
            <div style={{ background: t.card, border: "1px solid " + t.bd, borderRadius: 8, padding: 16 }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Sel t={t} label="Map" value={g.map} onChange={v => {
                  sg({ ...g, map: v });
                  smis(mis.map(m => ({ ...m, where: resolveSpawn(v, m.where) })));
                  swavs(wavs.map(w => ({
                    ...w,
                    spawns: w.spawns.map(sp => ({ ...sp, where: resolveSpawn(v, sp.where) })),
                  })));
                }} width={180}>
                  {MAPS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </Sel>
                <Inp t={t} label="Starting $" value={g.money} onChange={v => sg({ ...g, money: v })} />
                <Inp t={t} label="Respawn" value={g.respawn} onChange={v => sg({ ...g, respawn: v })} />
                <Sel t={t} label="Bots Attack In Spawnroom" value={g.attack} onChange={v => sg({ ...g, attack: v })}><option value="no">No</option><option value="yes">Yes</option></Sel>
                <Sel t={t} label="Difficulty For Achievement Tracking" value={g.adv} onChange={v => sg({ ...g, adv: Number(v) })}><option value={0}>Normal</option><option value={1}>Advanced</option></Sel>
              </div>
              <div style={{ marginTop: 12 }}>
                <label style={{ fontSize: 10, color: t.txd, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 700 }}>Extra Settings (raw key-value lines)</label>
                <textarea value={g.extra || ""} onChange={e => sg({ ...g, extra: e.target.value })} placeholder={'e.g. EventPopfile Halloween\nFixedRespawnWaveTime Yes\nAddSentryBusterWhenDamageDealtExceeds 3000'} style={{ width: "100%", minHeight: 60, background: t.ib, color: t.it, border: "1px solid " + t.ibd, borderRadius: 4, padding: 6, fontSize: 12, fontFamily: "monospace", resize: "vertical", marginTop: 4 }} />
              </div>
            </div>
          )}
 
          {tab === "missions" && (
            <div>
              <button onClick={() => smis([...mis, { id: mkId(), obj: "Spy", ic: 90, where: "spawnbot", bw: 1, rw: 7, ct: 60, dc: 2, tmpl: "T_TFBot_Spy", skill: "" }])} style={{ ...btn, marginBottom: 12 }}>+ Mission</button>
              {mis.map((m, i) => (
                <div key={m.id} style={{ background: t.card, border: "1px solid " + t.bd, borderRadius: 8, padding: 12, marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontWeight: 700, color: t.ac }}>{m.obj}</span>
                    <button onClick={() => smis(mis.filter((_, j) => j !== i))} style={btnX}>X</button>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Sel t={t} label="Objective" value={m.obj} onChange={v => { const n = [...mis]; n[i] = { ...m, obj: v }; smis(n); }}>
                      {["DestroySentries", "Spy", "Sniper", "Engineer"].map(o => <option key={o}>{o}</option>)}
                    </Sel>
                    <Sel t={t} label="Spawn" value={resolveSpawn(g.map, m.where)} onChange={v => { const n = [...mis]; n[i] = { ...m, where: v }; smis(n); }} width={180}>
                      {getSpawnsForMap(g.map).map(s => <option key={s} value={s}>{s}</option>)}
                    </Sel>
                    <Inp t={t} label="Init Cooldown" value={m.ic} onChange={v => { const n = [...mis]; n[i] = { ...m, ic: v }; smis(n); }} />
                    <Inp t={t} label="Begin" value={m.bw} onChange={v => { const n = [...mis]; n[i] = { ...m, bw: v }; smis(n); }} />
                    <Inp t={t} label="Run" value={m.rw} onChange={v => { const n = [...mis]; n[i] = { ...m, rw: v }; smis(n); }} />
                    <Inp t={t} label="Cooldown" value={m.ct} onChange={v => { const n = [...mis]; n[i] = { ...m, ct: v }; smis(n); }} />
                    <Inp t={t} label="Count" value={m.dc} onChange={v => { const n = [...mis]; n[i] = { ...m, dc: v }; smis(n); }} />
                    <Inp t={t} label="Template" value={m.tmpl} onChange={v => { const n = [...mis]; n[i] = { ...m, tmpl: v }; smis(n); }} type="text" width={200} />
                    <Sel t={t} label="Skill Override" value={m.skill || ""} onChange={v => { const n = [...mis]; n[i] = { ...m, skill: v }; smis(n); }}>
                      <option value="">Default</option>
                      {SKILLS.map(s => <option key={s} value={s}>{s}</option>)}
                    </Sel>
                  </div>
                </div>
              ))}
            </div>
          )}
 
          {tab === "bots" && (
            <div>
              <button onClick={() => scust([...cust, makeCustomBot()])} style={{ ...btn, marginBottom: 12 }}>+ New Bot Template</button>
              {cust.map((c, ci) => {
                const uc = (k, v) => { const a = [...cust]; a[ci] = { ...a[ci], [k]: v }; scust(a); };
                return (
                  <div key={c.id} style={{ background: t.card, border: "1px solid " + t.bd, borderRadius: 8, padding: 16, marginBottom: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                      <span style={{ fontWeight: 700, color: t.ac, fontSize: 16 }}>{c.tName}</span>
                      <button onClick={() => scust(cust.filter((_, j) => j !== ci))} style={btnX}>X</button>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                      <Inp t={t} label="Template Name" value={c.tName} onChange={v => uc("tName", v)} type="text" width={180} />
                      <Sel t={t} label="Class" value={c.cls} onChange={v => uc("cls", v)}>{CLASSES.map(x => <option key={x}>{x}</option>)}</Sel>
                      <Inp t={t} label="Name" value={c.dName} onChange={v => uc("dName", v)} type="text" width={140} />
                      <Sel t={t} label="Skill" value={c.skill} onChange={v => uc("skill", v)}>{SKILLS.map(x => <option key={x}>{x}</option>)}</Sel>
                      <Inp t={t} label="Health" value={c.health} onChange={v => uc("health", v)} type="text" width={70} />
                      <Inp t={t} label="Scale" value={c.scale} onChange={v => uc("scale", v)} type="text" width={60} />
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <label style={{ fontSize: 10, color: t.txd, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 700 }}>ClassIcon</label>
                        <ClassIconDropdown t={t} value={c.icon} onChange={v => uc("icon", v)} />
                      </div>
                      <Inp t={t} label="MaxVision" value={c.mvr} onChange={v => uc("mvr", v)} type="text" width={80} />
                      <Sel t={t} label="WeaponRestrictions" value={c.wr} onChange={v => uc("wr", v)}><option value="">None</option><option>PrimaryOnly</option><option>SecondaryOnly</option><option>MeleeOnly</option></Sel>
                      <Sel t={t} label="BehaviorModifiers" value={c.bm} onChange={v => uc("bm", v)}><option value="">None</option><option>Mobber</option><option>Push</option></Sel>
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <label style={{ fontSize: 10, color: t.txd, textTransform: "uppercase", fontWeight: 700 }}>Items</label>
                      {c.items.map((it, ii) => (
                        <div key={ii} style={{ display: "flex", gap: 4, marginTop: 4 }}>
                          <input value={it} onChange={e => { const a = [...c.items]; a[ii] = e.target.value; uc("items", a); }} style={{ flex: 1, background: t.ib, color: t.it, border: "1px solid " + t.ibd, borderRadius: 4, padding: "4px 8px", fontSize: 12, fontFamily: "monospace" }} />
                          <button onClick={() => uc("items", c.items.filter((_, j) => j !== ii))} style={btnX}>X</button>
                        </div>
                      ))}
                      <button onClick={() => uc("items", [...c.items, ""])} style={{ ...btn2, marginTop: 4, fontSize: 11, padding: "3px 10px" }}>+ Item</button>
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <label style={{ fontSize: 10, color: t.txd, textTransform: "uppercase", fontWeight: 700, display: "block", marginBottom: 4 }}>Attributes</label>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {ALL_ATTRS.map(a => {
                          const on = c.attrs.includes(a);
                          return (<label key={a} style={{ fontSize: 10, color: on ? t.ac : t.txd, cursor: "pointer", display: "flex", alignItems: "center", gap: 2 }}><input type="checkbox" checked={on} onChange={e => uc("attrs", e.target.checked ? [...c.attrs, a] : c.attrs.filter(x => x !== a))} style={{ width: 11, height: 11 }} />{a}</label>);
                        })}
                      </div>
                    </div>
                    <div style={{ background: t.ci, borderRadius: 6, padding: 10, marginBottom: 8, border: "1px solid " + t.bd }}>
                      <label style={{ fontSize: 10, color: t.ac2, textTransform: "uppercase", fontWeight: 700 }}>CharacterAttributes</label>
                      {c.cAttrs.map((r, ri) => (
                        <div key={ri} style={{ display: "flex", gap: 4, marginTop: 4 }}>
                          <input value={r.k} onChange={e => { const a = [...c.cAttrs]; a[ri] = { ...r, k: e.target.value }; uc("cAttrs", a); }} placeholder="attribute name" style={{ flex: 2, background: t.ib, color: t.it, border: "1px solid " + t.ibd, borderRadius: 4, padding: "3px 6px", fontSize: 12, fontFamily: "monospace" }} />
                          <input value={r.v} onChange={e => { const a = [...c.cAttrs]; a[ri] = { ...r, v: e.target.value }; uc("cAttrs", a); }} placeholder="val" style={{ width: 70, background: t.ib, color: t.it, border: "1px solid " + t.ibd, borderRadius: 4, padding: "3px 6px", fontSize: 12, fontFamily: "monospace" }} />
                          <button onClick={() => uc("cAttrs", c.cAttrs.filter((_, j) => j !== ri))} style={btnX}>X</button>
                        </div>
                      ))}
                      <button onClick={() => uc("cAttrs", [...c.cAttrs, { k: "", v: "" }])} style={{ ...btn2, marginTop: 4, fontSize: 11, padding: "3px 10px" }}>+ Attr</button>
                    </div>
                    <div style={{ background: t.ci, borderRadius: 6, padding: 10, marginBottom: 8, border: "1px solid " + t.bd }}>
                      <label style={{ fontSize: 10, color: t.ac2, textTransform: "uppercase", fontWeight: 700 }}>ItemAttributes</label>
                      {c.iAttrs.map((ia, iai) => (
                        <div key={iai} style={{ marginTop: 6, padding: 6, border: "1px dashed " + t.bd, borderRadius: 4 }}>
                          <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
                            <input value={ia.item} onChange={e => { const a = [...c.iAttrs]; a[iai] = { ...ia, item: e.target.value }; uc("iAttrs", a); }} placeholder="ItemName" style={{ flex: 1, background: t.ib, color: t.it, border: "1px solid " + t.ibd, borderRadius: 4, padding: "3px 6px", fontSize: 12, fontFamily: "monospace" }} />
                            <button onClick={() => uc("iAttrs", c.iAttrs.filter((_, j) => j !== iai))} style={btnX}>X</button>
                          </div>
                          {ia.rows.map((r, ri) => (
                            <div key={ri} style={{ display: "flex", gap: 4, marginTop: 3 }}>
                              <input value={r.k} onChange={e => { const a = [...c.iAttrs]; const rows = [...a[iai].rows]; rows[ri] = { ...r, k: e.target.value }; a[iai] = { ...a[iai], rows }; uc("iAttrs", a); }} placeholder="attribute name" style={{ flex: 2, background: t.ib, color: t.it, border: "1px solid " + t.ibd, borderRadius: 4, padding: "3px 6px", fontSize: 12, fontFamily: "monospace" }} />
                              <input value={r.v} onChange={e => { const a = [...c.iAttrs]; const rows = [...a[iai].rows]; rows[ri] = { ...r, v: e.target.value }; a[iai] = { ...a[iai], rows }; uc("iAttrs", a); }} placeholder="val" style={{ width: 70, background: t.ib, color: t.it, border: "1px solid " + t.ibd, borderRadius: 4, padding: "3px 6px", fontSize: 12, fontFamily: "monospace" }} />
                              <button onClick={() => { const a = [...c.iAttrs]; a[iai] = { ...a[iai], rows: a[iai].rows.filter((_, j) => j !== ri) }; uc("iAttrs", a); }} style={btnX}>X</button>
                            </div>
                          ))}
                          <button onClick={() => { const a = [...c.iAttrs]; a[iai] = { ...a[iai], rows: [...a[iai].rows, { k: "", v: "" }] }; uc("iAttrs", a); }} style={{ ...btn2, marginTop: 4, fontSize: 10, padding: "2px 8px" }}>+ Attr</button>
                        </div>
                      ))}
                      <button onClick={() => uc("iAttrs", [...c.iAttrs, { item: "", rows: [{ k: "", v: "" }] }])} style={{ ...btn2, marginTop: 6, fontSize: 11, padding: "3px 10px" }}>+ Item Block</button>
                    </div>
                    <label style={{ fontSize: 10, color: t.txd, textTransform: "uppercase", fontWeight: 700 }}>Preview (editable — changes here override the form above)</label>
                    <textarea value={c.override || genCustom(c)} onChange={e => uc("override", e.target.value)} style={{ width: "100%", minHeight: 150, background: t.ib, border: "1px solid " + t.ibd, borderRadius: 4, padding: 8, fontSize: 11, fontFamily: "monospace", overflow: "auto", whiteSpace: "pre", marginTop: 4, color: t.it, resize: "vertical" }} />
                    {c.override && <button onClick={() => uc("override", "")} style={{ ...btn2, marginTop: 4, fontSize: 10, padding: "3px 10px" }}>Reset to auto-generated</button>}
                  </div>
                );
              })}
              {cust.length === 0 && <div style={{ color: t.txd, textAlign: "center", padding: 40 }}>No custom bots yet.</div>}
            </div>
          )}
 
          {tab === "waves" && (
            <div>
              <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
                {wavs.map((w, i) => (
                  <div key={w.id} style={{ display: "flex" }}>
                    <button onClick={() => saw(i)} style={{ ...btn, background: aw === i ? t.ac : t.card, color: aw === i ? "#fff" : t.tx, border: "1px solid " + t.bd, padding: "6px 14px" }}>W{i + 1} ({w.spawns.length})</button>
                    {wavs.length > 1 && <button onClick={() => { const n = wavs.filter((_, j) => j !== i); swavs(n); saw(Math.min(aw, n.length - 1)); }} style={{ ...btnX, borderRadius: "0 4px 4px 0", marginLeft: -1 }}>X</button>}
                  </div>
                ))}
                <button onClick={() => { swavs([...wavs, { id: mkId(), spawns: [makeWS()] }]); saw(wavs.length); }} style={{ ...btn, background: "#1f3a1f" }}>+ Wave</button>
              </div>
              {wavs[aw] && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontWeight: 700, color: t.ac, fontSize: 16 }}>Wave {aw + 1} — <span style={{ color: t.ac2 }}>${wm}</span></span>
                    <button onClick={() => { const n = [...wavs]; n[aw] = { ...n[aw], spawns: [...n[aw].spawns, makeWS()] }; swavs(n); }} style={btn}>+ WaveSpawn</button>
                  </div>
                  <WaveBar wave={wavs[aw]} t={t} missions={mis} waveIndex={aw} />
                  {wavs[aw].spawns.map((sp, si) => (
                    <div key={sp.id} style={{ background: t.card, border: "1px solid " + t.bd, borderRadius: 8, padding: 12, marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: isWsOpen(sp.id) ? 8 : 0 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1, minWidth: 0 }}>
                          <button
                            onClick={() => toggleWs(sp.id)}
                            title={isWsOpen(sp.id) ? "Collapse" : "Expand"}
                            style={{ ...btn2, padding: "4px 10px", fontSize: 12, flexShrink: 0, minWidth: 32 }}
                          >
                            {isWsOpen(sp.id) ? "▼" : "▶"}
                          </button>
                          <span style={{ fontWeight: 700, color: t.tx, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {spawnSummary(sp)}
                          </span>
                          {isWsOpen(sp.id) && (
                            <Sel t={t} label="" value={sp.type} onChange={v => { const n = [...wavs]; n[aw].spawns[si] = { ...sp, type: v }; swavs(n); }}>
                              <option value="single">Single</option>
                              <option value="squad">Squad</option>
                              <option value="random">Random</option>
                              <option value="tank">Tank</option>
                            </Sel>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                          <button onClick={() => { if (si === 0) return; const n = [...wavs]; const s = [...n[aw].spawns]; [s[si-1], s[si]] = [s[si], s[si-1]]; n[aw] = { ...n[aw], spawns: s }; swavs(n); }} style={{ ...btnX, opacity: si === 0 ? 0.3 : 1 }}>{"\u25B2"}</button>
                          <button onClick={() => { const spawns = wavs[aw].spawns; if (si >= spawns.length - 1) return; const n = [...wavs]; const s = [...n[aw].spawns]; [s[si], s[si+1]] = [s[si+1], s[si]]; n[aw] = { ...n[aw], spawns: s }; swavs(n); }} style={{ ...btnX, opacity: si >= wavs[aw].spawns.length - 1 ? 0.3 : 1 }}>{"\u25BC"}</button>
                          <button onClick={() => { const n = [...wavs]; n[aw] = { ...n[aw], spawns: n[aw].spawns.filter((_, j) => j !== si) }; swavs(n); }} style={btnX}>X</button>
                        </div>
                      </div>
                      {isWsOpen(sp.id) && (() => {
                        const u = (k, v) => { const n = [...wavs]; n[aw].spawns[si] = { ...sp, [k]: v }; swavs(n); };
                        return (
                          <div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                              <Inp t={t} label="Name" value={sp.name} onChange={v => u("name", v)} type="text" width={110} />
                              {sp.type !== "tank" && (
                              <Sel t={t} label="Spawn" value={resolveSpawn(g.map, sp.where)} onChange={v => u("where", v)} width={180}>
                                {getSpawnsForMap(g.map).map(s => <option key={s} value={s}>{s}</option>)}
                                </Sel>
                              )}
                              <Inp t={t} label="$" value={sp.totalCurrency} onChange={v => u("totalCurrency", v)} />
                              <Inp t={t} label="WaitBefore" value={sp.waitBefore} onChange={v => u("waitBefore", v)} />
                            </div>
                            {sp.type !== "tank" && (
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                                <Inp t={t} label="Total" value={sp.totalCount} onChange={v => u("totalCount", v)} />
                                <Inp t={t} label="MaxActive" value={sp.maxActive} onChange={v => u("maxActive", v)} />
                                <Inp t={t} label="SpawnCount" value={sp.spawnCount} onChange={v => u("spawnCount", v)} />
                                <Inp t={t} label="WaitBetween" value={sp.waitBetween} onChange={v => u("waitBetween", v)} />
                                <Sel t={t} label="Support" value={sp.support} onChange={v => u("support", v)}><option value="none">None</option><option value="1">Infinite</option><option value="limited">Limited</option></Sel>
                              </div>
                            )}
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                              <Sel t={t} label="WaitForAllDead" value={sp.waitDead} onChange={v => u("waitDead", v)} width={150}><option value="">-- none --</option>{allNames.filter(n => n !== sp.name).map(n => <option key={n}>{n}</option>)}</Sel>
                              <Sel t={t} label="WaitForAllSpawned" value={sp.waitSpawned} onChange={v => u("waitSpawned", v)} width={150}><option value="">-- none --</option>{allNames.filter(n => n !== sp.name).map(n => <option key={n}>{n}</option>)}</Sel>
                            </div>
                            {sp.type === "tank" && (
                              <div style={{ background: t.ci, borderRadius: 6, padding: 10, border: "1px solid " + t.bd }}>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  <Inp t={t} label="HP" value={sp.tank.health} onChange={v => u("tank", { ...sp.tank, health: v })} />
                                  <Inp t={t} label="Speed" value={sp.tank.speed} onChange={v => u("tank", { ...sp.tank, speed: v })} />
                                  <Inp t={t} label="Name" value={sp.tank.name} onChange={v => u("tank", { ...sp.tank, name: v })} type="text" width={100} />
                                  <Inp t={t} label="Path" value={sp.tank.path} onChange={v => u("tank", { ...sp.tank, path: v })} type="text" width={140} />
                                  <Sel t={t} label="Skin" value={sp.tank.skin} onChange={v => u("tank", { ...sp.tank, skin: Number(v) })}><option value={0}>Normal</option><option value={1}>Final</option></Sel>
                                </div>
                              </div>
                            )}
                            {sp.type === "single" && <BotPicker t={t} bot={sp.bots[0]} onChange={b => u("bots", [b])} customBots={cust} />}
                            {sp.type === "squad" && (
                              <div>
                                {sp.squadBots.map((b, bi) => (
                                  <div key={b.id} style={{ display: "flex", gap: 4 }}>
                                    <div style={{ flex: 1 }}><BotPicker t={t} bot={b} label={bi === 0 ? "Leader" : "Member " + bi} onChange={nb => { const a = [...sp.squadBots]; a[bi] = nb; u("squadBots", a); }} customBots={cust} /></div>
                                    {sp.squadBots.length > 1 && <button onClick={() => u("squadBots", sp.squadBots.filter((_, j) => j !== bi))} style={{ ...btnX, marginTop: bi === 0 ? 20 : 8 }}>X</button>}
                                  </div>
                                ))}
                                <button onClick={() => u("squadBots", [...sp.squadBots, makeBot()])} style={btn2}>+ Member</button>
                              </div>
                            )}
                            {sp.type === "random" && (
                              <div>
                                {sp.randomBots.map((b, bi) => (
                                  <div key={b.id} style={{ display: "flex", gap: 4 }}>
                                    <div style={{ flex: 1 }}><BotPicker t={t} bot={b} label={"Choice " + (bi + 1)} onChange={nb => { const a = [...sp.randomBots]; a[bi] = nb; u("randomBots", a); }} customBots={cust} /></div>
                                    {sp.randomBots.length > 2 && <button onClick={() => u("randomBots", sp.randomBots.filter((_, j) => j !== bi))} style={{ ...btnX, marginTop: 20 }}>X</button>}
                                  </div>
                                ))}
                                <button onClick={() => u("randomBots", [...sp.randomBots, makeBot()])} style={btn2}>+ Choice</button>
                              </div>
                            )}
                            <details style={{ marginTop: 8 }}>
                              <summary style={{ fontSize: 11, color: t.ac, cursor: "pointer", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Preview (editable)</summary>
                              <textarea value={sp.override || genWSCode(sp)} onChange={e => u("override", e.target.value)} style={{ width: "100%", minHeight: 180, background: t.ib, border: "1px solid " + t.ibd, borderRadius: 4, padding: 8, fontSize: 11, fontFamily: "monospace", overflow: "auto", whiteSpace: "pre", marginTop: 4, color: t.it, resize: "vertical" }} />
                              {sp.override && <button onClick={() => u("override", "")} style={{ ...btn2, marginTop: 4, fontSize: 10, padding: "3px 10px" }}>Reset to auto-generated</button>}
                            </details>
                          </div>
                        );
                      })()}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}