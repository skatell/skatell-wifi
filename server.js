const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcrypt'); // Added for securing tenant admin passwords

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
        start_date TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi'),
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
        created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')
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
        last_updated TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')
      );
    `);

    // Safety check to automatically add 'last_updated' if it's missing from an older table version
    await pool.query(`
      ALTER TABLE isp_settings ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi');
    `);

    await pool.query(`
      INSERT INTO isp_settings (id, days_left, last_updated)
      VALUES (1, 30, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi'))
      ON CONFLICT (id) DO NOTHING;
    `);

    // 5. Wifi Tenants Table (For the Multi-Tenant System Generator)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wifi_tenants (
        id SERIAL PRIMARY KEY,
        business_name VARCHAR(255) NOT NULL,
        subdomain_or_slug VARCHAR(100) UNIQUE NOT NULL,
        admin_username VARCHAR(100) NOT NULL,
        admin_password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')
      );
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
const activeTenantSessions = new Set();

// Guard Middleware
const requireAuthAPI = (req, res, next) => {
  const token = req.headers['x-admin-token'] || req.headers['authorization'];
  if (token && (activeSessions.has(token) || activeTenantSessions.has(token))) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Unauthorized session' });
};

// --- MULTI-TENANT SYSTEM GENERATOR ENDPOINTS ---
app.post('/api/superadmin/create-tenant', requireAuthAPI, async (req, res) => {
  try {
    const { business_name, slug, admin_username, admin_password } = req.body;
    
    if (!business_name || !slug || !admin_username || !admin_password) {
      return res.status(400).json({ success: false, error: 'All fields are required.' });
    }

    const cleanSlug = slug.trim().toLowerCase();

    // Hash the password for safety
    const hashedPassword = await bcrypt.hash(admin_password.trim(), 10);
    
    // Save tenant details to the database
    await pool.query(
      'INSERT INTO wifi_tenants (business_name, subdomain_or_slug, admin_username, admin_password) VALUES ($1, $2, $3, $4)',
      [business_name.trim(), cleanSlug, admin_username.trim(), hashedPassword]
    );

    // Generate their unique link dynamically
    const uniqueLink = `${req.protocol}://${req.get('host')}/portal/${cleanSlug}`;

    res.json({ 
      success: true, 
      message: 'New Wi-Fi system generated successfully!', 
      link: uniqueLink 
    });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ success: false, error: 'This URL slug is already taken. Choose another.' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Tenant Login Endpoint
app.post('/api/tenant/login', async (req, res) => {
  try {
    let { slug, username, password } = req.body;
    slug = String(slug || '').trim().toLowerCase();
    username = String(username || '').trim();
    password = String(password || '').trim();

    if (!slug || !username || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    const tenantRes = await pool.query('SELECT * FROM wifi_tenants WHERE subdomain_or_slug = $1', [slug]);
    if (tenantRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Tenant portal not found.' });
    }

    const tenant = tenantRes.rows[0];
    if (tenant.admin_username !== username) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    const passwordMatch = await bcrypt.compare(password, tenant.admin_password);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    const token = 'tenant_tok_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    activeTenantSessions.add(token);

    res.json({ success: true, token, business_name: tenant.business_name });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- ISP System Endpoints (With EAT Local Timezone Support) ---

app.get('/api/isp-status', async (req, res) => {
  try {
    await pool.query(`
      UPDATE isp_settings 
      SET days_left = GREATEST(0, days_left - ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')::date - (last_updated AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')::date)),
          last_updated = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')
      WHERE id = 1 AND (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')::date > (last_updated AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')::date;
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

    await pool.query(`UPDATE isp_settings SET days_left = $1, last_updated = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') WHERE id = 1;`, [parsedDays]);

    if (parsedDays === 0) {
      await pool.query(`
        UPDATE paid_users 
        SET is_paused = true, 
            remaining_seconds = GREATEST(0, EXTRACT(EPOCH FROM (expiry_date - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')))::INT),
            status = 'Paused'
        WHERE is_approved = 1 AND is_paused = false AND expiry_date > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi');
      `);
      await pool.query(`INSERT INTO system_settings (key, value) VALUES ('isp_auto_paused', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true';`);
    } else if (parsedDays > 0 && isAutoPaused) {
      await pool.query(`
        UPDATE paid_users 
        SET is_paused = false, 
            expiry_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') + (remaining_seconds * INTERVAL '1 second'),
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

    await pool.query(`UPDATE isp_settings SET days_left = 30, last_updated = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') WHERE id = 1;`);

    if (isAutoPaused) {
      await pool.query(`
        UPDATE paid_users 
        SET is_paused = false, 
            expiry_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') + (remaining_seconds * INTERVAL '1 second'),
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

// --- RENEWAL CHECK ENDPOINT ---
app.post('/api/user/check-renewal', async (req, res) => {
  try {
    let { phone } = req.body;
    phone = String(phone || '').trim();

    if (!phone) {
      return res.status(400).json({ success: false, message: 'Please enter your phone number.' });
    }

    const queryText = `
      SELECT id, phone_number, user_name, device_name, mac_address, 
      CASE 
        WHEN is_approved = 0 OR is_approved IS NULL THEN 'Pending'
        WHEN is_paused THEN 'Paused'
        WHEN expiry_date IS NULL OR (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') >= expiry_date OR (expiry_date::date - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')::date) <= 0 THEN 'Expired'
        ELSE 'Active'
      END AS status
      FROM paid_users 
      WHERE phone_number = $1;
    `;
    const result = await pool.query(queryText, [phone]);

    if (result.rowCount === 0) {
      return res.json({ 
        success: false, 
        isRegistered: false, 
        message: 'Phone number not found in system. Please go back and use the Payment Page.' 
      });
    }

    const user = result.rows[0];

    if (user.status !== 'Expired') {
      return res.json({ 
        success: true, 
        isRegistered: true, 
        isExpired: false, 
        message: `Your account status is currently "${user.status}". You only need to renew when your account is expired.` 
      });
    }

    return res.json({ 
      success: true, 
      isRegistered: true, 
      isExpired: true, 
      userName: user.user_name,
      phone: user.phone_number,
      deviceName: user.device_name,
      macAddress: user.mac_address,
      message: 'Account is expired. Proceed to renewal plans.' 
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
});

// --- AUTOMATIC RENEWAL EXECUTION ENDPOINT ---
app.post('/api/user/renew', async (req, res) => {
  try {
    let { phone, days } = req.body;
    phone = String(phone || '').trim();
    const renewalDays = parseInt(days, 10);

    if (!phone || isNaN(renewalDays) || renewalDays <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid phone number or renewal package selection.' });
    }

    const checkUser = await pool.query(`
      SELECT id, expiry_date, 
      CASE 
        WHEN is_approved = 0 OR is_approved IS NULL THEN 'Pending'
        WHEN is_paused THEN 'Paused'
        WHEN expiry_date IS NULL OR (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') >= expiry_date OR (expiry_date::date - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')::date) <= 0 THEN 'Expired'
        ELSE 'Active'
      END AS status
      FROM paid_users WHERE phone_number = $1
    `, [phone]);

    if (checkUser.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'User not found in system.' });
    }

    const user = checkUser.rows[0];
    if (user.status !== 'Expired') {
      return res.status(400).json({ success: false, message: 'Account is not expired yet. Renewal is only allowed for expired accounts.' });
    }

    const updateQuery = `
      UPDATE paid_users 
      SET is_approved = 1,
          status = 'Active',
          requested_days = $1,
          start_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi'),
          expiry_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') + ($1 || ' days')::INTERVAL,
          is_paused = false,
          remaining_seconds = 0
      WHERE phone_number = $2
      RETURNING *, 
        TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS payment_date,
        TO_CHAR(expiry_date, 'YYYY-MM-DD HH24:MI') AS end_date;
    `;

    const result = await pool.query(updateQuery, [renewalDays, phone]);

    return res.json({ 
      success: true, 
      message: `Renewal successful! Your account has been automatically extended for ${renewalDays} days.`,
      user: result.rows[0]
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: `Server error during renewal: ${err.message}` });
  }
});

// Page Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/pay', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin-login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/user', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user.html')));
app.get('/portal/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
        WHEN expiry_date IS NULL OR (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') >= expiry_date OR (expiry_date::date - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')::date) <= 0 THEN 'Expired'
        ELSE 'Active'
      END AS status,
      CASE 
        WHEN is_approved = 0 OR is_approved IS NULL THEN 0
        WHEN is_paused THEN FLOOR(remaining_seconds / 86400.0)
        WHEN expiry_date IS NULL OR (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') >= expiry_date THEN 0
        ELSE GREATEST(0, (expiry_date::date - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')::date))
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

    const existingUser = await pool.query('SELECT phone_number FROM paid_users WHERE phone_number = $1', [phone]);
    if (existingUser.rowCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'This phone number is already registered in the system! Please use the Renewal Page instead of the Payment Page.' 
      });
    }

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
      VALUES ($1, $2, $3, $4, 'Pending', 0, $5, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi'), NULL, false, 0, $6, $7)
      RETURNING *, 
        TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS payment_date;
    `;
    const newRecord = await pool.query(queryText, [name, phone, paidAmount, mpesaCode, calculatedDays, deviceName, macAddress]);
    return res.json({ success: true, message: `Submission received! Your generated code is ${mpesaCode}. Status is Pending until Admin approval.`, user: newRecord.rows[0] });
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
        WHEN expiry_date IS NULL OR (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') >= expiry_date OR (expiry_date::date - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')::date) <= 0 THEN 'Expired'
        ELSE 'Active'
      END AS status,
      CASE 
        WHEN is_approved = 0 OR is_approved IS NULL THEN 0
        WHEN is_paused THEN FLOOR(remaining_seconds / 86400.0)
        WHEN expiry_date IS NULL OR (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') >= expiry_date THEN 0
        ELSE GREATEST(0, (expiry_date::date - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')::date))
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
          start_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi'),
          expiry_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') + ($1 || ' days')::INTERVAL
      WHERE id = $2
      RETURNING *,
        TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS payment_date,
        TO_CHAR(expiry_date, 'YYYY-MM-DD HH24:MI') AS end_date;
    `;
    const updatedUser = await pool.query(updateQuery, [days, id]);
    res.json({ success: true, message: 'Member approved! Subscription countdown started.', user: updatedUser.rows[0] });
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
    const approvedFlag = (is_approved !== undefined && is_approved !== null) ? parseInt(is_approved, 10) : 1;
    
    let userStatus = status || 'Active';
    let queryText = '';
    let queryParams = [];

    if (!isNaN(parsedDays) && parsedDays <= 0) {
      userStatus = 'Expired';
      queryText = `
        UPDATE paid_users 
        SET user_name = $1, phone_number = $2, mpesa_code = $3, amount_paid = $4, requested_days = 0,
            device_name = $5, mac_address = $6, status = $7, is_approved = $8,
            expiry_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') - INTERVAL '1 day'
        WHERE id = $9
        RETURNING *,
          TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS payment_date,
          TO_CHAR(expiry_date, 'YYYY-MM-DD HH24:MI') AS end_date;
      `;
      queryParams = [
        user_name ? user_name.trim() : '',
        phone_number ? phone_number.trim() : '',
        mpesa_code ? mpesa_code.trim().toUpperCase() : '',
        paidAmount,
        device_name ? device_name.trim() : '',
        mac_address ? mac_address.trim().toUpperCase() : '',
        userStatus, approvedFlag, userId
      ];
    } else {
      const calculatedDays = (!isNaN(parsedDays) && parsedDays > 0) ? parsedDays : calculatePackageDays(paidAmount);
      queryText = `
        UPDATE paid_users 
        SET user_name = $1, phone_number = $2, mpesa_code = $3, amount_paid = $4, requested_days = $5,
            device_name = $6, mac_address = $7, status = $8, is_approved = $9,
            start_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi'),
            expiry_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') + ($5 || ' days')::INTERVAL
        WHERE id = $10
        RETURNING *,
          TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS payment_date,
          TO_CHAR(expiry_date, 'YYYY-MM-DD HH24:MI') AS end_date;
      `;
      queryParams = [
        user_name ? user_name.trim() : '',
        phone_number ? phone_number.trim() : '',
        mpesa_code ? mpesa_code.trim().toUpperCase() : '',
        paidAmount, calculatedDays,
        device_name ? device_name.trim() : '',
        mac_address ? mac_address.trim().toUpperCase() : '',
        userStatus, approvedFlag, userId
      ];
    }

    const result = await pool.query(queryText, queryParams);

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
        $5, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi'), (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') + ($5 || ' days')::INTERVAL, false, 0, $6, $7
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
        start_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi'),
        expiry_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') + (EXCLUDED.requested_days || ' days')::INTERVAL
      RETURNING *,
        TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS payment_date,
        TO_CHAR(expiry_date, 'YYYY-MM-DD HH24:MI') AS end_date;
    `;

    const result = await pool.query(queryText, [
      phone.trim(), name.trim(), amountNum, mpesaCode, daysNum, 
      device_name ? device_name.trim() : 'Manual Device', 
      mac_address ? mac_address.trim().toUpperCase() : '00:00:00:00:00:00'
    ]);

    res.json({ success: true, message: `User registered and activated successfully with ${daysNum} days!`, user: result.rows[0] });
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

    let updatedUser;
    if (!user.is_paused) {
      const q = await pool.query(`
        UPDATE paid_users 
        SET is_paused = true, 
            remaining_seconds = GREATEST(0, EXTRACT(EPOCH FROM (expiry_date - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi')))::INT),
            status = 'Paused'
        WHERE id = $1
        RETURNING *, TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS payment_date, TO_CHAR(expiry_date, 'YYYY-MM-DD HH24:MI') AS end_date;
      `, [id]);
      updatedUser = q.rows[0];
      res.json({ success: true, message: 'User paused.', user: updatedUser });
    } else {
      const q = await pool.query(`
        UPDATE paid_users 
        SET is_paused = false, 
            expiry_date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Nairobi') + (remaining_seconds * INTERVAL '1 second'),
            remaining_seconds = 0,
            status = 'Active'
        WHERE id = $1
        RETURNING *, TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS payment_date, TO_CHAR(expiry_date, 'YYYY-MM-DD HH24:MI') AS end_date;
      `, [id]);
      updatedUser = q.rows[0];
      res.json({ success: true, message: 'User resumed.', user: updatedUser });
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
