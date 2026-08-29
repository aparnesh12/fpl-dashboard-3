#!/usr/bin/env python3
"""
Pulls live data from the official Fantasy Premier League API and writes
processed JSON files that the static dashboard (index.html/app.js) reads.

Runs on a GitHub Actions schedule — see .github/workflows/update-data.yml.
No login, API key, or authentication required: these are public,
read-only endpoints.
"""
import csv
import io
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pulp
import requests

BASE = "https://fantasy.premierleague.com/api"
HISTORY_BASE = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"
HISTORY_SEASONS = ["2025-26", "2024-25"]  # most recent completed seasons used for opponent history
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; fpl-dashboard/1.0)"}
TIMEOUT = 20
FIXTURE_WINDOW = 6       # how many gameweeks ahead the fixture ticker shows
PREDICT_WINDOW = 5       # how many gameweeks ahead "predicted next-5" covers
RECS_PER_POSITION = 12   # how many players per position on the Recommendations tab
MIN_HISTORY_MATCHES = 2  # need at least this many past meetings before trusting a history bonus
SQUAD_QUOTAS = {"GKP": 2, "DEF": 5, "MID": 5, "FWD": 3}
FORMATIONS = [(d, m, f) for d in range(3, 6) for m in range(2, 6) for f in [10 - d - m] if 1 <= f <= 3]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
CONFIG_PATH = os.path.join(ROOT, "config.json")

POSITIONS = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}

STATUS_LABELS = {
    "a": "Available",
    "d": "Doubtful",
    "i": "Injured",
    "s": "Suspended",
    "u": "Unavailable",
    "n": "Not available for selection",
}

# Predicted-points fixture-difficulty scaling. 3 (neutral) = 1.0x.
DIFFICULTY_MULTIPLIER = {1: 1.30, 2: 1.15, 3: 1.00, 4: 0.82, 5: 0.65}


def get(url):
    resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def get_csv(url):
    resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    return csv.DictReader(io.StringIO(resp.text))


def build_history_lookup(seasons=HISTORY_SEASONS):
    """Pulls prior-season gameweek-by-gameweek data from the vaastav/
    Fantasy-Premier-League public archive (not the live FPL API, which only
    exposes the current season's match-by-match detail) and builds:
      - vs_opponent[(player_name_lower, opponent_short_name)] -> [points, ...]
      - overall[player_name_lower] -> [points, ...]   (that player's own
        historical average, used as the baseline a strong-vs-opponent
        showing is judged against, rather than a flat league-wide number)
    Matching is by player full name (the FPL element id is not stable
    across seasons) and by team short_name (which IS stable — confirmed
    against a live sample before wiring this up). Best-effort: a season
    that fails to fetch is skipped rather than failing the whole run."""
    vs_opponent = {}
    overall = {}
    seasons_used = []

    for season in seasons:
        try:
            team_rows = get_csv(f"{HISTORY_BASE}/{season}/teams.csv")
            team_short_by_id = {int(row["id"]): row["short_name"] for row in team_rows}

            gw_rows = get_csv(f"{HISTORY_BASE}/{season}/gws/merged_gw.csv")
            for row in gw_rows:
                name_key = row.get("name", "").strip().lower()
                if not name_key:
                    continue
                try:
                    points = int(row.get("total_points") or 0)
                    opp_id = int(row.get("opponent_team"))
                except (TypeError, ValueError):
                    continue
                opp_short = team_short_by_id.get(opp_id)

                overall.setdefault(name_key, []).append(points)
                if opp_short:
                    vs_opponent.setdefault((name_key, opp_short), []).append(points)
            seasons_used.append(season)
        except (requests.RequestException, ValueError, KeyError) as exc:
            print(f"Warning: skipping history season {season}: {exc}", file=sys.stderr)

    print(f"History lookup built from {seasons_used or 'no seasons (all failed)'}.")
    return vs_opponent, overall, seasons_used


def opponent_history(player_full_name, next_opponent_short, vs_opponent, overall, seasons_used):
    """Returns (bonus_points, detail_dict_or_None) for how this player has
    fared specifically against their next opponent, over the seasons in
    seasons_used. Requires MIN_HISTORY_MATCHES prior meetings before it will
    contribute anything — one lucky/unlucky match is noise, not signal."""
    if not next_opponent_short or not seasons_used:
        return 0.0, None
    name_key = player_full_name.strip().lower()
    matches = vs_opponent.get((name_key, next_opponent_short), [])
    if len(matches) < MIN_HISTORY_MATCHES:
        return 0.0, None

    avg_vs_opp = sum(matches) / len(matches)
    player_overall_avg = sum(overall.get(name_key, matches)) / len(overall.get(name_key, matches))
    diff = avg_vs_opp - player_overall_avg
    bonus = round(max(-2.5, min(3.0, diff * 0.4)), 1)

    return bonus, {
        "opponent": next_opponent_short,
        "matches": len(matches),
        "avg_points": round(avg_vs_opp, 1),
        "best_points": max(matches),
        "seasons": seasons_used,
    }


