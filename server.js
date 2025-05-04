require('dotenv').config()
const express = require('express')
const app = express()
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const path = require('path')
const html = path.join(__dirname, '/html');
app.use(express.static(html))

const port = process.argv[2] || 8090;
const http = require("http").Server(app);

const maxHttpBufferSizeInMb = parseInt(process.env.MAX_HTTP_BUFFER_SIZE_MB || '1');
const io = require("socket.io")(http, {
  maxHttpBufferSize: maxHttpBufferSizeInMb * 1024 * 1024,
});


const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'require' ? { rejectUnauthorized: false } : false
});

pool.query('SELECT NOW()')
  .then(() => console.log('Database connected successfully'))
  .catch(err => console.error('Database connection error:', err));

pool.query(`CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created decimal default extract(epoch from now()),
  view_history BOOLEAN DEFAULT TRUE NOT NULL
    );`);

pool.query(`CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  sent_at DECIMAL DEFAULT EXTRACT(EPOCH FROM NOW())
    );`);

// batch size when requesting old questions
let batch_size = process.env.BATCH_SIZE ?? 50;

http.listen(port, function(){
	console.log("Starting server on port %s", port);
});

const users = new Set();
io.sockets.on("connection", function(socket){
	console.log("New connection!");

	var nick = null;

	socket.on("login", async function(data){
		// Security checks
		data.nick = data.nick.trim();

		// If is empty
		if(data.nick == ""){
			socket.emit("force-login", "Nick can't be empty.");
			nick = null;
			return;
		}

        try {
          const username = data.nick?.trim() || '';
          const password = data.password?.trim() || '';

          if (!username || !password) {
            return socket.emit("force-login", "Both username and password are required.");
          }

          // Database query
          const userRes = await pool.query(
            'SELECT username, password_hash, view_history FROM users WHERE username = $1',
            [username]
          );

          if (userRes.rows.length === 0) {
            return socket.emit("force-login", "Invalid credentials.");
          }

          const user = userRes.rows[0];
          const validPassword = await bcrypt.compare(password, user.password_hash);

          if (!validPassword) {
            return socket.emit("force-login", "Invalid credentials.");
          }

          nick = username;

          // Successful login logic...
          if (!users.has(username)) {
            users.add(username);

            // Tell everyone, that user joined
            io.to("main").emit("ue", {
                "nick": nick
            });
          }

          console.log(`User ${username} authenticated`);

          console.log("User %s joined.", nick.replace(/(<([^>]+)>)/ig, ""));
          socket.join("main");

          // Tell this user who is already in
          socket.emit("start", {
              "users": Array.from(users)
          });

          if (user.view_history) {
            const result = await pool.query(
              'SELECT username, message, sent_at, id FROM messages ORDER BY id DESC LIMIT $1',
              [batch_size]
            );

            const messageCache = result.rows.map(row => {
              try {
                return {
                  f: row.username,
                  m: JSON.parse(row.message),
                  time: row.sent_at * 1000,
                  id: row.id
                };
              } catch (err) {
                console.error('Failed to parse message:', row.message);
              }
            });

            socket.emit("previous-msg", { msgs: messageCache });
          }

        } catch (err) {
          console.error('Login error:', err);
          socket.emit("force-login", "Server error during authentication.");
        }
	});

	socket.on("send-msg", async function(data){
		// If is logged in
		if(nick == null){
			socket.emit("force-login", "You need to be logged in to send message.");
			return;
		}

        const result = await pool.query(
            'INSERT INTO messages (username, message) VALUES ($1, $2) RETURNING id, sent_at',
            [nick, data.m]
        );

        console.log(result.rows[0].sent_at);

		const msg = {
			"f": nick,
			"m": data.m,
			"id": result.rows[0].id,
            "time": result.rows[0].sent_at * 1000
        };

		// Send everyone message
		io.to("main").emit("new-msg", msg);

		console.log("User %s sent message.", nick.replace(/(<([^>]+)>)/ig, ""));
	});

    // Add this inside the io.sockets.on("connection") handler
    socket.on('load-more-messages', async (data) => {
        try {
            // Validate user is logged in
            if (!nick) {
                return socket.emit("force-login", "You need to be logged in.");
            }

            // Build the query based on whether we have a last message ID
            let query;
            let params;
            
            console.log("Fetching questions before %s for user %s", data.last, nick);
            
            if (data.last) {
                query = `
                    SELECT * FROM messages 
                    WHERE id < $1 
                    ORDER BY id DESC 
                    LIMIT $2
                `;
                params = [data.last, batch_size];
            } else {
                query = `
                    SELECT * FROM messages 
                    ORDER BY id DESC 
                    LIMIT $1
                `;
                params = [batch_size];
            }

            const result = await pool.query(query, params);

            // Format messages with proper IDs and parsed JSON
            const olderMessages = result.rows.map(row => {
                try {
                    return {
                        f: row.username,
                        m: JSON.parse(row.message),
                        time: row.sent_at * 1000,
                        id: row.id
                    };
                } catch (err) {
                    console.error('Error parsing message:', err);
                    return {
                        f: row.username,
                        m: { text: row.message }, // Fallback to raw text
                        time: row.sent_at * 1000,
                        id: row.id
                    };
                }
            });

            socket.emit('older-msgs', { 
                msgs: olderMessages,
                hasMore: olderMessages.length >= batch_size
            });

        } catch (err) {
            console.error('Error loading older messages:', err);
            socket.emit("error", "Failed to load older messages");
        }
    });

	socket.on("typing", function(typing){
		// Only logged in users
		if(nick != null){
			socket.broadcast.to("main").emit("typing", {
				status: typing,
				nick: nick
			});

			console.log("%s %s typing.", nick.replace(/(<([^>]+)>)/ig, ""), typing ? "is" : "is not");
		}
	});

	socket.on("disconnect", function(){
		console.log("Got disconnect!");

		if(nick != null){
			// Remove user from users
            users.delete(nick);

			// Tell everyone user left
			io.to("main").emit("ul", {
				"nick": nick
			});

			console.log("User %s left.", nick.replace(/(<([^>]+)>)/ig, ""));
			socket.leave("main");
			nick = null;
		}
	});
});
