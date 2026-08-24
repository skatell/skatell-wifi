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

// Initialize Tables and System Settings Automatically
async function initDb() {
  try {
    // 1. Paid Users Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS paid_users (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(20) UNIQUE NOT NULL,
        user_name VARCHAR(100) NOT NULL,
        amount_paid NUMERIC(10, 2) DEFAULT 0,
        mpesa_code VARCHAR(50) UNIQUE,
        status VARCHAR(20) DEFAULT 'Pending',
        is_approved INT DEFAULT 0,
        requested_days INT DEFAULT 0,
        start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expiry_date TIMESTAMP,
        is_paused BOOLEAN DEFAULT FALSE,
        remaining_seconds INT DEFAULT 0,
        device_name VARCHAR(100),
        mac_address VARCHAR(50)
      );
    `);

    // 2. Blacklist Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blacklist (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(20) UNIQUE NOT NULL,
        reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. System Settings Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT
      );
    `);
    
    const checkAutoPause = await pool.query("SELECT value FROM system_settings WHERE key = 'isp_auto_paused'");
    if (checkAutoPause.rowCount === 0) {
      await pool.query(`
        INSERT INTO system_settings (key, value)
        VALUES ('isp_auto_paused', 'false');
      `);
    }

    // 4. ISP Settings Table (Tracks days left and last update time for automatic decrement)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS isp_settings (
        id INT PRIMARY KEY DEFAULT 1,
        days_left INT DEFAULT 30,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      INSERT INTO isp_settings (id, days_left, last_updated)
      VALUES (1, 30, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log("DB Initialization Complete!");
  } catch (err) {
    console.error("DB Initialization Error:", err.message);
  }
}
initDb();

// Helper function strictly mapping your custom offers: 200 = 30d, 100 = 10d, 50 = 2d
function calculatePackageDays(amount) {
  const paid = parseFloat(amount) || 0;
  if (paid === 200) return 30;
  if (paid === 100) return 10;
  if (paid === 50) return 2;
  return 1;
}

// Admin Credentials
let ADMIN_USER = process.env.ADMIN_USER || 'roggers';
let ADMIN_PASS = process.env.ADMIN_PASS || '8422';
const activeSessions = new Set();

// Guard Middleware
const requireAuthAPI = (req, res, next) => {
  const token = req.headers['x-admin-token'] || req.headers['authorization'];
  if (token && activeSessions.has(token)) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Unauthorized session' });
};

// --- ISP System Endpoints (With Automatic Calendar Day Decrement) ---