def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {}


def safe_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def build_teams(bootstrap):
    return [
        {
            "id": t["id"],
            "name": t["name"],
            "short_name": t["short_name"],
            "strength_attack_home": t.get("strength_attack_home", 0),
            "strength_attack_away": t.get("strength_attack_away", 0),
            "strength_defence_home": t.get("strength_defence_home", 0),
            "strength_defence_away": t.get("strength_defence_away", 0),
        }
        for t in bootstrap["teams"]
    ]


def team_upcoming_fixtures(fixtures, team_id, n_gws):
    """Every not-yet-played fixture for a team, soonest first, capped at n_gws
    worth of gameweeks. Uses the fixture's own 'finished' flag rather than a
    pure gameweek-number cutoff, so a gameweek that's partway through (some
    teams played, some not) is handled correctly."""
    relevant = [
        f for f in fixtures
        if f["event"] and not f.get("finished") and (f["team_h"] == team_id or f["team_a"] == team_id)
    ]
    relevant.sort(key=lambda f: (f["event"], f["kickoff_time"] or ""))
    if not relevant:
        return []
    cutoff_gw = relevant[0]["event"] + n_gws - 1
    out = []
    for f in relevant:
        if f["event"] > cutoff_gw:
            break
        is_home = f["team_h"] == team_id
        out.append({
            "gw": f["event"],
            "opponent_id": f["team_a"] if is_home else f["team_h"],
            "is_home": is_home,
            "difficulty": f["team_h_difficulty"] if is_home else f["team_a_difficulty"],
        })
    return out


def build_fixture_ticker(fixtures, teams_by_id, n_gws=FIXTURE_WINDOW):
    by_team = {}
    for t_id, team in teams_by_id.items():
        fx = team_upcoming_fixtures(fixtures, t_id, n_gws)
        by_team[t_id] = [
            {**f, "opponent": teams_by_id.get(f["opponent_id"], {}).get("short_name", "?")}
            for f in fx
        ]
    return by_team


def build_team_fixture_scores(fixture_ticker, teams_by_id):
    """Same average-difficulty score used for the per-player ticker, computed
    per team instead, and pre-sorted easiest to hardest so the frontend
    doesn't have to."""
    scored = []
    for t_id, fixtures_list in fixture_ticker.items():
        team = teams_by_id.get(t_id, {})
        avg = round(sum(f["difficulty"] for f in fixtures_list) / len(fixtures_list), 2) if fixtures_list else None
        scored.append({
            "team_id": t_id,
            "team": team.get("short_name", "?"),
            "team_name": team.get("name", "?"),
            "score": avg,
            "fixtures": fixtures_list,
        })
    scored.sort(key=lambda t: (t["score"] is None, t["score"]))
    return scored


def price_change_confidence(percent):
    """Per FPL's own 2026/27 Price Change Predictor and how Fantasy Football
    Scout documents reading it: the percent is progress toward the next
    threshold and can run past 100 (or below -100) — official guidance is
    'very likely' at 100%+, 'likely' from 80%+. Below that it's too soft to
    act on, so this deliberately returns None rather than a false-confident
    label."""
    abs_pct = abs(percent)
    if abs_pct >= 100:
        return "Very Likely"
    if abs_pct >= 80:
        return "Likely"
    if abs_pct >= 50:
        return "Possible"
    return None


def build_price_changes(players):
    """Today's risers/fallers (cost_change_event) and season-long movers
    (cost_change_start), each pre-sorted by magnitude, plus predicted movers
    from FPL's own official Price Change Predictor (price_change_percent) —
    confirmed against FPL's launch announcement and Fantasy Football Scout's
    documented interpretation of the same fields before being wired up."""
    def slim(p, change_key):
        return {"id": p["id"], "name": p["name"], "team": p["team"], "pos": p["pos"],
                "price": p["price"], "change": p[change_key], "selected_by": p["selected_by"]}

    def slim_predicted(p):
        return {"id": p["id"], "name": p["name"], "team": p["team"], "pos": p["pos"],
                "price": p["price"], "percent": p["price_change_percent"],
                "hourly_rate": p["price_change_hourly_rate"],
                "confidence": price_change_confidence(p["price_change_percent"]),
                "selected_by": p["selected_by"]}

    today_risers = sorted([p for p in players if p["cost_change_event"] > 0], key=lambda p: -p["cost_change_event"])
    today_fallers = sorted([p for p in players if p["cost_change_event"] < 0], key=lambda p: p["cost_change_event"])
    season_risers = sorted([p for p in players if p["cost_change_start"] > 0], key=lambda p: -p["cost_change_start"])
    season_fallers = sorted([p for p in players if p["cost_change_start"] < 0], key=lambda p: p["cost_change_start"])

    predicted_pool = [p for p in players if price_change_confidence(p["price_change_percent"])]
    predicted_risers = sorted([p for p in predicted_pool if p["price_change_percent"] > 0],
                               key=lambda p: -p["price_change_percent"])
    predicted_fallers = sorted([p for p in predicted_pool if p["price_change_percent"] < 0],
                                key=lambda p: p["price_change_percent"])

    return {
        "today_risers": [slim(p, "cost_change_event") for p in today_risers[:25]],
        "today_fallers": [slim(p, "cost_change_event") for p in today_fallers[:25]],
        "season_risers": [slim(p, "cost_change_start") for p in season_risers[:25]],
        "season_fallers": [slim(p, "cost_change_start") for p in season_fallers[:25]],
        "predicted_risers": [slim_predicted(p) for p in predicted_risers[:25]],
        "predicted_fallers": [slim_predicted(p) for p in predicted_fallers[:25]],
    }


