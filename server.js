// Submit M-Pesa Code for Verification
app.post('/api/verify-payment', async (req, res) => {
  try {
    let { phone, mpesaCode } = req.body;

    if (!phone || !mpesaCode) {
      return res.status(400).json({ success: false, message: 'Please provide both phone number and M-Pesa code.' });
    }

    phone = String(phone).trim();
    mpesaCode = String(mpesaCode).trim().toUpperCase();

    // Query with explicit parameters matching the table schema
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
    // Log exact error to Render log console for debugging
    console.error('Database insertion error:', err.message);
    return res.status(500).json({ success: false, message: `Database error: ${err.message}` });
  }
});
