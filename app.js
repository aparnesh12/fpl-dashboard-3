const state = {
  players: [],
  teams: [],
  fixtures: {},
  recommendations: {},
  differentials: {},
  chipSquads: null,
  benchBoostPlan: null,
  tripleCaptainPlan: null,
  miniLeague: null,
  rivalIntelligence: null,
  seasonJourney: null,
  teamFixtureScores: [],
  priceChanges: null,
  meta: {},
  sortKey: 'pred_next5',
  sortDir: 'desc',
  search: '',
  posFilter: '',
  teamFilter: '',
  statusFilter: '',
  statsSortKey: 'def_con_p90',
  statsSortDir: 'desc',
  statsSearch: '',
  statsPosFilter: '',
  statsTeamFilter: '',
};

const DIFFICULTY_COLORS = { 1: '#1F7A4D', 2: '#34B871', 3: '#5B6B62', 4: '#C1443C', 5: '#8A2C26' };
const NUMERIC_KEYS = new Set(['price', 'selected_by', 'form', 'total_points', 'ppm', 'ict_index', 'xgi', 'def_con_p90', 'pred_next', 'pred_next5']);
const STATS_NUMERIC_KEYS = new Set(['tackles', 'cbi', 'recoveries', 'def_con_p90', 'influence', 'creativity', 'threat', 'xg', 'xa', 'xg_p90', 'xa_p90']);
const STATUS_SHORT = { d: 'DOUBT', i: 'INJ', s: 'SUSP', u: 'N/A', n: 'N/A' };
const REC_POSITIONS = ['GKP', 'DEF', 'MID', 'FWD'];
const PITCH_ROWS = { GKP: 12, DEF: 36, MID: 62, FWD: 86 };

const STATS_COLUMNS = [
  { key: 'name', label: 'Player' },
  { key: 'team', label: 'Team' },
  { key: 'pos', label: 'Pos' },
  { key: 'tackles', label: 'Tackles', tip: 'Tackles made this season.' },
  { key: 'cbi', label: 'CBI', tip: 'Clearances, blocks and interceptions, combined.' },
  { key: 'recoveries', label: 'Recov.', tip: 'Ball recoveries.' },
  { key: 'def_con_p90', label: 'DC/90', tip: 'Defensive Contribution per 90 minutes — the FPL-scoring combination of tackles, CBI and recoveries.' },
  { key: 'influence', label: 'Infl.', tip: 'FPL\u2019s Influence score \u2014 match-dominance actions. Reads "\u2014" during a live gameweek until FPL finalizes it.' },
  { key: 'creativity', label: 'Creat.', tip: 'FPL\u2019s Creativity score \u2014 chance creation and passing threat. Reads "\u2014" until finalized.' },
  { key: 'threat', label: 'Threat', tip: 'FPL\u2019s Threat score \u2014 goalscoring threat. Reads "\u2014" until finalized.' },
  { key: 'xg', label: 'xG', tip: 'Expected goals this season.' },
  { key: 'xa', label: 'xA', tip: 'Expected assists this season.' },
  { key: 'xg_p90', label: 'xG/90', tip: 'Expected goals per 90 minutes played.' },
  { key: 'xa_p90', label: 'xA/90', tip: 'Expected assists per 90 minutes played.' },
  { key: 'setpieces', label: 'Set Pieces', tip: 'Confirmed penalty, direct free-kick, and corner order for their club, where one exists.' },
];

const PRICE_TABS = [
  ['predicted_risers', 'Predicted Risers'], ['predicted_fallers', 'Predicted Fallers'],
  ['today_risers', "Today's Risers"], ['today_fallers', "Today's Fallers"],
  ['season_risers', 'Season Risers'], ['season_fallers', 'Season Fallers'],
];

const CHIP_TAB_DEFS = [
  ['wildcard', 'Wildcard'], ['free_hit', 'Free Hit'], ['bench_boost', 'Bench Boost'], ['triple_captain', 'Triple Captain'],
];

let activeRecPos = 'MID';
let recsMode = 'overall';
let activeChipTab = 'wildcard';
let activePricesTab = 'predicted_risers';

async function loadJSON(path) {
  const res = await fetch(path + '?t=' + Date.now());
  if (!res.ok) throw new Error('Failed to load ' + path);
  return res.json();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

/* ---------- Floating tooltip layer ---------- */
const tooltipLayer = document.createElement('div');
tooltipLayer.className = 'tooltip-layer';
document.body.appendChild(tooltipLayer);
let activeTipAnchor = null;

function positionTooltip(anchor) {
  const rect = anchor.getBoundingClientRect();
  const tw = tooltipLayer.offsetWidth || 250;
  const th = tooltipLayer.offsetHeight || 40;
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
  if (left < 8) left = 8;
  if (top + th > window.innerHeight - 8) top = rect.top - th - 8;
  tooltipLayer.style.left = left + 'px';
  tooltipLayer.style.top = top + 'px';
}

function showTooltip(anchor) {
  const text = anchor.getAttribute('data-tip');
  if (!text) return;
  tooltipLayer.textContent = text;
  tooltipLayer.classList.add('visible');
  activeTipAnchor = anchor;
  positionTooltip(anchor);
}

function hideTooltip() {
  tooltipLayer.classList.remove('visible');
  activeTipAnchor = null;
}

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tip]');
  if (el) showTooltip(el);
});
document.addEventListener('mouseout', (e) => {
  const el = e.target.closest('[data-tip]');
  if (el && el === activeTipAnchor) hideTooltip();
});
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-tip]');
  if (el) {
    activeTipAnchor === el ? hideTooltip() : showTooltip(el);
  } else if (activeTipAnchor) {
    hideTooltip();
  }
});
window.addEventListener('scroll', () => { if (activeTipAnchor) positionTooltip(activeTipAnchor); }, true);
window.addEventListener('resize', () => { if (activeTipAnchor) positionTooltip(activeTipAnchor); });

