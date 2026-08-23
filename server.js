const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Connect to Supabase PostgreSQL Database via Render Environment Variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Home Route
app.get('/', (req, res) => {
  res.send('KPLC & Wi-Fi Payment System is Running!');
});

// M-Pesa Callback Webhook Endpoint
app.post('/api/mpesa-callback', async (req, res) => {
  try {
    const callbackData = req.body.Body.stkCallback;

    if (callbackData.ResultCode === 0) {
      const meta = callbackData.CallbackMetadata.Item;
      const mpesaCode = meta.find(item => item.Name === 'MpesaReceiptNumber').Value;
      const amount = meta.find(item => item.Name === 'Amount').Value;
      const phone = meta.find(item => item.Name === 'PhoneNumber').Value;

      // Auto-insert or update user in Supabase paid_users table
      const queryText = `
        INSERT INTO paid_users (phone_number, amount_paid, mpesa_code, status, start_date, expiry_date)
        VALUES ($1, $2, $3, 'Active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days')
        ON CONFLICT (mpesa_code) DO NOTHING;
      `;
      await pool.query(queryText, [phone, amount, mpesaCode]);

      console.log(`Payment logged: ${phone} paid ${amount}`);
    }
  } catch (error) {
    console.error('Error processing payment:', error);
  }

  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
