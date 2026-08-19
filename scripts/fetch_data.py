#!/usr/bin/env python3
"""
Pulls live data from the official Fantasy Premier League API and writes
processed JSON files that the static dashboard (index.html/app.js) reads.

Runs on a GitHub Actions schedule — see .github/workflows/update-data.yml.
No login, API key, or authentication required: these are public,
read-only endpoints Anthropic/Claude also uses when asked about FPL data.
"""
import json
import os
import sys
from datetime import datetime, timezone

import requests

BASE = "https://fantasy.premierleague.com/api"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; fpl-dashboard/1.0)"}
TIMEOUT = 20
FIXTURE_WINDOW = 6  # how many gameweeks ahead the fixture ticker shows

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
CONFIG_PATH = os.path.join(ROOT, "config.json")

POSITIONS = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}


def get(url):
    resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json()


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


def build_players(bootstrap):
    teams_by_id = {t["id"]: t for t in bootstrap["teams"]}
    players = []
    for el in bootstrap["elements"]:
        team = teams_by_id.get(el["team"], {})
        now_cost_m = el["now_cost"] / 10
        total_points = el.get("total_points", 0)
        ppm = round(total_points / now_cost_m, 2) if now_cost_m else 0
        players.append(
            {
                "id": el["id"],
                "name": el.get("web_name", ""),
                "full_name": f'{el.get("first_name", "")} {el.get("second_name", "")}'.strip(),
                "team": team.get("short_name", "—"),
                "team_id": el["team"],
                "pos": POSITIONS.get(el["element_type"], "?"),
                "price": now_cost_m,
                "selected_by": safe_float(el.get("selected_by_percent")),
                "total_points": total_points,
                "ppm": ppm,
                "form": safe_float(el.get("form")),
                "points_per_game": safe_float(el.get("points_per_game")),
                "ict_index": safe_float(el.get("ict_index")),
                "xg": safe_float(el.get("expected_goals")),
                "xa": safe_float(el.get("expected_assists")),
                "xgi": safe_float(el.get("expected_goal_involvements")),
                "def_con": el.get("defensive_contribution", 0),
                "def_con_p90": safe_float(el.get("defensive_contribution_per_90")),
                "minutes": el.get("minutes", 0),
                "goals": el.get("goals_scored", 0),
                "assists": el.get("assists", 0),
                "clean_sheets": el.get("clean_sheets", 0),
                "status": el.get("status", "a"),
                "news": el.get("news", ""),
                "chance_of_playing": el.get("chance_of_playing_next_round"),
            }
        )
    return players


def build_fixture_ticker(fixtures, teams_by_id, current_gw, n_gws=FIXTURE_WINDOW):
    """Windowed by gameweek NUMBER (not 'first N found') so double and
    blank gameweeks show up correctly instead of being silently skipped."""
    max_gw = current_gw + n_gws - 1
    upcoming = [f for f in fixtures if f["event"] and current_gw <= f["event"] <= max_gw]
    upcoming.sort(key=lambda f: (f["event"], f["kickoff_time"] or ""))

    by_team = {t_id: [] for t_id in teams_by_id}
    for f in upcoming:
        gw = f["event"]
        if f["team_h"] in by_team:
            by_team[f["team_h"]].append(
                {
                    "gw": gw,
                    "opponent": teams_by_id.get(f["team_a"], {}).get("short_name", "?"),
                    "is_home": True,
                    "difficulty": f["team_h_difficulty"],
                }
            )
        if f["team_a"] in by_team:
            by_team[f["team_a"]].append(
                {
                    "gw": gw,
                    "opponent": teams_by_id.get(f["team_h"], {}).get("short_name", "?"),
                    "is_home": False,
                    "difficulty": f["team_a_difficulty"],
                }
            )
    return by_team


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

    teams = build_teams(bootstrap)
    teams_by_id = {t["id"]: t for t in teams}
    players = build_players(bootstrap)
    fixture_ticker = build_fixture_ticker(fixtures, teams_by_id, current_gw)

    print("Fetching squad (if configured)...")
    squad = build_squad(config, current_gw)

    with open(os.path.join(DATA_DIR, "players.json"), "w") as f:
        json.dump(players, f)

    with open(os.path.join(DATA_DIR, "teams.json"), "w") as f:
        json.dump(teams, f)

    with open(os.path.join(DATA_DIR, "fixtures.json"), "w") as f:
        json.dump(fixture_ticker, f)

    meta = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "current_gw": current_gw,
        "gw_deadline": (next_event or current_event or {}).get("deadline_time"),
        "squad": squad,
    }
    with open(os.path.join(DATA_DIR, "meta.json"), "w") as f:
        json.dump(meta, f)

    print(f"Done. {len(players)} players written, GW{current_gw}.")


if __name__ == "__main__":
    main()