async function init() {
  try {
    const [players, teams, fixtures, recommendations, differentials, chipSquads,
           benchBoostPlan, tripleCaptainPlan, miniLeague, rivalIntelligence, seasonJourney,
           teamFixtureScores, priceChanges, meta] = await Promise.all([
      loadJSON('data/players.json'),
      loadJSON('data/teams.json'),
      loadJSON('data/fixtures.json'),
      loadJSON('data/recommendations.json'),
      loadJSON('data/differentials.json').catch(() => ({})),
      loadJSON('data/chip_squads.json').catch(() => null),
      loadJSON('data/bench_boost_plan.json').catch(() => null),
      loadJSON('data/triple_captain_plan.json').catch(() => null),
      loadJSON('data/mini_league.json').catch(() => null),
      loadJSON('data/rival_intelligence.json').catch(() => null),
      loadJSON('data/season_journey.json').catch(() => null),
      loadJSON('data/team_fixture_scores.json').catch(() => []),
      loadJSON('data/price_changes.json').catch(() => null),
      loadJSON('data/meta.json'),
    ]);
    Object.assign(state, {
      players, teams, fixtures, recommendations, differentials, chipSquads,
      benchBoostPlan, tripleCaptainPlan, miniLeague, rivalIntelligence, seasonJourney,
      teamFixtureScores, priceChanges, meta,
    });

    renderMeta();
    renderTodaySummary();
    renderTeamFilter();
    renderMyFixtureTicker();
    renderTeamFixtureTicker();
    renderTableHead();
    renderTable();
    renderRecsModeTabs();
    renderRecsTabs();
    renderRecsList();
    renderChipsTabs();
    renderChipsContent();
    renderMiniLeague();
    renderRivalIntelligence();
    renderSeasonJourney();
    renderStatsTableHead();
    renderStatsTable();
    renderStatsTeamFilter();
    renderPricesTabs();
    renderPricesContent();
  } catch (err) {
    document.getElementById('gw-badge').textContent = 'Data unavailable';
    console.error(err);
  }
}

function renderMeta() {
  document.getElementById('gw-badge').textContent = state.meta.current_gw ? `GW${state.meta.current_gw}` : '—';
  const updated = document.getElementById('updated-badge');
  if (state.meta.last_updated) {
    updated.textContent = 'Updated ' + new Date(state.meta.last_updated).toLocaleString();
  } else {
    updated.textContent = 'Not yet synced — run the Action once (see README)';
  }
}

/* ---------- Today summary ---------- */
function renderTodaySummary() {
  const el = document.getElementById('today-bar');
  const chips = [];

  if (state.meta.gw_deadline) {
    const deadline = new Date(state.meta.gw_deadline);
    const istText = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(deadline);
    const diffMs = deadline - new Date();
    const isUrgent = diffMs > 0 && diffMs < 86400000;
    chips.push({ label: `GW${state.meta.deadline_gw || state.meta.current_gw || '?'} Deadline`, value: `${istText} IST`, cls: isUrgent ? 'alert' : '' });
  }

  const journeyGws = state.seasonJourney && state.seasonJourney.gameweeks;
  if (journeyGws && journeyGws.length) {
    const latest = journeyGws[journeyGws.length - 1];
    if (latest.overall_rank != null) {
      chips.push({ label: 'Overall Rank', value: `#${latest.overall_rank.toLocaleString()}`, cls: '' });
    }
    if (latest.rank != null) {
      chips.push({ label: `GW${latest.gw} Rank`, value: `#${latest.rank.toLocaleString()}`, cls: '' });
    }
  }

  const squad = state.meta.squad;
  if (squad && squad.picks && squad.picks.length) {
    const byId = {};
    state.players.forEach((p) => { byId[p.id] = p; });
    const squadPlayers = squad.picks.map((pk) => byId[pk.element]).filter(Boolean);
    const flagged = squadPlayers.filter((p) => p.status !== 'a').length;
    chips.push({ label: 'Flagged Players', value: flagged, cls: flagged > 0 ? 'alert' : 'ok' });

    if (state.priceChanges) {
      const myIds = new Set(squadPlayers.map((p) => p.id));
      let moving = 0;
      ['predicted_risers', 'predicted_fallers'].forEach((key) => {
        (state.priceChanges[key] || []).forEach((p) => { if (myIds.has(p.id)) moving++; });
      });
      chips.push({ label: 'Predicted to Move Tonight', value: moving, cls: moving > 0 ? 'alert' : '' });
    }
  }

  if (state.miniLeague && state.meta.my_entry_id) {
    const mine = state.miniLeague.standings.find((s) => s.entry === state.meta.my_entry_id);
    if (mine) chips.push({ label: 'League Rank', value: `#${mine.rank}`, cls: '' });
  }

  el.innerHTML = chips.map((c) => `
    <div class="today-chip ${c.cls}">
      <div class="today-chip-label">${escapeHtml(c.label)}</div>
      <div class="today-chip-value">${escapeHtml(c.value)}</div>
    </div>
  `).join('');
}

function renderTeamFilter() {
  const sel = document.getElementById('team-filter');
  [...state.teams]
    .sort((a, b) => a.short_name.localeCompare(b.short_name))
    .forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.short_name;
      opt.textContent = t.short_name;
      sel.appendChild(opt);
    });
}

/* ---------- Tabs ---------- */
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = true; });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    document.getElementById('tab-' + btn.dataset.tab).hidden = false;
  });
});

