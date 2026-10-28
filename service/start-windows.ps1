# Runs the bot forever, restarting it if it dies. Needs no admin: launch it
# from a shortcut in the user Startup folder (see README). Log: bot.log.
Set-Location (Split-Path $PSScriptRoot)

while ($true) { node index.js *>> bot.log; Start-Sleep 5 }
