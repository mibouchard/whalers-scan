// Whalers minors scan engine: Fantrax matching, NHL-equivalent scoring, trends, draft status, and the adapters for the
// leagues whose sites answer a plain fetch (HockeyTech leagues, Liiga, NHL, KHL).
// Loaded by src/env.js, which first puts the shared helpers from src/lib (names, config, retry) on window.WS_LIB, so
// there is exactly one copy of the name normaliser, the league id and the team map.
window.WS = (() => {
  const LIB = window.WS_LIB; if (!LIB) throw new Error('engine: window.WS_LIB is missing (load the engine through src/env.js)');
  const { nameKey, rusKey, rusOrderedKey, isRussianFirst, lastTeamKey, fold, posGroup, fxGroup, retry } = LIB;
  const LEAGUE = LIB.LEAGUE_ID;
  // approximate NHL-equivalency factors (public NHLe research, 2020s): points in league x factor = NHL points
  const NHLE = { NHL: 1, AHL: .389, OHL: .144, WHL: .141, QMJHL: .113, USHL: .143, ECHL: .15, BCHL: .07, Liiga: .441, KHL: .772, VHL: .30, MHL: .12, SHL: .566, Allsvenskan: .297, J20: .09, NL: .459, Czech: .418, NCAA: .194 };
  // names in these leagues are transliterated from Russian: only here are spelling variants folded and word order ignored
  const RUS = new Set(['KHL', 'VHL', 'MHL']);
  const HIST_DAYS = 22; // the trend looks back 14 days (7 as a fallback); nothing older is used
  const today = () => new Date().toISOString().slice(0, 10);
  const ls = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };
  const isoDay = d => { const t = new Date(d); return isNaN(t) ? null : t.toISOString().slice(0, 10); };
  const ageOn = (dob, ref) => { const b = isoDay(dob); if (!b) return null; const r = isoDay(ref || today()); let y = +r.slice(0, 4) - +b.slice(0, 4); if (r.slice(5) < b.slice(5)) y--; return y; };
  const J = u => retry(() => fetch(u).then(r => { if (!r.ok) throw new Error(r.status + ' ' + u.split('?')[0]); return r.json(); }), 3);
  const hasOrg = r => !!(r.org && r.org !== '(N/A)');

  // ---- Fantrax: player pool + league rosters, fetched once per run ----
  // own = ownership from next period's rosters (claims and lineup moves made this week only show there), falling back
  // to the current period. Anything that had to fall back is said in fx.notes. opts.period pins one period instead.
  async function fantrax(opts = {}) {
    if (WS._fx && !opts.period && !opts.fresh) return WS._fx;
    const ids = await J('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL');
    const pool = {}, rus = {}, rusOrd = {}, lastTeam = {}, byId = {};
    for (const p of Object.values(ids)) {
      const i = (p.name || '').indexOf(', '); const last = i < 0 ? (p.name || '') : p.name.slice(0, i), first = i < 0 ? '' : p.name.slice(i + 2);
      const c = [p.fantraxId, p.team || '', p.position || ''];
      byId[p.fantraxId] = [first ? first + ' ' + last : last, c[1], c[2]];
      (pool[nameKey(first, last)] = pool[nameKey(first, last)] || []).push(c);
      (rus[rusKey(first, last)] = rus[rusKey(first, last)] || []).push(c);
      (rusOrd[rusOrderedKey(first, last)] = rusOrd[rusOrderedKey(first, last)] || []).push(c);
      if (c[1] && c[1] !== '(N/A)') (lastTeam[lastTeamKey(last, c[1])] = lastTeam[lastTeamKey(last, c[1])] || []).push([...c, fold(first)[0] || '']);
    }
    const base = 'https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=' + LEAGUE;
    const ro = await J(base + (opts.period ? '&period=' + opts.period : ''));
    const read = x => { const own = {}; for (const [tid, t] of Object.entries(x.rosters)) for (const it of t.rosterItems) own[it.id] = [LIB.TEAMS[tid] || t.teamName, it.status]; return own; };
    let own = read(ro), ownPeriod = ro.period; const notes = [];
    if (!opts.period) {
      try {
        const nx = await J(base + '&period=' + ((ro.period || 0) + 1));
        if (nx && nx.rosters && nx.period === (ro.period || 0) + 1) { own = read(nx); ownPeriod = nx.period; }
        else notes.push('Fantrax has no period ' + ((ro.period || 0) + 1) + ' rosters: ownership is from period ' + ro.period);
      } catch (e) { notes.push('next-period rosters failed (' + e.message + '): ownership is from period ' + ro.period + ', so this week\'s claims are missing'); }
    }
    const fx = { pool, rus, rusOrd, lastTeam, byId, own, notes, period: ro.period, ownPeriod, elig: {}, nIds: Object.keys(ids).length };
    if (!opts.period) WS._fx = fx;
    return fx;
  }
  // Every Fantrax player whose name matches, of the same class (goalie / skater).
  //   KHL, VHL, MHL   the loose Russian key (spelling variants fold, word order ignored)
  //   everywhere else the exact key; and only if that finds nobody:
  //                   - a Russian given name gets the spelling fold with word order kept (OHL "Artem" = Fantrax "Artyom")
  //                   - an NHL row falls back to last name + NHL club + first initial, when exactly one player fits
  //                     (Zachary / Zack, Samuel / Sam)
  function candidates(fx, first, last, pos, lg, team) {
    const isG = posGroup(pos) === 'G'; const cls = x => /G/.test(x[2]) === isG;
    if (RUS.has(lg)) return (fx.rus[rusKey(first, last)] || []).filter(cls);
    let c = (fx.pool[nameKey(first, last)] || []).filter(cls);
    if (!c.length && isRussianFirst(first) && fx.rusOrd) c = (fx.rusOrd[rusOrderedKey(first, last)] || []).filter(cls);
    if (!c.length && lg === 'NHL' && team && fx.lastTeam) { const t = (fx.lastTeam[lastTeamKey(last, team)] || []).filter(x => cls(x) && x[3] === (fold(first)[0] || '')); if (t.length === 1) c = [t[0].slice(0, 3)]; }
    return c;
  }
  // Name match with sanity guards. Returns null (no such name), { rej } (a name matched but a guard refused it), or
  // { id, org, pos, q } where q is 'amb' when two or more Fantrax players fit and one had to be picked.
  //   - goalies only match goalies
  //   - forward / defence must agree whenever Fantrax's position is unambiguous (C/LW/RW vs D)
  //   - NHL rows prefer the Fantrax player listed with the same NHL club
  function match(fx, first, last, pos, lg, team) {
    let c = candidates(fx, first, last, pos, lg, team); if (!c.length) return null;
    const g = posGroup(pos);
    if (g === 'F' || g === 'D') {
      const ok = c.filter(x => { const fg = fxGroup(x[2], fx.elig[x[0]]); return !fg || fg === g; });
      if (!ok.length) return { rej: 'position: ' + lg + ' lists ' + g + ', Fantrax ' + c.map(x => x[0] + ' ' + x[2]).join(' / ') };
      c = ok;
    }
    const pick = (x, q) => ({ id: x[0], org: x[1], pos: x[2], q });
    if (c.length === 1) return pick(c[0], 'name');
    if (lg === 'NHL' && team) { const t = c.filter(x => x[1] === team); if (t.length === 1) return pick(t[0], 'name'); if (t.length) c = t; }
    const same = c.filter(x => fxGroup(x[2], fx.elig[x[0]]) === g); const base = same.length ? same : c;
    if (base.length === 1) return pick(base[0], 'name');
    const nhl = base.filter(x => x[1] && x[1] !== '(N/A)');
    return pick(nhl[0] || base[0], 'amb');
  }
  function setMatch(r, m, fx) {
    const ok = m && m.id;
    r.fx = ok ? m.id : null; r.org = ok ? m.org : null; r.mq = ok && m.q === 'amb' ? 'amb' : ''; r.rej = m && m.rej ? m.rej : null;
    const o = ok && fx.own[m.id]; r.own = o ? o[0] : null; r.st = o ? o[1] : null;
  }
  // take a match back (the cross-league check in src/lib/plausible.js found it implausible)
  function unmatch(r, why) { r.fx = null; r.org = null; r.own = null; r.st = null; r.mq = ''; r.rej = why || 'implausible'; }

  // ---- scoring ----
  function score(lg, rows) {
    const f = NHLE[lg] || .2;
    const elig = rows.filter(r => !r.goalie && r.gp >= 3);
    const prior = { F: 0, D: 0 }, n = { F: 0, D: 0 };
    elig.forEach(r => { const g = /D/.test(r.pos) ? 'D' : 'F'; prior[g] += r.pts / r.gp; n[g]++; });
    for (const g of ['F', 'D']) prior[g] = n[g] ? prior[g] / n[g] : .4;
    for (const r of rows) {
      if (r.goalie) continue;
      // no games, no estimate: a player who has not played gets a blank NHLe, not the league average
      if (!(r.gp > 0)) { r.ppg = 0; r.nhle = null; r.gem = null; continue; }
      const g = /D/.test(r.pos) ? 'D' : 'F';
      const shr = (r.pts + 5 * prior[g]) / (r.gp + 5);
      r.ppg = +(r.pts / r.gp).toFixed(2);
      r.nhle = +(shr * f * 82).toFixed(1);
      const age = r.age ?? 21;
      const af = Math.max(.6, Math.min(1.4, 1 + .1 * (21 - age)));
      r.gem = +(r.nhle * af * (g === 'D' ? 1.3 : 1)).toFixed(1);
    }
  }
  // ---- history + trends (per league, state/ws.hist.<lg>.json) ----
  function trend(lg, rows) {
    const H = ls.get('ws.hist.' + lg, {});
    const d = today();
    H[d] = {}; rows.forEach(r => { if (!r.goalie) H[d][r.sid] = [r.gp, r.pts]; });
    const days = Object.keys(H).sort(); while (days.length > HIST_DAYS) delete H[days.shift()];
    ls.set('ws.hist.' + lg, H);
    const pick = n => { const target = new Date(Date.now() - n * 864e5).toISOString().slice(0, 10); const older = days.filter(x => x <= target); return older.length ? H[older[older.length - 1]] : null; };
    const w14 = pick(14) || pick(7);
    for (const r of rows) {
      if (r.goalie) continue;
      const o = w14 && w14[r.sid];
      if (o && r.gp - o[0] >= 3) { r.rgp = r.gp - o[0]; r.rppg = +((r.pts - o[1]) / r.rgp).toFixed(2); r.tr = +(r.rppg - r.ppg).toFixed(2); }
      if (r.prev != null && r.gp >= 3) r.yoy = +(r.ppg - r.prev).toFixed(2);
    }
    return days.length;
  }
  // [[day, total games played by every skater]] oldest first: the staleness check compares these day to day
  function histTotals(lg) {
    const H = ls.get('ws.hist.' + lg, {});
    return Object.keys(H).sort().map(d => [d, Object.values(H[d]).reduce((s, v) => s + (+v[0] || 0), 0)]);
  }

  // ---- NHL draft status ----
  // A player with no NHL club who has not yet been through an NHL draft is never a free-agent pickup: he has to go
  // through the draft first. First eligible: 18 by Sept 15 of the draft year; the draft is in late June, so from July the
  // cutoff moves on a year by itself.
  //   'post'  an NHL club holds him (and the Fantrax match is not ambiguous), or his real birthdate is on or before the cutoff
  //   'pre'   no NHL club and his real birthdate is after the cutoff
  //   ''      unknown: no real birthdate. Estimated ages (NCAA class year, Czech age bands) never decide this.
  function draftCutoff(ref) { const t = new Date(ref || today()); const y = t.getUTCMonth() >= 6 ? t.getUTCFullYear() : t.getUTCFullYear() - 1; return (y - 18) + '-09-15'; }
  function draftStatus(r, ref) {
    if (hasOrg(r) && r.mq !== 'amb') return 'post';
    const b = r.dob ? isoDay(r.dob) : null;
    return b ? (b > draftCutoff(ref) ? 'pre' : 'post') : '';
  }

  // ---- main ----
  // collect: fetch one league, match every row to Fantrax, score it and record the trend point.
  async function collect(lg, adapter, opts = {}) {
    const fx = opts.fx || await fantrax();
    const rows = await adapter();
    const meta = { partial: rows.partial || null, notes: rows.notes || [], ppp: rows.ppp || null };
    for (const r of rows) {
      let real = r.dob ? ageOn(r.dob) : null; if (real != null && (real < 14 || real > 50)) { real = null; r.dob = null; }
      // ak = how the age is known: 'dob' from a real birthdate, 'est' estimated by the adapter (class year, age band), '' unknown
      r.ak = real != null ? 'dob' : r.age != null ? 'est' : '';
      r.age = real ?? r.age ?? null;
      setMatch(r, match(fx, r.first, r.last, r.pos, lg, r.team), fx);
    }
    score(lg, rows);
    const nDays = opts.noTrend ? 0 : trend(lg, rows);
    return { lg, rows, nDays, meta };
  }
  const SK = ['fx', 'own', 'st', 'name', 'team', 'pos', 'age', 'gp', 'g', 'a', 'pts', 'ppp', 'ppg', 'nhle', 'prev', 'yoy', 'tr', 'rgp', 'toi', 'dr', 'ak', 'mq'];
  const GK = ['fx', 'own', 'st', 'name', 'team', 'age', 'gp', 'svp', 'gaa', 'w', 'min', 'ak', 'mq'];
  // summarize: the per-league lists. opts.free(id) -> true when Fantrax says the player is a free agent or on waivers;
  // when given, the free-agent lists (avail, undrafted, risers, unowned goalies) keep only those players.
  function summarize(lg, rows, opts = {}) {
    for (const r of rows) r.dr = draftStatus(r);
    const S = r => [r.fx || '', r.own || '', r.st || '', r.first + ' ' + r.last, r.team, r.pos, r.age ?? '', r.gp, r.g, r.a, r.pts, r.ppp ?? '', r.ppg, r.nhle ?? '', r.prev ?? '', r.yoy ?? '', r.tr ?? '', r.rgp ?? '', r.toi ?? '', r.dr || '', r.ak || '', r.mq || ''].join('|');
    const G = r => [r.fx || '', r.own || '', r.st || '', r.first + ' ' + r.last, r.team, r.age ?? '', r.gp, r.svp ?? '', r.gaa ?? '', r.w ?? '', r.min ?? '', r.ak || '', r.mq || ''].join('|');
    const sk = rows.filter(r => !r.goalie), gl = rows.filter(r => r.goalie);
    const minGP = opts.minGP ?? 3, maxAge = opts.maxAge ?? 24;
    const ownedOK = r => r.own && (!opts.ownedSt || opts.ownedSt.includes(r.st));
    // a pickup target: in Fantrax, unowned, free per Fantrax, the match is not an ambiguous namesake, and not a known veteran
    const target = r => !r.own && r.fx && r.mq !== 'amb' && !r.vet && r.gp >= minGP && (!opts.free || opts.free(r.fx));
    const known = r => r.ak ? 1 : 0; // rows with no age at all rank below rows with one
    const byGem = (a, b) => known(b) - known(a) || (b.gem ?? -1) - (a.gem ?? -1);
    const young = (r, max) => r.age == null || r.age <= max;
    const owned = sk.filter(ownedOK).map(S);
    const avail = sk.filter(r => target(r) && hasOrg(r) && young(r, maxAge)).sort(byGem).slice(0, opts.nAvail ?? 15).map(S);
    const undrafted = sk.filter(r => target(r) && !hasOrg(r) && r.age != null && r.age <= (opts.undMaxAge ?? 20)).sort(byGem).slice(0, opts.nUnd ?? 8).map(S);
    const risers = sk.filter(r => target(r) && r.tr != null && r.rgp >= 4 && young(r, 23)).sort((a, b) => known(b) - known(a) || b.tr - a.tr).slice(0, 6).map(S);
    // players the league lists but Fantrax does not have (or whose only name match was refused): not free agents
    const notInFx = sk.filter(r => !r.fx && r.gp >= minGP && r.age != null && r.age <= (opts.undMaxAge ?? 20)).sort(byGem).slice(0, opts.nNotInFx ?? 4).map(S);
    // every owned goalie is kept; only the unowned list is cut
    const bySv = (a, b) => known(b) - known(a) || (b.svp || 0) - (a.svp || 0);
    const goalies = [...gl.filter(ownedOK).sort(bySv), ...gl.filter(r => target(r) && hasOrg(r) && young(r, maxAge)).sort(bySv).slice(0, opts.nGoalies ?? 14)].map(G);
    // league leaders on scan day: [name, team, value, gp, owner, fantraxId, nhlRights, fantraxStatus, pos, age, dr]; ties go to fewer games played
    const lead = k => { const r = sk.filter(x => x[k] != null).sort((x, y) => (y[k] - x[k]) || (x.gp - y.gp))[0]; return r ? [r.first + ' ' + r.last, r.team, r[k], r.gp, r.own || '', r.fx || '', hasOrg(r) ? r.org : '', '', r.pos || '', r.age ?? '', r.dr || ''] : null; };
    const leaders = { pts: lead('pts'), g: lead('g'), a: lead('a') };
    return { lg, d: today(), nSk: sk.length, nG: gl.length, matched: sk.filter(r => r.fx).length, owned, avail, undrafted, risers, goalies, notInFx, leaders };
  }
  async function run(lg, adapter, opts = {}) { const c = await collect(lg, adapter, opts); return { ...summarize(lg, c.rows, opts), nDays: c.nDays, meta: c.meta }; }

  // ---- adapters ----
  // Every adapter returns an array of rows; it may carry .ppp ('points' or 'goals': what the ppp column holds),
  // .partial (text, when part of the league could not be read) and .notes (strings).
  const HT = { AHL: ['ahl', 'ccb91f29d6744675'], OHL: ['ohl', 'd33ffebb443a4536'], WHL: ['whl', '41b145a848f4bd67'], QMJHL: ['lhjmq', '02163f1eeecebec4'], USHL: ['ushl', 'e828f89b243dc43f'], ECHL: ['echl', '2c2b89ea7345cae8'] };
  const htFeed = async (c, k, q) => { const r = await fetch(`https://lscluster.hockeytech.com/feed/index.php?${q}&key=${k}&client_code=${c}`); if (!r.ok) throw new Error(r.status + ' hockeytech ' + c); const t = await r.text(); return JSON.parse(t.replace(/^\(|\)$/g, '')); };
  async function htSeasons(c, k) {
    const s = (await htFeed(c, k, 'feed=modulekit&view=seasons&fmt=json')).SiteKit.Seasons.filter(x => x.career === '1' && x.playoff === '0');
    return [s[0].season_id, s[1] && s[1].season_id];
  }
  async function htPlayers(c, k, season, pos) {
    const j = await htFeed(c, k, `feed=statviewfeed&view=players&season=${season}&team=all&position=${pos}&rookies=0&statsType=standard&rosterstatus=undefined&site_id=0&first=0&limit=3000&sort=${pos === 'goalies' ? 'gp' : 'points'}&league_id=1&lang=en&division=-1`);
    return j[0].sections[0].data.map(x => ({ ...x.row, name: x.row.name || (x.prop && x.prop.shortname && x.prop.shortname.seoName) || x.row.shortname || '' }));
  }
  async function htDobs(c, k, season) {
    const C = ls.get('ws.dob.' + c, { s: null, d: null, m: {} });
    if (C.s === season && C.d && (Date.now() - new Date(C.d)) < 7 * 864e5) return C.m;
    const teams = (await htFeed(c, k, `feed=modulekit&view=teamsbyseason&season_id=${season}&fmt=json`)).SiteKit.Teamsbyseason;
    const m = {};
    for (let i = 0; i < teams.length; i += 4) await Promise.all(teams.slice(i, i + 4).map(async t => { for (let tries = 0; tries < 3; tries++) { try { const ro = (await htFeed(c, k, `feed=modulekit&view=roster&team_id=${t.id}&season_id=${season}&fmt=json`)).SiteKit.Roster; ro.forEach(p => { if (p.player_id && p.birthdate) m[p.player_id] = p.birthdate; }); break; } catch (e) { await new Promise(r => setTimeout(r, 400)); } } }));
    // a refresh that found nothing keeps the old birthdates rather than wiping them
    if (!Object.keys(m).length && C.s === season && Object.keys(C.m || {}).length) return C.m;
    ls.set('ws.dob.' + c, { s: season, d: today(), m });
    return m;
  }
  function hockeytech(lg) {
    const [c, k] = HT[lg];
    return async () => {
      const [cur, prev] = await htSeasons(c, k);
      const [sk, gl, dob] = await Promise.all([htPlayers(c, k, cur, 'skaters'), htPlayers(c, k, cur, 'goalies'), htDobs(c, k, cur)]);
      let P = ls.get('ws.prev.' + c, null);
      if (!P || P.s !== prev) { const pr = prev ? await htPlayers(c, k, prev, 'skaters') : []; P = { s: prev, m: {} }; pr.forEach(r => { if (+r.games_played >= 10) P.m[r.player_id] = +(r.points / r.games_played).toFixed(2); }); ls.set('ws.prev.' + c, P); }
      const split = n => { if (n.includes(', ')) { const [l, f] = n.split(', '); return [f, l]; } const i = n.indexOf(' '); return [n.slice(0, i), n.slice(i + 1)]; };
      const out = sk.filter(r => r.position !== 'G').map(r => { const [first, last] = split(r.name); return { sid: r.player_id, first, last, pos: r.position, team: r.team_code, gp: +r.games_played, g: +r.goals, a: +r.assists, pts: +r.points, ppp: (r.power_play_goals == null && r.power_play_assists == null) ? null : (+r.power_play_goals || 0) + (+r.power_play_assists || 0), dob: dob[r.player_id], prev: P.m[r.player_id] ?? null }; });
      gl.forEach(r => { const [first, last] = split(r.name); out.push({ goalie: 1, sid: r.player_id, first, last, pos: 'G', team: r.team_code, gp: +r.games_played, svp: r.save_percentage, gaa: r.goals_against_average, w: r.wins, min: r.minutes_played || r.minutes, dob: dob[r.player_id] }); });
      out.ppp = 'points';
      return out;
    };
  }
  // Liiga goalies are not in the skater feed. The goalie feed's address is not documented, so the likely ones are tried in
  // turn and whichever answers with goalie rows is used; if none does, skaters still load and a note says so.
  async function liigaGoalies(y) {
    const base = 'https://liiga.fi/api/v2/';
    const urls = ['goalkeeperStats', 'goalieStats', 'goalkeeperBasicStats', 'goalkeepers'].map(t => `players/stats/summed/${y}/${y}/runkosarja/true?dataType=${t}`)
      .concat([`goalkeepers/stats/summed/${y}/${y}/runkosarja/true`, `players/stats/summed/${y}/${y}/runkosarja/true?dataType=basicStats&goalkeepers=true`]);
    const pct = v => { const x = parseFloat(v); return isNaN(x) ? '' : (x > 1 ? x / 100 : x).toFixed(3); };
    const mmss = v => { if (v == null || v === '') return ''; if (/:/.test(String(v))) return String(v); const s = +v; return isNaN(s) ? '' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0'); };
    for (const u of urls) {
      try {
        const r = await fetch(base + u); if (!r.ok) continue;
        const j = await r.json(); const list = (Array.isArray(j) ? j : []).filter(x => x && !x.removed && x.playerId != null && (x.goalkeeper === true || x.role === 'MV' || x.saves != null || x.savePercentage != null || x.blockedShots != null && x.goalsAgainstAverage != null));
        if (!list.length) continue;
        return { via: u.split('?')[1] || u.split('/')[0], rows: list.map(x => ({ goalie: 1, sid: x.playerId, first: x.firstName, last: x.lastName, pos: 'G', team: x.teamShortName, gp: x.playedGames ?? x.games ?? 0, svp: pct(x.savePercentage ?? x.savePct ?? x.savesPercentage), gaa: x.goalsAgainstAverage ?? x.gaa ?? '', w: x.wins ?? x.won ?? '', min: mmss(x.timeOnIce ?? x.minutes ?? x.playedTime) })) };
      } catch (e) { }
    }
    return { via: null, rows: [] };
  }
  function liiga() {
    return async () => {
      const y = new Date().getMonth() >= 6 ? new Date().getFullYear() + 1 : new Date().getFullYear();
      const get = async u => { const r = await fetch(u); if (!r.ok) throw new Error(r.status + ' liiga.fi'); return r.json(); };
      const cur = await get(`https://liiga.fi/api/v2/players/stats/summed/${y}/${y}/runkosarja/true?dataType=basicStats`);
      let P = ls.get('ws.prev.liiga', null);
      if (!P || P.s !== y - 1) { const pr = await get(`https://liiga.fi/api/v2/players/stats/summed/${y - 1}/${y - 1}/runkosarja/true?dataType=basicStats`); P = { s: y - 1, m: {} }; pr.forEach(r => { if (r.playedGames >= 10 && !r.goalkeeper) P.m[r.playerId] = +(r.points / r.playedGames).toFixed(2); }); ls.set('ws.prev.liiga', P); }
      const notes = [];
      let gk = cur.filter(r => !r.removed && r.goalkeeper).map(r => ({ goalie: 1, sid: r.playerId, first: r.firstName, last: r.lastName, pos: 'G', team: r.teamShortName, gp: r.playedGames }));
      const extra = await liigaGoalies(y).catch(() => ({ via: null, rows: [] }));
      if (extra.rows.length) { gk = extra.rows; notes.push('goalies from ' + extra.via); } else if (!gk.length) notes.push('no goalie feed answered: Liiga goalies are missing');
      const DB = ls.get('ws.dob.liiga', {}); const need = [...cur.filter(r => !r.removed), ...gk.map(g => ({ playerId: g.sid }))].filter(r => !DB[r.playerId]).map(r => r.playerId);
      for (let i = 0; i < need.length; i += 25) await Promise.all(need.slice(i, i + 25).map(async id => { try { const j = await fetch('https://liiga.fi/api/v2/players/info/' + id).then(r => r.json()); if (j.dateOfBirth) DB[id] = j.dateOfBirth; } catch (e) { } }));
      ls.set('ws.dob.liiga', DB);
      // power play: true points when the feed has power-play assists, otherwise goals only
      const hasPPA = cur.some(r => r.powerplayAssists != null || r.powerplayPoints != null);
      const pp = r => r.powerplayPoints ?? (r.powerplayAssists != null ? (+r.powerplayGoals || 0) + (+r.powerplayAssists || 0) : r.powerplayGoals);
      const seen = new Set();
      const out = cur.filter(r => !r.removed && !r.goalkeeper).map(r => ({ sid: r.playerId, first: r.firstName, last: r.lastName, pos: r.role === 'P' ? 'D' : 'F', team: r.teamShortName, gp: r.playedGames, g: r.goals, a: r.assists, pts: r.points, ppp: pp(r), dob: DB[r.playerId], prev: P.m[r.playerId] ?? null }));
      for (const g of gk) { if (seen.has(g.sid)) continue; seen.add(g.sid); out.push({ ...g, dob: DB[g.sid] }); }
      out.ppp = hasPPA ? 'points' : 'goals'; out.notes = notes;
      return out;
    };
  }
  function nhl() {
    return async () => {
      const T = LIB.NHL_TEAMS;
      const out = []; const failed = [];
      // true power-play points come from the NHL stats report (one call); without it the column falls back to power-play goals
      let ppPts = null;
      try {
        const now = new Date(), y = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
        const r = await fetch(`https://api.nhle.com/stats/rest/en/skater/summary?limit=-1&cayenneExp=${encodeURIComponent(`seasonId=${y}${y + 1} and gameTypeId=2`)}`);
        if (r.ok) { const j = await r.json(); if (Array.isArray(j.data) && j.data.length && j.data[0].ppPoints !== undefined) { ppPts = {}; j.data.forEach(s => { ppPts[s.playerId] = s.ppPoints; }); } }
      } catch (e) { }
      for (let i = 0; i < T.length; i += 4) await Promise.all(T.slice(i, i + 4).map(async t => {
        try {
          const ro = await retry(() => fetch(`https://api-web.nhle.com/v1/roster/${t}/current`).then(r => { if (!r.ok) throw new Error(r.status + ' roster ' + t); return r.json(); }), 3);
          const cs = await fetch(`https://api-web.nhle.com/v1/club-stats/${t}/now`).then(r => r.ok ? r.json() : {}).catch(() => ({}));
          const st = {}; (cs.skaters || []).forEach(s => st[s.playerId] = s); const gs = {}; (cs.goalies || []).forEach(s => gs[s.playerId] = s);
          for (const grp of ['forwards', 'defensemen', 'goalies']) (ro[grp] || []).forEach(p => {
            const base = { sid: p.id, first: p.firstName.default, last: p.lastName.default, pos: grp === 'goalies' ? 'G' : grp === 'defensemen' ? 'D' : p.positionCode, team: t, dob: p.birthDate };
            if (grp === 'goalies') { const s = gs[p.id] || {}; out.push({ ...base, goalie: 1, gp: s.gamesPlayed || 0, svp: s.savePercentage != null ? s.savePercentage.toFixed(3) : '', gaa: s.goalsAgainstAverage != null ? s.goalsAgainstAverage.toFixed(2) : '', w: s.wins }); }
            else { const s = st[p.id] || {}; out.push({ ...base, gp: s.gamesPlayed || 0, g: s.goals || 0, a: s.assists || 0, pts: s.points || 0, ppp: ppPts ? (ppPts[p.id] ?? (s.gamesPlayed ? 0 : null)) : (s.powerPlayGoals ?? null) }); }
          });
        } catch (e) { failed.push(t); }
      }));
      // a few clubs missing is a partial league; most of them missing is a failure
      if (failed.length > 8) throw new Error(`NHL: ${failed.length}/32 clubs failed (${failed.slice(0, 6).join(', ')}...)`);
      if (failed.length) out.partial = `${failed.length}/32 clubs failed: ${failed.join(', ')}`;
      out.ppp = ppPts ? 'points' : 'goals';
      return out;
    };
  }
  // KHL (en.khl.ru): internal REST feed, needs the stats page's session token. Season/tournament ids change yearly
  // (2026-27: season s19, tournament 1436 = regular season). Pages return 20 goalies/defense/forwards each.
  // io = { fetch, sess }: src/leagues.js passes a fetch that routes /rest/ calls to the site with the session cookie.
  function khl(season = 's19', tour = '1436', io = {}) {
    return async () => {
      const F = io.fetch || fetch; const sess = io.sess || BX.bitrix_sessid(); const out = [];
      const post = page => F('/rest/stat/players/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `nav%5Bpage%5D=${page}&values%5Bseason%5D=${season}&values%5Btournament%5D=${tour}&values%5Bamplua_full%5D=all&values%5Bclubs_full%5D=all&values%5Bonly%5D=table&sessid=${sess}` }).then(r => r.json());
      const first = await post(1); const maxP = Math.max(...first.data.list.map(s => s.nav.max));
      const pages = [first]; for (let p = 2; p <= maxP; p += 4) pages.push(...await Promise.all([p, p + 1, p + 2, p + 3].filter(x => x <= maxP).map(post)));
      const seen = new Set();
      for (const pg of pages) for (const s of pg.data.list) for (const it of s.list) {
        const nm = it.first[1].val, link = it.first[1].link || '', sid = (link.match(/players\/(\d+)/) || [])[1]; if (!sid || seen.has(sid)) continue; seen.add(sid);
        const [last, ...rest] = nm.split(' '); const first_ = rest.join(' '); const club = ((it.first[1].image || '').match(/teamplayers\/(\d+)\//) || [])[1] || '';
        const c = it.cols;
        if (s.code === 'goalies') out.push({ goalie: 1, sid, first: first_, last, pos: 'G', team: club, gp: c.gp, svp: c.sv_pct ? (c.sv_pct / 100).toFixed(3) : '', gaa: c.gaa, w: c.w, min: c.toi });
        else out.push({ sid, first: first_, last, pos: s.code === 'defenses' ? 'D' : 'F', team: club, gp: c.gp, g: c.g, a: c.a, pts: c.pts, ppp: c.ppg, toi: c.toi_avg });
      }
      // birthdates + club codes from the profile feed, cached per player in state/ws.khlprof.json
      const PC = ls.get('ws.khlprof', {}); const need = out.filter(r => !PC[r.sid]).map(r => r.sid);
      for (let i = 0; i < need.length; i += 10) await Promise.all(need.slice(i, i + 10).map(async id => { try { const j = await F('/rest/players/profile/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `values%5Bid%5D=${id}&sessid=${sess}` }).then(r => r.json()); const D = j.data && j.data.DATA; if (D) { const b = (D.birthdate || '').split('.'); PC[id] = [b.length === 3 ? `${b[2]}-${b[1]}-${b[0]}` : '', (D.team && D.team.CODE) || (JSON.stringify(D).match(/"CODE":"([^"]+)"/) || [])[1] || '']; } } catch (e) { } }));
      ls.set('ws.khlprof', PC);
      out.forEach(r => { const p = PC[r.sid]; if (p) { if (p[0]) r.dob = p[0]; if (p[1]) r.team = p[1]; } });
      out.ppp = 'goals';
      return out;
    };
  }
  return { v: 6, run, collect, summarize, hockeytech, liiga, nhl, khl, HT, NHLE, RUS, SK, GK, ls, ageOn, match, candidates, setMatch, unmatch, fantrax, score, trend, histTotals, draftStatus, draftCutoff, hasOrg, TEAMS: LIB.TEAMS };
})();