/* ---------- Pitch view (shared: My Squad + Chip Squad wildcard/free hit) ---------- */
function renderPitchView(containerId, starters, bench) {
  const el = document.getElementById(containerId);
  let html = '<div class="pitch-wrap"><div class="pitch">';
  Object.keys(PITCH_ROWS).forEach((pos) => {
    const list = starters[pos] || [];
    if (!list.length) return;
    html += `<div class="pitch-row" style="top:${PITCH_ROWS[pos]}%">`;
    list.forEach((p) => {
      const cBadge = p.isCaptain ? '<span class="pitch-shirt-c">C</span>' : (p.isVice ? '<span class="pitch-shirt-c" style="background:var(--chalk-dim)">V</span>' : '');
      html += `<div class="pitch-chip${p.isCaptain ? ' captain' : ''}" data-tip="${escapeAttr(p.name + (p.sub ? ' · ' + p.sub : ''))}">
        <div class="pitch-shirt">${cBadge}</div>
        <div class="pitch-chip-name">${escapeHtml(p.name)}</div>
      </div>`;
    });
    html += '</div>';
  });
  html += '</div>';
  if (bench && bench.length) {
    html += '<div class="pitch-bench-strip"><div class="pitch-bench-label">Bench</div>';
    bench.forEach((p) => {
      html += `<div class="pitch-chip" data-tip="${escapeAttr(p.name + (p.sub ? ' · ' + p.sub : ''))}">
        <div class="pitch-shirt"></div>
        <div class="pitch-chip-name">${escapeHtml(p.name)}</div>
      </div>`;
    });
    html += '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

/* ---------- My Players' fixture ticker (Overview) ---------- */
function fixtureScoreColor(avg) {
  if (avg <= 1.75) return '#1F7A4D';
  if (avg <= 2.5) return '#34B871';
  if (avg <= 3.25) return '#5B6B62';
  if (avg <= 4.0) return '#C1443C';
  return '#8A2C26';
}

function renderMyFixtureTicker() {
  const wrap = document.getElementById('my-fixture-ticker');
  const squad = state.meta.squad;
  if (!squad || !squad.picks || !squad.picks.length) {
    wrap.innerHTML = '<p class="empty-hint">Add your Team ID to config.json to see your own players here.</p>';
    return;
  }
  const byId = {};
  state.players.forEach((p) => { byId[p.id] = p; });

  wrap.innerHTML = '';
  [...squad.picks]
    .sort((a, b) => a.position - b.position)
    .forEach((pick) => {
      const p = byId[pick.element];
      if (!p) return;
      const row = document.createElement('div');
      row.className = 'ticker-row';

      const label = document.createElement('div');
      label.className = 'ticker-team';
      label.textContent = p.name;
      row.appendChild(label);

      const fixList = state.fixtures[p.team_id] || [];
      const avg = fixList.length ? fixList.reduce((s, f) => s + f.difficulty, 0) / fixList.length : null;
      const scoreEl = document.createElement('div');
      scoreEl.className = 'ticker-score';
      if (avg !== null) {
        scoreEl.style.background = fixtureScoreColor(avg);
        scoreEl.textContent = avg.toFixed(1);
        scoreEl.setAttribute('data-tip', `Average difficulty across ${fixList.length} upcoming fixture${fixList.length === 1 ? '' : 's'}. Lower is easier.`);
      } else {
        scoreEl.style.background = '#5B6B62';
        scoreEl.textContent = '—';
      }
      row.appendChild(scoreEl);

      const cellsWrap = document.createElement('div');
      cellsWrap.className = 'ticker-cells';
      if (!fixList.length) {
        const cell = document.createElement('div');
        cell.className = 'ticker-cell';
        cell.style.background = '#5B6B62';
        cell.textContent = 'BLANK';
        cellsWrap.appendChild(cell);
      }
      fixList.forEach((f, idx) => {
        const cell = document.createElement('div');
        cell.className = 'ticker-cell';
        cell.style.background = DIFFICULTY_COLORS[f.difficulty] || '#5B6B62';
        cell.textContent = (f.is_home ? '' : '@') + f.opponent;
        let tip = `GW${f.gw} — ${f.is_home ? 'Home' : 'Away'} vs ${f.opponent} (FDR ${f.difficulty})`;
        const h = p.fixture_history && p.fixture_history[f.gw];
        if (h) {
          tip += ` — history vs ${h.opponent}: ${h.matches} apps, avg ${h.avg_points}pts (best ${h.best_points}), ${h.seasons.join(' & ')}.`;
          cell.classList.add('has-history');
        }
        cell.setAttribute('data-tip', tip);
        cellsWrap.appendChild(cell);
      });
      row.appendChild(cellsWrap);
      wrap.appendChild(row);
    });
}

/* ---------- All 20 teams' fixture difficulty (Overview), ticker-style with score badge ---------- */
function renderTeamFixtureTicker() {
  const wrap = document.getElementById('team-fixture-ticker');
  const scores = state.teamFixtureScores || [];
  if (!scores.length) {
    wrap.innerHTML = '<p class="empty-hint">No fixture data yet.</p>';
    return;
  }
  const allGws = new Set();
  scores.forEach((t) => t.fixtures.forEach((f) => allGws.add(f.gw)));
  const gwList = [...allGws].sort((a, b) => a - b).slice(0, 6);

  wrap.innerHTML = '';
  scores.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'ticker-row';

    const label = document.createElement('div');
    label.className = 'ticker-team';
    label.textContent = t.team_name || t.team;
    label.setAttribute('data-tip', t.team_name && t.team_name !== t.team ? `${t.team_name} (${t.team})` : t.team);
    row.appendChild(label);

    const scoreEl = document.createElement('div');
    scoreEl.className = 'ticker-score';
    if (t.score !== null) {
      scoreEl.style.background = fixtureScoreColor(t.score);
      scoreEl.textContent = t.score.toFixed(1);
      scoreEl.setAttribute('data-tip', `Average difficulty across ${t.fixtures.length} upcoming fixture${t.fixtures.length === 1 ? '' : 's'}. Lower is easier.`);
    } else {
      scoreEl.style.background = '#5B6B62';
      scoreEl.textContent = '—';
    }
    row.appendChild(scoreEl);

    const cellsWrap = document.createElement('div');
    cellsWrap.className = 'ticker-cells';
    const byGw = {};
    t.fixtures.forEach((f) => { byGw[f.gw] = f; });
    gwList.forEach((gw) => {
      const f = byGw[gw];
      const cell = document.createElement('div');
      cell.className = 'ticker-cell';
      if (f) {
        cell.style.background = DIFFICULTY_COLORS[f.difficulty] || '#5B6B62';
        cell.textContent = (f.is_home ? '' : '@') + f.opponent;
        cell.setAttribute('data-tip', `GW${f.gw} — ${f.is_home ? 'Home' : 'Away'} vs ${f.opponent} (FDR ${f.difficulty})`);
      } else {
        cell.style.background = 'rgba(91,107,98,0.25)';
        cell.style.color = 'var(--chalk-dim)';
        cell.textContent = '–';
        cell.setAttribute('data-tip', `GW${gw} — blank gameweek`);
      }
      cellsWrap.appendChild(cell);
    });
    row.appendChild(cellsWrap);
    wrap.appendChild(row);
  });
}

