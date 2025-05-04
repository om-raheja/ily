require('dotenv').config();

const bcrypt = require('bcrypt')
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'require' ? { rejectUnauthorized: false } : false
});

// Test connection on startup
pool.query('SELECT NOW()')
  .then(() => console.log('Database connected successfully'))
  .catch(err => console.error('Database connection error:', err));

async function initUsers() {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  view_history BOOLEAN DEFAULT TRUE NOT NULL
    );`);
}

async function createUser(username, password) {
  await initUsers();
  const hash = await bcrypt.hash(password, 10)
  await pool.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
    [username, hash]
  )
  console.log(`User ${username} created`)
}

const [,, username, password] = process.argv;
if (!username || !password) {
  console.log('Usage: node create-user.js <username> <password>');
  process.exit(1);
}

createUser(username, password)
  .catch(console.error)
  .finally(() => pool.end());
