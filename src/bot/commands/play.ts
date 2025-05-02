import { Message, AttachmentBuilder } from 'discord.js';
import { findMediaBySearch, getRandomMedia } from '../../database/db';
import { processMedia, parseFilterString, parseClipOptions } from '../../media/processor';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export const handlePlayCommand = async (message: Message, searchTerm?: string, filterString?: string, clipOptions?: { duration?: string; start?: string }) => {
  try {
    let media;
    
    if (!searchTerm) {
      // Get random media when no search term provided
      const randomResults = await getRandomMedia(1);
      if (randomResults.length === 0) {
        await message.reply('No media found in the database');
        return;
      }
      media = randomResults[0];
    } else {
      const results = await findMediaBySearch(searchTerm);
      
      if (results.length === 0) {
        await message.reply(`No media found for "${searchTerm}"`);
        return;
      }
      media = results[0];
    }

    // Determine the file path, resolving to absolute paths
    let normalizedDir = path.join(process.cwd(), 'normalized');
    let filePath;
    
    if (media.normalizedPath) {
      // Handle relative paths starting with 'normalized/'
      if (media.normalizedPath.startsWith('normalized/')) {
        // Replace the 'normalized/' prefix with the actual full path
        filePath = path.join(process.cwd(), media.normalizedPath);
      } else {
        filePath = media.normalizedPath;
      }
    } else {
      filePath = media.filePath;
    }
    
    // Apply filters or clip options if provided
    if (filterString || (clipOptions && Object.keys(clipOptions).length > 0)) {
      try {
        const randomId = crypto.randomBytes(4).toString('hex');
        const outputFilename = `temp_${randomId}_${path.basename(filePath)}`;
        const options: any = {};
        
        if (filterString) {
          options.filters = parseFilterString(filterString);
        }
        
        if (clipOptions) {
          options.clip = clipOptions;
        }
        
        filePath = await processMedia(filePath, outputFilename, options);
      } catch (error) {
        console.error('Error processing media:', error);
        await message.reply(`Error applying filters: ${(error as Error).message}`);
        return;
      }
    }
    
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      await message.reply('Error: Media file not found');
      return;
    }
    
    const attachment = new AttachmentBuilder(filePath);
    await message.reply({ files: [attachment] });
  } catch (error) {
    console.error('Error handling play command:', error);
    await message.reply(`An error occurred: ${(error as Error).message}`);
  }
};