/* ---------- All Players table ---------- */
function renderTableHead() {
  const tr = document.getElementById('player-table-head');
  tr.innerHTML = '';
  const COLUMNS = [
    { key: 'name', label: 'Player' },
    { key: 'team', label: 'Team' },
    { key: 'pos', label: 'Pos' },
    { key: 'price', label: 'Price', tip: 'Current market price in £ millions.' },
    { key: 'selected_by', label: 'Own%', tip: 'Percentage of FPL managers who own this player.' },
    { key: 'form', label: 'Form', tip: "FPL's average points per match over the last 30 days." },
    { key: 'total_points', label: 'Pts', tip: 'Total points scored this season.' },
    { key: 'ppm', label: 'PPM', tip: 'Points per million spent (total points ÷ price). Higher is better value.' },
    { key: 'ict_index', label: 'ICT', tip: 'Influence + Creativity + Threat index. Reads "—" during a live gameweek until FPL finalizes it, usually a day or so after the last match.' },
    { key: 'xgi', label: 'xGI', tip: 'Expected Goal Involvements — combined expected goals and expected assists from chance quality.' },
    { key: 'def_con_p90', label: 'DC/90', tip: 'Defensive Contribution per 90 minutes: tackles, interceptions, clearances and blocks.' },
    { key: 'pred_next', label: 'Next', tip: 'Predicted points for the next gameweek: form × fixture-difficulty multiplier × minutes-reliability factor, plus a small history adjustment if they\u2019ve faced this opponent before (hover the number itself when present).' },
    { key: 'pred_next5', label: 'Next 5', tip: 'Predicted total points summed over the next 5 gameweeks, same formula per fixture.' },
    { key: 'status', label: 'Status', tip: 'Injury or availability flag. Tap or hover a flagged player to see details.' },
  ];
  COLUMNS.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col.label;
    th.dataset.key = col.key;
    if (col.tip) th.dataset.tip = col.tip;
    th.addEventListener('click', () => {
      if (state.sortKey === col.key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = col.key;
        state.sortDir = 'desc';
      }
      renderTable();
    });
    tr.appendChild(th);
  });
}

function statusFlagged(p) {
  return p.status !== 'a';
}

function statusBadgeHtml(p) {
  if (!statusFlagged(p)) return '';
  const cls = p.status === 'd' ? 'doubtful' : '';
  const short = STATUS_SHORT[p.status] || p.status.toUpperCase();
  const pctPart = (p.chance_of_playing !== null && p.chance_of_playing !== undefined) ? ` — ${p.chance_of_playing}% chance of playing` : '';
  const tip = `${p.status_label || short}${p.news ? ': ' + p.news : ''}${pctPart}`;
  return `<span class="status-badge ${cls}" data-tip="${escapeAttr(tip)}">${escapeHtml(short)}</span>`;
}

function ictCellHtml(p) {
  if (p.ict_index === null || p.ict_index === undefined) {
    return `<span class="na-cell" data-tip="FPL hasn't finalized Influence/Creativity/Threat for this gameweek yet — usually ready a day or so after the last match.">—</span>`;
  }
  return p.ict_index.toFixed(1);
}

function nextCellHtml(p) {
  if (p.history_vs_next_opp) {
    const h = p.history_vs_next_opp;
    const tip = `Includes a history adjustment vs ${h.opponent}: ${h.matches} past meetings, averaged ${h.avg_points} pts (best ${h.best_points}), from ${h.seasons.join(' & ')}.`;
    return `<span data-tip="${escapeAttr(tip)}">${(p.pred_next ?? 0).toFixed(1)}</span>`;
  }
  return (p.pred_next ?? 0).toFixed(1);
}

function applyFilters(players) {
  const q = state.search.toLowerCase();
  return players.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q) && !p.full_name.toLowerCase().includes(q)) return false;
    if (state.posFilter && p.pos !== state.posFilter) return false;
    if (state.teamFilter && p.team !== state.teamFilter) return false;
    if (state.statusFilter === 'a' && p.status !== 'a') return false;
    if (state.statusFilter === 'flag' && p.status === 'a') return false;
    return true;
  });
}

