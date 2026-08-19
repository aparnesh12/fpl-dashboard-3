const state = {
  players: [],
  teams: [],
  fixtures: {},
  meta: {},
  sortKey: 'total_points',
  sortDir: 'desc',
  search: '',
  posFilter: '',
  teamFilter: '',
  statusFilter: '',
};

const DIFFICULTY_COLORS = { 1: '#1F7A4D', 2: '#34B871', 3: '#5B6B62', 4: '#C1443C', 5: '#8A2C26' };
const NUMERIC_KEYS = new Set(['price', 'selected_by', 'form', 'total_points', 'ppm', 'ict_index', 'xgi', 'def_con_p90']);

async function loadJSON(path) {
  const res = await fetch(path + '?t=' + Date.now());
  if (!res.ok) throw new Error('Failed to load ' + path);
  return res.json();
}

async function init() {
  try {
    const [players, teams, fixtures, meta] = await Promise.all([
      loadJSON('data/players.json'),
      loadJSON('data/teams.json'),
      loadJSON('data/fixtures.json'),
      loadJSON('data/meta.json'),
    ]);
    state.players = players;
    state.teams = teams;
    state.fixtures = fixtures;
    state.meta = meta;
    renderMeta();
    renderTeamFilter();
    renderFixtureTicker();
    renderSquad();
    renderTable();
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

function renderFixtureTicker() {
  const wrap = document.getElementById('fixture-ticker');
  wrap.innerHTML = '';
  [...state.teams]
    .sort((a, b) => a.short_name.localeCompare(b.short_name))
    .forEach((t) => {
      const row = document.createElement('div');
      row.className = 'ticker-row';

      const label = document.createElement('div');
      label.className = 'ticker-team';
      label.textContent = t.short_name;
      row.appendChild(label);

      const cellsWrap = document.createElement('div');
      cellsWrap.className = 'ticker-cells';
      const fixList = state.fixtures[t.id] || [];
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

function statusFlagged(p) {
  return p.status !== 'a';
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderTable() {
  const tbody = document.getElementById('player-rows');
  const rows = applyFilters(state.players);

  rows.sort((a, b) => {
    const dir = state.sortDir === 'asc' ? 1 : -1;
    const av = a[state.sortKey];
    const bv = b[state.sortKey];
    if (NUMERIC_KEYS.has(state.sortKey)) return ((av ?? 0) - (bv ?? 0)) * dir;
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
      <td>${p.ict_index.toFixed(1)}</td>
      <td>${p.xgi.toFixed(1)}</td>
      <td>${p.def_con_p90.toFixed(1)}</td>
      <td>${statusFlagged(p) ? `<span class="status-flag" title="${escapeHtml(p.news || 'Fitness doubt')}">&#9873;</span>` : ''}</td>
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

document.querySelectorAll('#player-table thead th').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = 'desc';
    }
    renderTable();
  });
});

init();
