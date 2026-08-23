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


def predicted_points(player_form, team_fixtures, games_elapsed, minutes_played, n_gws=PREDICT_WINDOW):
    """Heuristic, transparent projection: recent form (FPL's own recency-
    weighted points/game) scaled by upcoming fixture difficulty and by how
    reliably the player has actually been getting minutes. Not a trained
    model — a documented formula so it's inspectable, not a black box.
    Returns (next_gw_points, next_n_gw_total)."""
    possible_minutes = max(90, games_elapsed * 90)
    minutes_share = min(1.0, minutes_played / possible_minutes)
    reliability = 0.5 + 0.5 * minutes_share

    fixtures_in_window = [f for f in team_fixtures if f["gw"] < team_fixtures[0]["gw"] + n_gws] if team_fixtures else []
    next_gw_fixtures = [f for f in team_fixtures if f["gw"] == team_fixtures[0]["gw"]] if team_fixtures else []

    def score(fx_list):
        total = 0.0
        for fx in fx_list:
            mult = DIFFICULTY_MULTIPLIER.get(fx["difficulty"], 1.0)
            total += player_form * mult * reliability
        return round(total, 1)

    return score(next_gw_fixtures), score(fixtures_in_window)


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
        pred_next, pred_next5 = predicted_points(form, team_fixtures, current_gw, minutes)

        next_opp_id = team_fixtures[0]["opponent_id"] if team_fixtures else None
        next_opp_short = teams_by_id.get(next_opp_id, {}).get("short_name") if next_opp_id else None
        hist_bonus, hist_detail = opponent_history(full_name, next_opp_short, vs_opponent, overall, seasons_used)
        pred_next = round(pred_next + hist_bonus, 1)
        pred_next5 = round(pred_next5 + hist_bonus, 1)

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
                "xg": safe_float(el.get("expected_goals")),
                "xa": safe_float(el.get("expected_assists")),
                "xgi": safe_float(el.get("expected_goal_involvements")),
                "def_con": el.get("defensive_contribution", 0),
                "def_con_p90": safe_float(el.get("defensive_contribution_per_90")),
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
                "next_opponent": next_opp_id,
                "history_vs_next_opp": hist_detail,
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


def build_team_rating(squad, players_by_id, all_players):
    """0-100 squad rating: scoring strength (vs a theoretical best-possible
    XV under the same quotas), value efficiency (squad's avg PPM vs the
    league's), availability (share of the 15 that are actually fit), and
    captaincy quality (is the armband on the squad's actual best starter).
    Every component is a simple, checkable ratio — no hidden weighting
    beyond the four numbers stated alongside the total."""
    if not squad or not squad.get("picks"):
        return None
    picks = squad["picks"]
    squad_players = [players_by_id[p["element"]] for p in picks if p["element"] in players_by_id]
    if len(squad_players) < 15:
        return None
    starters = [players_by_id[p["element"]] for p in picks if p["multiplier"] > 0 and p["element"] in players_by_id]
    captain_pick = next((p for p in picks if p["is_captain"]), None)
    captain_player = players_by_id.get(captain_pick["element"]) if captain_pick else None

    by_pos = {"GKP": [], "DEF": [], "MID": [], "FWD": []}
    for p in all_players:
        if p["status"] != "u":
            by_pos.setdefault(p["pos"], []).append(p)
    for pos in by_pos:
        by_pos[pos].sort(key=lambda p: p["pred_next5"], reverse=True)
    best_possible = sum(sum(p["pred_next5"] for p in by_pos[pos][:n]) for pos, n in SQUAD_QUOTAS.items())
    squad_total = sum(p["pred_next5"] for p in squad_players)
    scoring_score = min(100, (squad_total / best_possible) * 100) if best_possible else 0

    active_league = [p for p in all_players if p["minutes"] > 0]
    league_avg_ppm = (sum(p["ppm"] for p in active_league) / len(active_league)) if active_league else 1
    squad_active = [p for p in squad_players if p["minutes"] > 0]
    squad_avg_ppm = (sum(p["ppm"] for p in squad_active) / len(squad_active)) if squad_active else 0
    value_score = min(100, max(0, 50 + (squad_avg_ppm - league_avg_ppm) / league_avg_ppm * 100)) if league_avg_ppm else 50

    availability_score = (sum(1 for p in squad_players if p["status"] == "a") / len(squad_players)) * 100

    if captain_player and starters:
        best_starter_pred = max(p["pred_next"] for p in starters)
        captaincy_score = 100 if best_starter_pred <= 0 else min(100, (captain_player["pred_next"] / best_starter_pred) * 100)
    else:
        captaincy_score = 50

    overall = round(0.35 * scoring_score + 0.25 * value_score + 0.25 * availability_score + 0.15 * captaincy_score, 1)
    best_captain = max(starters, key=lambda p: p["pred_next"]) if starters else None

    return {
        "overall": overall,
        "components": {
            "scoring_strength": round(scoring_score, 1),
            "value_efficiency": round(value_score, 1),
            "availability": round(availability_score, 1),
            "captaincy": round(captaincy_score, 1),
        },
        "squad_total_pred_next5": round(squad_total, 1),
        "best_possible_pred_next5": round(best_possible, 1),
        "flagged_players": [{"name": p["name"], "status_label": p["status_label"]} for p in squad_players if p["status"] != "a"],
        "captain_name": captain_player["name"] if captain_player else None,
        "best_captain_option": best_captain["name"] if best_captain else None,
        "captain_is_optimal": bool(captain_player and best_captain and captain_player["id"] == best_captain["id"]),
    }


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
    current_event = next((e for e in events if e.get("is_current")), None)
    next_event = next((e for e in events if e.get("is_next")), None)
    current_gw = (current_event or next_event or {}).get("id", 1)
    # ICT (influence/creativity/threat) finalizes on a slower pipeline than
    # raw stats — FPL marks this with data_checked on the current event.
    ict_pending = bool(current_event) and not current_event.get("data_checked", False)

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
    recommendations = build_recommendations(players, teams_by_id, squad_element_ids)

    print("Rating squad and building chip-optimal lineups...")
    team_rating = build_team_rating(squad, players_by_id, players)
    wildcard_budget = squad["bank"] + squad["squad_value"] if squad else 100.0
    chip_squads = build_chip_squads(players, wildcard_budget)

    print("Fetching mini league (if configured)...")
    mini_league = build_mini_league(config, current_gw)

    with open(os.path.join(DATA_DIR, "players.json"), "w") as f:
        json.dump(players, f)

    with open(os.path.join(DATA_DIR, "teams.json"), "w") as f:
        json.dump(teams, f)

    with open(os.path.join(DATA_DIR, "fixtures.json"), "w") as f:
        json.dump(fixture_ticker, f)

    with open(os.path.join(DATA_DIR, "recommendations.json"), "w") as f:
        json.dump(recommendations, f)

    with open(os.path.join(DATA_DIR, "team_rating.json"), "w") as f:
        json.dump(team_rating, f)

    with open(os.path.join(DATA_DIR, "chip_squads.json"), "w") as f:
        json.dump(chip_squads, f)

    with open(os.path.join(DATA_DIR, "mini_league.json"), "w") as f:
        json.dump(mini_league, f)

    meta = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "current_gw": current_gw,
        "gw_deadline": (next_event or current_event or {}).get("deadline_time"),
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