function renderTable() {
  document.querySelectorAll('#player-table-head th').forEach((th) => {
    th.style.color = th.dataset.key === state.sortKey ? 'var(--chalk)' : '';
  });

  const tbody = document.getElementById('player-rows');
  const rows = applyFilters(state.players);

  rows.sort((a, b) => {
    const dir = state.sortDir === 'asc' ? 1 : -1;
    const av = a[state.sortKey];
    const bv = b[state.sortKey];
    if (NUMERIC_KEYS.has(state.sortKey)) return ((av ?? -1) - (bv ?? -1)) * dir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
  });

  document.getElementById('row-count').textContent = `${rows.length} player${rows.length === 1 ? '' : 's'}`;

  const frag = document.createDocumentFragment();
  rows.forEach((p) => {
    const tr = document.createElement('tr');
    if (statusFlagged(p)) tr.classList.add('flagged');
    tr.innerHTML = `
      <td class="name-cell">${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.team)}</td>
      <td>${p.pos}</td>
      <td>£${p.price.toFixed(1)}m</td>
      <td>${p.selected_by.toFixed(1)}%</td>
      <td>${p.form.toFixed(1)}</td>
      <td>${p.total_points}</td>
      <td>${p.ppm.toFixed(1)}</td>
      <td>${ictCellHtml(p)}</td>
      <td>${p.xgi.toFixed(1)}</td>
      <td>${p.def_con_p90.toFixed(1)}</td>
      <td>${nextCellHtml(p)}</td>
      <td>${(p.pred_next5 ?? 0).toFixed(1)}</td>
      <td>${statusBadgeHtml(p)}</td>
    `;
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

document.getElementById('search').addEventListener('input', (e) => { state.search = e.target.value; renderTable(); });
document.getElementById('pos-filter').addEventListener('change', (e) => { state.posFilter = e.target.value; renderTable(); });
document.getElementById('team-filter').addEventListener('change', (e) => { state.teamFilter = e.target.value; renderTable(); });
document.getElementById('status-filter').addEventListener('change', (e) => { state.statusFilter = e.target.value; renderTable(); });

/* ---------- Recommendations (+ Differentials mode) ---------- */
function renderRecsModeTabs() {
  const wrap = document.getElementById('recs-mode-tabs');
  wrap.innerHTML = '';
  [['overall', 'Best Overall'], ['differential', 'Differentials']].forEach(([key, label]) => {
    const btn = document.createElement('button');
    btn.className = 'recs-pos-btn' + (key === recsMode ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => { recsMode = key; renderRecsModeTabs(); renderRecsList(); });
    wrap.appendChild(btn);
  });
}

function renderRecsTabs() {
  const wrap = document.getElementById('recs-tabs');
  wrap.innerHTML = '';
  REC_POSITIONS.forEach((pos) => {
    const btn = document.createElement('button');
    btn.className = 'recs-pos-btn' + (pos === activeRecPos ? ' active' : '');
    btn.textContent = pos;
    btn.addEventListener('click', () => {
      activeRecPos = pos;
      renderRecsTabs();
      renderRecsList();
    });
    wrap.appendChild(btn);
  });
}

function renderRecsList() {
  const wrap = document.getElementById('recs-list');
  const source = recsMode === 'differential' ? (state.differentials || {}) : (state.recommendations || {});
  const list = source[activeRecPos] || [];
  if (!list.length) {
    wrap.innerHTML = `<p class="empty-hint">${recsMode === 'differential' ? 'No low-ownership options meeting the threshold right now.' : 'No data yet — run the Action to populate this.'}</p>`;
    return;
  }
  wrap.innerHTML = '';
  list.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'rec-row' + (p.owned ? ' owned' : '');
    const h = p.history_vs_next_opp;
    const histLine = h
      ? `<div class="rec-sub rec-hist">vs ${escapeHtml(h.opponent)} before: ${h.matches} apps, avg ${h.avg_points}pts (best ${h.best_points})</div>`
      : '';
    const ownSub = recsMode === 'differential' ? ` · ${p.selected_by.toFixed(1)}% owned` : '';
    row.innerHTML = `
      <div class="rec-rank">${idx + 1}</div>
      <div class="rec-name-wrap">
        <div class="rec-name">${escapeHtml(p.name)}${p.owned ? '<span class="rec-owned-tag">SQUAD</span>' : ''}${statusBadgeHtml(p)}</div>
        <div class="rec-sub">${escapeHtml(p.team)} · £${p.price.toFixed(1)}m · PPM ${p.ppm.toFixed(1)}${ownSub}</div>
        ${histLine}
      </div>
      <div class="rec-stat"><div class="rec-stat-value">${(p.pred_next ?? 0).toFixed(1)}</div><div class="rec-stat-label">Next</div></div>
      <div class="rec-stat"><div class="rec-stat-value">${(p.pred_next5 ?? 0).toFixed(1)}</div><div class="rec-stat-label">Next 5</div></div>
    `;
    wrap.appendChild(row);
  });
}

/* ---------- Season Journey (hand-rolled SVG line charts, no external library) ---------- */
function renderLineChart(containerId, points, options = {}) {
  const el = document.getElementById(containerId);
  if (!points.length) {
    el.innerHTML = '<div class="chart-empty">Not enough data yet.</div>';
    return;
  }
  const width = options.width || 600;
  const height = options.height || 170;
  const padding = { top: 12, right: 14, bottom: 24, left: 54 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);

  const scaleX = (x) => padding.left + (xMax === xMin ? plotW / 2 : (x - xMin) / (xMax - xMin) * plotW);
  const scaleY = (y) => {
    const t = (y - yMin) / (yMax - yMin);
    return options.invertY ? padding.top + t * plotH : padding.top + (1 - t) * plotH;
  };

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(p.x).toFixed(1)} ${scaleY(p.y).toFixed(1)}`).join(' ');
  const baseY = (padding.top + plotH).toFixed(1);
  const areaD = `${pathD} L ${scaleX(xs[xs.length - 1]).toFixed(1)} ${baseY} L ${scaleX(xs[0]).toFixed(1)} ${baseY} Z`;
  const color = options.color || '#00FF85';

  const dots = points.map((p) => {
    const label = p.label || (options.yFormat ? options.yFormat(p.y) : String(p.y));
    return `<circle cx="${scaleX(p.x).toFixed(1)}" cy="${scaleY(p.y).toFixed(1)}" r="3.2" fill="${color}" stroke="#12301F" stroke-width="1.5" data-tip="${escapeAttr(label)}"></circle>`;
  }).join('');

  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  const gridLines = yTicks.map((v) => {
    const y = scaleY(v).toFixed(1);
    const label = options.yFormat ? options.yFormat(v) : Math.round(v).toLocaleString();
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="rgba(243,246,241,0.08)" stroke-width="1"></line>
            <text x="${padding.left - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" fill="#B9C6BE" font-size="10">${label}</text>`;
  }).join('');

  const labelPoints = points.length <= 6 ? points : [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]];
  const xLabels = labelPoints.map((p) => `<text x="${scaleX(p.x).toFixed(1)}" y="${height - 6}" text-anchor="middle" fill="#B9C6BE" font-size="10">GW${p.x}</text>`).join('');

  el.innerHTML = `<div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; display:block;">
    <path d="${areaD}" fill="${color}" opacity="0.1"></path>
    <path d="${pathD}" fill="none" stroke="${color}" stroke-width="2.5"></path>
    ${gridLines}
    ${dots}
    ${xLabels}
  </svg></div>`;
}