app.get('/api/isp-status', async (req, res) => {
  try {
    // Automatically reduce days_left based on elapsed calendar days since last checked/updated
    await pool.query(`
      UPDATE isp_settings 
      SET days_left = GREATEST(0, days_left - (CURRENT_DATE - last_updated::date)),
          last_updated = CURRENT_TIMESTAMP
      WHERE id = 1 AND CURRENT_DATE > last_updated::date;
    `);

    const result = await pool.query("SELECT days_left FROM isp_settings WHERE id = 1");
    if (result.rowCount === 0) {
      return res.json({ days_left: 0, is_active: false });
    }
    const daysLeft = result.rows[0].days_left;
    res.json({ days_left: daysLeft, is_active: daysLeft > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/update-isp-days', requireAuthAPI, async (req, res) => {
  try {
    const { days } = req.body;
    const parsedDays = parseInt(days, 10);

    if (isNaN(parsedDays) || parsedDays < 0 || parsedDays > 30) {
      return res.status(400).json({ success: false, error: 'Days must be an integer between 0 and 30.' });
    }

    const autoPauseRes = await pool.query("SELECT value FROM system_settings WHERE key = 'isp_auto_paused'");
    const isAutoPaused = autoPauseRes.rowCount > 0 && autoPauseRes.rows[0].value === 'true';

    await pool.query(`UPDATE isp_settings SET days_left = $1, last_updated = CURRENT_TIMESTAMP WHERE id = 1;`, [parsedDays]);

    if (parsedDays === 0) {
      await pool.query(`
        UPDATE paid_users 
        SET is_paused = true, 
            remaining_seconds = GREATEST(0, EXTRACT(EPOCH FROM (expiry_date - CURRENT_TIMESTAMP))::INT),
            status = 'Paused'
        WHERE is_approved = 1 AND is_paused = false AND expiry_date > CURRENT_TIMESTAMP;
      `);
      await pool.query(`INSERT INTO system_settings (key, value) VALUES ('isp_auto_paused', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true';`);
    } else if (parsedDays > 0 && isAutoPaused) {
      await pool.query(`
        UPDATE paid_users 
        SET is_paused = false, 
            expiry_date = CURRENT_TIMESTAMP + (remaining_seconds * INTERVAL '1 second'),
            remaining_seconds = 0,
            status = 'Active'
        WHERE is_approved = 1 AND is_paused = true AND remaining_seconds > 0;
      `);
      await pool.query(`INSERT INTO system_settings (key, value) VALUES ('isp_auto_paused', 'false') ON CONFLICT (key) DO UPDATE SET value = 'false';`);
    }

    res.json({ success: true, message: `Main link set to ${parsedDays} Days!`, days_left: parsedDays });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/refill-isp', requireAuthAPI, async (req, res) => {
  try {
    const autoPauseRes = await pool.query("SELECT value FROM system_settings WHERE key = 'isp_auto_paused'");
    const isAutoPaused = autoPauseRes.rowCount > 0 && autoPauseRes.rows[0].value === 'true';

    await pool.query(`UPDATE isp_settings SET days_left = 30, last_updated = CURRENT_TIMESTAMP WHERE id = 1;`);

    if (isAutoPaused) {
      await pool.query(`
        UPDATE paid_users 
        SET is_paused = false, 
            expiry_date = CURRENT_TIMESTAMP + (remaining_seconds * INTERVAL '1 second'),
            remaining_seconds = 0,
            status = 'Active'
        WHERE is_approved = 1 AND is_paused = true AND remaining_seconds > 0;
      `);
      await pool.query(`INSERT INTO system_settings (key, value) VALUES ('isp_auto_paused', 'false') ON CONFLICT (key) DO UPDATE SET value = 'false';`);
    }

    res.json({ success: true, message: 'Main 5G Router Subscription refilled for 30 Days!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Page Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/pay', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin-login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/user', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user.html')));

app.get('/api/user-count', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) AS count FROM paid_users');
    res.json({ count: parseInt(result.rows[0].count, 10) || 0 });
  } catch (err) {
    res.status(500).json({ count: 0 });
  }
});

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

app.post('/api/admin/change-credentials', requireAuthAPI, (req, res) => {
  const { newUsername, newPassword } = req.body;
  if (!newUsername || !newPassword) {
    return res.status(400).json({ success: false, message: 'Both fields required' });
  }
  ADMIN_USER = newUsername.trim();
  ADMIN_PASS = newPassword.trim();
  return res.json({ success: true, message: 'Credentials updated successfully!' });
});

app.post('/api/user/login', async (req, res) => {
  try {
    let { name, phone } = req.body;
    name = String(name || '').trim();
    phone = String(phone || '').trim();

    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'Please enter both your name and phone number.' });
    }

    const queryText = `
      SELECT id, phone_number, user_name, mpesa_code, amount_paid, device_name, mac_address, 
      TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS payment_date,
      TO_CHAR(expiry_date, 'YYYY-MM-DD HH24:MI') AS end_date,
      is_paused, remaining_seconds, is_approved,
      CASE 
        WHEN is_approved = 0 OR is_approved IS NULL THEN 'Pending'
        WHEN is_paused THEN 'Paused'
        WHEN CURRENT_TIMESTAMP > expiry_date THEN 'Expired'
        ELSE 'Active'
      END AS status,
      CASE 
        WHEN is_approved = 0 OR is_approved IS NULL THEN 0
        WHEN is_paused THEN CEIL(remaining_seconds / 86400.0)
        ELSE GREATEST(0, (expiry_date::date - CURRENT_DATE))
      END AS days_left
      FROM paid_users 
      WHERE phone_number = $1 AND LOWER(user_name) = LOWER($2);
    `;
    const result = await pool.query(queryText, [phone, name]);

    if (result.rowCount === 0) {
      return res.status(401).json({ success: false, message: 'Account not found. Ensure details match.' });
    }

    return res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
});

app.post('/api/verify-payment', async (req, res) => {
  try {
    const ispRes = await pool.query("SELECT days_left FROM isp_settings WHERE id = 1");
    if (ispRes.rowCount > 0 && ispRes.rows[0].days_left <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Main 5G Network Link is currently expired. Payment portal is temporarily closed.' 
      });
    }

    let { name, phone, amount, deviceName, macAddress } = req.body;
    if (!name || !phone || !amount || !deviceName || !macAddress) {
      return res.status(400).json({ success: false, message: 'Provide name, phone number, package, device name, and MAC address.' });
    }

    name = String(name).trim();
    phone = String(phone).trim();
    deviceName = String(deviceName).trim();
    macAddress = String(macAddress).trim().toUpperCase();
    const paidAmount = parseFloat(amount) || 0;

    const checkBlacklist = await pool.query('SELECT * FROM blacklist WHERE phone_number = $1', [phone]);
    if (checkBlacklist.rowCount > 0) {
      return res.status(403).json({ success: false, message: 'Your phone number is blocked from payments.' });
    }

    if (paidAmount <= 0) return res.status(400).json({ success: false, message: 'Please select a valid package.' });

    const calculatedDays = calculatePackageDays(paidAmount);

    let mpesaCode = 'AUTO_' + Math.random().toString(36).substring(2, 8).toUpperCase();
    let codeExists = true;
    while (codeExists) {
      const checkCode = await pool.query('SELECT * FROM paid_users WHERE mpesa_code = $1', [mpesaCode]);
      if (checkCode.rowCount === 0) {
        codeExists = false;
      } else {
        mpesaCode = 'AUTO_' + Math.random().toString(36).substring(2, 8).toUpperCase();
      }
    }

    const queryText = `
      INSERT INTO paid_users (
        user_name, phone_number, amount_paid, mpesa_code, status, is_approved, 
        requested_days, start_date, expiry_date, is_paused, remaining_seconds, device_name, mac_address
      )
      VALUES ($1, $2, $3, $4, 'Pending', 0, $5, CURRENT_TIMESTAMP, NULL, false, 0, $6, $7)
      ON CONFLICT (phone_number) 
      DO UPDATE SET 
        user_name = EXCLUDED.user_name,
        mpesa_code = EXCLUDED.mpesa_code,
        amount_paid = EXCLUDED.amount_paid,
        requested_days = EXCLUDED.requested_days,
        device_name = EXCLUDED.device_name,
        mac_address = EXCLUDED.mac_address,
        status = 'Pending',
        is_approved = 0,
        is_paused = false,
        remaining_seconds = 0,
        start_date = CURRENT_TIMESTAMP,
        expiry_date = NULL
      RETURNING *;
    `;
    await pool.query(queryText, [name, phone, paidAmount, mpesaCode, calculatedDays, deviceName, macAddress]);
    return res.json({ success: true, message: `Submission received! Your generated code is ${mpesaCode}. Status is Pending until Admin approval.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: `Database error: ${err.message}` });
  }
});

app.get('/api/admin/users', requireAuthAPI, async (req, res) => {
  try {
    const queryText = `
      SELECT id, phone_number, user_name, mpesa_code, amount_paid, device_name, mac_address, requested_days,
      TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS payment_date,
      TO_CHAR(expiry_date, 'YYYY-MM-DD HH24:MI') AS end_date,
      is_paused, remaining_seconds, is_approved,
      CASE 
        WHEN is_approved = 0 OR is_approved IS NULL THEN 'Pending'
        WHEN is_paused THEN 'Paused'
        WHEN CURRENT_TIMESTAMP > expiry_date THEN 'Expired'
        ELSE 'Active'
      END AS status,
      CASE 
        WHEN is_approved = 0 OR is_approved IS NULL THEN 0
        WHEN is_paused THEN CEIL(remaining_seconds / 86400.0)
        ELSE GREATEST(0, (expiry_date::date - CURRENT_DATE))
      END AS days_left
      FROM paid_users 
      WHERE is_approved = 1
      ORDER BY id DESC;
    `;
    const result = await pool.query(queryText);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/pending-approvals', requireAuthAPI, async (req, res) => {
  try {
    const queryText = `
      SELECT id, phone_number, user_name, mpesa_code, amount_paid, device_name, mac_address, requested_days, status, is_approved,
      TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS payment_date
      FROM paid_users 
      WHERE is_approved = 0 OR is_approved IS NULL OR status = 'Pending' 
      ORDER BY id DESC;
    `;
    const result = await pool.query(queryText);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/approve-user', requireAuthAPI, async (req, res) => {
  try {
    const { id } = req.body;
    const userRes = await pool.query('SELECT requested_days, amount_paid FROM paid_users WHERE id = $1', [id]);
    if (userRes.rowCount === 0) return res.status(404).json({ success: false, message: 'User not found' });

    const days = (userRes.rows[0].requested_days && parseInt(userRes.rows[0].requested_days, 10) > 0)
      ? parseInt(userRes.rows[0].requested_days, 10)
      : calculatePackageDays(userRes.rows[0].amount_paid);

    const updateQuery = `
      UPDATE paid_users 
      SET is_approved = 1,
          status = 'Active',
          requested_days = $1,
          expiry_date = CURRENT_TIMESTAMP + make_interval(days => $1::int)
      WHERE id = $2;
    `;
    await pool.query(updateQuery, [days, id]);
    res.json({ success: true, message: 'Member approved! Subscription countdown started.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/update-user', requireAuthAPI, async (req, res) => {
  try {
    const { id, user_name, phone_number, mpesa_code, amount_paid, requested_days, device_name, mac_address, status, is_approved } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'User ID is required.' });

    const userId = parseInt(id, 10);
    const paidAmount = parseFloat(amount_paid) || 0;
    const parsedDays = parseInt(requested_days, 10);
    const calculatedDays = (!isNaN(parsedDays) && parsedDays > 0) ? parsedDays : calculatePackageDays(paidAmount);
    const approvedFlag = (is_approved !== undefined && is_approved !== null) ? parseInt(is_approved, 10) : 1;
    const userStatus = status || 'Active';

    const queryText = `
      UPDATE paid_users 
      SET user_name = $1, phone_number = $2, mpesa_code = $3, amount_paid = $4, requested_days = $5,
          device_name = $6, mac_address = $7, status = $8, is_approved = $9,
          expiry_date = COALESCE(start_date, CURRENT_TIMESTAMP) + make_interval(days => $5::int)
      WHERE id = $10
      RETURNING *;
    `;

    const result = await pool.query(queryText, [
      user_name ? user_name.trim() : '',
      phone_number ? phone_number.trim() : '',
      mpesa_code ? mpesa_code.trim().toUpperCase() : '',
      paidAmount, calculatedDays,
      device_name ? device_name.trim() : '',
      mac_address ? mac_address.trim().toUpperCase() : '',
      userStatus, approvedFlag, userId
    ]);

    if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'Member ID not found in database.' });
    return res.json({ success: true, message: 'All member details updated successfully!', user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'Phone number or M-Pesa code already exists.' });
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/register', requireAuthAPI, async (req, res) => {
  try {
    const { phone, name, amount, days, device_name, mac_address } = req.body;
    if (!phone || !name) return res.status(400).json({ success: false, message: 'Name and phone number are required.' });

    const amountNum = parseFloat(amount) || 0;
    const inputDays = parseInt(days, 10);
    const daysNum = (!isNaN(inputDays) && inputDays > 0) ? inputDays : calculatePackageDays(amountNum);
    const mpesaCode = 'MANUAL_' + Math.random().toString(36).substring(2, 8).toUpperCase();

    const queryText = `
      INSERT INTO paid_users (
        phone_number, user_name, amount_paid, mpesa_code, status, is_approved, 
        requested_days, start_date, expiry_date, is_paused, remaining_seconds, device_name, mac_address
      )
      VALUES (
        $1, $2, $3, $4, 'Active', 1, 
        $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + make_interval(days => $5::int), false, 0, $6, $7
      )
      ON CONFLICT (phone_number) DO UPDATE SET
        user_name = EXCLUDED.user_name,
        amount_paid = EXCLUDED.amount_paid,
        mpesa_code = EXCLUDED.mpesa_code,
        device_name = EXCLUDED.device_name,
        mac_address = EXCLUDED.mac_address,
        status = 'Active',
        is_approved = 1,
        requested_days = EXCLUDED.requested_days,
        is_paused = false,
        remaining_seconds = 0,
        start_date = CURRENT_TIMESTAMP,
        expiry_date = CURRENT_TIMESTAMP + make_interval(days => EXCLUDED.requested_days::int);
    `;

    await pool.query(queryText, [
      phone.trim(), name.trim(), amountNum, mpesaCode, daysNum, 
      device_name ? device_name.trim() : 'Manual Device', 
      mac_address ? mac_address.trim().toUpperCase() : '00:00:00:00:00:00'
    ]);

    res.json({ success: true, message: `User registered and activated successfully with ${daysNum} days!` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/toggle-pause', requireAuthAPI, async (req, res) => {
  try {
    const { id } = req.body;
    const userRes = await pool.query('SELECT * FROM paid_users WHERE id = $1', [id]);
    if (userRes.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    const user = userRes.rows[0];

    if (!user.is_paused) {
      await pool.query(`
        UPDATE paid_users 
        SET is_paused = true, 
            remaining_seconds = GREATEST(0, EXTRACT(EPOCH FROM (expiry_date - CURRENT_TIMESTAMP))::INT)
        WHERE id = $1;
      `, [id]);
      res.json({ success: true, message: 'User paused.' });
    } else {
      await pool.query(`
        UPDATE paid_users 
        SET is_paused = false, 
            expiry_date = CURRENT_TIMESTAMP + (remaining_seconds * INTERVAL '1 second'),
            remaining_seconds = 0
        WHERE id = $1;
      `, [id]);
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

app.get('/api/admin/blacklist', requireAuthAPI, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM blacklist ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/blacklist', requireAuthAPI, async (req, res) => {
  try {
    const { phone, reason } = req.body;
    await pool.query('INSERT INTO blacklist (phone_number, reason) VALUES ($1, $2) ON CONFLICT (phone_number) DO NOTHING', [phone.trim(), reason || 'Blocked by Admin']);
    res.json({ success: true, message: 'Number added to blacklist' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/blacklist/:phone', requireAuthAPI, async (req, res) => {
  try {
    await pool.query('DELETE FROM blacklist WHERE phone_number = $1', [req.params.phone]);
    res.json({ success: true, message: 'Number removed from blacklist' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