def predicted_points(player_form, team_fixtures, games_elapsed, minutes_played, n_gws=PREDICT_WINDOW):
    """Heuristic, transparent projection: recent form (FPL's own recency-
    weighted points/game) scaled by upcoming fixture difficulty and by how
    reliably the player has actually been getting minutes. Not a trained
    model — a documented formula so it's inspectable, not a black box.
    Returns (next_gw_points, next_n_gw_total, {gw: points, ...}) — the
    per-gameweek breakdown is what chip-timing decisions (Bench Boost,
    Triple Captain) need: which specific week is best, not just the total
    across several."""
    possible_minutes = max(90, games_elapsed * 90)
    minutes_share = min(1.0, minutes_played / possible_minutes)
    reliability = 0.5 + 0.5 * minutes_share

    by_gw = {}
    if team_fixtures:
        start_gw = team_fixtures[0]["gw"]
        for fx in team_fixtures:
            if fx["gw"] >= start_gw + n_gws:
                continue
            mult = DIFFICULTY_MULTIPLIER.get(fx["difficulty"], 1.0)
            by_gw[fx["gw"]] = round(by_gw.get(fx["gw"], 0) + player_form * mult * reliability, 1)

    next_gw_total = by_gw.get(team_fixtures[0]["gw"], 0.0) if team_fixtures else 0.0
    window_total = round(sum(by_gw.values()), 1)

    return round(next_gw_total, 1), window_total, by_gw


def build_players(bootstrap, fixtures, teams_by_id, current_gw, ict_pending, history_data):
    vs_opponent, overall, seasons_used = history_data
    players = []
    for el in bootstrap["elements"]:
        team = teams_by_id.get(el["team"], {})
        now_cost_m = el["now_cost"] / 10
        total_points = el.get("total_points", 0)
        ppm = round(total_points / now_cost_m, 2) if now_cost_m else 0
        form = safe_float(el.get("form"))
        minutes = el.get("minutes", 0)
        full_name = f'{el.get("first_name", "")} {el.get("second_name", "")}'.strip()

        team_fixtures = team_upcoming_fixtures(fixtures, el["team"], PREDICT_WINDOW + 1)
        pred_next, pred_next5, pred_by_gw = predicted_points(form, team_fixtures, current_gw, minutes)

        next_opp_id = team_fixtures[0]["opponent_id"] if team_fixtures else None
        next_opp_short = teams_by_id.get(next_opp_id, {}).get("short_name") if next_opp_id else None
        hist_bonus, hist_detail = opponent_history(full_name, next_opp_short, vs_opponent, overall, seasons_used)
        pred_next = round(pred_next + hist_bonus, 1)
        pred_next5 = round(pred_next5 + hist_bonus, 1)
        # The history bonus is specifically about the NEXT fixture (the
        # opponent that triggered it) — apply it to that one gameweek's
        # entry in the breakdown too, not to every future week.
        if pred_by_gw and next_opp_id is not None:
            first_gw = team_fixtures[0]["gw"]
            if first_gw in pred_by_gw:
                pred_by_gw[first_gw] = round(pred_by_gw[first_gw] + hist_bonus, 1)

        # History against EVERY upcoming opponent in the window, not just the
        # next one — powers the fixture ticker's per-cell detail AND lets
        # other functions (e.g. Triple Captain) look up history for a
        # specific gameweek directly. Keyed by gw rather than a positional
        # list, so no index-alignment assumptions needed downstream. Cheap:
        # dictionary lookups against already-loaded data, no new network call.
        fixture_history = {}
        for fx in team_fixtures:
            fx_opp_short = teams_by_id.get(fx["opponent_id"], {}).get("short_name")
            _, fx_hist_detail = opponent_history(full_name, fx_opp_short, vs_opponent, overall, seasons_used)
            if fx_hist_detail:
                fixture_history[fx["gw"]] = fx_hist_detail

        status = el.get("status", "a")
        players.append(
            {
                "id": el["id"],
                "name": el.get("web_name", ""),
                "full_name": full_name,
                "team": team.get("short_name", "—"),
                "team_id": el["team"],
                "pos": POSITIONS.get(el["element_type"], "?"),
                "price": now_cost_m,
                "selected_by": safe_float(el.get("selected_by_percent")),
                "total_points": total_points,
                "ppm": ppm,
                "form": form,
                "points_per_game": safe_float(el.get("points_per_game")),
                "ict_index": None if ict_pending else safe_float(el.get("ict_index")),
                "influence": None if ict_pending else safe_float(el.get("influence")),
                "creativity": None if ict_pending else safe_float(el.get("creativity")),
                "threat": None if ict_pending else safe_float(el.get("threat")),
                "xg": safe_float(el.get("expected_goals")),
                "xa": safe_float(el.get("expected_assists")),
                "xgi": safe_float(el.get("expected_goal_involvements")),
                "xg_p90": safe_float(el.get("expected_goals_per_90")),
                "xa_p90": safe_float(el.get("expected_assists_per_90")),
                "def_con": el.get("defensive_contribution", 0),
                "def_con_p90": safe_float(el.get("defensive_contribution_per_90")),
                "tackles": el.get("tackles", 0),
                "cbi": el.get("clearances_blocks_interceptions", 0),
                "recoveries": el.get("recoveries", 0),
                "bps": el.get("bps", 0),
                "starts": el.get("starts", 0),
                "corner_fk_order": el.get("corners_and_indirect_freekicks_order"),
                "direct_fk_order": el.get("direct_freekicks_order"),
                "penalty_order": el.get("penalties_order"),
                "cost_change_event": round(el.get("cost_change_event", 0) / 10, 1),
                "cost_change_start": round(el.get("cost_change_start", 0) / 10, 1),
                "price_change_percent": safe_float(el.get("price_change_percent")),
                "price_change_hourly_rate": el.get("price_change_hourly_rate", 0),
                "minutes": minutes,
                "goals": el.get("goals_scored", 0),
                "assists": el.get("assists", 0),
                "clean_sheets": el.get("clean_sheets", 0),
                "status": status,
                "status_label": STATUS_LABELS.get(status, "Unknown"),
                "news": el.get("news", ""),
                "chance_of_playing": el.get("chance_of_playing_next_round"),
                "pred_next": pred_next,
                "pred_next5": pred_next5,
                "pred_by_gw": pred_by_gw,
                "next_opponent": next_opp_id,
                "history_vs_next_opp": hist_detail,
                "fixture_history": fixture_history,
            }
        )
    return players


