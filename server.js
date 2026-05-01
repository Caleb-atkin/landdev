require('dotenv').config();
const express = require('express');
const path = require('path');
const { query, ready } = require('./database');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helper: map DB row → frontend-compatible CO object ──────────────────────
function mapCO(row) {
  return {
    id: row.id,
    phaseId: row.phase_id,
    cat: row.category,
    desc: row.description,
    scope: row.scope || '',
    vendor: row.vendor || '',
    cost: Number(row.cost),
    status: row.status,
    by: row.submitted_by || '',
    date: row.date || '',
  };
}

function dbError(res, e) {
  console.error('DB error:', e.message);
  res.status(500).json({ error: e.message });
}

// ─── Projects ─────────────────────────────────────────────────────────────────

app.get('/api/projects', async (req, res) => {
  try {
    const projects = (await query('SELECT * FROM projects ORDER BY created_at ASC')).rows;
    const phases = (await query('SELECT * FROM phases ORDER BY created_at ASC')).rows;
    const result = projects.map(p => ({
      ...p,
      phases: phases
        .filter(ph => ph.project_id === p.id)
        .map(ph => ({ ...ph, budget: Number(ph.budget), lots: Number(ph.lots) })),
    }));
    res.json(result);
  } catch (e) { dbError(res, e); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    const result = await query('INSERT INTO projects (name) VALUES ($1) RETURNING id', [name.trim()]);
    res.json({ id: result.rows[0].id, name: name.trim(), phases: [] });
  } catch (e) { dbError(res, e); }
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    await query('UPDATE projects SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
    res.json({ ok: true });
  } catch (e) { dbError(res, e); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    await query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { dbError(res, e); }
});

// ─── Phases ───────────────────────────────────────────────────────────────────

app.post('/api/projects/:id/phases', async (req, res) => {
  try {
    const { name, budget, lots } = req.body;
    if (!name || !budget || !lots) return res.status(400).json({ error: 'All fields required' });
    const result = await query(
      'INSERT INTO phases (project_id, name, budget, lots) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.params.id, name.trim(), parseFloat(budget), parseInt(lots)]
    );
    res.json({
      id: result.rows[0].id,
      project_id: parseInt(req.params.id),
      name: name.trim(),
      budget: parseFloat(budget),
      lots: parseInt(lots),
    });
  } catch (e) { dbError(res, e); }
});

app.put('/api/phases/:id', async (req, res) => {
  try {
    const { name, budget, lots } = req.body;
    if (!name || !budget || !lots) return res.status(400).json({ error: 'All fields required' });
    await query(
      'UPDATE phases SET name = $1, budget = $2, lots = $3 WHERE id = $4',
      [name.trim(), parseFloat(budget), parseInt(lots), req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { dbError(res, e); }
});

app.delete('/api/phases/:id', async (req, res) => {
  try {
    await query('DELETE FROM phases WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { dbError(res, e); }
});

// ─── Change Orders ────────────────────────────────────────────────────────────

app.get('/api/change-orders', async (req, res) => {
  try {
    const result = await query('SELECT * FROM change_orders ORDER BY created_at DESC');
    res.json(result.rows.map(mapCO));
  } catch (e) { dbError(res, e); }
});

app.post('/api/change-orders', async (req, res) => {
  try {
    const { phaseId, cat, desc, scope, vendor, cost, by, date } = req.body;
    if (!phaseId || !cat || !desc || !cost) return res.status(400).json({ error: 'Required fields missing' });
    const result = await query(
      `INSERT INTO change_orders (phase_id, category, description, scope, vendor, cost, submitted_by, date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, status`,
      [phaseId, cat, desc, scope || '', vendor || '', parseFloat(cost), by || '', date || '']
    );
    res.json({
      id: result.rows[0].id,
      phaseId,
      cat,
      desc,
      scope: scope || '',
      vendor: vendor || '',
      cost: parseFloat(cost),
      status: result.rows[0].status,
      by: by || '',
      date: date || '',
    });
  } catch (e) { dbError(res, e); }
});

app.put('/api/change-orders/:id', async (req, res) => {
  try {
    const { cat, desc, scope, vendor, cost, status, by, date } = req.body;
    await query(
      `UPDATE change_orders
       SET category=$1, description=$2, scope=$3, vendor=$4, cost=$5, status=$6, submitted_by=$7, date=$8
       WHERE id=$9`,
      [cat, desc, scope || '', vendor || '', parseFloat(cost), status, by || '', date || '', req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { dbError(res, e); }
});

app.delete('/api/change-orders/:id', async (req, res) => {
  try {
    await query('DELETE FROM change_orders WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { dbError(res, e); }
});

// ─── AI Pricing Proxy ─────────────────────────────────────────────────────────

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

app.get('/api/history', async (req, res) => {
  try {
    const result = await query('SELECT * FROM co_history ORDER BY year DESC');
    res.json(result.rows);
  } catch (e) { dbError(res, e); }
});

app.post('/api/history', async (req, res) => {
  try {
    const { category, description, total_cost, lots, year } = req.body;
    const result = await query(
      `INSERT INTO co_history (category, description, total_cost, lots, year)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [category, description || '', parseFloat(total_cost) || 0, parseInt(lots) || 0, parseInt(year) || new Date().getFullYear()]
    );
    res.json({ id: result.rows[0].id, ...req.body });
  } catch (e) { dbError(res, e); }
});

// ─── Serve frontend for all other routes ─────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start server only when run directly (not when imported by Vercel) ───────

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  ready
    .then(() => app.listen(PORT, () => console.log(`LandDev running → http://localhost:${PORT}`)))
    .catch(err => {
      console.error('Failed to start:', err.message);
      process.exit(1);
    });
}

module.exports = app;
