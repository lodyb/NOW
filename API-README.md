# NOW API Server

This is the standalone API server for the NOW Discord bot, providing endpoints for media management and upload.

## Overview

This server implements a direct SQLite-based API for managing media files, bypassing TypeORM for simplicity and reliability. It provides all the necessary endpoints for:

- Uploading media files
- Managing media metadata and answers
- Retrieving media for playback
- Token validation for secure uploads

## Getting Started

### Prerequisites

- Node.js v16 or newer
- SQLite3 database
- FFmpeg for media processing

### Running the Server

You can run the API server in multiple ways:

#### Direct Node.js

```bash
# Run the API server directly
npm run api

# or using the start.sh script for just the API
./start.sh --api-only
```

#### Using PM2 (Production)

```bash
# Run with PM2 for production use
npm run api:pm2

# or using the start.sh script with PM2
./start.sh --api-only --pm2
```

#### Running Both Bot and API

```bash
# Run both the Discord bot and API server together
./start.sh --all

# or with PM2 for production
./start.sh --all --pm2
```

## API Endpoints

The server provides the following API endpoints:

### Test Endpoint
- `GET /api/test` - Test if the API is working

### Media Management
- `GET /api/media` - Get list of all media
- `PUT /api/media/:id` - Update a media item's title and answers
- `POST /api/media/:id` - Alias for PUT (same functionality)
- `DELETE /api/media/:id` - Delete a media item
- `GET /api/media/:id/preview` - Get the media file for preview/playback
- `GET /api/media/:id/waveform` - Get waveform image for the media

### Upload
- `POST /api/upload` - Upload media files
- `GET /api/validate-token` - Validate an upload token

## Configuration

Configuration is done through environment variables:

- `PORT` - Port for the web server (default: 3000)
- `UPLOAD_SECRET` - Secret key for signing upload tokens
- `DB_PATH` - Path to SQLite database (default: ./now.sqlite)

## File Structure

- `server.js` - Main server implementation
- `web/` - Static web files (upload.html, etc.)
- `uploads/` - Directory for uploaded files
- `normalized/` - Directory for normalized media files

## Security

The server implements token-based authentication for uploads. Each token:
- Is specific to a user
- Expires after 24 hours
- Is signed with HMAC-SHA256