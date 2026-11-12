// Preloaded into the Treasury app helper (`node --import`): its HTTPS requests to the app's host go to the loopback
// app server instead, with the Host header the server binds to. `HELPER_LOSE=after-send` sends the request and then
// loses the answer (the app acted, the reply never arrived); `HELPER_LOSE=malformed` answers something unreadable.
import { appendFileSync } from 'node:fs';
import { request } from 'node:http';

const port = Number(process.env.HELPER_APP_PORT), lose = process.env.HELPER_LOSE ?? '';
globalThis.fetch = (input, init = {}) => new Promise((done, fail) => {
  const url = new URL(input);
  if (process.env.HELPER_REQUESTS) appendFileSync(process.env.HELPER_REQUESTS, `${url.pathname}\n`);
  if (url.protocol !== 'https:' || url.host !== 'treasury-app.test') return fail(new Error(`Unexpected request to ${url.origin}`));
  const req = request({ host: '127.0.0.1', port, path: url.pathname + url.search, method: init.method,
    headers: { ...Object.fromEntries(new Headers(init.headers)), host: url.host } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk)).on('end', () => {
      if (lose === 'after-send') return fail(new TypeError('fetch failed'));
      done(new Response(lose === 'malformed' ? '<html>' : Buffer.concat(chunks), { status: res.statusCode }));
    });
  });
  req.on('error', fail); req.end(init.body);
});