def build_recommendations(players, teams_by_id, squad_element_ids):
    """Position-wise ranking by predicted next-5-gameweek points, which
    already includes the opponent-history bonus computed in build_players
    (see opponent_history()). 'Composite' = form + fixture run + minutes
    reliability + opponent-history, fused into pred_next5 rather than kept
    as a separate hidden score, so the ranking and the visible number never
    disagree with each other."""
    by_pos = {"GKP": [], "DEF": [], "MID": [], "FWD": []}
    for p in players:
        if p["status"] == "u":
            continue
        by_pos.setdefault(p["pos"], []).append(p)

    out = {}
    for pos, plist in by_pos.items():
        ranked = sorted(plist, key=lambda p: p["pred_next5"], reverse=True)[:RECS_PER_POSITION]
        out[pos] = [
            {
                "id": p["id"],
                "name": p["name"],
                "team": p["team"],
                "price": p["price"],
                "form": p["form"],
                "pred_next": p["pred_next"],
                "pred_next5": p["pred_next5"],
                "ppm": p["ppm"],
                "status": p["status"],
                "status_label": p["status_label"],
                "news": p["news"],
                "chance_of_playing": p["chance_of_playing"],
                "owned": p["id"] in squad_element_ids,
                "history_vs_next_opp": p["history_vs_next_opp"],
            }
            for p in ranked
        ]
    return out


DIFFERENTIAL_OWNERSHIP_THRESHOLD = 15.0  # percent


def build_differential_finder(players, squad_element_ids):
    """Same shape as Recommendations, filtered to selected_by% under
    DIFFERENTIAL_OWNERSHIP_THRESHOLD — the players who could actually move
    your mini-league rank. A template player rising or falling moves
    everyone in the league together; a low-ownership player doing the same
    only moves you."""
    by_pos = {"GKP": [], "DEF": [], "MID": [], "FWD": []}
    for p in players:
        if p["status"] == "u" or p["selected_by"] >= DIFFERENTIAL_OWNERSHIP_THRESHOLD:
            continue
        by_pos.setdefault(p["pos"], []).append(p)

    out = {}
    for pos, plist in by_pos.items():
        ranked = sorted(plist, key=lambda p: p["pred_next5"], reverse=True)[:RECS_PER_POSITION]
        out[pos] = [
            {
                "id": p["id"],
                "name": p["name"],
                "team": p["team"],
                "price": p["price"],
                "selected_by": p["selected_by"],
                "pred_next": p["pred_next"],
                "pred_next5": p["pred_next5"],
                "ppm": p["ppm"],
                "status": p["status"],
                "status_label": p["status_label"],
                "news": p["news"],
                "chance_of_playing": p["chance_of_playing"],
                "owned": p["id"] in squad_element_ids,
                "history_vs_next_opp": p["history_vs_next_opp"],
            }
            for p in ranked
        ]
    return out


