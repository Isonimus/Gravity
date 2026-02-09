# Gravity

> 🛡️ Antigravity Quota Guard - Protect yourself from cooldown penalties

A lightweight VS Code/Antigravity extension that monitors your AI model quota usage and warns you before you hit the cooldown threshold.

![Gravity Icon](assets/icon.png)

## Features

### 🛡️ Quota Protection
- **Warning Alerts** - Get notified when any model's quota drops below the warning threshold (default: 10%)
- **Block Alerts** - Strong warning modal when quota reaches critical levels (default: 2%)
- **Configurable Thresholds** - Set your own warning and blocking thresholds

### 📊 Real-Time Monitoring
- **Status Bar Integration** - Always visible quota status with color-coded backgrounds
- **Multi-Model Tracking** - Monitor all available AI models simultaneously
- **Reset Time Display** - Know exactly when your quota will refresh

### 🎯 Smart Indicators
Status bar colors indicate quota health:
- **Default** - All models healthy (>warning threshold)
- **Yellow** - One or more models in warning zone
- **Red** - Critical quota level or exhausted

### 🔧 Flexible Configuration
- Pin specific models to the status bar
- Toggle protection on/off
- Adjust polling interval
- Customize all thresholds

## Installation

### From Source
```bash
# Clone the repository
git clone https://github.com/isonimus/Gravity.git
cd Gravity

# Install dependencies
npm install

# Compile
npm run compile

# Package as VSIX
npm run package
```

### Install VSIX
1. Open VS Code/Antigravity
2. Go to Extensions → ... → Install from VSIX...
3. Select the generated `.vsix` file
4. Restart the IDE

## Configuration

Access settings via `Ctrl+,` (or `Cmd+,` on macOS) and search for "Gravity":

| Setting | Default | Description |
|---------|---------|-------------|
| `gravity.enabled` | `true` | Enable Gravity monitoring |
| `gravity.warningThreshold` | `10` | Warn when quota falls below this % |
| `gravity.blockThreshold` | `2` | Show blocking modal below this % |
| `gravity.pollingInterval` | `120` | Seconds between quota checks |
| `gravity.guardEnabled` | `true` | Enable protection (warnings/blocks) |
| `gravity.pinnedModels` | `[]` | Model IDs to show in status bar |

## Commands

Open Command Palette (`Ctrl+Shift+P`) and type:

| Command | Description |
|---------|-------------|
| `Gravity: Refresh Quota` | Manually refresh quota data |
| `Gravity: Show Quota Status` | Open the quota menu |
| `Gravity: Toggle Protection` | Enable/disable warnings |
| `Gravity: Show Debug Logs` | Open the debug output panel |
| `Gravity: Reconnect` | Reconnect to Antigravity process |

## How It Works

1. **Process Detection** - Gravity automatically finds Antigravity's language server process and extracts connection parameters
2. **API Polling** - Periodically calls the `GetUserStatus` API to fetch quota data
3. **State Analysis** - Analyzes quota levels and determines alert status
4. **UI Updates** - Updates status bar and shows warnings when needed

## Why "Gravity"?

It's a pun on **Anti**gravity - this extension keeps you grounded by preventing you from flying too high and hitting the quota ceiling! 🚀⬇️

## Development

```bash
# Watch mode for development
npm run watch

# Lint
npm run lint
```

## Credits

Inspired by [AntigravityQuota](https://github.com/Henrik-3/AntigravityQuota) by Henrik Mertens.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Disclaimer

This project is not endorsed by Google and does not reflect the views or opinions of Google or anyone officially involved in producing or managing Antigravity.
