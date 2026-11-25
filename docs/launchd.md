# Auto-start with launchd (macOS)

The daemon runs in the foreground; for auto-start, install a launchd agent. A template also ships at `extras/com.baton.daemon.plist`.

1. Find the installed binary: `command -v baton`
2. Copy the template to `~/Library/LaunchAgents/com.baton.daemon.plist` and replace the placeholders — `{{PATH_TO_BATON}}` with the binary path from step 1, `{{HOME}}` with your home directory.
3. Load and start it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.baton.daemon.plist
```

Stop and unload:

```sh
launchctl bootout gui/$(id -u)/com.baton.daemon
```

Template (`RunAtLoad` starts it at login; `KeepAlive` restarts it after a crash):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.baton.daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>{{PATH_TO_BATON}}</string>
        <string>daemon</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ProcessType</key>
    <string>Background</string>

    <key>StandardOutPath</key>
    <string>{{HOME}}/Library/Logs/baton.log</string>
    <key>StandardErrorPath</key>
    <string>{{HOME}}/Library/Logs/baton.log</string>
</dict>
</plist>
```

Other platforms: run `baton daemon` under your service manager of choice (systemd user unit, Windows service wrapper). The daemon is foreground-only by design; anything that supervises a foreground process works.