def optimize_squad(players, budget, objective_key="pred_next5"):
    """ILP-optimal 15-man squad: maximizes total objective_key subject to the
    real FPL constraints (2/5/5/3 by position, <=3 per club, total cost <=
    budget). Excludes injured/suspended/unavailable players from the pool —
    picking them would only ever be a budget-saving trick, not a genuine
    scoring decision, and this keeps the objective honest."""
    pool = [p for p in players if p["status"] not in ("u", "i", "s")]
    prob = pulp.LpProblem("squad", pulp.LpMaximize)
    x = {p["id"]: pulp.LpVariable(f"x_{p['id']}", cat="Binary") for p in pool}

    prob += pulp.lpSum(x[p["id"]] * p[objective_key] for p in pool)
    for pos, n in SQUAD_QUOTAS.items():
        prob += pulp.lpSum(x[p["id"]] for p in pool if p["pos"] == pos) == n
    prob += pulp.lpSum(x[p["id"]] * p["price"] for p in pool) <= budget
    for team_id in {p["team_id"] for p in pool}:
        prob += pulp.lpSum(x[p["id"]] for p in pool if p["team_id"] == team_id) <= 3

    status = prob.solve(pulp.PULP_CBC_CMD(msg=0))
    if pulp.LpStatus[status] != "Optimal":
        return None
    return [p for p in pool if x[p["id"]].value() == 1]


def best_starting_xi(squad, objective_key="pred_next5"):
    """Given a fixed 15-man squad, searches standard formations (3-5 DEF,
    2-5 MID, 1-3 FWD, summing to 10 outfield) and returns whichever lineup
    maximizes total objective_key. Captain is simply the single highest
    scorer in the squad (they're guaranteed a starting slot in an optimal
    lineup, since benching your best player is never correct)."""
    by_pos = {"GKP": [], "DEF": [], "MID": [], "FWD": []}
    for p in squad:
        by_pos.setdefault(p["pos"], []).append(p)
    for pos in by_pos:
        by_pos[pos].sort(key=lambda p: p[objective_key], reverse=True)

    best = None
    for d, m, f in FORMATIONS:
        if len(by_pos["DEF"]) < d or len(by_pos["MID"]) < m or len(by_pos["FWD"]) < f:
            continue
        xi = [by_pos["GKP"][0]] + by_pos["DEF"][:d] + by_pos["MID"][:m] + by_pos["FWD"][:f]
        total = sum(p[objective_key] for p in xi)
        if best is None or total > best["total"]:
            bench_gk = by_pos["GKP"][1:2]
            bench_outfield = by_pos["DEF"][d:] + by_pos["MID"][m:] + by_pos["FWD"][f:]
            best = {
                "formation": f"{d}-{m}-{f}",
                "xi": xi,
                "bench": bench_gk + bench_outfield,
                "total": round(total, 1),
            }
    if best:
        best["captain"] = max(best["xi"], key=lambda p: p[objective_key])
    return best


def slim_player(p):
    return {"id": p["id"], "name": p["name"], "team": p["team"], "pos": p["pos"], "price": p["price"],
            "pred_next": p["pred_next"], "pred_next5": p["pred_next5"], "status": p["status"]}


def build_chip_squads(players, budget):
    """Optimal Wildcard squad (maximizes the next-5-gameweek run, since a
    wildcard's picks persist) and optimal Free Hit squad (maximizes just the
    next gameweek, since Free Hit reverts after one week — a squad built for
    a single-week spike is a genuinely different answer, not the same squad
    relabelled)."""
    out = {}
    for label, objective in [("wildcard", "pred_next5"), ("free_hit", "pred_next")]:
        squad = optimize_squad(players, budget, objective_key=objective)
        if not squad:
            out[label] = None
            continue
        lineup = best_starting_xi(squad, objective_key=objective)
        out[label] = {
            "budget_used": round(sum(p["price"] for p in squad), 1),
            "budget_available": round(budget, 1),
            "formation": lineup["formation"],
            "starting_xi": [slim_player(p) for p in lineup["xi"]],
            "bench": [slim_player(p) for p in lineup["bench"]],
            "captain": slim_player(lineup["captain"]),
            "projected_points": lineup["total"],
        }
    return out


def build_bench_boost_plan(squad, players_by_id, n_gws=PREDICT_WINDOW):
    """Which of the next N gameweeks projects best for Bench Boost, based on
    your CURRENT bench specifically — Bench Boost plays your existing 15,
    it isn't a transfer chip, so this deliberately doesn't touch the
    optimizer at all, just the four players already sitting there."""
    if not squad or not squad.get("picks"):
        return None
    bench_players = [players_by_id[p["element"]] for p in squad["picks"]
                      if p["multiplier"] == 0 and p["element"] in players_by_id]
    if not bench_players:
        return None

    all_gws = sorted({gw for p in bench_players for gw in p.get("pred_by_gw", {})})[:n_gws]
    by_gameweek = [
        {"gw": gw, "projected_bench_points": round(sum(p["pred_by_gw"].get(gw, 0) for p in bench_players), 1)}
        for gw in all_gws
    ]
    by_gameweek.sort(key=lambda x: -x["projected_bench_points"])

    return {
        "bench_players": [{"id": p["id"], "name": p["name"], "team": p["team"], "pos": p["pos"]} for p in bench_players],
        "by_gameweek": by_gameweek,
        "best_gw": by_gameweek[0]["gw"] if by_gameweek else None,
    }


