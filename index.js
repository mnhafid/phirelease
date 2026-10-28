import { config } from './src/config.js';
import { makeBot } from './src/telegram.js';
import { sendViaDumbpipe } from './src/notify.js';
import { deploy, pullIfBehind, forcePushTo, DeployError } from './src/git-deploy.js';
import { isVpnConnected, isInternetConnected } from './src/net-check.js';
import { scheduleEvery20 } from './src/scheduler.js';

// No Telegram token = alerts go to the log, and over dumbpipe to the
// Telegram relay container if NOTIFY_TICKET is set; /deploy is unavailable. A failed dumbpipe send returns false so the
// alert outbox below retries it later.
const bot = config.tgToken
  ? makeBot(config.tgToken)
  : {
      async sendMessage(_chatId, text) {
        console.log(`[${new Date().toISOString()}] ${text}`);
        return config.notifyTicket ? sendViaDumbpipe(config.dumbpipe, config.notifyTicket, text) : true;
      },
      pollUpdates() {},
    };

// If a remote URL has a token embedded (https://user:TOKEN@host/...), git can
// echo it back on stdout/stderr — scrub before it ever reaches chat history.
function redact(text) {
  return text.replace(/:\/\/[^\s/@]+:[^\s/@]+@/g, '://***:***@');
}

let deployInFlight = false;

async function handleMessage(message) {
  const chatId = String(message.chat.id);
  if (chatId !== config.tgChatId) return; // silently ignore anyone not whitelisted

  const text = (message.text || '').trim();
  const match = text.match(/^\/deploy(?:\s+(\d{8}))?$/);
  if (!match) return;

  if (deployInFlight) {
    await bot.sendMessage(chatId, '⏳ a deploy or auto-pull is running, try again in a moment');
    return;
  }

  deployInFlight = true;
  try {
    const dateArg = match[1];
    await bot.sendMessage(chatId, `🚀 deploying release/${dateArg ?? '(today)'}...`);
    const log = await deploy({
      repoDir: config.repoDir,
      releaseRemote: config.releaseRemote,
      pushRemote: config.pushRemote,
      efArgs: config.efArgs,
      dateArg,
    });
    await bot.sendMessage(chatId, redact(clip(`✅ deploy done\n\n${log}`)));
  } catch (err) {
    const detail = err instanceof DeployError ? `${err.message}\n\n${err.log.join('\n')}` : String(err);
    await bot.sendMessage(chatId, redact(clip(`❌ deploy failed\n\n${detail}`)));
  } finally {
    deployInFlight = false;
  }
}

// Telegram messages cap around 4096 chars. On failure the *end* of the log is
// the useful part (the actual error), so truncate the middle, not the tail.
function clip(text, max = 4000) {
  return text.length > max ? `…(truncated)…\n${text.slice(-(max - 20))}` : text;
}

// Alerts go through a small outbox: sendMessage never throws (see
// telegram.js) but can still fail (that's the internet being down, which is
// exactly what we're trying to report). Queue on failure, flush on the next
// successful send, so a "down" alert isn't just lost.
const pendingAlerts = [];
async function alert(text) {
  pendingAlerts.push(text);
  if (pendingAlerts.length > 20) pendingAlerts.shift(); // ponytail: drop oldest rather than grow unbounded across a multi-day outage
  while (pendingAlerts.length) {
    const ok = await bot.sendMessage(config.tgChatId, pendingAlerts[0]);
    if (!ok) break;
    pendingAlerts.shift();
  }
}

let lastVpnOk = null;
let lastNetOk = null;

async function checkConnectivity() {
  const vpnOk = isVpnConnected({ subnetPrefix: config.vpnSubnetPrefix, ifacePattern: config.vpnIfacePattern });
  const netOk = await isInternetConnected(config.internetCheckUrl);
  const stamp = new Date().toTimeString().slice(0, 5);
  const firstRun = lastVpnOk === null;
  // State is updated *before* sending, alert only on transitions (not every
  // 20-min tick) — so a failed send (network's still down) doesn't leave the
  // transition permanently undetected on the next successful tick.
  const vpnChanged = !firstRun && vpnOk !== lastVpnOk;
  const netChanged = !firstRun && netOk !== lastNetOk;
  lastVpnOk = vpnOk;
  lastNetOk = netOk;

  if (firstRun) {
    await alert(`🟢 deploy bot started — VPN ${vpnOk ? 'up' : 'down'}, internet ${netOk ? 'up' : 'down'} (${stamp})`);
    return;
  }
  if (vpnChanged) await alert(vpnOk ? `✅ VPN back up (${stamp})` : `⚠️ VPN down (${stamp})`);
  if (netChanged) await alert(netOk ? `✅ internet back up (${stamp})` : `⚠️ internet down (${stamp})`);
}

// Sync: every WATCH_INTERVAL_MIN, fetch + fast-forward WATCH_REF, then
// force-push it to SYNC_TARGET. Shares the deploy lock (a skipped tick just
// catches up on the next one). Errors alert once per distinct message.
let lastSyncError = null;
async function sync() {
  if (deployInFlight) return;
  deployInFlight = true;
  try {
    const commits = await pullIfBehind({ repoDir: config.repoDir, watchRef: config.watchRef });
    if (commits) await alert(redact(clip(`⬇️ pulled ${config.watchRef}\n\n${commits}`)));
    if (config.syncTarget && (await forcePushTo({ repoDir: config.repoDir, watchRef: config.watchRef, target: config.syncTarget }))) {
      await alert(`⬆️ force-pushed ${config.watchRef} → ${config.syncTarget}`);
    }
    lastSyncError = null;
  } catch (err) {
    const msg = err instanceof DeployError ? err.message : String(err);
    if (msg !== lastSyncError) await alert(redact(clip(`⚠️ sync: ${msg}`)));
    lastSyncError = msg;
  } finally {
    deployInFlight = false;
  }
}

if (config.watchRef) setInterval(sync, config.watchIntervalMin * 60_000);

scheduleEvery20(checkConnectivity);
bot.pollUpdates(handleMessage);
console.log('phirelease deploy bot running');
