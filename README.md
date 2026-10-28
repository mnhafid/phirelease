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

## Sync phi-dev → ict-dev (optional)

Every `WATCH_INTERVAL_MIN` minutes the laptop checks GitLab (over the VPN) —
no webhook, no server side:

```
git fetch <WATCH_REF> → ff-only pull → git push -f <SYNC_TARGET>
```

`.env` on the laptop:

```
WATCH_REF=origin/phi-dev
SYNC_TARGET=ups/ict-dev
WATCH_INTERVAL_MIN=1
```

- A merged MR is a new commit on `phi-dev`, so it's picked up on the next check.
- Pull is `git merge --ff-only` only: wrong branch checked out, dirty tree,
  or local commits not on the remote → alert once, touch nothing, push nothing.
- The push sends the fetched `refs/remotes/<WATCH_REF>` commit, not local
  `HEAD`, so local-only commits never reach `ict-dev`. It runs `ls-remote`
  first and skips when already in sync; a failed push retries on the next run.
- VPN down → fetch fails (`⚠️ sync: ...`, alerted once) and it catches up on
  the first check after the VPN is back.

## Alerts via relay container → Telegram (laptop can't reach Telegram)

```
Windows bot ──dumbpipe (iroh)──► sanjaya: docker relay (dumbpipe listen-tcp → telegram-relay.js) ──► Telegram
```

With `TG_TOKEN` blank and `NOTIFY_TICKET` set on the laptop, every alert —
VPN down/up, internet down/up, `⬇️ pulled`, `⬆️ force-pushed`, sync errors —
is sent to the relay, which posts it to Telegram. The relay only confirms
delivery after Telegram accepted it; anything undelivered stays queued on the
laptop (last 20) and is retried with the next alert. Everything is also
written to `bot.log`.

Deploy on sanjaya (needs Docker and outbound access to Telegram + GitHub):

```sh
rsync -a relay/ sanjaya:/opt/phi-relay/
ssh sanjaya
cd /opt/phi-relay
printf 'TG_TOKEN=<token>\nTG_CHAT_ID=<chat id>\n' > relay.env
docker compose up -d --build
docker compose logs relay          # ticket -> NOTIFY_TICKET in the laptop's .env
                                   # "using secret key <hex>" -> add IROH_SECRET=<hex> to relay.env,
docker compose up -d               # then recreate so the ticket stays the same across restarts
```

`network_mode: host` lets iroh advertise sanjaya's own addresses so the laptop
can connect directly; if that path is blocked it falls back to iroh's public
relays, which both sides then need to reach.

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

### Windows (no admin needed)

`service/start-windows.ps1` runs the bot in a restart-forever loop, logging
to `bot.log`. Start it at logon from the per-user
Startup folder (Task Scheduler's "highest privileges" needs admin; this doesn't):

```powershell
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("$([Environment]::GetFolderPath('Startup'))\phirelease.lnk")
$s.TargetPath  = 'powershell.exe'
$s.Arguments   = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\path\to\phirelease\service\start-windows.ps1"'
$s.WindowStyle = 7   # minimized
$s.Save()
```

Runs from logon until logoff (a locked screen is fine). To stop:

```powershell
Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'start-windows\.ps1|index\.js' } | % { Stop-Process -Id $_.ProcessId -Force }
```

No admin for the tools either: Node portable `.zip` from nodejs.org,
PortableGit, `dotnet-install.ps1 -InstallDir $env:LOCALAPPDATA\dotnet`, and
the `dumbpipe` release `.exe` — unzip into your user folder and add to the
*user* PATH (`[Environment]::SetEnvironmentVariable('Path', ..., 'User')`).
