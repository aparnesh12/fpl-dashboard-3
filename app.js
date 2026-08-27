const state = {
  players: [],
  teams: [],
  fixtures: {},
  recommendations: {},
  teamRating: null,
  chipSquads: null,
  miniLeague: null,
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
  ['today_risers', "Today's Risers"], ['today_fallers', "Today's Fallers"],
  ['season_risers', 'Season Risers'], ['season_fallers', 'Season Fallers'],
];

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

let activeRecPos = 'MID';
let activeChipTab = 'wildcard';

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

// Text-node escaping (above) doesn't need to touch quote characters, but an
// attribute value does — a literal " in API-sourced text would otherwise
// close the attribute early. Belt-and-braces for data-tip specifically.
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

/* ---------- Floating tooltip layer ----------
   Deliberately NOT a ::after on the element itself. Headers and status
   badges live inside .table-wrap, which has overflow-x/y:auto for the
   horizontal-scrolling table — any ::after tooltip on a descendant gets
   clipped the instant it would extend past the currently-scrolled-into-
   view area, which is exactly the "have to scroll right to read it"
   problem. A single fixed-position layer outside that scroll container,
   repositioned via getBoundingClientRect, has no such ceiling. */
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
    const [players, teams, fixtures, recommendations, teamRating, chipSquads, miniLeague, teamFixtureScores, priceChanges, meta] = await Promise.all([
      loadJSON('data/players.json'),
      loadJSON('data/teams.json'),
      loadJSON('data/fixtures.json'),
      loadJSON('data/recommendations.json'),
      loadJSON('data/team_rating.json').catch(() => null),
      loadJSON('data/chip_squads.json').catch(() => null),
      loadJSON('data/mini_league.json').catch(() => null),
      loadJSON('data/team_fixture_scores.json').catch(() => []),
      loadJSON('data/price_changes.json').catch(() => null),
      loadJSON('data/meta.json'),
    ]);
    state.players = players;
    state.teams = teams;
    state.fixtures = fixtures;
    state.recommendations = recommendations;
    state.teamRating = teamRating;
    state.chipSquads = chipSquads;
    state.miniLeague = miniLeague;
    state.teamFixtureScores = teamFixtureScores;
    state.priceChanges = priceChanges;
    state.meta = meta;

    renderMeta();
    renderTeamFilter();
    renderMyFixtureTicker();
    renderTeamFixtureTicker();
    renderSquad();
    renderTableHead();
    renderTable();
    renderRecsTabs();
    renderRecsList();
    renderMyTeam();
    renderChipsTabs();
    renderChipsContent();
    renderMiniLeague();
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

