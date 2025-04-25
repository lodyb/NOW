# NOW Discord Bot

NOW is a powerful Discord bot for collecting, playing, and managing media files (video and audio) with interactive quiz functionality.

## Features

- **Media Playback**: Play audio and video files directly in Discord
- **Media Augmentation**: Apply effects like amplification, reversal, and clipping
- **Quiz Game**: Host interactive quiz games in voice channels based on your media
- **Media Management**: Upload, organize, and manage your media collection via web interface

## Architecture

- **Framework**: discord.js with TypeScript
- **Runtime**: Node.js with PM2 for process management and auto-restart
- **Database**: PostgreSQL with TypeORM for storing media metadata
- **Media Processing**: FFmpeg for audio/video manipulation
- **Web Interface**: Express.js for the upload portal

## Setup

### Prerequisites

- Node.js (v16.x or higher)
- PostgreSQL database
- FFmpeg installed on your system
- Discord Bot Token

### Installation

1. Clone this repository:
   ```
   git clone https://github.com/lodyb/now.git
   cd now
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a `.env` file with the following variables:
   ```
   # Discord Configuration
   DISCORD_TOKEN=your_discord_bot_token
   
   # Database Configuration
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=now
   DB_USER=postgres
   DB_PASSWORD=your_password
   
   # Web Server Configuration
   WEB_PORT=3000
   UPLOAD_DIR=./uploads
   NORMALIZED_DIR=./normalized
   UPLOAD_SECRET=your_secure_string_here
   
   # Bot Configuration
   MAX_FILE_SIZE=9
   ```

4. Create the PostgreSQL database:
   ```
   createdb now
   ```

5. Build the TypeScript project:
   ```
   npm run build
   ```

6. Start the bot:
   ```
   npm start
   ```
   
   Or with PM2:
   ```
   npm run start:pm2
   ```

## Command Usage

NOW uses the prefix `NOW` for all commands.

### Media Playback

- **Play media**:
  ```
  NOW play star wars theme
  ```

- **Play with effects**:
  ```
  NOW play imperial march {amplify=2,reverse=1}
  ```

- **Play a clip**:
  ```
  NOW clip=4s indiana jones theme
  ```

- **Play a clip from specific position**:
  ```
  NOW clip=4s start=3s jurassic park theme
  ```

### Quiz Game

- **Start a quiz**:
  ```
  NOW quiz
  ```

- **Start a quiz with effects**:
  ```
  NOW quiz {reverse=1}
  ```

- **Start a quiz with clip options**:
  ```
  NOW quiz clip=4s start=2s
  ```

- **Stop a quiz**:
  ```
  NOW stop
  ```

### Media Management

- **Get upload link**:
  ```
  NOW upload
  ```

## Media Processing

NOW processes media files to ensure compatibility with Discord's limitations:

- Files are normalized to consistent volume levels
- Video files are re-encoded to H264 for compatibility
- Audio files are converted to Opus codec
- Files exceeding Discord's size limit (8MB) are compressed with progressive quality reduction
- Multiple encoding passes with adaptive settings ensure optimal quality within size constraints
- Original files are preserved, with processed versions used for playback

## Project Structure

```
now/
├── src/                    # Source code
│   ├── commands/           # Bot commands implementation
│   │   ├── clip.ts         # Clip command handler
│   │   ├── index.ts        # Command processor
│   │   ├── play.ts         # Play command handler
│   │   ├── quiz.ts         # Quiz command handler
│   │   └── upload.ts       # Upload command handler
│   ├── database/           # Database models and connection
│   │   ├── connection.ts   # TypeORM configuration
│   │   └── entities/       # TypeORM entity definitions
│   ├── services/           # Business logic
│   │   ├── media/          # Media processing services
│   │   │   ├── clipper.ts  # File clipping functionality
│   │   │   ├── normalizer.ts # Media normalization
│   │   │   └── processor.ts # Media effect processing
│   │   └── web/            # Web server for uploads
│   │       └── server.ts   # Express server implementation
│   ├── utils/              # Utility functions
│   │   ├── init.ts         # Initialization utilities
│   │   └── logger.ts       # Logging functionality
│   └── index.ts            # Main entry point
├── uploads/                # Original uploaded files
├── normalized/             # Processed media files
│   └── clips/              # Generated clips directory
├── web/                    # Web interface static files
│   ├── index.html          # Landing page
│   └── upload.html         # Media upload interface
├── tests/                  # Jest test files
├── tsconfig.json           # TypeScript configuration
├── jest.config.js          # Jest configuration
├── package.json            # NPM dependencies
└── README.md               # This file
```

## Database Schema

The application uses TypeORM with the following entity structure:

- **Media**: Stores metadata about media files
- **MediaAnswer**: Alternative titles/answers for each media item
- **MediaTag**: Junction table for media-tag relationships
- **Tag**: Categories for organizing media
- **User**: Stores user statistics for quiz games
- **GameSession**: Records of quiz game sessions

## TypeScript Configuration

The project uses ES modules with TypeScript. Key TypeScript configurations:
- `"module": "NodeNext"` 
- `"moduleResolution": "NodeNext"`
- `"target": "es2020"`
- Enabled decorator metadata for TypeORM

## Development

### Building

```
npm run build
```

### Running Tests

```
npm test
```

### Manual Start

```
node dist/index.js
```

## Troubleshooting

Common issues:

1. **FFmpeg not found**: Ensure ffmpeg is installed and in your PATH
2. **Database connection errors**: Check your PostgreSQL credentials in .env
3. **Discord token invalid**: Generate a new bot token in the Discord Developer Portal
4. **File permission errors**: Ensure upload/normalized directories are writable

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.