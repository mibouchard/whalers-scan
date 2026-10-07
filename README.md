# whalers-scan

Daily fantasy-hockey data for the Hartford Whalers (HFD) in the Fantrax league "The Hockey Life" (16 teams). GitHub Actions reads 16 hockey leagues, Fantrax's public league feed and the NHL API, and commits JSON files under `data/`. Scheduled reports and a dashboard read those files from `raw.githubusercontent.com`.

This repository is public. It holds no secrets, tokens, cookies or logins, and none may be added: every source it reads is a public page or feed. Do not commit anything private.

## What runs when

| When | What | Writes |
|---|---|---|
| about 09:14 UTC daily | An outside timer starts the **Daily minors scan** workflow (`scan.yml`, by `workflow_dispatch`). | everything under "Daily files" |
| 09:17, 09:47, 10:23 UTC | GitHub's own schedule, as backups. A backup stops at once if today's scan finished clean. If leagues or steps failed, it re-reads only those leagues, re-runs only those steps and merges. | the same files |
| about 11:40 PM Toronto | An outside timer starts the **One-off tool** workflow (`tool.yml`) with `tool=nightalert`. | `data/adhoc/alert.json` |
| by hand | Actions tab, "One-off tool", pick a script from `src/tools/`. | that tool's file |

Cron times are UTC and do not follow daylight saving. 09:17 UTC is 5:17 AM in Toronto on EDT (summer) and 4:17 AM on EST (winter). Every date the code works out itself ("yesterday", "tonight", "today's scan") uses the America/Toronto calendar, whatever the season.

Both workflows share one concurrency group (`repo-write`), so two runs never push at the same time. GitHub keeps only one waiting run per group: a run queued behind another can be replaced by a newer one.

### The daily job, in order

1. `src/scan.js`: the 16-league scan.
2. `form`, `pool`, `league`, `box` (yesterday), `nightalert late` (yesterday), `fawatch`, `week`.
3. `src/ci/health.js` writes `data/health.json`.
4. Commit and push (three tries: `git pull --rebase -X theirs`, push, a jittered wait).
5. Last, after the push: the job fails if any league or step failed, so GitHub emails the owner. A red job never costs data.

Each step in 1 and 2 records `ok` or `ERR: ...` and never stops the job.

## Failure behaviour