/* ---------- Squad ---------- */
function renderSquad() {
  const squad = state.meta.squad;
  const section = document.getElementById('squad-section');
  if (!squad || !squad.picks || !squad.picks.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  document.getElementById('squad-gw').textContent = squad.gw;

  const byId = {};
  state.players.forEach((p) => { byId[p.id] = p; });

  const list = document.getElementById('squad-list');
  list.innerHTML = '';
  [...squad.picks]
    .sort((a, b) => a.position - b.position)
    .forEach((pick) => {
      const p = byId[pick.element];
      if (!p) return;
      const chip = document.createElement('div');
      chip.className = 'squad-chip' + (pick.multiplier === 0 ? ' bench' : '');
      chip.innerHTML = escapeHtml(p.name)
        + (pick.is_captain ? ' <span class="cap-tag" title="Captain">C</span>' : '')
        + (pick.is_vice_captain ? ' <span class="vc-tag" title="Vice-captain">V</span>' : '');
      list.appendChild(chip);
    });
}

/* ---------- My Players' fixture ticker (Overview tab), with a quantitative score ---------- */
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
      fixList.forEach((f) => {
        const cell = document.createElement('div');
        cell.className = 'ticker-cell';
        cell.style.background = DIFFICULTY_COLORS[f.difficulty] || '#5B6B62';
        cell.textContent = (f.is_home ? '' : '@') + f.opponent;
        cell.setAttribute('data-tip', `GW${f.gw} — ${f.is_home ? 'Home' : 'Away'} vs ${f.opponent} (FDR ${f.difficulty})`);
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
  COLUMNS.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col.label;
    th.dataset.key = col.key;
    if (col.tip) {
      th.dataset.tip = col.tip;
    }
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

/* ---------- Recommendations ---------- */
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
  const list = state.recommendations[activeRecPos] || [];
  if (!list.length) {
    wrap.innerHTML = '<p class="empty-hint">No data yet — run the Action to populate this.</p>';
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
    row.innerHTML = `
      <div class="rec-rank">${idx + 1}</div>
      <div class="rec-name-wrap">
        <div class="rec-name">${escapeHtml(p.name)}${p.owned ? '<span class="rec-owned-tag">SQUAD</span>' : ''}</div>
        <div class="rec-sub">${escapeHtml(p.team)} · £${p.price.toFixed(1)}m · PPM ${p.ppm.toFixed(1)}</div>
        ${histLine}
      </div>
      <div class="rec-stat"><div class="rec-stat-value">${(p.pred_next ?? 0).toFixed(1)}</div><div class="rec-stat-label">Next</div></div>
      <div class="rec-stat"><div class="rec-stat-value">${(p.pred_next5 ?? 0).toFixed(1)}</div><div class="rec-stat-label">Next 5</div></div>
    `;
    wrap.appendChild(row);
  });
}

/* ---------- My Team ---------- */
function renderMyTeam() {
  const wrap = document.getElementById('myteam-content');
  const rating = state.teamRating;
  if (!rating) {
    wrap.innerHTML = '<p class="empty-hint">Add your Team ID to config.json to rate your squad.</p>';
    return;
  }
  const tier = rating.overall >= 70 ? '' : rating.overall >= 45 ? 'mid' : 'low';
  const label = rating.overall >= 80 ? 'Excellent squad — strong across the board.'
    : rating.overall >= 65 ? 'Solid squad with room to sharpen.'
    : rating.overall >= 45 ? 'Average — a few clear upgrade paths.'
    : 'Struggling — worth a serious look at transfers.';

  const comps = [
    ['Scoring Strength', rating.components.scoring_strength,
      `Your 15's predicted points vs the best possible squad under the same position quotas (${rating.squad_total_pred_next5} of ${rating.best_possible_pred_next5} predicted pts, next 5 GWs).`],
    ['Value Efficiency', rating.components.value_efficiency,
      "Your squad's average points-per-million vs the league-wide average among players who've actually played minutes."],
    ['Availability', rating.components.availability,
      `${rating.flagged_players.length} of 15 players currently flagged (injured, doubtful, or suspended).`],
    ['Captaincy', rating.components.captaincy,
      rating.captain_is_optimal ? 'Your captain is your squad\u2019s best starting option right now.' : `Your captain (${rating.captain_name}) isn\u2019t your highest predicted scorer \u2014 ${rating.best_captain_option} is, for next gameweek.`],
  ];

  let html = `
    <div class="rating-hero">
      <div class="rating-score ${tier}">${rating.overall}</div>
      <div class="rating-label">${escapeHtml(label)}</div>
    </div>
    <div class="rating-components">
      ${comps.map(([lbl, val, note]) => `
        <div class="rating-bar-wrap" data-tip="${escapeAttr(note)}">
          <div class="rating-bar-label"><span>${escapeHtml(lbl)}</span><span>${val.toFixed(0)}</span></div>
          <div class="rating-bar-track"><div class="rating-bar-fill" style="width:${Math.max(0, Math.min(100, val))}%"></div></div>
        </div>
      `).join('')}
    </div>
  `;

  if (!rating.captain_is_optimal && rating.best_captain_option) {
    html += `<div class="rating-note">Consider captaining ${escapeHtml(rating.best_captain_option)} instead of ${escapeHtml(rating.captain_name)} for next gameweek \u2014 higher predicted points.</div>`;
  }
  if (rating.flagged_players.length) {
    html += `<div class="rating-flagged">Flagged: ${rating.flagged_players.map((p) => `${escapeHtml(p.name)} (${escapeHtml(p.status_label)})`).join(', ')}</div>`;
  }
  wrap.innerHTML = html;
}

/* ---------- Chip Squad ---------- */
function renderChipsTabs() {
  const wrap = document.getElementById('chips-tabs');
  wrap.innerHTML = '';
  [['wildcard', 'Wildcard'], ['free_hit', 'Free Hit']].forEach(([key, label]) => {
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

function lineupChipHtml(p, isBench, isCaptain) {
  return `<div class="lineup-chip${isBench ? ' bench' : ''}${isCaptain ? ' captain' : ''}">
    <span class="lc-name">${escapeHtml(p.name)}${isCaptain ? ' (C)' : ''}</span>
    <span class="lc-pts">${(p.pred_next5 ?? 0).toFixed(1)}</span>
  </div>`;
}

function renderChipsContent() {
  const wrap = document.getElementById('chips-content');
  const data = state.chipSquads && state.chipSquads[activeChipTab];
  if (!data) {
    wrap.innerHTML = '<p class="empty-hint">Needs your Team ID configured (for the budget) and the Action to have run with the optimizer.</p>';
    return;
  }
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  data.starting_xi.forEach((p) => byPos[p.pos].push(p));

  let html = `<div class="chip-summary">
    <span>Formation: <b>${escapeHtml(data.formation)}</b></span>
    <span>Budget: <b>£${data.budget_used.toFixed(1)}m</b> / £${data.budget_available.toFixed(1)}m</span>
    <span>Projected: <b>${data.projected_points.toFixed(1)} pts</b></span>
    <span>Captain: <b>${escapeHtml(data.captain.name)}</b></span>
  </div>`;

  ['GKP', 'DEF', 'MID', 'FWD'].forEach((pos) => {
    if (!byPos[pos].length) return;
    html += `<div class="lineup-pos-group"><div class="lineup-pos-label">${pos}</div><div class="lineup-players">`;
    html += byPos[pos].map((p) => lineupChipHtml(p, false, p.id === data.captain.id)).join('');
    html += `</div></div>`;
  });

  html += `<div class="lineup-pos-group"><div class="lineup-pos-label">Bench</div><div class="lineup-players">`;
  html += data.bench.map((p) => lineupChipHtml(p, true, false)).join('');
  html += `</div></div>`;

  wrap.innerHTML = html;
}

/* ---------- Mini League ---------- */
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

/* ---------- All 20 teams' fixture difficulty (Overview) ---------- */
function renderTeamFixtureTicker() {
  const wrap = document.getElementById('team-fixture-ticker');
  const scores = state.teamFixtureScores || [];
  wrap.innerHTML = '';
  scores.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'ticker-row';

    const label = document.createElement('div');
    label.className = 'ticker-team';
    label.textContent = t.team;
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
    if (!t.fixtures.length) {
      const cell = document.createElement('div');
      cell.className = 'ticker-cell';
      cell.style.background = '#5B6B62';
      cell.textContent = 'BLANK';
      cellsWrap.appendChild(cell);
    }
    t.fixtures.forEach((f) => {
      const cell = document.createElement('div');
      cell.className = 'ticker-cell';
      cell.style.background = DIFFICULTY_COLORS[f.difficulty] || '#5B6B62';
      cell.textContent = (f.is_home ? '' : '@') + f.opponent;
      cell.setAttribute('data-tip', `GW${f.gw} — ${f.is_home ? 'Home' : 'Away'} vs ${f.opponent} (FDR ${f.difficulty})`);
      cellsWrap.appendChild(cell);
    });
    row.appendChild(cellsWrap);
    wrap.appendChild(row);
  });
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
      if (col.key === 'setpieces') return; // not a meaningful sort key
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

/* ---------- Price Changes tab ---------- */
let activePricesTab = 'today_risers';

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
  wrap.innerHTML = '';
  list.forEach((p) => {
    const positive = p.change > 0;
    const row = document.createElement('div');
    row.className = 'rec-row';
    row.innerHTML = `
      <div class="rec-rank ${positive ? 'move-up' : 'move-down'}">${positive ? '▲' : '▼'}</div>
      <div class="rec-name-wrap">
        <div class="rec-name">${escapeHtml(p.name)}</div>
        <div class="rec-sub">${escapeHtml(p.team)} · ${p.pos} · £${p.price.toFixed(1)}m · ${p.selected_by.toFixed(1)}% owned</div>
      </div>
      <div class="rec-stat"><div class="rec-stat-value ${positive ? 'move-up' : 'move-down'}">${positive ? '+' : ''}£${p.change.toFixed(1)}m</div></div>
    `;
    wrap.appendChild(row);
  });
}

init();
