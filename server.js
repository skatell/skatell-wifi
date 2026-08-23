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

// Admin Credentials
const ADMIN_USER = 'roggers wifi';
const ADMIN_PASS = '0713081880';

// Auth Middleware
const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Authentication required' });

  const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  if (auth[0] === ADMIN_USER && auth[1] === ADMIN_PASS) {
    next();
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
};

// Public Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Verify Payment Route (Public Portal with Name)
app.post('/api/verify-payment', async (req, res) => {
  try {
    let { name, phone, mpesaCode } = req.body;
    if (!name || !phone || !mpesaCode) {
      return res.status(400).json({ success: false, message: 'Provide name, phone number, and M-Pesa code.' });
    }

    name = String(name).trim();
    phone = String(phone).trim();
    mpesaCode = String(mpesaCode).trim().toUpperCase();

    const checkCode = await pool.query('SELECT * FROM paid_users WHERE mpesa_code = $1', [mpesaCode]);
    if (checkCode.rowCount > 0) return res.status(400).json({ success: false, message: 'M-Pesa code already used.' });

    const queryText = `
      INSERT INTO paid_users (user_name, phone_number, amount_paid, mpesa_code, status, start_date, expiry_date, is_paused)
      VALUES ($1, $2, 200, $3, 'Active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days', false)
      ON CONFLICT (phone_number) 
      DO UPDATE SET 
        user_name = EXCLUDED.user_name,
        mpesa_code = EXCLUDED.mpesa_code,
        amount_paid = EXCLUDED.amount_paid,
        status = 'Active',
        is_paused = false,
        start_date = CURRENT_TIMESTAMP,
        expiry_date = CURRENT_TIMESTAMP + INTERVAL '30 days'
      RETURNING *;
    `;
    await pool.query(queryText, [name, phone, mpesaCode]);
    return res.json({ success: true, message: 'Payment verified! Wi-Fi active for 30 days.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: `Database error: ${err.message}` });
  }
});

// Admin Endpoints

// Fetch All Users (Includes Days Left & Start Date)
app.get('/api/admin/users', requireAuth, async (req, res) => {
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

// Register Member Manually
app.post('/api/admin/register', requireAuth, async (req, res) => {
  try {
    const { phone, name, amount, days } = req.body;
    const daysNum = parseInt(days) || 30;
    const amountNum = parseFloat(amount) || 200;

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

// Pause / Resume User
app.post('/api/admin/toggle-pause', requireAuth, async (req, res) => {
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

// Delete User
app.delete('/api/admin/delete/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM paid_users WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'User deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
