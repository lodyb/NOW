#!/bin/bash
set -e

# Define colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Print with timestamp
log() {
  echo -e "[$(date +"%Y-%m-%d %H:%M:%S")] $1"
}

# Check if .env file exists
if [ ! -f .env ]; then
  log "${RED}Error: .env file not found!${NC}"
  log "Please create a .env file with your configuration."
  log "You can use .env.example as a template."
  exit 1
fi

# Source .env file to get configuration
source .env

# Check for required environment variables
if [ -z "$DISCORD_TOKEN" ]; then
  log "${RED}Error: DISCORD_TOKEN missing in .env file!${NC}"
  exit 1
fi

# Build TypeScript code
log "${GREEN}Building TypeScript code...${NC}"
npm run build

# Create required directories if they don't exist
log "${GREEN}Creating required directories...${NC}"
mkdir -p uploads normalized

# SQLite database will be created automatically by TypeORM if it doesn't exist
log "${GREEN}Using SQLite database at: ${DB_PATH:-./otoq.sqlite}${NC}"

# Check if ffmpeg is installed
if ! command -v ffmpeg &> /dev/null; then
  log "${YELLOW}Warning: ffmpeg not found!${NC}"
  log "${YELLOW}Media processing features will not work without ffmpeg.${NC}"
  log "${YELLOW}Install with: sudo apt-get install ffmpeg${NC}"
fi

# Start the bot
log "${GREEN}Starting Otoq Discord Bot...${NC}"
if [ "$1" == "--pm2" ]; then
  # Start with PM2
  pm2 start dist/index.js --name otoq --time
  log "${GREEN}Bot started with PM2!${NC}"
  log "Use 'pm2 logs otoq' to view logs"
  log "Use 'pm2 stop otoq' to stop the bot"
  log "Use 'pm2 restart otoq' to restart the bot"
else
  # Start normally
  node dist/index.js
fi