import { Message, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { AppDataSource } from '../database/connection';
import { Media } from '../database/entities/Media';
import { logger } from '../utils/logger';
import os from 'os';
import { normalizeMediaIfNeeded } from '../services/media/normalizer';

// Parse ffmpeg options from string
function parseOptions(optionsStr: string): Record<string, string | number | boolean> {
  if (!optionsStr) return {};
  
  // Remove curly braces and split by comma
  const optionsContent = optionsStr.replace(/^\{|\}$/g, '').trim();
  if (!optionsContent) return {};
  
  const options: Record<string, string | number | boolean> = {};
  optionsContent.split(',').forEach(option => {
    const [key, value] = option.split('=').map(part => part.trim());
    
    // Try to convert to appropriate type
    if (value.toLowerCase() === 'true') {
      options[key] = true;
    } else if (value.toLowerCase() === 'false') {
      options[key] = false;
    } else if (!isNaN(Number(value))) {
      options[key] = Number(value);
    } else {
      options[key] = value;
    }
  });
  
  return options;
}

// Extract search term and options from message content
function extractPlayOptions(content: string): {
  searchTerm: string;
  options: Record<string, string | number | boolean>;
} {
  let searchTerm = content.replace(/^NOW\s+play\s+/i, '').trim();
  let options = {};
  
  // Check for options in curly braces
  const optionsMatch = searchTerm.match(/\{(.+?)\}$/);
  if (optionsMatch) {
    // Extract options string
    options = parseOptions(optionsMatch[0]);
    
    // Remove options from search term
    searchTerm = searchTerm.replace(/\{(.+?)\}$/, '').trim();
  }
  
  return { searchTerm, options };
}

// Apply ffmpeg filters based on options
function applyFilters(command: ffmpeg.FfmpegCommand, options: Record<string, string | number | boolean>): ffmpeg.FfmpegCommand {
  let filterChain = '';
  
  if (options.amplify) {
    // Volume multiplier (1.0 = normal, 2.0 = double, etc.)
    const volumeValue = typeof options.amplify === 'number' ? options.amplify : 1.5;
    filterChain += `volume=${volumeValue},`;
  }
  
  if (options.reverse) {
    // Reverse the audio
    filterChain += 'areverse,';
  }
  
  if (options.pitch) {
    // Adjust pitch (1.0 = normal, 0.5 = lower, 2.0 = higher)
    const pitchValue = typeof options.pitch === 'number' ? options.pitch : 1.0;
    filterChain += `asetrate=44100*${pitchValue},`;
  }
  
  // Remove trailing comma if filters were added
  if (filterChain) {
    filterChain = filterChain.replace(/,$/, '');
    command = command.audioFilters(filterChain);
  }
  
  return command;
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
 * Handles the play command
 * @param message The Discord message
 */
export async function playCommand(message: Message): Promise<void> {
  try {
    // Extract play options from message content
    const { searchTerm, options } = extractPlayOptions(message.content);
    
    if (!searchTerm) {
      message.reply('Please specify what to search for. Example: `NOW play imperial march`');
      return;
    }
    
    const channel = message.channel as TextChannel | DMChannel | NewsChannel;
    
    // If there are options, acknowledge them
    if (Object.keys(options).length > 0) {
      channel.send(`Processing media with options: ${JSON.stringify(options)}...`);
    }
    
    // Find media in database
    const mediaRepository = AppDataSource.getRepository(Media);
    const query = mediaRepository
      .createQueryBuilder('media')
      .leftJoinAndSelect('media.answers', 'answers')
      .where('media.title LIKE :search OR answers.answer LIKE :search', {
        search: `%${searchTerm}%`
      })
      .orderBy('RANDOM()')
      .take(1);
    
    const media = await query.getOne();
    
    if (!media) {
      message.reply(`No media found matching "${searchTerm}". Try a different search term.`);
      return;
    }
    
    // Get the file path
    const filePath = media.normalizedPath || media.filePath;
    const fullPath = resolveMediaPath(filePath);
    
    logger.info(`Trying to access file at: ${fullPath}`);
    
    if (!fs.existsSync(fullPath)) {
      message.reply(`Error: File for "${media.title}" not found on the server.`);
      return;
    }
    
    // Check file size for Discord compatibility (Discord limit is ~8MB)
    const stats = fs.statSync(fullPath);
    const discordSizeLimit = (parseInt(process.env.MAX_FILE_SIZE || '8') * 1024 * 1024);
    
    // If no special options and file size is over limit, normalize on demand
    if (Object.keys(options).length === 0 && stats.size > discordSizeLimit) {
      try {
        channel.send(`File is too large for Discord (${(stats.size / (1024 * 1024)).toFixed(2)}MB), processing for compatibility...`);
        
        // Normalize the file on demand
        const normalizedDir = process.env.NORMALIZED_DIR || './normalized';
        const normalizedPath = await normalizeMediaIfNeeded(fullPath, normalizedDir);
        
        await channel.send({
          content: `Now playing: "${media.title}" (processed for Discord compatibility)`,
          files: [normalizedPath]
        });
        return;
      } catch (error) {
        logger.error(`Error normalizing oversized file: ${error instanceof Error ? error.message : String(error)}`);
        channel.send('The file is too large for Discord and could not be processed. You can still use it in quiz mode.');
        return;
      }
    }
    
    // If no special options and file is under limit, just send the file directly
    if (Object.keys(options).length === 0) {
      await channel.send({
        content: `Now playing: "${media.title}"`,
        files: [fullPath]
      });
      return;
    }
    
    // Process with ffmpeg for special options
    const tempFile = path.join(os.tmpdir(), `otoq_${Date.now()}_${path.basename(fullPath)}`);
    
    try {
      await new Promise<void>((resolve, reject) => {
        let command = ffmpeg(fullPath);
        
        // Apply any filters based on options
        command = applyFilters(command, options);
        
        command
          .output(tempFile)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });
      
      // Check if processed file is within Discord's limit
      const processedStats = fs.statSync(tempFile);
      if (processedStats.size > discordSizeLimit) {
        // File is still too large, try to normalize it
        channel.send(`Processed file is still too large (${(processedStats.size / (1024 * 1024)).toFixed(2)}MB), applying additional compression...`);
        
        const normalizedDir = path.dirname(tempFile);
        const compressedPath = await normalizeMediaIfNeeded(tempFile, normalizedDir);
        
        // Send the compressed file
        await channel.send({
          content: `Now playing: "${media.title}" with custom filters (compressed for Discord)`,
          files: [compressedPath]
        });
        
        // Clean up the temp files after a delay
        setTimeout(() => {
          try {
            fs.unlinkSync(tempFile);
            if (compressedPath !== tempFile) {
              fs.unlinkSync(compressedPath);
            }
          } catch (error) {
            logger.error(`Error deleting temp files: ${error instanceof Error ? error.message : String(error)}`);
          }
        }, 10000);
      } else {
        // Send the processed file
        await channel.send({
          content: `Now playing: "${media.title}" with custom filters`,
          files: [tempFile]
        });
        
        // Clean up the temp file after a delay
        setTimeout(() => {
          try {
            fs.unlinkSync(tempFile);
          } catch (error) {
            logger.error(`Error deleting temp file: ${error instanceof Error ? error.message : String(error)}`);
          }
        }, 10000);
      }
      
    } catch (error) {
      logger.error(`Error processing media: ${error instanceof Error ? error.message : String(error)}`);
      message.reply(`Error processing media: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } catch (error) {
    logger.error(`Error in play command: ${error instanceof Error ? error.message : String(error)}`);
    message.reply('An error occurred while processing your request. Please try again later.');
  }
}