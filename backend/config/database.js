const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'universal_chess',
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 10),
  queueLimit: 0,
  timezone: 'Z',
  decimalNumbers: true
});

pool.on('connection', connection => {
  connection.query("SET time_zone = '+00:00'");
});

module.exports = pool;
