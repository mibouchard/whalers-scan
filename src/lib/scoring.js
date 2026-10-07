// The one copy of the league's scoring (The Hockey Life, head-to-head points).
//   skaters  G 3, A 2, PPP 1, SHG 2, GWG 1, +/- 0.5, BLK 0.2, HIT 0.2, PIM 0.25, SOG 0.1
//   goalies  W 5, SO 5, SV 0.25, GA -1  (a goalie's own goals and assists score like a skater's)
export const SCORING = { G: 3, A: 2, PPP: 1, SHG: 2, GWG: 1, PM: 0.5, BLK: 0.2, HIT: 0.2, PIM: 0.25, SOG: 0.1, W: 5, SO: 5, SV: 0.25, GA: -1 };
export const SCORING_TEXT = 'G 3, A 2, PPP 1, SHG 2, GWG 1, +/- 0.5, BLK 0.2, HIT 0.2, PIM 0.25, SOG 0.1; G: W 5, SO 5, SV 0.25, GA -1';
const n = x => +x || 0;
const r2 = x => +x.toFixed(2);

// s: { g, a, ppp, shg, gwg, pm, blk, hit, pim, sog } (missing = 0)
export const skaterFP = s => r2(SCORING.G * n(s.g) + SCORING.A * n(s.a) + SCORING.PPP * n(s.ppp) + SCORING.SHG * n(s.shg) + SCORING.GWG * n(s.gwg)
  + SCORING.PM * n(s.pm) + SCORING.BLK * n(s.blk) + SCORING.HIT * n(s.hit) + SCORING.PIM * n(s.pim) + SCORING.SOG * n(s.sog));
// s: { w, so, sv, ga, g, a }
export const goalieFP = s => r2(SCORING.W * n(s.w) + SCORING.SO * n(s.so) + SCORING.SV * n(s.sv) + SCORING.GA * n(s.ga) + SCORING.G * n(s.g) + SCORING.A * n(s.a));

// One row of an NHL game log (api-web /player/<id>/game-log) -> fantasy points. Game logs carry no hits or blocks:
// pass them in extra = { hit, blk } when known.
export function gameLogFP(x, extra = {}) {
  if (x.shotsAgainst !== undefined || x.savePctg !== undefined)
    return goalieFP({ w: x.decision === 'W' ? 1 : 0, so: n(x.shutouts), sv: n(x.shotsAgainst) - n(x.goalsAgainst), ga: x.goalsAgainst, g: x.goals, a: x.assists });
  return skaterFP({ g: x.goals, a: x.assists, ppp: x.powerPlayPoints, shg: x.shorthandedGoals, gwg: x.gameWinningGoals, pm: x.plusMinus, pim: x.pim, sog: x.shots, hit: extra.hit, blk: extra.blk });
}
