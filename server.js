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

// Verify Payment Route
app.post('/api/verify-payment', async (req, res) => {
  try {
    let { phone, mpesaCode } = req.body;

    if (!phone || !mpesaCode) {
      return res.status(400).json({ success: false, message: 'Please provide both phone number and M-Pesa code.' });
    }

    phone = String(phone).trim();
    mpesaCode = String(mpesaCode).trim().toUpperCase();

    const queryText = `
      INSERT INTO paid_users (phone_number, amount_paid, mpesa_code, status, start_date, expiry_date)
      VALUES ($1, 200, $2, 'Active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days')
      ON CONFLICT (mpesa_code) DO NOTHING
      RETURNING *;
    `;

    const result = await pool.query(queryText, [phone, mpesaCode]);

    if (result.rowCount === 0) {
      return res.status(400).json({ success: false, message: 'This M-Pesa code has already been submitted or used.' });
    }

    return res.json({ success: true, message: 'Payment verified! Your Wi-Fi access is active for 30 days.' });
  } catch (err) {
    console.error('Database error:', err.message);
    return res.status(500).json({ success: false, message: `Database error: ${err.message}` });
  }
});

// Get paid users endpoint
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM paid_users ORDER BY start_date DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
