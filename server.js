const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Admin Credentials
let ADMIN_USER = process.env.ADMIN_USER || 'roggers';
let ADMIN_PASS = process.env.ADMIN_PASS || '8422';
const activeSessions = new Set();

// Guard Middleware
const requireAuthAPI = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (token && activeSessions.has(token)) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Unauthorized session' });
};

// Page Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Admin Login
app.post('/api/admin/login', (req, res) => {
  let { username, password } = req.body;
  username = String(username || '').trim();
  password = String(password || '').trim();

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = 'tok_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    activeSessions.add(token);
    return res.json({ success: true, token });
  }
  return res.status(401).json({ success: false, message: 'Invalid Username or Password!' });
});

// Change Admin Credentials
app.post('/api/admin/change-credentials', requireAuthAPI, (req, res) => {
  const { newUsername, newPassword } = req.body;
  if (!newUsername || !newPassword) {
    return res.status(400).json({ success: false, message: 'Both fields required' });
  }
  ADMIN_USER = newUsername.trim();
  ADMIN_PASS = newPassword.trim();
  return res.json({ success: true, message: 'Credentials updated successfully!' });
});

// Public Payment Verification Endpoint (Enforces Blacklist & Handles Expired/Renewal Users)
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

    // Check Blacklist
    const checkBlacklist = await pool.query('SELECT * FROM blacklist WHERE phone_number = $1', [phone]);
    if (checkBlacklist.rowCount > 0) {
      return res.status(403).json({ success: false, message: 'Your phone number is blocked from payments. Contact Admin.' });
    }

    if (paidAmount <= 0) return res.status(400).json({ success: false, message: 'Please enter a valid amount.' });

    const calculatedDays = Math.max(1, Math.round((paidAmount / 200) * 30));

    // Check if M-Pesa Code has already been used
    const checkCode = await pool.query('SELECT * FROM paid_users WHERE mpesa_code = $1', [mpesaCode]);
    if (checkCode.rowCount > 0) return res.status(400).json({ success: false, message: 'M-Pesa code already used.' });

    // UPSERT Query: Replaces expired/existing record on phone_number conflict
    const queryText = `
      INSERT INTO paid_users (user_name, phone_number, amount_paid, mpesa_code, status, start_date, expiry_date, is_paused, remaining_seconds)
      VALUES ($1, $2, $3, $4, 'Active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($5 || ' days')::INTERVAL, false, 0)
      ON CONFLICT (phone_number) 
      DO UPDATE SET 
        user_name = EXCLUDED.user_name,
        mpesa_code = EXCLUDED.mpesa_code,
        amount_paid = EXCLUDED.amount_paid,
        status = 'Active',
        is_paused = false,
        remaining_seconds = 0,
        start_date = CURRENT_TIMESTAMP,
        expiry_date = CURRENT_TIMESTAMP + ($5 || ' days')::INTERVAL
      RETURNING *;
    `;
    await pool.query(queryText, [name, phone, paidAmount, mpesaCode, calculatedDays]);
    return res.json({ success: true, message: `Payment verified! Wi-Fi active for ${calculatedDays} days.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: `Database error: ${err.message}` });
  }
});

// Member Dashboard Management Endpoints
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
      INSERT INTO paid_users (phone_number, user_name, amount_paid, mpesa_code, status, start_date, expiry_date, is_paused, remaining_seconds)
      VALUES ($1, $2, $3, 'MANUAL_REG', 'Active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($4 || ' days')::INTERVAL, false, 0)
      ON CONFLICT (phone_number) DO UPDATE SET
        user_name = EXCLUDED.user_name,
        amount_paid = EXCLUDED.amount_paid,
        mpesa_code = 'MANUAL_REG',
        status = 'Active',
        is_paused = false,
        remaining_seconds = 0,
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

// Blacklist API Routes
app.get('/api/admin/blacklist', requireAuthAPI, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM blacklist ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/blacklist', requireAuthAPI, async (req, res) => {
  try {
    const { phone, reason } = req.body;
    await pool.query(
      'INSERT INTO blacklist (phone_number, reason) VALUES ($1, $2) ON CONFLICT (phone_number) DO NOTHING',
      [phone.trim(), reason || 'Blocked by Admin']
    );
    res.json({ success: true, message: 'Number added to blacklist' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/blacklist/:phone', requireAuthAPI, async (req, res) => {
  try {
    await pool.query('DELETE FROM blacklist WHERE phone_number = $1', [req.params.phone]);
    res.json({ success: true, message: 'Number removed from blacklist' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback Route
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
