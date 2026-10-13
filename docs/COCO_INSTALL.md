# Install with Cortex Code

[Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli) (CoCo) is Snowflake's AI
coding agent. This repository ships a project skill, `install-rbac-explorer`, that teaches Cortex Code how to
install, verify, upgrade and remove the app. You answer a few questions and approve the account-level step;
Cortex Code runs the scripts and checks the result.

The manual steps it follows are in [INSTALL.md](INSTALL.md), so you can review exactly what will run.

## 1. Install the Cortex Code CLI

Requirements: a Snowflake account (not a standard trial account) where your role has the
`SNOWFLAKE.CORTEX_USER` database role, and the
[Snowflake CLI](https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation).
See the [prerequisites](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli#prerequisites).

macOS, Linux or WSL:

```bash
curl -LsS https://ai.snowflake.com/static/cc-scripts/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://ai.snowflake.com/static/cc-scripts/install.ps1 | iex
```

The installer puts the `cortex` command on your `PATH`. Open a new terminal if `cortex` isn't found.
If you prefer an IDE, [Cortex Code Desktop](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-desktop)
reads the same skills.

## 2. Connect to Snowflake

Run `cortex` once. The setup wizard lets you pick a connection from `~/.snowflake/connections.toml` (shared
with the Snowflake CLI) or create a new one. Use a connection whose user can switch to `ACCOUNTADMIN`, or have an
administrator run the account setup step for you.

## 3. Clone this repository and start Cortex Code in it

```bash
git clone https://github.com/sfc-gh-vshiv/snowflake-rbac-explorer.git
cd snowflake-rbac-explorer
cortex
```

Starting `cortex` inside the clone loads the project skill from `.cortex/skills/install-rbac-explorer/`.
Check it is available with `/skill list`.

## 4. Ask it to install the app

```
$install-rbac-explorer Install Role Explorer in my account.
```

Cortex Code will:

1. Check your Snowflake CLI version and connection.
2. Ask for the admin user, warehouse and alert email (and suggest defaults).
3. Show what `setup/setup.sql` will create and wait for your approval, then run it as `ACCOUNTADMIN`.
4. Run `setup/alerts.sql` and `deploy/deploy.sh`.
5. Verify the app exists, the watcher task is started and a dry-run check succeeds, then tell you how to open it.

Cortex Code asks permission before running commands, unless you have relaxed its permission settings.

### Other things you can ask

```
$install-rbac-explorer Add Slack alerts to the #security-alerts channel.
$install-rbac-explorer Install the demo scenario so I can see an alert fire.
$install-rbac-explorer Use the Snowflake artifact repository instead of PyPI egress.
$install-rbac-explorer Upgrade Role Explorer to the latest version.
$install-rbac-explorer The app shows an error on start-up. Help me fix it.
$install-rbac-explorer Uninstall Role Explorer.
```

For Slack, create the incoming webhook in Slack first and paste only when Cortex Code asks; it passes the value
straight to `setup/slack.sql`, which stores it in a Snowflake secret.

## Without the skill

The skill is optional. You can also point Cortex Code at the guide directly:

```
Follow docs/INSTALL.md to install this app into my Snowflake account. Ask me for any values you need and
confirm before running anything as ACCOUNTADMIN.
```

## Learn more

- [Cortex Code CLI](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli)
- [Skills, subagents, hooks and MCP](https://docs.snowflake.com/en/user-guide/cortex-code/extensibility)
