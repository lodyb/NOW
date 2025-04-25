import { Message, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { AppDataSource } from '../database/connection';
import { Media } from '../database/entities/Media';
import { logger } from '../utils/logger';
import os from 'os';

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
    const fullPath = path.resolve(process.env.NORMALIZED_DIR || './normalized', filePath);
    
    if (!fs.existsSync(fullPath)) {
      message.reply(`Error: File for "${media.title}" not found on the server.`);
      return;
    }
    
    // If no special options, just send the file directly
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
      
    } catch (error) {
      logger.error(`Error processing media: ${error instanceof Error ? error.message : String(error)}`);
      message.reply(`Error processing media: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } catch (error) {
    logger.error(`Error in play command: ${error instanceof Error ? error.message : String(error)}`);
    message.reply('An error occurred while processing your request. Please try again later.');
  }
}