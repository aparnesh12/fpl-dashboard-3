# Mishra's Thirteen — FPL Dashboard

A live, self-updating Fantasy Premier League dashboard. A GitHub Actions job
pulls the official FPL API and a couple of well-established public archives
once a day, computes everything server-side, and writes the results as JSON.
GitHub Pages serves a static site that reads that JSON. No server, no
database, no API key, no framework — plain HTML/CSS/JS plus one Python
script.

**Why it's built this way:** browsers can't call `fantasy.premierleague.com`
directly from a different domain — the API doesn't send the CORS headers
that would allow it. GitHub Actions runners aren't browsers, so they don't
hit that wall. Fetch server-side on a timer, publish the result as static
files, let the page read files instead of calling the API itself.

## What you get

Nine tabs, grouped into My Squad / Research / League, plus a summary strip
above them showing your deadline countdown, any flagged players, anything
of yours predicted to move price tonight, and your live mini-league rank.

**My Squad**
- **Overview** — your squad on an actual pitch view, a fixture-difficulty
  ticker for your own players (6 gameweeks out), and all 20 clubs' fixture
  difficulty as a heatmap grid aligned by real gameweek number, sorted
  easiest first
- **My Team** — a 0–100 squad rating (scoring strength, value efficiency,
  availability, captaincy quality), with a specific call-out when your
  captain isn't your best option
- **Season Journey** — your full season auto-charted: rank, points per
  gameweek, and squad value over time, plus a chip-usage log. Pulled in one
  call from FPL's own history record — nothing to log by hand
- **Chip Squad** — Wildcard and Free Hit are ILP-optimal 15-man squads
  (integer linear programming, not a heuristic) built against your real
  budget. Bench Boost and Triple Captain use your *current* squad instead —
  those chips don't let you rebuild, so it's about which upcoming gameweek
  suits the players you already have

**Research**
- **All Players** — every player: price, ownership%, form, points, PPM,
  ICT, xGI, defensive contribution/90, and two predicted-points columns.
  Sortable, filterable, header tooltips on every column, sticky header,
  flagged players show why
- **Recommendations** — top players per position by predicted points, with
  a toggle for **Differentials** (same ranking, filtered under 15%
  ownership) — the picks that could actually move your mini-league rank
- **Attacking/Defending** — every genuine underlying-stats field FPL
  exposes: tackles, clearances/blocks/interceptions, recoveries, BPS,
  Influence/Creativity/Threat as separate numbers, xG/xA with per-90 rates,
  confirmed set-piece duty. Shots, headers won, and "chances created" are
  NOT here — FPL's free API doesn't expose them, that's Opta-licensed data
- **Price Changes** — FPL's own official Price Change Predictor (new for
  2026/27): predicted risers/fallers with a confidence label, plus changes
  that have already happened today and this season

**League**
- **Mini League** — live standings, rank movement, and week-over-week trend
  once enough daily snapshots exist, plus **Rival Intelligence**: once a
  gameweek's deadline passes for the league, captain distribution and chip
  usage across everyone in it — the same public data your own squad uses,
  just pointed at your rivals too

Predicted points are a transparent formula (form × fixture difficulty ×
minutes-reliability, plus a history adjustment), documented in the "Next 5"
tooltip and in `scripts/fetch_data.py` — not a trained model, so you can see
exactly why a number is what it is.

## Where the extra data comes from

- **Opponent history** (Recommendations, All Players): the live FPL API only
  covers the *current* season match-by-match. For prior seasons, the script
  pulls [vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League),
  a long-running public archive. Best-effort — if it's unreachable, the
  script logs a warning and carries on without that adjustment.
- **Rival Intelligence**: uses the exact same public picks endpoint your own
  squad uses, once per rival in the configured league, capped at 30 rivals.
  Only works once a gameweek's deadline has passed — same limit as your own
  team, no way around it, by FPL's own design.
- **Price predictions**: FPL's own official Price Change Predictor fields,
  confirmed against FPL's 2026/27 launch announcement and Fantasy Football
  Scout's documented interpretation before being wired up.

## One-time setup

1. **Create a GitHub repo.** Public is recommended — unlimited free Actions
   minutes and free Pages hosting. Everything shown is already public FPL
   data (see the Mini League privacy note below for the one exception).

2. **Push this code to it.**
   ```bash
   cd fpl-dashboard
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git branch -M main
   git push -u origin main
   ```

3. **Give Actions permission to push.** Repo → Settings → Actions → General
   → "Workflow permissions" → **Read and write permissions** → Save.

4. **Turn on Pages.** Repo → Settings → Pages → Source: **Deploy from a
   branch**, branch **main**, folder **/ (root)**. Your URL appears on that
   same page: `https://<your-username>.github.io/<your-repo>/`

5. **Run the data fetch once, manually.** Actions tab → "Update FPL Data" →
   **Run workflow**. Give it 45–60 seconds — it does more now than a simple
   fetch (history archive, league scan, optimizer solve).

6. **Configure `config.json`:**
   - `fpl_team_id` — the number from your team URL,
     `fantasy.premierleague.com/entry/`**`1234567`**`/event/3`. Unlocks your
     squad, My Team, Season Journey, and Chip Squad.
   - `mini_league_id` — the number from your league's URL,
     `fantasy.premierleague.com/leagues/`**`1035071`**`/standings/c`.
     Unlocks Mini League and Rival Intelligence.

   Neither needs a login — both are public read-only identifiers.

## A privacy note on Mini League

That tab shows real names and team names for everyone in your configured
league, not just you — visible to anyone who finds this site, not just
people already in the league with you. Worth knowing before you point this
at a league with people who'd mind. `robots.txt` can keep the site out of
search results, and the repo can be made private if you want it properly
access-controlled (private repos need a paid GitHub plan for Pages hosting,
and have a capped, non-unlimited Actions minutes allowance — usually still
enough for a once-daily script).

## Changing the refresh schedule

Edit the `cron` line in `.github/workflows/update-data.yml` — currently
`0 3 * * *` (once daily, 3am UTC).

## Extending it

`scripts/fetch_data.py` is the only place that talks to any API — every
`build_*` function there does one job and returns one JSON-serializable
value written to `data/`. `app.js` is the only place that renders the page.
Ask Claude to add anything else directly to this repo.
