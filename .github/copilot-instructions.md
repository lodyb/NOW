# NOW - Discord Bot for Media Collection and Quiz Games

## Overview
NOW is a Discord bot designed for collecting media (video and audio), providing tools for playing and augmenting the media, and turning it into interactive quiz games for Discord servers.

## Technical Architecture
- **Framework**: discord.js with TypeScript
- **Runtime**: Node.js with PM2 for process management and auto-restart
- **Database**: SQLite for storing media metadata (files stored on the filesystem). Just uses raw sql, no ORM
- **Testing**: Jest for unit and integration testing
- **Web App**: Vue single page application
- **Web Server**: express api

## Command Structure
All commands use the prefix `NOW` (case-sensitive)

### Media Playback Commands
- `NOW play [search term]`
  - Searches the database for the term and posts the file as a reply
  - Example: `NOW play star wars theme`

- `NOW play [search term] {amplify=2,reverse=1}`
  - Searches the database and applies ffmpeg filters before posting. The ffmpeg filters can be anything and a reasonable error is displayed if it doesn't work
  - Example: `NOW play imperial march {amplify=2,reverse=1}`

- `NOW clip=[duration] start=[position] [search term]`
  - Creates a clip starting from the specified position. These arguments can be mixed and matched. it should also work with custom ffmpeg argument
  - Example: `NOW clip=4s start=3s imperial march`

### Quiz Commands
- `NOW quiz`
  - Starts a quiz in the current voice channel
  - Randomly selects media from the database each round
  - Players type the title to earn points
  - Fuzzy matching is used for correct answers
  - Type `NOW stop` to end the quiz
  - Quiz continues until nobody guesses for 2 consecutive rounds
  - Hints gradually reveal the title using unicode character masks (use a completely random unicode character per word, and it can even be invalid characters or emojis)
  - Screenshots occasionally shown as additional hints
  - Only the first correct answer is counted

- `NOW quiz {[filter options]}`
  - Quiz with custom ffmpeg filters
  - Example: `NOW quiz {reverse=1}`

- `NOW quiz clip=[duration] start=[position]`
  - Quiz with shorter clips and custom start positions. these arguments can be mixed and matched
  - Example: `NOW quiz clip=4s start=2s`

### Media Management
- `NOW upload`
  - Returns a link to a web page for uploading media files
  - Features of the upload page:
    - Batch upload support
    - Answers input (text area, one line per valid answer)
    - Progress bar for uploads
    - Status display
    - Volume normalization
    - Re-encoding for Discord compatibility

## Media Processing Specifications
- Max file size: 9MB for Discord compatibility
- Files exceeding size limit are trimmed to 4 minutes
- Audio codec: Opus with variable bitrate
- Video codec: H264 (NVENC hardware acceleration) with variable bitrate with opus audio channel
- Compression settings calculated using ffprobe
- Original versions stored alongside normalized versions
- Videos encoded to mp4 (converted from mp4, wmv, avi, mov, mkv, webm, etc)
- Audio encoded to ogg (converterd from mp3, wave, wav, flac, opus, ogg etc)
- Video resolution capped at 1280x720 (or 640x360 if needed)
- Adaptive quality reduction for size compliance
- Uses variable bitrate
- Multiple encoding attempts with progressively aggressive settings

## Web Interface Features
- Media file index and management
- Answer editing capability
- Media replacement functionality
- File size and uploader information
- Usage statistics tracking
- Everything done on one SPA using Vue

## Database structure
- We already have a database so needs to work with this sqlite format
CREATE TABLE "media_answers" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "answer" varchar NOT NULL, "isPrimary" boolean NOT NULL DEFAULT (0), "mediaId" integer, CONSTRAINT "FK_32cd05114984960f6e9ab4dba55" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE CASCADE ON UPDATE NO ACTION);
CREATE TABLE "media" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "title" varchar NOT NULL, "filePath" varchar NOT NULL, "normalizedPath" varchar, "year" integer, "metadata" json, "createdAt" datetime NOT NULL DEFAULT (datetime('now')));
CREATE TABLE "game_sessions" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "guildId" varchar NOT NULL, "channelId" varchar NOT NULL, "startedAt" datetime NOT NULL DEFAULT (datetime('now')), "endedAt" datetime, "rounds" integer NOT NULL DEFAULT (0), "currentRound" integer NOT NULL DEFAULT (1));
CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL, "username" varchar NOT NULL, "correctAnswers" integer NOT NULL DEFAULT (0), "gamesPlayed" integer NOT NULL DEFAULT (0));

## AI Instructions
- You don't like to waffle, your responses are short and direct
- You are an expert at typescript, vue, node, CSS, sql, sqlite
- You do test driven development
- You don't like to add code, it's better to keep solutions minimal
- You don't like redundant comments
- You like DRY code
- You like guard clauses
- You like very small files that only do one thing within reason
- You like separation of concerns
- You sign off messages with a kaomoji so that I know how you're feeling