def build_triple_captain_plan(squad, players_by_id, n_gws=PREDICT_WINDOW):
    """Best gameweek + captain combination for Triple Captain: for each
    currently-starting player, their single highest-projected gameweek in
    the window, ranked best first across the whole squad."""
    if not squad or not squad.get("picks"):
        return None
    starters = [players_by_id[p["element"]] for p in squad["picks"]
                if p["multiplier"] > 0 and p["element"] in players_by_id]
    if not starters:
        return None

    candidates = []
    for p in starters:
        by_gw = p.get("pred_by_gw") or {}
        if not by_gw:
            continue
        best_gw, best_pts = max(by_gw.items(), key=lambda kv: kv[1])
        candidates.append({
            "id": p["id"], "name": p["name"], "team": p["team"],
            "gw": best_gw, "projected_points": best_pts,
            "history_vs_opp": (p.get("fixture_history") or {}).get(best_gw),
        })
    candidates.sort(key=lambda c: -c["projected_points"])
    return {"candidates": candidates[:8]}


MINI_LEAGUE_HISTORY_FILE = "mini_league_history.json"


def build_mini_league(config, current_gw):
    """Pulls live standings for a configured classic mini-league and keeps
    one snapshot per day in data/mini_league_history.json, which the Action
    commits back to the repo each run — so a real week-by-week trend builds
    up naturally over the season. Pattern recognition and rival 'personas'
    need that accumulated history to mean anything; with only a snapshot or
    two so far, this deliberately just shows standings plus movement vs a
    week ago once there's a week ago to compare against."""
    league_id = config.get("mini_league_id")
    if not league_id:
        return None
    try:
        data = get(f"{BASE}/leagues-classic/{league_id}/standings/")
    except requests.RequestException as exc:
        print(f"Warning: could not fetch mini league {league_id}: {exc}", file=sys.stderr)
        return None

    league_name = data.get("league", {}).get("name", "")
    standings = [
        {
            "entry": r["entry"],
            "entry_name": r["entry_name"],
            "player_name": r["player_name"],
            "rank": r["rank"],
            "last_rank": r.get("last_rank"),
            "total": r["total"],
            "event_total": r["event_total"],
        }
        for r in data.get("standings", {}).get("results", [])
    ]

    history_path = os.path.join(DATA_DIR, MINI_LEAGUE_HISTORY_FILE)
    history = []
    if os.path.exists(history_path):
        try:
            with open(history_path) as f:
                history = json.load(f)
        except (json.JSONDecodeError, OSError):
            history = []

    today = datetime.now(timezone.utc).date().isoformat()
    history = [h for h in history if h.get("date") != today]  # one snapshot per day
    history.append({"date": today, "gw": current_gw, "standings": standings})
    history = history[-60:]

    with open(history_path, "w") as f:
        json.dump(history, f)

    trend = {}
    if len(history) >= 2:
        cutoff = (datetime.now(timezone.utc).date() - timedelta(days=7)).isoformat()
        candidates = [h for h in history if h["date"] <= cutoff]
        week_ago = candidates[-1] if candidates else history[0]
        if week_ago is not history[-1]:
            prev_rank = {s["entry"]: s["rank"] for s in week_ago["standings"]}
            trend = {
                str(s["entry"]): (prev_rank[s["entry"]] - s["rank"])
                for s in standings if s["entry"] in prev_rank
            }

    return {
        "league_id": league_id,
        "league_name": league_name,
        "standings": standings,
        "trend_vs_week_ago": trend,
        "snapshots_recorded": len(history),
    }


def build_season_journey(config):
    """Full gameweek-by-gameweek season history — rank, points, squad
    value, bank, transfers, and chips — pulled in one call from FPL's own
    entry-history endpoint. Replaces manual GW-by-GW logging entirely: this
    is the same data a hand-kept tracker needs, just already sitting in
    FPL's records."""
    team_id = config.get("fpl_team_id")
    if not team_id:
        return None
    try:
        data = get(f"{BASE}/entry/{team_id}/history/")
    except requests.RequestException as exc:
        print(f"Warning: could not fetch season history for team {team_id}: {exc}", file=sys.stderr)
        return None

    chips_by_event = {c["event"]: c["name"] for c in data.get("chips", [])}
    gameweeks = [
        {
            "gw": gw["event"],
            "points": gw.get("points", 0),
            "total_points": gw.get("total_points", 0),
            "overall_rank": gw.get("overall_rank"),
            "rank": gw.get("rank"),
            "bank": round(gw.get("bank", 0) / 10, 1),
            "value": round(gw.get("value", 0) / 10, 1),
            "transfers": gw.get("event_transfers", 0),
            "transfer_cost": gw.get("event_transfers_cost", 0),
            "points_on_bench": gw.get("points_on_bench", 0),
            "chip": chips_by_event.get(gw["event"]),
        }
        for gw in data.get("current", [])
    ]
    return {
        "gameweeks": gameweeks,
        "chips_used": [{"name": c["name"], "event": c["event"]} for c in data.get("chips", [])],
    }


