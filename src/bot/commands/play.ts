import { Message, AttachmentBuilder } from 'discord.js';
import { findMediaBySearch } from '../../database/db';
import { processMedia, parseFilterString, parseClipOptions } from '../../media/processor';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export const handlePlayCommand = async (message: Message, searchTerm?: string, filterString?: string, clipOptions?: { duration?: string; start?: string }) => {
  if (!searchTerm) {
    await message.reply('Please provide a search term. Usage: `NOW play [search term]`');
    return;
  }

  try {
    const results = await findMediaBySearch(searchTerm);
    
    if (results.length === 0) {
      await message.reply(`No media found for "${searchTerm}"`);
      return;
    }

    const media = results[0];
    let filePath = media.normalizedPath || media.filePath;
    
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