function renderSeasonJourney() {
  const wrap = document.getElementById('journey-content');
  const journey = state.seasonJourney;
  if (!journey || !journey.gameweeks || !journey.gameweeks.length) {
    wrap.innerHTML = '<p class="empty-hint">Add your Team ID to config.json to see your season charted here.</p>';
    return;
  }
  const gws = journey.gameweeks;
  let html = '';
  html += `<section class="card"><div class="card-title">Overall Rank (lower is better)</div><div id="journey-rank-chart"></div></section>`;
  html += `<section class="card"><div class="card-title">Points per Gameweek</div><div id="journey-points-chart"></div></section>`;
  html += `<section class="card"><div class="card-title">Squad Value</div><div id="journey-value-chart"></div></section>`;
  if (journey.chips_used && journey.chips_used.length) {
    html += `<section class="card"><div class="card-title">Chips Used</div><div class="squad-list">`;
    journey.chips_used.forEach((c) => {
      html += `<div class="squad-chip">${escapeHtml(c.name)} <span class="rec-owned-tag">GW${c.event}</span></div>`;
    });
    html += `</div></section>`;
  }
  wrap.innerHTML = html;

  const rankPoints = gws.filter((g) => g.overall_rank != null).map((g) => ({ x: g.gw, y: g.overall_rank }));
  renderLineChart('journey-rank-chart', rankPoints, {
    invertY: true, color: '#00FF85',
    yFormat: (v) => (v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v.toLocaleString()),
  });

  const ptsPoints = gws.map((g) => ({ x: g.gw, y: g.points, label: `GW${g.gw}: ${g.points} pts${g.chip ? ' · ' + g.chip : ''}` }));
  renderLineChart('journey-points-chart', ptsPoints, { color: '#FF3D82', yFormat: (v) => Math.round(v) });

  const valuePoints = gws.map((g) => ({ x: g.gw, y: g.value, label: `GW${g.gw}: £${g.value.toFixed(1)}m` }));
  renderLineChart('journey-value-chart', valuePoints, { color: '#04F5FF', yFormat: (v) => `£${v.toFixed(1)}m` });
}

/* ---------- Chip Squad (Wildcard/Free Hit via pitch view, Bench Boost/Triple Captain via lists) ---------- */
function renderChipsTabs() {
  const wrap = document.getElementById('chips-tabs');
  wrap.innerHTML = '';
  CHIP_TAB_DEFS.forEach(([key, label]) => {
    const btn = document.createElement('button');
    btn.className = 'recs-pos-btn' + (key === activeChipTab ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      activeChipTab = key;
      renderChipsTabs();
      renderChipsContent();
    });
    wrap.appendChild(btn);
  });
}

function renderBenchBoostContent(wrap) {
  const plan = state.benchBoostPlan;
  if (!plan || !plan.by_gameweek || !plan.by_gameweek.length) {
    wrap.innerHTML = '<p class="empty-hint">Needs your Team ID configured, and a bench to project.</p>';
    return;
  }
  let html = `<div class="chip-summary"><span>Your bench: <b>${plan.bench_players.map((p) => escapeHtml(p.name)).join(', ')}</b></span></div><div class="recs-list">`;
  plan.by_gameweek.forEach((g, idx) => {
    html += `<div class="rec-row${idx === 0 ? ' owned' : ''}">
      <div class="rec-rank">${idx === 0 ? '★' : idx + 1}</div>
      <div class="rec-name-wrap"><div class="rec-name">GW${g.gw}${idx === 0 ? '<span class="rec-owned-tag">BEST</span>' : ''}</div></div>
      <div class="rec-stat"><div class="rec-stat-value">${g.projected_bench_points.toFixed(1)}</div><div class="rec-stat-label">Bench Pts</div></div>
    </div>`;
  });
  wrap.innerHTML = html + '</div>';
}

function renderTripleCaptainContent(wrap) {
  const plan = state.tripleCaptainPlan;
  if (!plan || !plan.candidates || !plan.candidates.length) {
    wrap.innerHTML = '<p class="empty-hint">Needs your Team ID configured to rank your captain options.</p>';
    return;
  }
  let html = '<div class="recs-list">';
  plan.candidates.forEach((c, idx) => {
    const h = c.history_vs_opp;
    const histLine = h
      ? `<div class="rec-sub rec-hist">vs ${escapeHtml(h.opponent)} before: ${h.matches} apps, avg ${h.avg_points}pts (best ${h.best_points})</div>`
      : '';
    html += `<div class="rec-row${idx === 0 ? ' owned' : ''}">
      <div class="rec-rank">${idx === 0 ? '★' : idx + 1}</div>
      <div class="rec-name-wrap"><div class="rec-name">${escapeHtml(c.name)}${idx === 0 ? '<span class="rec-owned-tag">BEST</span>' : ''}</div><div class="rec-sub">${escapeHtml(c.team)} · best in GW${c.gw}</div>${histLine}</div>
      <div class="rec-stat"><div class="rec-stat-value">${c.projected_points.toFixed(1)}</div><div class="rec-stat-label">at 3x</div></div>
    </div>`;
  });
  wrap.innerHTML = html + '</div>';
}

function renderChipsContent() {
  const wrap = document.getElementById('chips-content');
  if (activeChipTab === 'bench_boost') { renderBenchBoostContent(wrap); return; }
  if (activeChipTab === 'triple_captain') { renderTripleCaptainContent(wrap); return; }

  const data = state.chipSquads && state.chipSquads[activeChipTab];
  if (!data) {
    wrap.innerHTML = '<p class="empty-hint">Needs your Team ID configured (for the budget) and the Action to have run with the optimizer.</p>';
    return;
  }
  const starters = { GKP: [], DEF: [], MID: [], FWD: [] };
  data.starting_xi.forEach((p) => {
    starters[p.pos].push({ name: p.name, isCaptain: p.id === data.captain.id, sub: `£${p.price.toFixed(1)}m` });
  });
  const bench = data.bench.map((p) => ({ name: p.name, sub: `£${p.price.toFixed(1)}m` }));

  wrap.innerHTML = `<div class="chip-summary">
    <span>Formation: <b>${escapeHtml(data.formation)}</b></span>
    <span>Budget: <b>£${data.budget_used.toFixed(1)}m</b> / £${data.budget_available.toFixed(1)}m</span>
    <span>Projected: <b>${data.projected_points.toFixed(1)} pts</b></span>
    <span>Captain: <b>${escapeHtml(data.captain.name)}</b></span>
  </div><div id="chips-pitch"></div>`;
  renderPitchView('chips-pitch', starters, bench);
}

