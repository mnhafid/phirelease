// Runs in the relay container next to `dumbpipe listen-tcp --host
// 127.0.0.1:7879` (see relay/Dockerfile): each alert the Windows bot sends over dumbpipe is
// forwarded to Telegram. The connection is closed cleanly only after Telegram
// accepted the message, so the bot's `dumbpipe connect` exits 0; otherwise
// it's reset and the bot keeps the alert queued for a retry.
import { createServer } from 'node:net';

const { TG_TOKEN, TG_CHAT_ID, PORT = '7879', TG_API = 'https://api.telegram.org' } = process.env;
if (!TG_TOKEN || !TG_CHAT_ID) throw new Error('TG_TOKEN and TG_CHAT_ID are required');
const MAX = 64 * 1024;

async function sendToTelegram(text) {
  try {
    const res = await fetch(`${TG_API}/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: text.slice(-4000) }), // Telegram caps ~4096
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error('telegram sendMessage failed:', res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error('telegram sendMessage error:', err.message, err.cause ?? '');
    return false;
  }
}

// allowHalfOpen: the sender half-closes after writing; we must keep our side
// open until Telegram answers, since closing it is the delivery ack.
createServer({ allowHalfOpen: true }, (sock) => {
  let text = '';
  sock.setEncoding('utf8');
  sock.setTimeout(30_000, () => sock.destroy());
  sock.on('error', () => {});
  sock.on('data', (chunk) => {
    text += chunk;
    if (text.length > MAX) sock.destroy();
  });
  sock.on('end', async () => {
    text = text.trim();
    const ok = !text || (await sendToTelegram(text));
    console.log(`[${new Date().toISOString()}] ${ok ? 'sent' : 'FAILED'}: ${text.split('\n')[0]}`);
    if (ok) sock.end();
    else sock.resetAndDestroy(); // RST, not FIN — a plain destroy() would look like a clean ack
  });
}).listen(Number(PORT), '127.0.0.1', () => console.log(`telegram relay on 127.0.0.1:${PORT}`));