RIVAL_FETCH_CAP = 30  # keep the mini-league scan bounded even for a larger league


def build_rival_intelligence(standings, players_by_id, current_gw):
    """For each rival in the mini-league, pulls their most recently locked
    gameweek's picks AND transfers — captain, chip, and exactly who they
    brought in/sent out this week — from the same public endpoints your own
    squad uses. Only works once that gameweek's deadline has passed for
    everyone, you included; before that there is nothing to fetch, same
    limit as always. Best-effort per rival and per call: a manager who
    hasn't set a team yet, a transient fetch error, or transfers being
    unavailable is skipped/degraded rather than failing the whole run."""
    if not standings:
        return None

    rivals = []
    for entry in standings[:RIVAL_FETCH_CAP]:
        try:
            picks_data = get(f"{BASE}/entry/{entry['entry']}/event/{current_gw}/picks/")
        except requests.RequestException:
            continue
        picks = picks_data.get("picks", [])
        captain_pick = next((p for p in picks if p.get("is_captain")), None)
        captain_player = players_by_id.get(captain_pick["element"]) if captain_pick else None
        entry_history = picks_data.get("entry_history") or {}

        transfers_in, transfers_out = [], []
        try:
            transfers_data = get(f"{BASE}/entry/{entry['entry']}/transfers/")
            for t in transfers_data:
                if t.get("event") != current_gw:
                    continue
                p_in = players_by_id.get(t.get("element_in"))
                p_out = players_by_id.get(t.get("element_out"))
                if p_in:
                    transfers_in.append(p_in["name"])
                if p_out:
                    transfers_out.append(p_out["name"])
        except requests.RequestException:
            pass  # transfer detail is a bonus on top of picks — don't drop the rival over it

        rivals.append({
            "entry": entry["entry"],
            "entry_name": entry["entry_name"],
            "player_name": entry["player_name"],
            "captain": captain_player["name"] if captain_player else None,
            "chip": picks_data.get("active_chip"),
            "gw_points": entry_history.get("points"),
            "transfers_made": entry_history.get("event_transfers", 0),
            "transfer_cost": entry_history.get("event_transfers_cost", 0),
            "transfers_in": transfers_in,
            "transfers_out": transfers_out,
        })

    if not rivals:
        return None

    captain_counts = {}
    for r in rivals:
        if r["captain"]:
            captain_counts[r["captain"]] = captain_counts.get(r["captain"], 0) + 1
    captain_distribution = sorted(
        [{"name": name, "count": count} for name, count in captain_counts.items()],
        key=lambda x: -x["count"],
    )

    transfer_in_counts = {}
    for r in rivals:
        for name in r["transfers_in"]:
            transfer_in_counts[name] = transfer_in_counts.get(name, 0) + 1
    trending_in = sorted(
        [{"name": name, "count": count} for name, count in transfer_in_counts.items()],
        key=lambda x: -x["count"],
    )

    return {
        "gw": current_gw,
        "rivals": rivals,
        "captain_distribution": captain_distribution,
        "trending_in": trending_in,
        "chips_played": [{"entry_name": r["entry_name"], "chip": r["chip"]} for r in rivals if r["chip"]],
    }


