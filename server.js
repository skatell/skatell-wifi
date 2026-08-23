const express = require('express');
const { Pool } = require('pg');
const path = require('path');

// Initialize express app FIRST
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Database connection setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin Dashboard Route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Verify Payment / Renewal Route
app.post('/api/verify-payment', async (req, res) => {
  try {
    let { phone, mpesaCode } = req.body;

    if (!phone || !mpesaCode) {
      return res.status(400).json({ success: false, message: 'Please provide both phone number and M-Pesa code.' });
    }

    phone = String(phone).trim();
    mpesaCode = String(mpesaCode).trim().toUpperCase();

    // 1. Check if this exact M-Pesa code was already used
    const checkCode = await pool.query('SELECT * FROM paid_users WHERE mpesa_code = $1', [mpesaCode]);
    if (checkCode.rowCount > 0) {
      return res.status(400).json({ success: false, message: 'This M-Pesa code has already been used.' });
    }

    // 2. Insert new payment or update/renew existing phone number
    const queryText = `
      INSERT INTO paid_users (phone_number, amount_paid, mpesa_code, status, start_date, expiry_date)
      VALUES ($1, 200, $2, 'Active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days')
      ON CONFLICT (phone_number) 
      DO UPDATE SET 
        mpesa_code = EXCLUDED.mpesa_code,
        amount_paid = EXCLUDED.amount_paid,
        status = 'Active',
        start_date = CURRENT_TIMESTAMP,
        expiry_date = CURRENT_TIMESTAMP + INTERVAL '30 days'
      RETURNING *;
    `;

    await pool.query(queryText, [phone, mpesaCode]);

    return res.json({ success: true, message: 'Payment verified! Your Wi-Fi access is active for 30 days.' });
  } catch (err) {
    console.error('Database error:', err.message);
    return res.status(500).json({ success: false, message: `Database error: ${err.message}` });
  }
});

// Get users with real-time Expiration check
app.get('/api/users', async (req, res) => {
  try {
    const queryText = `
      SELECT 
        id, 
        phone_number, 
        mpesa_code, 
        amount_paid, 
        start_date, 
        expiry_date,
        CASE 
          WHEN CURRENT_TIMESTAMP > expiry_date THEN 'Expired'
          ELSE 'Active'
        END AS status
      FROM paid_users 
      ORDER BY start_date DESC;
    `;
    const result = await pool.query(queryText);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
