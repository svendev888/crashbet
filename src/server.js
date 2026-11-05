const path = require('path');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const config = require('./config');
const { createLive } = require('./live');
const { createRoutes } = require('./routes');

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log('MongoDB connected:', config.mongoUri.replace(/\/\/[^@]*@/, '//***@'));

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const live = createLive(io);

  app.use(express.json({ limit: '5mb' }));
  app.use(createRoutes(live, config.ingestKey));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  io.on('connection', (socket) => socket.emit('live', live.snapshot()));

  server.listen(config.port, () => console.log(`Dashboard: http://localhost:${config.port}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
