// Plain long-polling client. No bot-framework dependency needed for one
// command and one alert channel.
export function makeBot(token) {
  const api = `https://api.telegram.org/bot${token}`;

  // Never throws — a failed send (e.g. internet is the thing that's down)
  // must not crash the caller or wedge a lock held across it. Returns
  // whether it actually went out, so callers can queue/retry if they need to.
  async function sendMessage(chatId, text) {
    try {
      const res = await fetch(`${api}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.error('telegram sendMessage failed:', res.status, await res.text());
        return false;
      }
      return true;
    } catch (err) {
      console.error('telegram sendMessage error:', err.message);
      return false;
    }
  }

  async function pollUpdates(onMessage) {
    let offset = 0;
    for (;;) {
      try {
        const res = await fetch(`${api}/getUpdates?timeout=50&offset=${offset}`, {
          signal: AbortSignal.timeout(60_000), // must exceed the 50s long-poll timeout above
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.description || `telegram API error (${res.status})`);
        for (const update of data.result ?? []) {
          offset = update.update_id + 1;
          // Fire-and-forget: don't block polling on a slow/long deploy, so the
          // deployInFlight lock in index.js actually gets a chance to reject a
          // second /deploy instead of Telegram just queuing it up.
          if (update.message) Promise.resolve(onMessage(update.message)).catch((err) => console.error('onMessage error:', err));
        }
      } catch (err) {
        console.error('telegram poll error:', err.message);
        await new Promise((r) => setTimeout(r, 5000)); // ponytail: fixed backoff, add exponential if this ever gets rate-limited
      }
    }
  }

  return { sendMessage, pollUpdates };
}