def build_squad(config, current_gw):
    team_id = config.get("fpl_team_id")
    if not team_id:
        return None
    try:
        picks_data = get(f"{BASE}/entry/{team_id}/event/{current_gw}/picks/")
        entry_history = picks_data.get("entry_history", {}) or {}
        return {
            "gw": current_gw,
            "picks": [
                {
                    "element": p["element"],
                    "is_captain": p["is_captain"],
                    "is_vice_captain": p["is_vice_captain"],
                    "multiplier": p["multiplier"],
                    "position": p["position"],
                }
                for p in picks_data.get("picks", [])
            ],
            "active_chip": picks_data.get("active_chip"),
            "bank": entry_history.get("bank", 0) / 10,
            "squad_value": entry_history.get("value", 1000) / 10,
        }
    except requests.RequestException as exc:
        print(f"Warning: could not fetch squad for team {team_id}: {exc}", file=sys.stderr)
        return None


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    config = load_config()

    print("Fetching bootstrap-static...")
    bootstrap = get(f"{BASE}/bootstrap-static/")

    print("Fetching fixtures...")
    fixtures = get(f"{BASE}/fixtures/?future=1")

    events = bootstrap["events"]

    # is_current/is_next can both lag once a gameweek's matches finish but
    # before the next deadline passes — that's exactly what produced the
    # "deadline says GW2, should say GW3" bug. Deadline-time comparison is
    # unambiguous and doesn't depend on FPL's own flag timing.
    def _deadline(e):
        dt = e.get("deadline_time")
        if not dt:
            return None
        return datetime.fromisoformat(dt.replace("Z", "+00:00"))

    now = datetime.now(timezone.utc)
    dated_events = [(e, _deadline(e)) for e in events]
    dated_events = [(e, d) for e, d in dated_events if d is not None]

    locked_events = [e for e, d in dated_events if d < now]
    locked_event = locked_events[-1] if locked_events else None
    upcoming_event = next((e for e, d in dated_events if d >= now), None)

    # Squad/rival/history-log purposes need the most recently LOCKED
    # gameweek — that's the only one with actually-fetchable picks (FPL
    # hides picks until deadline, even for your own team). The deadline
    # display needs the UPCOMING one specifically. These can legitimately
    # be different gameweeks for the whole window between a deadline
    # passing and that gameweek finishing.
    current_gw = (locked_event or upcoming_event or {}).get("id", 1)
    deadline_gw = (upcoming_event or locked_event or {}).get("id", 1)

    # ICT (influence/creativity/threat) finalizes on a slower pipeline than
    # raw stats — FPL marks this with data_checked on the relevant event.
    ict_pending = bool(locked_event) and not locked_event.get("data_checked", False)

    teams = build_teams(bootstrap)
    teams_by_id = {t["id"]: t for t in teams}

    print("Fetching squad (if configured)...")
    squad = build_squad(config, current_gw)
    squad_element_ids = {p["element"] for p in squad["picks"]} if squad else set()

    print(f"Building opponent-history lookup from {HISTORY_SEASONS}...")
    history_data = build_history_lookup()

    players = build_players(bootstrap, fixtures, teams_by_id, current_gw, ict_pending, history_data)
    players_by_id = {p["id"]: p for p in players}
    fixture_ticker = build_fixture_ticker(fixtures, teams_by_id)
    team_fixture_scores = build_team_fixture_scores(fixture_ticker, teams_by_id)
    recommendations = build_recommendations(players, teams_by_id, squad_element_ids)
    price_changes = build_price_changes(players)

    print("Building chip-optimal lineups...")
    wildcard_budget = squad["bank"] + squad["squad_value"] if squad else 100.0
    chip_squads = build_chip_squads(players, wildcard_budget)
    bench_boost_plan = build_bench_boost_plan(squad, players_by_id)
    triple_captain_plan = build_triple_captain_plan(squad, players_by_id)
    differentials = build_differential_finder(players, squad_element_ids)

    print("Fetching mini league (if configured)...")
    mini_league = build_mini_league(config, current_gw)
    rival_intelligence = build_rival_intelligence(mini_league["standings"], players_by_id, current_gw) if mini_league else None

    print("Fetching season journey (if configured)...")
    season_journey = build_season_journey(config)

    with open(os.path.join(DATA_DIR, "players.json"), "w") as f:
        json.dump(players, f)

    with open(os.path.join(DATA_DIR, "teams.json"), "w") as f:
        json.dump(teams, f)

    with open(os.path.join(DATA_DIR, "fixtures.json"), "w") as f:
        json.dump(fixture_ticker, f)

    with open(os.path.join(DATA_DIR, "team_fixture_scores.json"), "w") as f:
        json.dump(team_fixture_scores, f)

    with open(os.path.join(DATA_DIR, "price_changes.json"), "w") as f:
        json.dump(price_changes, f)

    with open(os.path.join(DATA_DIR, "recommendations.json"), "w") as f:
        json.dump(recommendations, f)

    with open(os.path.join(DATA_DIR, "chip_squads.json"), "w") as f:
        json.dump(chip_squads, f)

    with open(os.path.join(DATA_DIR, "mini_league.json"), "w") as f:
        json.dump(mini_league, f)

    with open(os.path.join(DATA_DIR, "rival_intelligence.json"), "w") as f:
        json.dump(rival_intelligence, f)

    with open(os.path.join(DATA_DIR, "season_journey.json"), "w") as f:
        json.dump(season_journey, f)

    with open(os.path.join(DATA_DIR, "bench_boost_plan.json"), "w") as f:
        json.dump(bench_boost_plan, f)

    with open(os.path.join(DATA_DIR, "triple_captain_plan.json"), "w") as f:
        json.dump(triple_captain_plan, f)

    with open(os.path.join(DATA_DIR, "differentials.json"), "w") as f:
        json.dump(differentials, f)

    meta = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "current_gw": current_gw,
        "deadline_gw": deadline_gw,
        "gw_deadline": (upcoming_event or {}).get("deadline_time"),
        "ict_pending": ict_pending,
        "history_seasons_used": history_data[2],
        "my_entry_id": config.get("fpl_team_id"),
        "squad": squad,
    }
    with open(os.path.join(DATA_DIR, "meta.json"), "w") as f:
        json.dump(meta, f)

    print(f"Done. {len(players)} players written, GW{current_gw}, ict_pending={ict_pending}.")


if __name__ == "__main__":
    main()
