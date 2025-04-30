import { Message, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';
import { createClip } from '../services/media/clipper';
import ffmpeg from 'fluent-ffmpeg';
import { findMediaByTitle } from '../database/repositories/mediaRepository';

// Parse time string to seconds
function parseTimeString(time: string): number {
  // Handle simple seconds format (e.g., "5")
  if (/^\d+$/.test(time)) {
    return parseInt(time, 10);
  }
  
  // Handle seconds with unit (e.g., "5s")
  if (/^\d+s$/.test(time)) {
    return parseInt(time.slice(0, -1), 10);
  }
  
  // Handle minutes:seconds format (e.g., "1:30")
  if (/^\d+:\d+$/.test(time)) {
    const [minutes, seconds] = time.split(':').map(part => parseInt(part, 10));
    return minutes * 60 + seconds;
  }
  
  // Default fallback
  return 5; // Default to 5 seconds
}

// Extract clip options from message content
function extractClipOptions(content: string): {
  clipDuration: number;
  startPosition: number | null;
  searchTerm: string;
} {
  // Default values
  let clipDuration = 5; // 5 seconds by default
  let startPosition = null;
  let searchTerm = '';
  
  // Extract clip duration (format: "clip=Xs")
  const clipMatch = content.match(/clip=(\d+[s:]?\d*)/i);
  if (clipMatch) {
    clipDuration = parseTimeString(clipMatch[1]);
  }
  
  // Extract start position (format: "start=Xs")
  const startMatch = content.match(/start=(\d+[s:]?\d*)/i);
  if (startMatch) {
    startPosition = parseTimeString(startMatch[1]);
  }
  
  // Extract search term (anything after the options)
  searchTerm = content
    .replace(/NOW\s+clip=\d+[s:]?\d*/i, '')
    .replace(/start=\d+[s:]?\d*/i, '')
    .trim();
  
  return { clipDuration, startPosition, searchTerm };
}

/**
 * Helper function to resolve file path correctly
 */
function resolveMediaPath(filePath: string): string {
  const normalizedDir = process.env.NORMALIZED_DIR || './normalized';
  
  // Check if the path already includes the normalized directory
  if (filePath.startsWith('normalized/') || filePath.startsWith('./normalized/')) {
    // Path already contains the normalized prefix, just resolve from project root
    return path.resolve(process.cwd(), filePath);
  } else {
    // Path doesn't contain the prefix, join with normalized directory
    return path.resolve(normalizedDir, filePath);
  }
}

/**
 * Handles the clip command
 * @param message The Discord message
 */
export async function clipCommand(message: Message): Promise<void> {
  try {
    // Extract clip options from message content
    const { clipDuration, startPosition, searchTerm } = extractClipOptions(message.content);
    
    if (!searchTerm) {
      message.reply('Please specify what to search for. Example: `NOW clip=5s imperial march`');
      return;
    }
    
    // Reply to acknowledge the command
    const channel = message.channel as TextChannel | DMChannel | NewsChannel;
    await channel.send(`Searching for "${searchTerm}" and creating a ${clipDuration}s clip...`);
    
    // Find media in database using our new repository function
    const mediaList = await findMediaByTitle(searchTerm, 1);
    
    if (!mediaList.length) {
      message.reply(`No media found matching "${searchTerm}". Try a different search term.`);
      return;
    }
    
    const media = mediaList[0];
    
    // Get the file path
    const filePath = media.normalizedPath || media.filePath;
    const fullPath = resolveMediaPath(filePath);
    
    logger.info(`Trying to access file for clip at: ${fullPath}`);
    
    if (!fs.existsSync(fullPath)) {
      message.reply(`Error: File for "${media.title}" not found on the server.`);
      return;
    }
    
    // Create clip
    channel.send(`Creating a ${clipDuration}s clip of "${media.title}"...`);
    
    try {
      // Generate the clip
      const clipPath = await createClip(fullPath, clipDuration, startPosition);
      
      // Send the clip
      await channel.send({
        content: `Here's your clip of "${media.title}"${startPosition !== null ? ` starting at ${startPosition}s` : ''}:`,
        files: [clipPath]
      });
      
      // Clean up the clip file after a delay to ensure it's fully sent
      setTimeout(() => {
        try {
          fs.unlinkSync(clipPath);
        } catch (error) {
          logger.error(`Error deleting clip file: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, 10000);
      
    } catch (error) {
      logger.error(`Error creating clip: ${error instanceof Error ? error.message : String(error)}`);
      message.reply(`Error creating clip: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
  } catch (error) {
    logger.error(`Error in clip command: ${error instanceof Error ? error.message : String(error)}`);
    message.reply('An error occurred while processing your request. Please try again later.');
  }
}