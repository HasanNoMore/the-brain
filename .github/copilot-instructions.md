
# Copilot AI Agent Instructions for Brain Bot Versol

## Project Overview
This project appears to be a bot or automation system, likely for trading or messaging, with integration to Bybit, Telegram, and Discord. Environment variables are managed in `.env`.

## Essential Knowledge for AI Agents

- **Environment Variables:**
	- All sensitive API keys and tokens are stored in `.env`. Never hardcode secrets. Example keys: `BYBIT_API_KEY`, `TELEGRAM_BOT_TOKEN`, `DISCORD_WEBHOOK_URL`.
	- Use `BRAINBOT_DRY_RUN` and `BRAINBOT_TESTNET` to control runtime/testnet behavior.

- **Extensions & Tools:**
	- The project recommends the `anthropic.claude-code` VS Code extension (see `.vscode/extensions.json`).
	- Terminal and debugging settings are customized in `.vscode/settings.json`.

- **Development Workflow:**
	- **Scaffolding:** Start by clarifying requirements and scaffolding the project structure.
	- **Customization:** Adapt the scaffold to project needs before installing dependencies.
	- **Extensions:** Install all recommended VS Code extensions before coding.
	- **Build/Run:** Compile and run the project using tasks or scripts (details may need to be added as the codebase grows).
	- **Documentation:** Ensure all steps and customizations are documented as you go.

- **Best Practices:**
	- Work through each checklist item in order.
	- Keep communication concise and focused.
	- Follow development best practices relevant to the language/framework in use (to be specified as the codebase grows).

## Patterns & Conventions

- Store all configuration and secrets in `.env`.
- Use `.vscode/` for editor and extension settings.
- Place all project-specific instructions in `.github/copilot-instructions.md`.

## Next Steps for AI Agents

1. If the codebase is empty, begin by scaffolding the main application structure.
2. Always check `.env` for required runtime variables before running or deploying.
3. Update this file as new conventions or workflows are established.

---
**If any section is unclear or incomplete, please provide feedback for further iteration.**
