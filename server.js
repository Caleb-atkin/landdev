require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ─── Helper: map DB row to frontend-compatible CO object ─────────────────────
function mapCO(row) {
  return {
    id: row.id,
    phaseId: row.phase_id,
    cat: row.category,
    desc: row.description,
    scope: row.scope || '',
    vendor: row.vendor || '',
    cost: row.cost,
    status: row.status,
    by: row.submitted_by || '',
    date: row.date || '',
  };
}

// ─── Projects ─────────────────────────────────────────────────────────────────

app.get('/api/projects', (req, res) => {
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all();
  const phases = db.prepare('SELECT * FROM phases ORDER BY created_at ASC').all();
  const result = projects.map(p => ({
    ...p,
    phases: phases.filter(ph => ph.project_id === p.id),
  }));
  res.json(result);
});

app.post('/api/projects', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const result = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name.trim());
  res.json({ id: result.lastInsertRowid, name: name.trim(), phases: [] });
});

app.put('/api/projects/:id', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Phases ───────────────────────────────────────────────────────────────────

app.post('/api/projects/:id/phases', (req, res) => {
  const { name, budget, lots } = req.body;
  if (!name || !budget || !lots) return res.status(400).json({ error: 'All fields required' });
  const result = db
    .prepare('INSERT INTO phases (project_id, name, budget, lots) VALUES (?, ?, ?, ?)')
    .run(req.params.id, name.trim(), parseFloat(budget), parseInt(lots));
  res.json({ id: result.lastInsertRowid, project_id: parseInt(req.params.id), name: name.trim(), budget: parseFloat(budget), lots: parseInt(lots) });
});

app.put('/api/phases/:id', (req, res) => {
  const { name, budget, lots } = req.body;
  if (!name || !budget || !lots) return res.status(400).json({ error: 'All fields required' });
  db.prepare('UPDATE phases SET name = ?, budget = ?, lots = ? WHERE id = ?').run(name.trim(), parseFloat(budget), parseInt(lots), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/phases/:id', (req, res) => {
  db.prepare('DELETE FROM phases WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Change Orders ────────────────────────────────────────────────────────────

app.get('/api/change-orders', (req, res) => {
  const rows = db.prepare('SELECT * FROM change_orders ORDER BY created_at DESC').all();
  res.json(rows.map(mapCO));
});

app.post('/api/change-orders', (req, res) => {
  const { phaseId, cat, desc, scope, vendor, cost, by, date } = req.body;
  if (!phaseId || !cat || !desc || !cost) return res.status(400).json({ error: 'Required fields missing' });
  const result = db
    .prepare('INSERT INTO change_orders (phase_id, category, description, scope, vendor, cost, submitted_by, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(phaseId, cat, desc, scope || '', vendor || '', parseFloat(cost), by || '', date || '');
  res.json({ id: result.lastInsertRowid, phaseId, cat, desc, scope: scope || '', vendor: vendor || '', cost: parseFloat(cost), status: 'draft', by: by || '', date: date || '' });
});

app.put('/api/change-orders/:id', (req, res) => {
  const { cat, desc, scope, vendor, cost, status, by, date } = req.body;
  db.prepare('UPDATE change_orders SET category=?, description=?, scope=?, vendor=?, cost=?, status=?, submitted_by=?, date=? WHERE id=?')
    .run(cat, desc, scope || '', vendor || '', parseFloat(cost), status, by || '', date || '', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/change-orders/:id', (req, res) => {
  db.prepare('DELETE FROM change_orders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── AI Pricing Proxy ─────────────────────────────────────────────────────────
// Proxies requests to Anthropic so the API key stays server-side

app.post('/api/ai-check', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Historical Benchmark Data ────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  const rows = db.prepare('SELECT * FROM co_history ORDER BY year DESC').all();
  res.json(rows);
});

app.post('/api/history', (req, res) => {
  const { category, description, total_cost, lots, year } = req.body;
  const result = db
    .prepare('INSERT INTO co_history (category, description, total_cost, lots, year) VALUES (?, ?, ?, ?, ?)')
    .run(category, description || '', parseFloat(total_cost) || 0, parseInt(lots) || 0, parseInt(year) || new Date().getFullYear());
  res.json({ id: result.lastInsertRowid, ...req.body });
});

// ─── Serve frontend for all other routes ─────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LandDev running → http://localhost:${PORT}`));
