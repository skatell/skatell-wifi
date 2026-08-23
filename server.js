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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Submit M-Pesa Code for Verification
app.post('/api/verify-payment', async (req, res) => {
  try {
    let { phone, mpesaCode } = req.body;
    mpesaCode = mpesaCode.trim().toUpperCase();

    if (!phone || !mpesaCode) {
      return res.status(400).json({ success: false, message: 'Please provide phone and transaction code.' });
    }

    // Save transaction to Supabase database
    const queryText = `
      INSERT INTO paid_users (phone_number, amount_paid, mpesa_code, status, start_date, expiry_date)
      VALUES ($1, 200, $2, 'Active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days')
      ON CONFLICT (mpesa_code) DO NOTHING
      RETURNING *;
    `;
    
    const result = await pool.query(queryText, [phone, mpesaCode]);

    if (result.rowCount === 0) {
      return res.status(400).json({ success: false, message: 'This M-Pesa code has already been submitted.' });
    }

    res.json({ success: true, message: 'Payment verified! Your Wi-Fi access is active for 30 days.' });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ success: false, message: 'Server error saving payment.' });
  }
});

// Get active paid users
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM paid_users ORDER BY start_date DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
