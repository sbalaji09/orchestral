const http = require('http');

const PORT = process.env.PORT || 8080;
const NAME = process.env.DEMO_AGENT_NAME || 'hello-web';

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`${NAME}: ok\n`);
}).listen(PORT, () => {
  console.log(`${NAME} listening on :${PORT}`);
});
