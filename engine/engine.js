// Whalers minors scan engine. Runs in the built-in browser on the source's origin.
// Stores itself as localStorage['ws.engine'] so later scans can run eval(localStorage['ws.engine']).
window.WS = (() => {
  const LEAGUE = 'fs61ldkdmow7aw2h';
  // approximate NHL-equivalency factors (public NHLe research, 2020s): points in league x factor = NHL points
  const NHLE = { NHL: 1, AHL: .389, OHL: .144, WHL: .141, QMJHL: .113, USHL: .143, ECHL: .15, BCHL: .07, Liiga: .441, KHL: .772, VHL: .30, MHL: .12, SHL: .566, Allsvenskan: .297, NL: .459, Czech: .418, NCAA: .194 };
  const today = () => new Date().toISOString().slice(0, 10);
  const ls = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };
  const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019`]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Russian transliteration variants (Dmitry/Dmitri, Yegor/Egor, Alexei/Aleksei, Vasily/Vasili) collapse to one key
  const canon = t => t.replace(/x/g, 'ks').replace(/^ye/, 'e').replace(/yo/g, 'e').replace(/(ey|ei|ii|iy|yi|ij|y)$/, 'i');
  const key = (first, last) => norm(first + ' ' + last).split(' ').filter(Boolean).map(canon).sort().join(' ');
  const ageOn = (dob, ref) => { if (!dob) return null; const a = new Date(dob), r = new Date(ref || today()); let y = r.getFullYear() - a.getFullYear(); if (r < new Date(r.getFullYear(), a.getMonth(), a.getDate())) y--; return y; };

  // ---- Fantrax: player pool (cached daily) + league rosters (fresh) ----
  async function fantrax(opts = {}) {
    let pool = ls.get('ws.pool3', null);
    if (!pool || pool.d !== today()) {
      const ids = await fetch('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL').then(r => r.json());
      const byKey = {};
      for (const p of Object.values(ids)) {
        const [last, first] = (p.name || '').split(', ');
        const k = key(first || '', last || '');
        (byKey[k] = byKey[k] || []).push([p.fantraxId, p.team || '', p.position || '']);
      }
      pool = { d: today(), byKey };
      ls.set('ws.pool3', pool);
    }
    // opts.period pins a scoring period (box scores use the period the games were played in); no period = current, upgraded to next period for ownership/claims
    const ro = await fetch('https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=' + LEAGUE + (opts.period ? '&period=' + opts.period : '')).then(r => r.json());
    const own = {};
    for (const [tid, t] of Object.entries(ro.rosters)) for (const it of t.rosterItems) own[it.id] = [WS.TEAMS[tid] || t.teamName, it.status];
    // claims and lineup moves take effect next scoring period: prefer next period's rosters when Fantrax has them
    if (!opts.period) try { const nx = await fetch('https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=' + LEAGUE + '&period=' + ((ro.period || 0) + 1)).then(r => r.json()); if (nx && nx.rosters) { for (const k of Object.keys(own)) delete own[k]; for (const [tid, t] of Object.entries(nx.rosters)) for (const it of t.rosterItems) own[it.id] = [WS.TEAMS[tid] || t.teamName, it.status]; } } catch (e) { }
    return { pool: pool.byKey, own };
  }
  function match(fx, first, last, pos) {
    const c0 = fx.pool[key(first, last)]; if (!c0) return null;
    const isG = /G/.test(pos); const c = c0.filter(x => /G/.test(x[2]) === isG); if (!c.length) return null;
    if (c.length === 1) return c[0];
    const g = /G/.test(pos) ? 'G' : /D/.test(pos) ? 'D' : 'F';
    const same = c.filter(x => (g === 'G' ? /G/.test(x[2]) : g === 'D' ? /D/.test(x[2]) : !/[GD]/.test(x[2])));
    const nhl = (same.length ? same : c).filter(x => x[1] && x[1] !== '(N/A)');
    return (nhl[0] || same[0] || c[0]);
  }

  // ---- scoring ----
  function score(lg, rows) {
    const f = NHLE[lg] || .2;
    const elig = rows.filter(r => !r.goalie && r.gp >= 3);
    const prior = { F: 0, D: 0 }, n = { F: 0, D: 0 };
    elig.forEach(r => { const g = /D/.test(r.pos) ? 'D' : 'F'; prior[g] += r.pts / r.gp; n[g]++; });
    for (const g of ['F', 'D']) prior[g] = n[g] ? prior[g] / n[g] : .4;
    for (const r of rows) {
      if (r.goalie) continue;
      const g = /D/.test(r.pos) ? 'D' : 'F';
      const shr = (r.pts + 5 * prior[g]) / (r.gp + 5);
      r.ppg = r.gp ? +(r.pts / r.gp).toFixed(2) : 0;
      r.nhle = +(shr * f * 82).toFixed(1);
      const age = r.age ?? 21;
      const af = Math.max(.6, Math.min(1.4, 1 + .1 * (21 - age)));
      r.gem = +(r.nhle * af * (g === 'D' ? 1.3 : 1)).toFixed(1);
    }
  }
  // ---- history + trends (per league, in this origin's storage) ----
  function trend(lg, rows) {
    const H = ls.get('ws.hist.' + lg, {});
    const d = today();
    H[d] = {}; rows.forEach(r => { if (!r.goalie) H[d][r.sid] = [r.gp, r.pts]; });
    const days = Object.keys(H).sort(); while (days.length > 75) delete H[days.shift()];
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
  // ---- main ----
  async function run(lg, adapter, opts = {}) {
    const fx = await fantrax();
    const rows = await adapter();
    for (const r of rows) {
      r.age = r.dob ? ageOn(r.dob) : r.age ?? null; if (r.age != null && (r.age < 16 || r.age > 45)) r.age = null;
      const m = match(fx, r.first, r.last, r.pos);
      r.fx = m ? m[0] : null; r.org = m ? m[1] : null;
      const o = m && fx.own[m[0]]; r.own = o ? o[0] : null; r.st = o ? o[1] : null;
    }
    score(lg, rows);
    const nDays = trend(lg, rows);
    // NHL draft status. A player with no NHL club who has not yet been through an NHL draft is not a free-agent pickup:
    // he has to go through the draft first (and only becomes claimable if he is passed over, or later released).
    // First eligible: 18 by Sept 15 of the draft year; the draft is in late June. 'pre' = not yet through a draft,
    // 'post' = drafted or already passed over, '' = unknown (no birthdate; Czech ages are bands).
    const td = new Date(today()), drY = td.getMonth() >= 6 ? td.getFullYear() : td.getFullYear() - 1;
    const cut = new Date(drY - 18, 8, 15);
    for (const r of rows) {
      r.dr = r.org && r.org !== '(N/A)' ? 'post'
        : r.dob ? (new Date(r.dob) > cut ? 'pre' : 'post')
        : r.age != null && lg !== 'Czech' ? (r.age <= 17 ? 'pre' : r.age >= 19 ? 'post' : '') : '';
    }
    const S = r => [r.fx || '', r.own || '', r.st || '', r.first + ' ' + r.last, r.team, r.pos, r.age ?? '', r.gp, r.g, r.a, r.pts, r.ppp ?? '', r.ppg, r.nhle, r.prev ?? '', r.yoy ?? '', r.tr ?? '', r.rgp ?? '', r.toi ?? '', r.dr || ''].join('|');
    const G = r => [r.fx || '', r.own || '', r.st || '', r.first + ' ' + r.last, r.team, r.age ?? '', r.gp, r.svp ?? '', r.gaa ?? '', r.w ?? '', r.min ?? ''].join('|');
    const sk = rows.filter(r => !r.goalie), gl = rows.filter(r => r.goalie);
    const minGP = opts.minGP ?? 3;
    const ownedOK = r => r.own && (!opts.ownedSt || opts.ownedSt.includes(r.st));
    const owned = sk.filter(ownedOK).map(S);
    const avail = sk.filter(r => !r.own && r.fx && r.org && r.org !== '(N/A)' && r.gp >= minGP && (r.age == null || r.age <= (opts.maxAge ?? 24))).sort((a, b) => b.gem - a.gem).slice(0, opts.nAvail ?? 15).map(S);
    const undrafted = sk.filter(r => !r.own && (!r.org || r.org === '(N/A)') && r.gp >= minGP && r.age != null && r.age <= 20).sort((a, b) => b.gem - a.gem).slice(0, opts.nUnd ?? 8).map(S);
    const risers = sk.filter(r => !r.own && r.tr != null && r.rgp >= 4 && (r.age == null || r.age <= 23)).sort((a, b) => b.tr - a.tr).slice(0, 6).map(S);
    const goalies = gl.filter(r => ownedOK(r) || (!r.own && r.fx && r.org && r.org !== '(N/A)' && r.gp >= minGP && (r.age == null || r.age <= (opts.maxAge ?? 24)))).sort((a, b) => (b.own ? 1 : 0) - (a.own ? 1 : 0) || (b.svp || 0) - (a.svp || 0)).slice(0, 14).map(G);
    // league leaders on scan day: [name, team, value, gp, owner]; ties go to fewer games played
    const lead = k => { const r = sk.filter(x => x[k] != null).sort((x, y) => (y[k] - x[k]) || (x.gp - y.gp))[0]; return r ? [r.first + ' ' + r.last, r.team, r[k], r.gp, r.own || '', r.fx || '', r.org && r.org !== '(N/A)' ? r.org : '', '', r.pos || '', r.age ?? '', r.dr || ''] : null; };
    const leaders = { pts: lead('pts'), g: lead('g'), a: lead('a') };
    return { lg, d: today(), nSk: sk.length, nG: gl.length, nDays, matched: sk.filter(r => r.fx).length, owned, avail, undrafted, risers, goalies, leaders };
  }

  // ---- adapters ----
  const HT = { AHL: ['ahl', 'ccb91f29d6744675'], OHL: ['ohl', 'd33ffebb443a4536'], WHL: ['whl', '41b145a848f4bd67'], QMJHL: ['lhjmq', '02163f1eeecebec4'], USHL: ['ushl', 'e828f89b243dc43f'], ECHL: ['echl', '2c2b89ea7345cae8'] };
  const htFeed = async (c, k, q) => { const t = await fetch(`https://lscluster.hockeytech.com/feed/index.php?${q}&key=${k}&client_code=${c}`).then(r => r.text()); return JSON.parse(t.replace(/^\(|\)$/g, '')); };
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
    for (let i = 0; i < teams.length; i += 4) await Promise.all(teams.slice(i, i + 4).map(async t => { for (let tries = 0; tries < 3; tries++) { try { const ro = (await htFeed(c, k, `feed=modulekit&view=roster&team_id=${t.id}&season_id=${season}&fmt=json`)).SiteKit.Roster; ro.forEach(p => { if (p.player_id && p.birthdate) m[p.player_id] = p.birthdate; }); WS.rosters[c] = WS.rosters[c] || {}; ro.forEach(p => { if (p.first_name) WS.rosters[c][p.player_id] = [p.first_name, p.last_name, p.position || '', t.code || t.name, p.birthdate]; }); break; } catch (e) { await new Promise(r => setTimeout(r, 400)); } } }));
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
      return out;
    };
  }
  function liiga() {
    return async () => {
      const y = new Date().getMonth() >= 6 ? new Date().getFullYear() + 1 : new Date().getFullYear();
      const cur = await fetch(`https://liiga.fi/api/v2/players/stats/summed/${y}/${y}/runkosarja/true?dataType=basicStats`).then(r => r.json());
      let P = ls.get('ws.prev.liiga', null);
      if (!P || P.s !== y - 1) { const pr = await fetch(`https://liiga.fi/api/v2/players/stats/summed/${y - 1}/${y - 1}/runkosarja/true?dataType=basicStats`).then(r => r.json()); P = { s: y - 1, m: {} }; pr.forEach(r => { if (r.playedGames >= 10 && !r.goalkeeper) P.m[r.playerId] = +(r.points / r.playedGames).toFixed(2); }); ls.set('ws.prev.liiga', P); }
      const DB = ls.get('ws.dob.liiga', {}); const need = cur.filter(r => !r.removed && !DB[r.playerId]).map(r => r.playerId);
      for (let i = 0; i < need.length; i += 25) await Promise.all(need.slice(i, i + 25).map(async id => { try { const j = await fetch('https://liiga.fi/api/v2/players/info/' + id).then(r => r.json()); if (j.dateOfBirth) DB[id] = j.dateOfBirth; } catch (e) { } }));
      ls.set('ws.dob.liiga', DB);
      return cur.filter(r => !r.removed).map(r => r.goalkeeper
        ? { goalie: 1, sid: r.playerId, first: r.firstName, last: r.lastName, pos: 'G', team: r.teamShortName, gp: r.playedGames, dob: DB[r.playerId] }
        : { sid: r.playerId, first: r.firstName, last: r.lastName, pos: r.role === 'P' ? 'D' : 'F', team: r.teamShortName, gp: r.playedGames, g: r.goals, a: r.assists, pts: r.points, ppp: r.powerplayGoals, dob: DB[r.playerId], prev: P.m[r.playerId] ?? null });
    };
  }
  function nhl() {
    return async () => {
      const T = ['ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ', 'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH', 'NJD', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SJS', 'SEA', 'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WSH', 'WPG'];
      const out = [];
      for (let i = 0; i < T.length; i += 4) await Promise.all(T.slice(i, i + 4).map(async t => {
        try {
          const [ro, cs] = await Promise.all([fetch(`https://api-web.nhle.com/v1/roster/${t}/current`).then(r => r.json()), fetch(`https://api-web.nhle.com/v1/club-stats/${t}/now`).then(r => r.ok ? r.json() : {}).catch(() => ({}))]);
          const st = {}; (cs.skaters || []).forEach(s => st[s.playerId] = s); const gs = {}; (cs.goalies || []).forEach(s => gs[s.playerId] = s);
          for (const grp of ['forwards', 'defensemen', 'goalies']) (ro[grp] || []).forEach(p => {
            const base = { sid: p.id, first: p.firstName.default, last: p.lastName.default, pos: grp === 'goalies' ? 'G' : grp === 'defensemen' ? 'D' : p.positionCode, team: t, dob: p.birthDate };
            if (grp === 'goalies') { const s = gs[p.id] || {}; out.push({ ...base, goalie: 1, gp: s.gamesPlayed || 0, svp: s.savePercentage != null ? s.savePercentage.toFixed(3) : '', gaa: s.goalsAgainstAverage != null ? s.goalsAgainstAverage.toFixed(2) : '', w: s.wins }); }
            else { const s = st[p.id] || {}; out.push({ ...base, gp: s.gamesPlayed || 0, g: s.goals || 0, a: s.assists || 0, pts: s.points || 0, ppp: s.powerPlayGoals ?? null }); }
          });
        } catch (e) { }
      }));
      return out;
    };
  }
  // KHL (run on en.khl.ru): internal REST feed, needs the page's session token. Season/tournament ids change yearly
  // (2026-27: season s19, tournament 1436 = regular season). Pages return 20 goalies/defense/forwards each.
  function khl(season = 's19', tour = '1436') {
    return async () => {
      const sess = BX.bitrix_sessid(); const out = [];
      const post = page => fetch('/rest/stat/players/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `nav%5Bpage%5D=${page}&values%5Bseason%5D=${season}&values%5Btournament%5D=${tour}&values%5Bamplua_full%5D=all&values%5Bclubs_full%5D=all&values%5Bonly%5D=table&sessid=${sess}` }).then(r => r.json());
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
      // birthdates + club codes from the profile feed, cached per player (first run takes ~60s; the page keeps working after a tool timeout)
      const PC = ls.get('ws.khlprof', {}); const need = out.filter(r => !PC[r.sid]).map(r => r.sid);
      for (let i = 0; i < need.length; i += 10) await Promise.all(need.slice(i, i + 10).map(async id => { try { const j = await fetch('/rest/players/profile/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `values%5Bid%5D=${id}&sessid=${sess}` }).then(r => r.json()); const D = j.data && j.data.DATA; if (D) { const b = (D.birthdate || '').split('.'); PC[id] = [b.length === 3 ? `${b[2]}-${b[1]}-${b[0]}` : '', (D.team && D.team.CODE) || (JSON.stringify(D).match(/"CODE":"([^"]+)"/) || [])[1] || '']; } } catch (e) { } }));
      ls.set('ws.khlprof', PC);
      out.forEach(r => { const p = PC[r.sid]; if (p) { if (p[0]) r.dob = p[0]; if (p[1]) r.team = p[1]; } });
      return out;
    };
  }
  // cross-site hand-off: a collector on a site that blocks Fantrax puts {lg, rows} in window.name, then the tab navigates to the hub
  function xfer(lg) { return async () => { let p = null; if (window.name.startsWith('WSXFER:')) { p = JSON.parse(window.name.slice(7)); if (p.lg === lg) { window.name = ''; ls.set('ws.xfer.' + lg, { d: today(), rows: p.rows }); return p.rows; } } const c = ls.get('ws.xfer.' + lg, null); if (c && c.d === today()) return c.rows; throw new Error('no ' + lg + ' payload today: run the collector on its site first'); }; }
  async function collect(lg, adapter) { const rows = await adapter(); window.name = 'WSXFER:' + JSON.stringify({ lg, rows }); return rows.length; }
  return { v: 5, xfer, collect, run, hockeytech, liiga, nhl, khl, HT, NHLE, ls, norm, key, ageOn, match, fantrax, score, trend, rosters: {}, TEAMS: {"m1hfr04lmow7aw2v":"HFD","4psrznwkmow7aw2u":"CGY","h32ctyahmow7aw2v":"BOS","svnb4s7amow7aw2u":"CGS","fay1fny2mow7aw2u":"VAN","nw53mrdzmow7aw2v":"QUE","ps4l4b6mmow7aw2v":"WPG","39n75kyjmow7aw2u":"CHI","tu2c5havmow7aw2v":"WAS","tsr78hmdmow7aw2u":"ANA","nx9xgs2mmow7aw2u":"COL","br7rvnwsmow7aw2u":"OTT","z64j08mgmow7aw2u":"MTL","vm1rdwvtmow7aw2u":"CAR","hghiywi2mow7aw2u":"EDM","4yx4ssw6mow7aw2v":"DET"} };
})();
