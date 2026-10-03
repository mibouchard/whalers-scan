# whalers-scan

Daily minors scan for the Hartford Whalers (Fantrax league "The Hockey Life"). A GitHub Actions job runs every morning at 5:17 AM Toronto time. It pulls 16 leagues, matches every player to Fantrax, and scores them. The results land in `data/`, where Claude's 6:54 AM morning report picks them up and copies them into the Whalers Front Office page.

## Leagues
NHL, AHL, ECHL, OHL, WHL, QMJHL, USHL, Liiga, KHL, VHL, MHL, SHL, HockeyAllsvenskan, J20 (Swedish U20), NCAA, Czech Extraliga.

## Files
- `data/latest.json`: the latest run, in the same shape as the Front Office `minors/latest` doc.
- `data/YYYY-MM-DD.json`: daily snapshots, kept for 120 days.
- `data/status.json`: whether each league worked on the last run.
- `state/`: caches (birthdates, last season's numbers) and the 75-day trend history. Committed so it survives between runs.
- `engine/engine.js`: the shared scoring and matching engine (the same code the in-browser scan uses).
- `src/leagues.js`: one adapter per league collected from its own site. Season ids that change every year are at the top.

## Running by hand
Actions tab → "Daily minors scan" → Run workflow. To debug part of the scan, enter league names (e.g. `KHL VHL`); a partial run does not overwrite `latest.json`.

## Yearly maintenance
Update the season ids in `src/leagues.js` (KHL tournament, SHL ssgtUuid, swehockey event ids, Czech season) and the KHL defaults in `engine/engine.js` when a new season starts.
