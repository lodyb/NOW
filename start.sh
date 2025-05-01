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

# Create required directories if they don't exist
log "${GREEN}Creating required directories...${NC}"
mkdir -p uploads normalized

# SQLite database will be created automatically if it doesn't exist
log "${GREEN}Using SQLite database at: ${DB_PATH:-./now.sqlite}${NC}"

# Check if ffmpeg is installed
if ! command -v ffmpeg &> /dev/null; then
  log "${YELLOW}Warning: ffmpeg not found!${NC}"
  log "${YELLOW}Media processing features will not work without ffmpeg.${NC}"
  log "${YELLOW}Install with: sudo apt-get install ffmpeg${NC}"
fi

# Decide what to start based on arguments
if [ "$1" == "--api-only" ]; then
  # Start just the API server
  log "${GREEN}Starting NOW API Server only...${NC}"
  if [ "$2" == "--pm2" ]; then
    # Start API with PM2
    pm2 start server.js --name now-api --time
    log "${GREEN}API server started with PM2!${NC}"
    log "Use 'pm2 logs now-api' to view logs"
    log "Use 'pm2 stop now-api' to stop the API server"
    log "Use 'pm2 restart now-api' to restart the API server"
  else
    # Start API normally
    node server.js
  fi
elif [ "$1" == "--all" ]; then
  # Start both bot and API
  log "${GREEN}Starting both NOW Discord Bot and API Server...${NC}"
  # Build TypeScript code for the bot
  log "${GREEN}Building TypeScript code...${NC}"
  npm run build
  
  if [ "$2" == "--pm2" ]; then
    # Start with PM2
    pm2 start dist/index.js --name now-bot --time
    pm2 start server.js --name now-api --time
    log "${GREEN}Bot and API server started with PM2!${NC}"
    log "Use 'pm2 logs' to view all logs"
    log "Use 'pm2 logs now-bot' or 'pm2 logs now-api' to view specific logs"
  else
    # Start API in background and bot in foreground
    log "${YELLOW}Starting API server in background...${NC}"
    node server.js &
    API_PID=$!
    log "${GREEN}API server started with PID: $API_PID${NC}"
    log "${GREEN}Starting Discord bot in foreground...${NC}"
    node dist/index.js
    # When bot terminates, kill the API server too
    kill $API_PID
  fi
else
  # Default: start just the bot
  log "${GREEN}Starting NOW Discord Bot...${NC}"
  # Build TypeScript code
  log "${GREEN}Building TypeScript code...${NC}"
  npm run build
  
  if [ "$1" == "--pm2" ]; then
    # Start with PM2
    pm2 start dist/index.js --name now-bot --time
    log "${GREEN}Bot started with PM2!${NC}"
    log "Use 'pm2 logs now-bot' to view logs"
    log "Use 'pm2 stop now-bot' to stop the bot"
    log "Use 'pm2 restart now-bot' to restart the bot"
  else
    # Start normally
    node dist/index.js
  fi
fi