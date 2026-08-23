const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Admin Credentials & Active Token Sessions
let ADMIN_USER = 'roggers wifi';
let ADMIN_PASS = '0713081880';
const activeSessions = new Set();

// API Guard Middleware (Returns 401 JSON, NOT WWW-Authenticate header)
const requireAuthAPI = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (token && activeSessions.has(token)) {
    next();
  } else {
    res.status(401).json({ success: false, message: 'Unauthorized session' });
  }
};

// Page Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Custom Portal Admin Login Endpoint
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
    activeSessions.add(token);
    return res.json({ success: true, token });
  }
  return res.status(401).json({ success: false, message: 'Invalid Username or Password!' });
});

// Public Payment Verification Endpoint
app.post('/api/verify-payment', async (req, res) => {
  try {
    let { name, phone, mpesaCode, amount } = req.body;
    if (!name || !phone || !mpesaCode || !amount) {
      return res.status(400).json({ success: false, message: 'Provide name, phone number, transaction code, and amount.' });
    }

    name = String(name).trim();
    phone = String(phone).trim();
    mpesaCode = String(mpesaCode).trim().toUpperCase();
    const paidAmount = parseFloat(amount) || 0;

    if (paidAmount <= 0) return res.status(400).json({ success: false, message: 'Please enter a valid amount.' });

    const calculatedDays = Math.max(1, Math.round((paidAmount / 200) * 30));

    const checkCode = await pool.query('SELECT * FROM paid_users WHERE mpesa_code = $1', [mpesaCode]);
    if (checkCode.rowCount > 0) return res.status(400).json({ success: false, message: 'M-Pesa code already used.' });

    const queryText = `
      INSERT INTO paid_users (user_name, phone_number, amount_paid, mpesa_code, status, start_date, expiry_date, is_paused)
      VALUES ($1, $2, $3, $4, 'Active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($5 || ' days')::INTERVAL, false)
      ON CONFLICT (phone_number) 
      DO UPDATE SET 
        user_name = EXCLUDED.user_name,
        mpesa_code = EXCLUDED.mpesa_code,
        amount_paid = EXCLUDED.amount_paid,
        status = 'Active',
        is_paused = false,
        start_date = CURRENT_TIMESTAMP,
        expiry_date = CURRENT_TIMESTAMP + ($5 || ' days')::INTERVAL
      RETURNING *;
    `;
    await pool.query(queryText, [name, phone, paidAmount, mpesaCode, calculatedDays]);
    return res.json({ success: true, message: `Payment verified! Wi-Fi active for ${calculatedDays} days.` });
  } catch (err) {
    return res.json({ success: false, message: `Database error: ${err.message}` });
  }
});

// Protected Admin API Endpoints

app.get('/api/admin/users', requireAuthAPI, async (req, res) => {
  try {
    const queryText = `
      SELECT id, phone_number, user_name, mpesa_code, amount_paid, start_date, expiry_date, is_paused, remaining_seconds,
      CASE 
        WHEN is_paused THEN 'Paused'
        WHEN CURRENT_TIMESTAMP > expiry_date THEN 'Expired'
        ELSE 'Active'
      END AS status,
      CASE 
        WHEN is_paused THEN CEIL(remaining_seconds / 86400.0)
        ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expiry_date - CURRENT_TIMESTAMP)) / 86400.0))
      END AS days_left
      FROM paid_users ORDER BY start_date DESC;
    `;
    const result = await pool.query(queryText);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/update-user', requireAuthAPI, async (req, res) => {
  try {
    const { id, user_name, phone_number, mpesa_code, amount_paid } = req.body;
    const paidAmount = parseFloat(amount_paid) || 0;
    const calculatedDays = Math.max(1, Math.round((paidAmount / 200) * 30));

    const queryText = `
      UPDATE paid_users 
      SET user_name = $1, phone_number = $2, mpesa_code = $3, amount_paid = $4,
          expiry_date = start_date + ($5 || ' days')::INTERVAL
      WHERE id = $6;
    `;
    await pool.query(queryText, [user_name, phone_number, mpesa_code, paidAmount, calculatedDays, id]);
    res.json({ success: true, message: 'User updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/register', requireAuthAPI, async (req, res) => {
  try {
    const { phone, name, amount, days } = req.body;
    const amountNum = parseFloat(amount) || 200;
    const daysNum = days ? parseInt(days) : Math.max(1, Math.round((amountNum / 200) * 30));

    const queryText = `
      INSERT INTO paid_users (phone_number, user_name, amount_paid, mpesa_code, status, start_date, expiry_date, is_paused)
      VALUES ($1, $2, $3, 'MANUAL_REG', 'Active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($4 || ' days')::INTERVAL, false)
      ON CONFLICT (phone_number) DO UPDATE SET
        user_name = EXCLUDED.user_name,
        amount_paid = EXCLUDED.amount_paid,
        mpesa_code = 'MANUAL_REG',
        status = 'Active',
        is_paused = false,
        start_date = CURRENT_TIMESTAMP,
        expiry_date = CURRENT_TIMESTAMP + ($4 || ' days')::INTERVAL;
    `;
    await pool.query(queryText, [phone, name, amountNum, daysNum]);
    res.json({ success: true, message: 'User registered successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/toggle-pause', requireAuthAPI, async (req, res) => {
  try {
    const { id } = req.body;
    const userRes = await pool.query('SELECT * FROM paid_users WHERE id = $1', [id]);
    if (userRes.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    const user = userRes.rows[0];

    if (!user.is_paused) {
      const pauseQuery = `
        UPDATE paid_users 
        SET is_paused = true, 
            remaining_seconds = GREATEST(0, EXTRACT(EPOCH FROM (expiry_date - CURRENT_TIMESTAMP))::INT)
        WHERE id = $1;
      `;
      await pool.query(pauseQuery, [id]);
      res.json({ success: true, message: 'User paused.' });
    } else {
      const resumeQuery = `
        UPDATE paid_users 
        SET is_paused = false, 
            expiry_date = CURRENT_TIMESTAMP + (remaining_seconds || ' seconds')::INTERVAL,
            remaining_seconds = 0
        WHERE id = $1;
      `;
      await pool.query(resumeQuery, [id]);
      res.json({ success: true, message: 'User resumed.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/delete/:id', requireAuthAPI, async (req, res) => {
  try {
    await pool.query('DELETE FROM paid_users WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'User deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
