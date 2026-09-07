# YC Auto-Apply

Automatically applies to matching jobs on [Y Combinator's Work at a Startup](https://www.workatastartup.com/jobs).
A Playwright runner opens Chrome with your saved session, discovers jobs via Algolia search API, injects the apply
script, and the script:

- discovers jobs matching your **title keywords** and **skills**,
- opens each job's application page,
- fills the **cover letter** (personalized per company/role from your `.env` data),
- answers extra questions from a built-in Q&A bank,
- submits the application, and respects a **50/day cap**.

It starts in **DRY RUN** mode by default — it fills everything but never presses Send —
so you can watch it work before going live.

## Requirements

- Linux or Windows (macOS untested)
- [Node.js](https://nodejs.org/) 18+
- Google Chrome
- A Work at a Startup account with your profile completed

## Setup

**1. Clone and install:**

```bash
git clone https://github.com/yourusername/yc-auto-apply.git
cd yc-auto-apply
npm install
```

**2. Create your `.env`:**

```bash
cp .env.example .env
```

Open `.env` and fill in your details — name, contact, skills, highlights, salary
expectations, links, etc. Every application answer and cover letter is built from
these values; **nothing personal is hard-coded in the scripts**. `.env` is
git-ignored, so your data never gets pushed.

**3. Log in to Work at a Startup (one time, visible browser):**

```bash
node auto-apply-runner.js yc login
```

A Chrome window opens — log in to workatastartup.com, then close the window.
The session is saved to `.yc-chrome-profile/` and reused by every later run.

**4. Dry run (watch it, nothing is submitted):**

```bash
node auto-apply-runner.js yc
```

Chrome opens on the jobs feed, and you'll see forms being filled. The log
shows progress lines.

**5. Go live:**

```bash
node auto-apply-runner.js yc --live
```

Same flow, but applications are actually submitted. Each application is appended to
`applications.csv` and counted toward the daily cap.

## Customizing which jobs it applies to

Edit the `TITLE_KEYWORDS`, `TITLE_BLOCKLIST`, and `QNA` objects at the top of `yc-auto-apply.js`:

| Setting | What it does |
|---|---|
| `TITLE_KEYWORDS` | Apply only when the job title contains one of these (case-insensitive) |
| `TITLE_BLOCKLIST` | Skip when the title contains any of these (senior, manager, etc.) |
| `MAX_APPLICATIONS` | Per-run cap (the runner overrides it with the daily cap remaining) |
| `MIN_DELAY_MS` / `MAX_DELAY_MS` | Wait between applications (default 60–150 s — human pace) |
| `QNA` | Regex patterns mapping application questions to answers |

## Run it automatically every day (Linux — systemd)

```bash
bash setup-scheduler.sh
```

This installs a systemd user timer that runs daily at **18:30 IST** (9:00 AM ET / 3:00 PM CET).

Useful commands:

```bash
systemctl --user status yc-auto-apply.timer    # check timer
systemctl --user start yc-auto-apply.service    # run now
systemctl --user stop yc-auto-apply.timer       # pause
journalctl --user -u yc-auto-apply.service      # view logs
```

## Run it automatically every day (Windows — Task Scheduler)

```powershell
$repo = "C:\path\to\yc-auto-apply"
$action  = New-ScheduledTaskAction -Execute "node.exe" -Argument "`"$repo\auto-apply-runner.js`" yc --live" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 18:30
Register-ScheduledTask -TaskName "YCAutoApply" -Action $action -Trigger $trigger -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `0 job cards found` on every page | The site may have changed its structure. Try running with `--live` manually to debug. |
| Session logged out | Delete `.yc-chrome-profile/` and repeat the `login` step. |
| `no apply button found` | The job page structure may have changed. Check the DOM manually. |
| `captcha / verification` | Pause and wait, then retry. The stealth plugin helps but isn't foolproof. |
| Want today's counter reset | Delete `apply-state-yc.json`. |

## Files

| File | Purpose |
|---|---|
| `auto-apply-runner.js` | Playwright wrapper: opens Chrome, injects the site script, enforces daily cap |
| `yc-auto-apply.js` | The YC apply logic (also pasteable into DevTools console) |
| `config.js` | Tiny no-dependency `.env` loader |
| `.env.example` | Template — copy to `.env` and fill in |
| `applications.csv` | Every submitted application (git-ignored) |
| `apply-state-yc.json` | Today's application count for the 50/day cap (git-ignored) |
| `auto-apply-yc.log` | Run history (git-ignored) |
| `.yc-chrome-profile/` | Saved Chrome session (git-ignored) |

## Disclaimer

Auto-applying may violate Work at a Startup's Terms of Service and can get an
account rate-limited or banned. The delays are deliberately human-like and everything
runs on your own machine with your own account — use at your own risk, and review
the dry run before going live.
