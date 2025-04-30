#!/bin/bash

# cleanup-duplicates.sh - Script to clean up duplicate media entries in the database

echo "NOW Media Duplicate Cleanup Utility"
echo "==================================="
echo "This script will identify and remove duplicate media entries"
echo "while preserving all relationships by transferring them to the record we keep."
echo

# Get directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Check if reflect-metadata package is installed
if ! grep -q '"reflect-metadata"' package.json; then
    echo "Installing reflect-metadata package required by TypeORM..."
    npm install reflect-metadata --save
fi

echo "Starting duplicate cleanup process..."
echo "Log output will be saved to combined.log"

# Run the cleanup script with proper TypeORM decorator support
NODE_OPTIONS="--require=reflect-metadata" npx ts-node \
  --transpile-only \
  -r tsconfig-paths/register \
  cleanup-duplicates.ts

echo
echo "Duplicate cleanup process complete!"
echo "Check the combined.log file for details about the process."