import * as net from 'net';

const PORT = 8080;
const HOST = '127.0.0.1';
const MESSAGE = 'Hello from client!';

const client = new net.Socket();

client.connect(PORT, HOST, () => {
  console.log(`Connected to server at ${HOST}:${PORT}`);
  client.write(MESSAGE);
});

client.on('data', (data) => {
  console.log(`Received from server: ${data.toString().trim()}`);
  client.destroy();
});

client.on('close', () => {
  console.log('Connection closed');
});

client.on('error', (err) => {
  console.error(`Connection error: ${err.message}`);
});
