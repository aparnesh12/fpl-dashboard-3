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
from datetime import datetime, timezone

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


def build_squad(config, current_gw):
    team_id = config.get("fpl_team_id")
    if not team_id:
        return None
    try:
        picks_data = get(f"{BASE}/entry/{team_id}/event/{current_gw}/picks/")
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
    fixture_ticker = build_fixture_ticker(fixtures, teams_by_id)
    recommendations = build_recommendations(players, teams_by_id, squad_element_ids)

    with open(os.path.join(DATA_DIR, "players.json"), "w") as f:
        json.dump(players, f)

    with open(os.path.join(DATA_DIR, "teams.json"), "w") as f:
        json.dump(teams, f)

    with open(os.path.join(DATA_DIR, "fixtures.json"), "w") as f:
        json.dump(fixture_ticker, f)

    with open(os.path.join(DATA_DIR, "recommendations.json"), "w") as f:
        json.dump(recommendations, f)

    meta = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "current_gw": current_gw,
        "gw_deadline": (next_event or current_event or {}).get("deadline_time"),
        "ict_pending": ict_pending,
        "history_seasons_used": history_data[2],
        "squad": squad,
    }
    with open(os.path.join(DATA_DIR, "meta.json"), "w") as f:
        json.dump(meta, f)

    print(f"Done. {len(players)} players written, GW{current_gw}, ict_pending={ict_pending}.")


if __name__ == "__main__":
    main()