/* ---------- Mini League + Rival Intelligence ---------- */
function renderMiniLeague() {
  const titleEl = document.getElementById('league-title');
  const wrap = document.getElementById('league-content');
  const league = state.miniLeague;
  if (!league) {
    wrap.innerHTML = '<p class="empty-hint">Configure mini_league_id in config.json to track a league.</p>';
    return;
  }
  titleEl.textContent = league.league_name || 'Mini League';
  const myId = state.meta.my_entry_id;
  const hasTrend = league.trend_vs_week_ago && Object.keys(league.trend_vs_week_ago).length > 0;

  let html = '';
  if (league.snapshots_recorded < 8) {
    html += `<p class="rec-explainer" style="margin-bottom:14px;">Recording one snapshot a day (${league.snapshots_recorded} so far). Week-over-week movement, pattern recognition, and rival profiles all need real history to accumulate \u2014 they'll fill in automatically as the season goes, nothing to do on your end.</p>`;
  }

  html += `<div class="table-wrap" style="max-height:none;"><table class="league-table"><thead><tr>
    <th>Rank</th><th>GW\u2194</th><th>7-Day</th><th>Team</th><th>Manager</th><th>GW Pts</th><th>Total</th>
  </tr></thead><tbody>`;

  league.standings.forEach((s) => {
    const gwMove = (s.last_rank != null) ? (s.last_rank - s.rank) : null;
    const gwMoveHtml = gwMove === null ? '<span class="move-flat">\u2014</span>'
      : gwMove > 0 ? `<span class="move-up">\u25B2${gwMove}</span>`
      : gwMove < 0 ? `<span class="move-down">\u25BC${Math.abs(gwMove)}</span>`
      : '<span class="move-flat">\u2014</span>';
    const weekMove = hasTrend ? league.trend_vs_week_ago[String(s.entry)] : undefined;
    const weekMoveHtml = (weekMove === undefined || weekMove === null) ? '<span class="move-flat">\u2014</span>'
      : weekMove > 0 ? `<span class="move-up">\u25B2${weekMove}</span>`
      : weekMove < 0 ? `<span class="move-down">\u25BC${Math.abs(weekMove)}</span>`
      : '<span class="move-flat">flat</span>';
    html += `<tr class="${s.entry === myId ? 'is-you' : ''}">
      <td>${s.rank}</td>
      <td>${gwMoveHtml}</td>
      <td>${weekMoveHtml}</td>
      <td class="lt-name">${escapeHtml(s.entry_name)}${s.entry === myId ? ' (you)' : ''}</td>
      <td>${escapeHtml(s.player_name)}</td>
      <td>${s.event_total}</td>
      <td>${s.total}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  wrap.innerHTML = html;
}

function renderRivalIntelligence() {
  const wrap = document.getElementById('rival-content');
  const intel = state.rivalIntelligence;
  if (!intel || !intel.rivals || !intel.rivals.length) {
    wrap.innerHTML = '<p class="empty-hint">Populates once this gameweek\u2019s deadline has passed for the league.</p>';
    return;
  }
  let html = `<div class="card-title">GW${intel.gw} Captain Choices</div><div class="squad-list" style="margin-bottom:16px;">`;
  intel.captain_distribution.forEach((c) => {
    html += `<div class="squad-chip">${escapeHtml(c.name)} <span class="rec-owned-tag">${c.count}</span></div>`;
  });
  html += `</div>`;

  if (intel.trending_in && intel.trending_in.length) {
    html += `<div class="card-title">Trending In This Gameweek</div><div class="squad-list" style="margin-bottom:16px;">`;
    intel.trending_in.forEach((c) => {
      html += `<div class="squad-chip">${escapeHtml(c.name)} <span class="rec-owned-tag">${c.count}</span></div>`;
    });
    html += `</div>`;
  }

  if (intel.chips_played.length) {
    html += `<div class="card-title">Chips Played This Gameweek</div><div class="squad-list" style="margin-bottom:16px;">`;
    intel.chips_played.forEach((c) => {
      html += `<div class="squad-chip bench">${escapeHtml(c.entry_name)}: ${escapeHtml(c.chip)}</div>`;
    });
    html += `</div>`;
  }

  html += `<div class="card-title">Transfers This Gameweek</div>`;
  const activeRivals = intel.rivals.filter((r) => r.transfers_made > 0);
  if (!activeRivals.length) {
    html += `<p class="empty-hint">No transfers made in the league this gameweek yet.</p>`;
  } else {
    html += `<div style="display:flex; flex-direction:column; gap:8px;">`;
    activeRivals.forEach((r) => {
      const parts = [];
      const n = Math.max(r.transfers_in.length, r.transfers_out.length);
      for (let i = 0; i < n; i++) {
        const outName = r.transfers_out[i];
        const inName = r.transfers_in[i];
        if (outName && inName) parts.push(`${outName} \u2192 ${inName}`);
        else if (inName) parts.push(`+${inName}`);
        else if (outName) parts.push(`-${outName}`);
      }
      const detail = parts.length ? parts.join(', ') : `${r.transfers_made} transfer${r.transfers_made === 1 ? '' : 's'}`;
      const hitText = r.transfer_cost > 0 ? ` <span style="color:var(--red)">(\u2212${r.transfer_cost} hit)</span>` : '';
      html += `<div class="today-chip" style="flex:none;">
        <div class="today-chip-label">${escapeHtml(r.entry_name)}</div>
        <div class="today-chip-value" style="font-size:12px;">${escapeHtml(detail)}${hitText}</div>
      </div>`;
    });
    html += `</div>`;
  }
  wrap.innerHTML = html;
}

/* ---------- Attacking/Defending stats tab ---------- */
function pendingNumCell(val) {
  if (val === null || val === undefined) {
    return `<span class="na-cell" data-tip="Not finalized for this gameweek yet — same reason as the ICT column.">—</span>`;
  }
  return val.toFixed(1);
}

function setPiecesHtml(p) {
  const tags = [];
  if (p.penalty_order) tags.push(p.penalty_order === 1 ? 'PEN' : `PEN${p.penalty_order}`);
  if (p.direct_fk_order) tags.push(p.direct_fk_order === 1 ? 'FK' : `FK${p.direct_fk_order}`);
  if (p.corner_fk_order) tags.push(p.corner_fk_order === 1 ? 'CK' : `CK${p.corner_fk_order}`);
  return tags.length ? escapeHtml(tags.join(' ')) : '<span class="na-cell">—</span>';
}

function renderStatsTeamFilter() {
  const sel = document.getElementById('stats-team-filter');
  [...state.teams]
    .sort((a, b) => a.short_name.localeCompare(b.short_name))
    .forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.short_name;
      opt.textContent = t.short_name;
      sel.appendChild(opt);
    });
}

function renderStatsTableHead() {
  const tr = document.getElementById('stats-table-head');
  tr.innerHTML = '';
  STATS_COLUMNS.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col.label;
    th.dataset.key = col.key;
    if (col.tip) th.dataset.tip = col.tip;
    th.addEventListener('click', () => {
      if (col.key === 'setpieces') return;
      if (state.statsSortKey === col.key) {
        state.statsSortDir = state.statsSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.statsSortKey = col.key;
        state.statsSortDir = 'desc';
      }
      renderStatsTable();
    });
    tr.appendChild(th);
  });
}

function applyStatsFilters(players) {
  const q = state.statsSearch.toLowerCase();
  return players.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q) && !p.full_name.toLowerCase().includes(q)) return false;
    if (state.statsPosFilter && p.pos !== state.statsPosFilter) return false;
    if (state.statsTeamFilter && p.team !== state.statsTeamFilter) return false;
    return true;
  });
}

function renderStatsTable() {
  document.querySelectorAll('#stats-table-head th').forEach((th) => {
    th.style.color = th.dataset.key === state.statsSortKey ? 'var(--chalk)' : '';
  });

  const tbody = document.getElementById('stats-rows');
  const rows = applyStatsFilters(state.players);

  rows.sort((a, b) => {
    const dir = state.statsSortDir === 'asc' ? 1 : -1;
    const av = a[state.statsSortKey];
    const bv = b[state.statsSortKey];
    if (STATS_NUMERIC_KEYS.has(state.statsSortKey)) return ((av ?? -1) - (bv ?? -1)) * dir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
  });

  document.getElementById('stats-row-count').textContent = `${rows.length} player${rows.length === 1 ? '' : 's'}`;

  const frag = document.createDocumentFragment();
  rows.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="name-cell">${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.team)}</td>
      <td>${p.pos}</td>
      <td>${p.tackles}</td>
      <td>${p.cbi}</td>
      <td>${p.recoveries}</td>
      <td>${p.def_con_p90.toFixed(1)}</td>
      <td>${pendingNumCell(p.influence)}</td>
      <td>${pendingNumCell(p.creativity)}</td>
      <td>${pendingNumCell(p.threat)}</td>
      <td>${p.xg.toFixed(1)}</td>
      <td>${p.xa.toFixed(1)}</td>
      <td>${p.xg_p90.toFixed(2)}</td>
      <td>${p.xa_p90.toFixed(2)}</td>
      <td>${setPiecesHtml(p)}</td>
    `;
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

document.getElementById('stats-search').addEventListener('input', (e) => { state.statsSearch = e.target.value; renderStatsTable(); });
document.getElementById('stats-pos-filter').addEventListener('change', (e) => { state.statsPosFilter = e.target.value; renderStatsTable(); });
document.getElementById('stats-team-filter').addEventListener('change', (e) => { state.statsTeamFilter = e.target.value; renderStatsTable(); });

/* ---------- Price Changes ---------- */
function renderPricesTabs() {
  const wrap = document.getElementById('prices-tabs');
  wrap.innerHTML = '';
  PRICE_TABS.forEach(([key, label]) => {
    const btn = document.createElement('button');
    btn.className = 'recs-pos-btn' + (key === activePricesTab ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      activePricesTab = key;
      renderPricesTabs();
      renderPricesContent();
    });
    wrap.appendChild(btn);
  });
}

function renderPricesContent() {
  const wrap = document.getElementById('prices-content');
  const list = (state.priceChanges && state.priceChanges[activePricesTab]) || [];
  if (!list.length) {
    wrap.innerHTML = '<p class="empty-hint">No movers in this category right now.</p>';
    return;
  }
  const isPredicted = activePricesTab.startsWith('predicted_');
  wrap.innerHTML = '';
  list.forEach((p) => {
    const positive = isPredicted ? p.percent > 0 : p.change > 0;
    const row = document.createElement('div');
    row.className = 'rec-row';
    if (isPredicted) {
      const tip = `FPL's own Price Change Predictor: ${p.percent.toFixed(0)}% progress toward tonight's threshold, moving at ${p.hourly_rate > 0 ? '+' : ''}${p.hourly_rate}%/hr. A guide, not a guarantee — late transfer activity can still change the outcome.`;
      row.innerHTML = `
        <div class="rec-rank ${positive ? 'move-up' : 'move-down'}">${positive ? '▲' : '▼'}</div>
        <div class="rec-name-wrap">
          <div class="rec-name">${escapeHtml(p.name)}</div>
          <div class="rec-sub">${escapeHtml(p.team)} · ${p.pos} · £${p.price.toFixed(1)}m · ${p.selected_by.toFixed(1)}% owned</div>
        </div>
        <div class="rec-stat" data-tip="${escapeAttr(tip)}">
          <div class="rec-stat-value ${positive ? 'move-up' : 'move-down'}">${p.confidence}</div>
          <div class="rec-stat-label">${p.percent.toFixed(0)}%</div>
        </div>
      `;
    } else {
      row.innerHTML = `
        <div class="rec-rank ${positive ? 'move-up' : 'move-down'}">${positive ? '▲' : '▼'}</div>
        <div class="rec-name-wrap">
          <div class="rec-name">${escapeHtml(p.name)}</div>
          <div class="rec-sub">${escapeHtml(p.team)} · ${p.pos} · £${p.price.toFixed(1)}m · ${p.selected_by.toFixed(1)}% owned</div>
        </div>
        <div class="rec-stat"><div class="rec-stat-value ${positive ? 'move-up' : 'move-down'}">${positive ? '+' : ''}£${p.change.toFixed(1)}m</div></div>
      `;
    }
    wrap.appendChild(row);
  });
}

init();
