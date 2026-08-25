# McBotAI

An AI-powered Minecraft companion bot — controlled entirely from in-game menus, no console, no manual setup.

McBotAI adds a configurable Node.js/Mineflayer bot to your world. Set a host, port, and username from a menu, click one button to install it, click another to launch it — the bot joins your game as a real player-like entity you can chat with and command.

---

## ✨ About

- **Fully in-game setup.** A "McBotAI" button appears on the main menu and the pause menu — no editing config files by hand.
- **Bundled Node.js runtime.** You don't need Node.js installed on your system; the mod ships its own runtime and manages it for you.
- **One-click install.** "Setup Bot" downloads and prepares everything the bot needs, right from the menu.
- **Full lifecycle control.** Launch, stop, and reconfigure the bot at any time without restarting Minecraft.

## 🚀 Setup & Instructions

1. Install McBotAI like any other Forge mod (drop the `.jar` into your `mods` folder).
2. Launch Minecraft and open **McBotAI** from the main menu.
3. Fill in the server **Host**, **Port**, **Bot Username**, and **Master Username(s)** — masters are the players the bot will listen to for commands.
4. Click **Setup Bot** and wait for it to finish preparing the bot files.
5. Click **Save**.
6. In-game, open the pause menu → **McBotAI** → **Launch Bot**.
7. Use **Stop Bot** whenever you want to disconnect it.

## 🔒 Security & Privacy

- The bot **only ever connects to the server IP/port you explicitly enter.** Nothing is hardcoded, nothing is preset, nothing phones home anywhere else.
- **No telemetry, no analytics, no background network activity.** The single connection you configure is the only network activity this mod performs.
- **Master usernames act as a whitelist.** Only players you list can issue commands to the bot — leave this thoughtfully configured, especially on public servers.
- All bot files and the runtime live inside your own instance's config folder — nothing is installed system-wide, and nothing persists outside your Minecraft directory.

## 🤝 Trust & Transparency

- No obfuscation, no packed/minified code — straightforward, readable Forge Java + Node.js source.
- The bundled runtime is an unmodified Node.js build, used solely to run the bot's own bundled script — it exposes no general-purpose code execution to the player.
- Every action (setup, launch, stop) is manually triggered by the user. Nothing runs automatically in the background without you clicking a button.
- Source available for review — see the project repository for the full codebase.

---

*Questions, bugs, or ideas? Open an issue on the [repository](https://github.com/beasty-mods/McBotAI) — feedback is always welcome.*
