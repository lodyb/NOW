#!/bin/bash

# normalize-media.sh - Script to normalize all media files in the database

echo "Starting NOW media normalization process..."
echo "This will normalize all media files to -3dB peak audio level"
echo "It will create both uncompressed versions for quiz and compressed versions for Discord"
echo ""

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

# Create the normalized directory structure if it doesn't exist
mkdir -p normalized/uncompressed
echo "Created normalized directories"

# Run the normalize-all.ts script with ts-node
echo "Starting normalization process..."
npx ts-node normalize-all.ts

echo ""
echo "Normalization process complete!"
echo "Check the combined.log file for details about the process."
echo ""
echo "You can now run the 'NOW quiz' command to test the normalized audio."