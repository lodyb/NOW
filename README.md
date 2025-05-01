# NOW Discord Bot

A Discord bot for collecting media, providing playback tools, and creating interactive quiz games.

## Features

- Media playback with custom filters and clipping
- Interactive media quizzes in voice channels
- Web-based media upload interface with drag-and-drop
- SQLite database for media management

## Prerequisites

- Node.js 16+ and npm
- FFmpeg installed on your system
- Discord bot token (see [Discord Developer Portal](https://discord.com/developers/applications))

## Quick Setup

1. **Install dependencies**

```bash
npm install
```

2. **Configure environment variables**

Create a `.env` file in the root directory:

```bash
# Required: Your Discord bot token
DISCORD_TOKEN=your_discord_bot_token_here

# Optional: Web server port (defaults to 3000)
PORT=3000

# Optional: Environment (development or production)
NODE_ENV=development
```

3. **Build the project**

```bash
npm run build
```

4. **Start the application**

```bash
# Development mode with auto-restart
npm run dev

# Production mode
npm start

# Production with PM2 (recommended for servers)
npm run pm2:start
```

## Running Components

The application has two main components that run together:

1. **Discord Bot** - Handles Discord commands and interactions
2. **Web Server** - Provides the media management interface

When you start the application, both components run automatically. You can access:

- Web interface: http://localhost:3000 (or your configured PORT)
- Discord bot: Invite the bot to your server and use commands

## Discord Commands

- `NOW play [search term]` - Play media matching the search term
- `NOW play [search term] {filter=value}` - Apply FFmpeg filters (e.g., `{amplify=2,reverse=1}`)
- `NOW clip=5s start=10s [search term]` - Play a clip with specific timing
- `NOW quiz` - Start a quiz game in your voice channel
- `NOW stop` - Stop an active quiz
- `NOW upload` - Get a link to upload new media

## Web Interface

The web interface allows you to:

1. **Upload media** - Drag and drop files to the top section
2. **Manage existing media** - View, edit answers, delete/restore
3. **Search your collection** - Use the search bar to find specific media

## Project Structure

- `src/` - TypeScript source code
  - `index.ts` - Main entry point
  - `bot/` - Discord bot command handlers
  - `database/` - SQLite database operations
  - `media/` - Media processing with FFmpeg
  - `web/` - Express API and Vue SPA

## Troubleshooting

- **FFmpeg not found**: Ensure FFmpeg is installed and in your PATH
- **Discord connection issues**: Verify your token in `.env` is correct
- **Media upload failures**: Check file permissions in uploads/ and processed/