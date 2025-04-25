# NOW - Discord Bot for Media Collection and Quiz Games

## Overview
NOW is a Discord bot designed for collecting media (video and audio), providing tools for playing and augmenting the media, and turning it into interactive quiz games for Discord servers.

## Technical Architecture
- **Framework**: discord.js with TypeScript
- **Runtime**: Node.js with PM2 for process management and auto-restart
- **Database**: PostgreSQL for storing media metadata (files stored on the filesystem)
- **Testing**: Jest for unit and integration testing

## Command Structure
All commands use the prefix `NOW` (case-sensitive)

### Media Playback Commands
- `NOW play [search term]`
  - Searches the database for the term and posts the file as a reply
  - Example: `NOW play star wars theme`

- `NOW play [search term] {amplify=2,reverse=1}`
  - Searches the database and applies ffmpeg filters before posting
  - Example: `NOW play imperial march {amplify=2,reverse=1}`

- `NOW clip=[duration] [search term]`
  - Creates a clip from a random position in the media
  - Example: `NOW clip=4s star wars theme`

- `NOW clip=[duration] start=[position] [search term]`
  - Creates a clip starting from the specified position
  - Example: `NOW clip=4s start=3s imperial march`

### Quiz Commands
- `NOW quiz`
  - Starts a quiz in the current voice channel
  - Randomly selects media from the database each round
  - Players type the title to earn points
  - Fuzzy matching is used for correct answers
  - Type `NOW stop` to end the quiz
  - Quiz continues until nobody guesses for 2 consecutive rounds
  - Hints gradually reveal the title using unicode character masks
  - Screenshots occasionally shown as additional hints
  - Only the first correct answer is counted

- `NOW quiz {[filter options]}`
  - Quiz with custom ffmpeg filters
  - Example: `NOW quiz {reverse=1}`

- `NOW quiz clip=[duration] start=[position]`
  - Quiz with shorter clips and custom start positions
  - Example: `NOW quiz clip=4s start=2s`

### Media Management
- `NOW upload`
  - Returns a link to a web page for uploading media files
  - Features of the upload page:
    - Batch upload support
    - Title input (one per line in a text area)
    - Progress bar for uploads
    - Status display
    - Volume normalization
    - Re-encoding for Discord compatibility

## Media Processing Specifications
- Max file size: 9MB for Discord compatibility
- Files exceeding size limit are trimmed to 4 minutes
- Audio codec: Opus with variable bitrate
- Video codec: H264 (NVENC hardware acceleration) with variable bitrate
- Compression settings calculated using ffprobe
- Original versions stored alongside normalized versions
- Video resolution capped at 1280x720 (or 640x360 if needed)
- Adaptive quality reduction for size compliance
- Multiple encoding attempts with progressively aggressive settings

## Web Interface Features
- Media file index and management
- Title editing capability
- Media replacement functionality
- File size and uploader information
- Usage statistics tracking

## Database Schema
```sql
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  normalized_path TEXT,
  year INTEGER,
  metadata TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS media_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER NOT NULL,
  answer TEXT NOT NULL,
  is_primary BOOLEAN DEFAULT 0,
  FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS media_tags (
  media_id INTEGER,
  tag_id INTEGER,
  PRIMARY KEY (media_id, tag_id),
  FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  correct_answers INTEGER DEFAULT 0,
  games_played INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP,
  rounds INTEGER DEFAULT 0,
  current_round INTEGER DEFAULT 1
);
```