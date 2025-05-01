import { Message, AttachmentBuilder } from 'discord.js';
import { findMediaBySearch, getRandomMedia } from '../../database/db';
import path from 'path';
import fs from 'fs';

export const handleImageCommand = async (message: Message, searchTerm?: string) => {
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

    // Check if the media has any thumbnails
    if (!media.thumbnails || media.thumbnails.length === 0) {
      await message.reply('This media does not have any thumbnails or visualizations.');
      return;
    }

    // Select a random thumbnail from the available ones
    const randomIndex = Math.floor(Math.random() * media.thumbnails.length);
    const thumbnailPath = media.thumbnails[randomIndex];
    
    // Extract just the filename from the path
    const filename = thumbnailPath.split('/').pop();
    if (!filename) {
      await message.reply('Error retrieving thumbnail information.');
      return;
    }
    
    // Get the absolute path to the thumbnail file
    const absoluteThumbnailPath = path.join(process.cwd(), 'thumbnails', filename);
    
    if (!fs.existsSync(absoluteThumbnailPath)) {
      await message.reply('Thumbnail file not found');
      return;
    }
    
    // Get the type of media for the response message
    const isVideo = media.normalizedPath?.endsWith('.mp4');
    const mediaType = isVideo ? 'video' : 'audio';
    const visualType = isVideo ? 'thumbnail' : (thumbnailPath.includes('waveform') ? 'waveform' : 'spectrogram');
    
    // Create the attachment
    const attachment = new AttachmentBuilder(absoluteThumbnailPath);
    
    // Send the message with the image
    await message.reply({ 
      content: `Here's a ${visualType} of the ${mediaType}: **${media.title}**`,
      files: [attachment] 
    });
  } catch (error) {
    console.error('Error handling image command:', error);
    await message.reply(`An error occurred: ${(error as Error).message}`);
  }
};