# Testing PRism (desktop preview builds)

PRism's desktop builds are **unsigned** preview binaries for hands-on testing. Your OS
will warn you the first time you run them — that's expected for an unsigned app, not a
sign anything is wrong. Steps below get you past it.

There is **no auto-update**. To update, download the latest build and reinstall.

## Windows

1. Download `PRism <version>.exe` (portable) from the release.
2. Double-click. Windows SmartScreen shows "Windows protected your PC."
3. Click **More info** → **Run anyway**.
4. PRism opens. Paste your GitHub PAT to begin.

If your machine is managed by your employer (Intune/MDM) and "Run anyway" is missing or
blocked, your IT policy is blocking unsigned apps — ask the maintainer for the browser-tab
build instead.

## macOS (Apple Silicon)

> Intel (x86) Macs are **not supported** in this preview build — it's an Apple Silicon (arm64) binary only. On an Intel Mac, ask the maintainer for the browser-tab build instead.

1. Download `PRism-<version>-arm64.dmg`, open it, drag PRism to Applications.
2. First launch: macOS says *"Apple could not verify 'PRism' is free of malware."*
   - **macOS Sonoma (14) or earlier:** Control-click the app → **Open** → **Open**.
   - **macOS Sequoia (15) or later:** **System Settings → Privacy & Security →** scroll to the
     PRism prompt → **Open Anyway** → authenticate.
3. If you instead see *"PRism is damaged and can't be opened"*, clear the quarantine flag in
   Terminal, then reopen:
   ```
   xattr -dr com.apple.quarantine /Applications/PRism.app
   ```
4. PRism opens. Paste your GitHub PAT to begin.

## Where is my data?

PRism stores state and logs in your OS application-data folder — the **same location the
browser-tab build uses**, so your PAT and drafts carry across both:

- **Windows:** `%LOCALAPPDATA%\PRism` (e.g. `C:\Users\<you>\AppData\Local\PRism`)
- **macOS / Linux:** `~/.local/share/PRism`

Logs are in the `logs/` subfolder. The exact path is also shown inside the app under
**Settings → Connection → Copy logs path**. To recover a lost draft, see the
identity-change events in the logs.