- **Retries and deadlines.** Every league gets three tries with backoff inside its own deadline (3 to 9 minutes), and the scan as a whole has a 22-minute budget. A league that does not fit is reported as failed. KHL's internal calls get six tries each, thrown errors included.
- **Carry-forward.** A league that fails keeps its last good rows. Its status reads `carried YYYY-MM-DD` (the date of the data, kept when a carry is carried again) and the reason is under `errors`. Carried rows older than 7 days are dropped and the status becomes `ERR ...`. Free-agent rows that are carried are re-checked against today's Fantrax status.
- **Empty is a failure.** A league that returns no players after it has had rows this season is `empty` (a failure, carried). `no games yet` is only for a league that has never returned rows this season.
- **Partial.** If a few NHL clubs cannot be read the NHL status is `partial: ...` and it counts as failed (a backup retries it); more than 8 clubs missing is a failure.
- **Retry-failed.** `node src/scan.js --retry-failed` re-reads only the leagues listed under today's `errors` and merges them into `latest.json`, the dated snapshot and `status.json`.
- **Fantrax down.** If `getLeagueInfo` fails nobody is treated as a free agent: `avail`, `und`, `risers` and unowned goalies are empty, and `errors.Fantrax` and `notes.Fantrax` say why. If next period's rosters cannot be read, ownership falls back to the current period and `fantrax.nextPeriod` / `notes.Fantrax` say so.
- **Stale sites.** A league whose total games played has not changed over 4 or more daily points while at least three other leagues moved is listed under `stale`. It is a hint, not a failure: leagues with few game days trip it.
- **Debug runs.** A scan of named leagues (`node src/scan.js KHL VHL`, or the workflow's `leagues` box) writes only `data/status-debug.json`.
- **health.json** says whether each step ran, and carries the date and time of last night's `alert.json`, so a reader can tell that the 11:40 PM alert job did not run.

## League rules the code applies

- **Scoring** (`src/lib/scoring.js`): G 3, A 2, PPP 1, SHG 2, GWG 1, +/- 0.5, BLK 0.2, HIT 0.2, PIM 0.25, SOG 0.1. Goalies: W 5, SO 5, SV 0.25, GA -1, and their own goals and assists score too. A shutout needs the goalie to have played the whole game with no goal against his team; a shootout loss is not a win.
- **Cap** (`capOf` in `src/lib/fantrax.js`): $114.4M counts ACTIVE + RESERVE salaries plus dead cap (`config.json`). MINORS and INJURED_RESERVE do not count. `roomAfterIR` is the room left if every injured-reserve player came back.
- **Roster**: main roster (active + reserve) 18 to 20, active 14, reserve up to 6, minors up to 25.
- **Periods**: a move made this week only shows in next period's roster. Ownership, counts, cap and "next week" use period N+1 (falling back to N). Scoring a game already played uses the period in effect at its start time (`periodForDate`, from the period dates in `getLeagueInfo`).
- **Free agents**: only Fantrax's own status (`getLeagueInfo` `playerInfo`, FA or WW). Never inferred from rosters.
- **NHL draft**: a player with no NHL club who has not been through an NHL draft is never claimable (`dr` = `pre`). The cutoff is "18 by September 15 of the draft year" and moves on by itself each July. Only a real birthdate decides it; with an estimated or missing age `dr` is blank (unknown).

## Daily files

Rows in `latest.json` are pipe-delimited strings; `cols` names the fields. New columns are only ever appended.

### `data/latest.json` (and `data/YYYY-MM-DD.json`, kept 120 days)

| Field | Meaning |
|---|---|
| `d`, `at`, `src` | Toronto date of the scan, UTC time, `github-actions` |
| `cols.sk` | `lg, fx, own, st, name, team, pos, age, gp, g, a, pts, ppp, ppg, nhle, prev, yoy, tr, rgp, toi, dr, ak, mq` |
| `cols.g` | `lg, fx, own, st, name, team, age, gp, svp, gaa, w, min, ak, mq` |
| `owned` | every skater on a fantasy roster (NHL league: MINORS only) |
| `avail` | free agents (FA/WW) whose NHL rights are held, 24 or younger or of unknown age, top 12 per league |
| `und` | free agents with no NHL club, 20 or younger, top 6 per league; check `dr` |
| `risers` | free agents trending up over the last two weeks |
| `goalies` | every owned goalie, plus up to 14 unowned free-agent goalies per league |
| `notInFx` | best young players a league lists that Fantrax does not have (not free agents) |
| `cov` | per league `[skaters, goalies, matched to Fantrax, owned, history days]`, or `no games yet` / `ERR ...` |
| `status` | per league: `ok`, `no games yet`, `partial: ...`, `carried YYYY-MM-DD`, `ERR ...` |
| `errors` | `{ league or "Fantrax": reason }` for everything that failed today (carried leagues included) |
| `stale` | `{ league: text }`, see above |
| `fantrax` | `{ rosters, period, ownPeriod, nextPeriod, leagueInfo }`: which period ownership came from and whether each feed worked |
| `ppp` | per league what the `ppp` column holds: `points`, `goals` or `none` |
| `leaders` | per league `pts` / `g` / `a`: `[name, team, value, gp, owner, fantraxId, nhlRights, fantraxStatus, pos, age, dr]` |
| `hfdMissing` | HFD MINORS players (next period's roster) not found in any scanned league: `[{ id, name, nhlTeam, pos }]` |
| `checks` | what the matching guards did: `dropped`, `ambiguous`, `veteran`, `rejected` (lists of `lg|fx|name|team|reason`) |
| `leagueNotes` | per-league remarks from the adapters (which Liiga goalie feed answered, NCAA birthdates found) |
| `pending`, `notes` | leagues not covered yet; plain-language notes on every convention above |

Column values worth knowing: `dr` = `post` / `pre` / blank (draft status, above). `ak` = how the age is known: `dob` (real birthdate), `est` (NCAA class year, Czech age band), blank (no age). `mq` = `amb` when one Fantrax player was matched to more than one person and none is clearly the real one. `nhle` is blank for a player with no games. Rows with no age rank below rows with one.

### `data/status.json`
`{ d, at, mode ("full" | "retry-failed"), status, errors, fantrax, stale, subset: [], retried? }`. `data/status-debug.json` is the same for a debug run, plus `cov`, `checks`, `leagueNotes`.

### `data/health.json`
`{ at, d, mode, steps: { scan, form, pool, league, box, alertLate, fawatch, week: "ok" | "ERR: ..." }, leagues: <status map>, errors, fantrax, stale, alert: { date, at } }`.

### `data/league.json` (from `src/tools/league.js`)

```
{ at, period, nextPeriod,
  periodDates: { cur: { start, end }, next: { start, end } | null },
  teams: { <teamId>: { short, name, cur: [[fxId, status, salaryM, pos, name, nhlTeam]], next: [...] | null } },
  hfd: { cur:  { counts: { active, reserve, ir, minors, main }, cap: { active, reserve, dead, ir, used, room, roomAfterIR } },
         next: { same } | null,
         ir: [{ id, name, salary, ret }],          // ret = expected return from data/pool.json, or null
         warnings: ["minors 26/25", "main roster 21/20", "active not 14 (13)", "reserve 7/6", "over the cap by 1.200M"] },
  free: { <fxId>: "FA" | "WW" } | null,            // null when the feed failed; never inferred
  scores: { period, matchups: [{ a, h, as, hs }] } | null,
  standings: { rows: [{ team, w, l, t, pf, pa, rank }] } | null,
  moves: [{ team, id, name, from, to, salaryFrom, salaryTo }], movesSince,
  unknownIds: [...], notes: [...] }
```

`a`, `h` and `team` are short codes (HFD, CGY, ...). `status` is `ACTIVE`, `RESERVE`, `MINORS` or `INJURED_RESERVE`. `moves` compares every team's next-period roster with the previous `league.json` (written at `movesSince`): an add has `from: null`, a drop `to: null`, a trade is a drop on one team and an add on the other. `pa` is null: the public standings feed has no points against. `warnings` describe the next-period roster.

### `data/fo/` (ready-to-write dashboard documents, also from `league.js`)
- `rosters.json`: `{ asOf, src: "Fantrax getTeamRosters", period, teams: { <teamId>: [[fxId, status, salaryM, pos, name], ...] }, dead: { <teamId>: 0.588 } }`. Next period's rosters, or the current ones when there is no next. A team with fewer than 25 rows is left out and named in `league.json` `notes`.
- `scores.json`: `{ asOf, period, matchups: [{ a, h, as, hs }] }`.
- `standings.json`: `{ asOf, rows: [...] }`, only written once wins or losses exist.

`asOf` is an ISO time with the Toronto offset.

### `data/form.json` (from `form.js`)
`{ at, window: 5, scoring, players: { <fxId>: { name, nhlId, gp, fpg, games: [[date, fp]] } }, roster: { <fxId>: [name, nhlTeam, positions] } }`: fantasy points per game over each HFD NHL player's last 5 regular-season games, hits and blocks included.

### `data/pool.json` (from `pool.js`)
`{ at, status: { asOf, src, rows: { <fxId>: "WW" } } | null, injuries: { asOf, src, rows: { <fxId>: [injury, status text, updated, expected return or ""] } } | null, notes }`. If the injury report cannot be read, the last one (up to 4 days old) is kept and a note says so.

### `data/adhoc/`
- `box.json`, `box-YYYY-MM-DD.json` (dated copies kept 14 days), from `box.js`: `{ d, at, period, periods, currentPeriod, nextPeriod, games, gamesPending, gameType: [2], hfdCapRoomNext, hfdCap, nPlayerInfo, fa, unmatched, notes, rows }`. Each row: `{ fxStatus, name, team, opp, pos, fp, <stat line>, fx, own, st, ownNext, sal, period }`. `own` / `st` are from the period in effect for that game, `ownNext` from next period, `fxStatus` is Fantrax's FA / WW / T. `fa` lists the night's free agents, or null if Fantrax's status feed failed.
- `alert.json`, from `nightalert.js`: `{ at, date, gamesFinal, gamesPending, candidates: [{ name, team, pos, age, fx, status, fp, line, toi, avgToi, gpBefore, reasons, why }], nearMisses, unmatched }`.
- `alert-late.json`, from `nightalert.js late`: the same plus `late: true` and `lateGames` (the games `alert.json` listed as pending for that date, or all games if `alert.json` is for another date). Candidates come only from those games.
- `fawatch.json`, from `fawatch.js`: `{ at, src, status, errors, skaters: [{ lg, <sk columns>, ageKnown, rights, fxStatus, elig, gem }], goalies: [...] }`. Free agents across all leagues, rows with a known age first.
- `week.json`, from `week.js`: `{ at, week, period, scoring, hitsBlocks, games, byDay, current, next, stats }`.
- `hfd-roster.json`, `team.json`, `lookup.json`, `names.json`: the one-off lookups below.

## Tools (`src/tools/`)

Run with the "One-off tool" workflow (`tool` = file name without `.js`, `args` optional) or locally with `node src/tools/<name>.js [args]`. Arguments can also come from the environment: `ARGS`, `DATE`, `TEAM`, `LATE=1`.

| Tool | Arguments | Writes |
|---|---|---|
| `league` | | `data/league.json`, `data/fo/*.json` |
| `box` | date (default: yesterday) | `data/adhoc/box.json`, `box-<date>.json` |
| `nightalert` | date; `late` | `data/adhoc/alert.json` or `alert-late.json` |
| `fawatch` | | `data/adhoc/fawatch.json` |
| `form` | | `data/form.json` |
| `pool` | | `data/pool.json` |
| `week` | Monday date (default: this week) | `data/adhoc/week.json` |
| `roster` | | `data/adhoc/hfd-roster.json` |
| `team` | team name, short code or id, e.g. `Ottawa Senators` | `data/adhoc/team.json` |
| `lookup` | reads `data/adhoc/lookup-in.json` (array of Fantrax ids) | `data/adhoc/lookup.json` |
| `names` | reads `data/adhoc/names-in.json` (array of "First Last") | `data/adhoc/names.json` |

A tool run commits `data/adhoc`, `data/form.json`, `data/pool.json`, `data/league.json`, `data/fo` and `data/health.json`; anything it changed under `state/` is not saved.

## How matching works

Players from league sites are matched to Fantrax by name (`src/lib/names.js`, `match` in `engine/engine.js`):

- Names match exactly once accents, apostrophes, hyphens and spacing are ignored. Word order matters.
- Names from KHL, VHL and MHL are transliterated from Russian, so there spelling variants fold together and word order is ignored. In other leagues a Russian given name (Artem / Artyom, Dmitri / Dmitry) still folds, with word order kept. NHL rows can also match on last name, NHL club and first initial.
- A goalie only matches a goalie. A forward never matches a Fantrax defenceman, or the reverse.
- After all leagues are read, `src/lib/plausible.js` checks the matches against each other: a Fantrax id found in two leagues must be a believable pair (NHL/AHL/ECHL, KHL/VHL/MHL, SHL/Allsvenskan/J20, or matching ages), and a player's age must fit the block of Fantrax ids his id comes from (ids are handed out in order, so neighbours are mostly one draft class; learned daily into `state/ws.idcohort.json`). Namesakes lose the match; pairs that cannot be told apart are tagged `amb`; rows with no age on a veteran's id are kept out of the free-agent lists. Everything it did is listed under `checks`.

## Layout

- `config.json`: league id, team id, cap, dead cap.
- `engine/engine.js`: matching, scoring (NHL-equivalent), trends, draft status, and the adapters for the HockeyTech leagues, Liiga, NHL and KHL.
- `src/leagues.js`: adapters for KHL (session handling), VHL, MHL, SHL, Allsvenskan, J20, NCAA, Czech.
- `src/lib/`: shared code. `config.js` (constants, dates, arguments), `fantrax.js` (feed, cap, periods, moves), `scoring.js`, `names.js`, `nhl.js` (box scores to fantasy lines), `plausible.js`, `pipeline.js` (league fetch loop), `util.js` (`retry`, deadlines).
- `src/ci/`: `guard.js` (full / retry / skip), `step.js` (records each step), `health.js`, `push.sh`.
- `state/`: caches that survive between runs: birthdates, last season's numbers, 22 days of trend history, the id cohort.
- `test/`: offline tests, `npm test`. `npm run check` syntax-checks every file.

## Yearly maintenance

- **Season ids** at the top of `src/leagues.js`: KHL season and tournament, SHL `ssgtUuid`, swehockey event ids (Allsvenskan, J20), Czech season and competition. The same KHL defaults are in `khl()` in `engine/engine.js`.
- **`config.json`**: cap and dead cap, when they change.
- **Nothing to do** for the draft cutoff (automatic), the NHL season id (worked out from the date) and the HockeyTech and Liiga seasons (read from the sites).
- New leagues: add an adapter, a line in `leagueJobs` and `LEAGUES` in `src/lib/pipeline.js`, an NHLe factor in the engine and, if its ages are real birthdates, the league in `DOB_LEAGUES` in `src/lib/plausible.js`.
