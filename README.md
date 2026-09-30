# phirelease deploy bot

Telegram-triggered `/deploy [YYYYMMDD]` on the offline release laptop, plus a
scheduler that alerts on VPN/internet state changes at :00/:20/:40 every hour.

No inbound port needed — the bot long-polls Telegram, so it works behind a
VPN/NAT with outbound-only access.

## Flow

`/deploy 20260929` (or `/deploy` for today) runs, in the laptop's repo at `REPO_DIR`:

```
git fetch --all
git rev-parse --verify <RELEASE_REMOTE>/release/20260929   # abort if missing
git status --porcelain                                     # abort if dirty
git checkout -B phi-dev <PUSH_REMOTE>/phi-dev               # reset local phi-dev to match remote
git merge --no-edit <RELEASE_REMOTE>/release/20260929
git push <PUSH_REMOTE> phi-dev
dotnet ef database update <EF_ARGS>
```

Local `phi-dev` is reset to `<PUSH_REMOTE>/phi-dev` before merging (not just
left as whatever was checked out), so the merge always starts from the same
base it's about to push back to — otherwise a stale local branch can turn
into a rejected non-fast-forward push, or worse, a push that succeeds against
an old base. A merge conflict aborts the merge, reports the conflicted files,
and stops — nothing is pushed and `dotnet ef` never runs.

Only `TG_CHAT_ID` can trigger it or receives scheduler alerts; every other
chat is silently ignored.

## Setup (both OS)

1. Create a bot with [@BotFather](https://t.me/BotFather), copy its token.
2. Message the bot once, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read your chat id.
3. `cp .env.example .env` and fill in `TG_TOKEN`, `TG_CHAT_ID`, `REPO_DIR`,
   and the remotes/EF args for this machine.
4. `node index.js` (Node 18+; no `npm install` needed, zero dependencies).

Prefer setting `VPN_SUBNET_PREFIX` (the IPv4 prefix your VPN hands out) over
the `VPN_IFACE_PATTERN` fallback — interface names vary a lot on Windows and
macOS always keeps a `utun0`-`utun3` around for iCloud/Continuity, so name
matching alone is unreliable.

### Finding your VPN_SUBNET_PREFIX

Connect the VPN, then run:

```sh
npm run vpn-info
```

This lists every interface/address on the machine (cross-platform, no
`ifconfig` vs `ipconfig` to remember) and, once `.env` exists, also prints
what `isVpnConnected()` currently evaluates to with your settings. Run it
once connected and once disconnected — the address that only shows up
connected is the VPN's.

Then write it into `.env` with:

```sh
npm run vpn-set-prefix                # interactive: pick from detected addresses
npm run vpn-set-prefix -- 10.151.     # direct, if you already know it
```

This creates `.env` from `.env.example` if it doesn't exist yet, and either
way just sets `VPN_SUBNET_PREFIX` — it doesn't touch anything else in the file.

Manual equivalents, if you'd rather not run the scripts:

```sh
# macOS
ifconfig | grep -A1 utun | grep inet

# Windows (PowerShell)
Get-NetIPAddress | Where InterfaceAlias -match 'VPN|PPP|TAP'
```

Use SSH remotes, not `https://user:token@...` URLs — deploy output (including
git's own messages) is echoed to Telegram, and a token embedded in the remote
URL would end up in chat history. (Anything that *does* leak that pattern is
redacted before sending, but don't rely on it.)

## Run at startup

### macOS

```sh
cp service/com.phi.deploybot.plist ~/Library/LaunchAgents/
# edit /absolute/path/to/phirelease and YOUR_USER in that file first —
# launchd's default PATH has neither node nor dotnet on it
launchctl load ~/Library/LaunchAgents/com.phi.deploybot.plist
```

`KeepAlive` restarts it if it crashes; `RunAtLoad` starts it at login.

### Windows

```powershell
schtasks /create /tn "phirelease deploy bot" /tr "node C:\path\to\phirelease\index.js" /sc onlogon /rl highest
```

Runs at logon under your user, inheriting your normal user PATH (so `node`
and `dotnet` just need to already be on it, unlike launchd). `schtasks`
doesn't restart on crash — the bot's own poll loop retries transient
failures, but if the process itself dies you'd need Task Scheduler's "restart
on failure" option (set it via `taskschd.msc` if that matters to you) or a
process supervisor.
