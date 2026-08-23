const state = {
  players: [],
  teams: [],
  fixtures: {},
  recommendations: {},
  meta: {},
  sortKey: 'pred_next5',
  sortDir: 'desc',
  search: '',
  posFilter: '',
  teamFilter: '',
  statusFilter: '',
};

const DIFFICULTY_COLORS = { 1: '#1F7A4D', 2: '#34B871', 3: '#5B6B62', 4: '#C1443C', 5: '#8A2C26' };
const NUMERIC_KEYS = new Set(['price', 'selected_by', 'form', 'total_points', 'ppm', 'ict_index', 'xgi', 'def_con_p90', 'pred_next', 'pred_next5']);
const STATUS_SHORT = { d: 'DOUBT', i: 'INJ', s: 'SUSP', u: 'N/A', n: 'N/A' };
const REC_POSITIONS = ['GKP', 'DEF', 'MID', 'FWD'];

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

async function init() {
  try {
    const [players, teams, fixtures, recommendations, meta] = await Promise.all([
      loadJSON('data/players.json'),
      loadJSON('data/teams.json'),
      loadJSON('data/fixtures.json'),
      loadJSON('data/recommendations.json'),
      loadJSON('data/meta.json'),
    ]);
    state.players = players;
    state.teams = teams;
    state.fixtures = fixtures;
    state.recommendations = recommendations;
    state.meta = meta;

    renderMeta();
    renderTeamFilter();
    renderMyFixtureTicker();
    renderSquad();
    renderTableHead();
    renderTable();
    renderRecsTabs();
    renderRecsList();
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

/* ---------- Tap-to-toggle tooltips (desktop still gets CSS :hover free) ---------- */
document.addEventListener('click', (e) => {
  const tipEl = e.target.closest('[data-tip]');
  document.querySelectorAll('.tip-active').forEach((el) => {
    if (el !== tipEl) el.classList.remove('tip-active');
  });
  if (tipEl) {
    tipEl.classList.toggle('tip-active');
  }
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

/* ---------- My Players' fixture ticker (Overview tab) ---------- */
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

      const cellsWrap = document.createElement('div');
      cellsWrap.className = 'ticker-cells';
      const fixList = state.fixtures[p.team_id] || [];
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
        cell.title = `GW${f.gw} — ${f.is_home ? 'Home' : 'Away'} vs ${f.opponent} (FDR ${f.difficulty})`;
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

init();
