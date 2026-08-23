# Mishra's Thirteen — FPL Dashboard

A live, self-updating Fantasy Premier League stats dashboard. A GitHub Actions
job pulls the official FPL API on a schedule and writes the results as JSON;
GitHub Pages serves a static site that reads that JSON. No server, no
database, no API key.

**Why it's built this way:** browsers can't call `fantasy.premierleague.com`
directly from a different domain — the API doesn't send the CORS headers
that would allow it. GitHub Actions runners aren't browsers, so they don't
hit that wall. That's the whole trick: fetch server-side on a timer, publish
the result as static files, let the page read files instead of calling the
API itself.

## What you get

Three tabs:

- **Overview** — your squad, and a fixture-difficulty ticker for *your own
  players* (not all 20 teams), 6 gameweeks out
- **All Players** — every player in the game: price, ownership%, form,
  total points, PPM, ICT, xGI, defensive contribution per 90, and two
  predicted-points columns (next gameweek, next 5). Sortable (click any
  header), filterable (search/position/team/status), header tooltips
  explain every stat, the header row stays visible while you scroll, and
  flagged players show why (injured/doubtful/suspended, with FPL's own
  chance-of-playing % where available)
- **Recommendations** — top players per position, ranked by predicted
  points over the next 5 gameweeks, with your own squad marked. The
  ranking includes a history adjustment for players who've faced their
  next opponent before, pulled from the last two completed seasons'
  actual results (see "Where the history data comes from" below)

Auto-refreshes every 3 hours, no maintenance required. Predicted points are
a transparent formula (form × fixture difficulty × minutes-reliability,
plus the history adjustment), documented in the "Next 5" column tooltip
and in `scripts/fetch_data.py` — not a trained model, so you can see
exactly why a number is what it is.

## Where the history data comes from

The live FPL API only exposes the *current* season's match-by-match
detail — there's no "how did this player do against Chelsea last year"
endpoint. For that, the script pulls from
[vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League),
a long-running, publicly maintained archive of gameweek-by-gameweek FPL
data going back years. It's a separate, best-effort fetch: if that repo is
ever unreachable or restructures its files, the script logs a warning and
carries on without the history adjustment rather than failing the whole
run. Matching between this season's players and the archive is done by
full name (FPL's internal player ID isn't stable across seasons), so a
handful of players with unusual name formatting might not match — that's
a known, minor limitation, not a bug to chase.

## One-time setup

1. **Create a GitHub repo.** Public is recommended — public repos get
   unlimited free Actions minutes and free Pages hosting. Everything this
   site shows is already public FPL data, so there's no privacy downside.

2. **Push this code to it.**
   ```bash
   cd fpl-dashboard
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git branch -M main
   git push -u origin main
   ```
   (This folder is already a git repo with an initial commit — you're just
   adding the remote and pushing.)

3. **Give Actions permission to push.** Repo → Settings → Actions → General →
   under "Workflow permissions," select **Read and write permissions**, then
   Save. The workflow file already requests this, but some repos default to
   read-only until you flip this switch — if the scheduled job's commit step
   ever fails, this is the first thing to check.

4. **Turn on Pages.** Repo → Settings → Pages → under "Build and
   deployment," set Source to **Deploy from a branch**, branch **main**,
   folder **/ (root)**. Save. Your URL (shown on that same page a few
   seconds later) will be:
   `https://<your-username>.github.io/<your-repo>/`

5. **Run the data fetch once, manually.** Repo → Actions tab → "Update FPL
   Data" → **Run workflow**. This populates real data immediately instead of
   waiting for the next scheduled run. Refresh your Pages URL after it
   finishes (~15 seconds).

6. **(Optional) Highlight your own squad.** Open `config.json`, set
   `fpl_team_id` to the number from your team URL —
   `fantasy.premierleague.com/entry/`**`1234567`**`/event/3` — commit, push.
   The next data refresh will pull your current picks and pin them at the
   top of the page. No login needed; team entries are public read data.

## Changing the refresh schedule

Edit the `cron` line in `.github/workflows/update-data.yml`. It's currently
`0 */3 * * *` (every 3 hours). FPL prices update roughly once a day and
points update during live match windows, so anywhere from hourly to every
6 hours is reasonable — more frequent just burns more Action minutes for
little extra freshness.

## Extending it

Everything the API returns is in `data/players.json` after each run —
`scripts/fetch_data.py` is the only place that talks to FPL, and `app.js` is
the only place that renders the page. Good next additions: a differential
finder (low ownership + high form), a template-team view, or per-gameweek
history charts using the `entry/{id}/history/` endpoint. Ask Claude to add
any of these directly to this repo.
