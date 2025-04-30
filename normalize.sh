#!/bin/bash

# normalize.sh - Script to normalize all media files to max 9MB with NVENC hardware acceleration

echo "NOW Media Normalizer"
echo "===================="
echo "This script will process all media files in the database, converting them to be:"
echo "- Maximum 9MB in size"
echo "- Using Opus audio codec with variable bitrate"
echo "- Using NVENC hardware acceleration when available"
echo "- Reducing quality gradually if needed to meet size constraints"
echo

# Get directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Check if ffmpeg is installed
if ! command -v ffmpeg &> /dev/null; then
    echo "Error: ffmpeg is not installed. Please install ffmpeg first."
    exit 1
fi

# Create necessary directories
mkdir -p normalized
mkdir -p temp

echo "Starting normalization process..."
echo "Log output will be saved to combined.log"

# Run the normalize script with settings to properly handle TypeORM decorators
npx ts-node \
  --transpile-only \
  -r tsconfig-paths/register \
  --compiler-options '{"experimentalDecorators":true,"emitDecoratorMetadata":true}' \
  normalize.ts

echo
echo "Normalization process complete!"
echo "Check the combined.log file for details about the process."