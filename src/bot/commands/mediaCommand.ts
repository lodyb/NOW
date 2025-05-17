import { Message, AttachmentBuilder } from 'discord.js';
import { findMediaBySearch, getRandomMedia } from '../../database/db';
import { parseFilterString } from '../../media/processor';
import { processFilterChain } from '../../media/chainProcessor';
import { safeReply } from '../utils/helpers';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { Stream } from 'stream';
import { promisify } from 'util';

// Directory for temporary downloads
const TEMP_DIR = path.join(process.cwd(), 'temp');
const NORMALIZED_DIR = path.join(process.cwd(), 'normalized');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Unified media command handler for both play and remix commands
 */
export const processMediaCommand = async (
  message: Message,
  options: {
    searchTerm?: string;
    filterString?: string;
    clipOptions?: { duration?: string; start?: string };
    fromReply?: boolean;
  }
) => {
  try {
    const { searchTerm, filterString, clipOptions, fromReply } = options;
    
    // Send initial status message
    const statusMessage = await message.reply(`Processing request... ⏳`);
    
    // Get media source based on whether this is a play or remix command
    const mediaSource = fromReply ? 
      await getMediaFromReplyOrAttachments(message) : 
      await getMediaFromDatabase(searchTerm);
    
    if (!mediaSource) {
      await statusMessage.edit(
        fromReply ?
          "No media found in this message or the one it replies to. Please include media or reply to a message with media." :
          `No media found ${searchTerm ? `for "${searchTerm}"` : 'in the database'}`
      );
      return;
    }
    
    try {
      let processedPath: string;
      let needsCleanup = false;
      
      // Skip processing if no filters or clip options are specified and the media is from database
      const hasFilters = !!filterString;
      const hasClipOptions = !!(clipOptions && (clipOptions.duration || clipOptions.start));
      
      if (!hasFilters && !hasClipOptions && !fromReply && !mediaSource.isTemporary) {
        // Just use the existing normalized file directly
        processedPath = mediaSource.filePath;
        await statusMessage.edit(`Found ${searchTerm ? `"${searchTerm}"` : 'media'}, uploading... 📤`);
      } else {
        // Prepare filter string for processing
        let parsedFilterString = filterString;
        if (filterString && !filterString.startsWith('{')) {
          parsedFilterString = `{${filterString}}`;
        }
        
        // Update status message based on filter presence
        if (parsedFilterString) {
          await statusMessage.edit(`Processing media with filters... ⏳`);
        } else {
          await statusMessage.edit(`Processing media... ⏳`);
        }
        
        // Generate random ID for output filename
        const randomId = crypto.randomBytes(4).toString('hex');
        const outputFilename = `processed_${randomId}${path.extname(mediaSource.filePath)}`;
        
        // Process the media with filter chain
        processedPath = await processFilterChain(
          mediaSource.filePath,
          outputFilename,
          parsedFilterString,
          clipOptions,
          async (stage, progress) => {
            try {
              await statusMessage.edit(`${stage} (${Math.round(progress * 100)}%)... ⏳`);
            } catch (err) {
              console.error('Error updating status message:', err);
            }
          },
          true // Always enforce Discord's file size limits
        );
        
        needsCleanup = true;
      }
      
      // Upload the processed file
      await statusMessage.edit(`Uploading... 📤`);
      const attachment = new AttachmentBuilder(processedPath);
      await safeReply(message, { files: [attachment] });
      
      // Clean up
      await statusMessage.delete().catch(err => console.error('Failed to delete status message:', err));
      
      // Clean up temporary files
      if (needsCleanup) {
        try {
          if (fs.existsSync(processedPath)) {
            fs.unlinkSync(processedPath);
          }
        } catch (error) {
          console.error('Error cleaning up processed file:', error);
        }
      }
      
      // If this was a downloaded file (not from database), clean it up too
      if (fromReply && mediaSource.isTemporary && fs.existsSync(mediaSource.filePath)) {
        try {
          fs.unlinkSync(mediaSource.filePath);
        } catch (error) {
          console.error('Error cleaning up temporary file:', error);
        }
      }
      
    } catch (error) {
      console.error('Error processing media:', error);
      await statusMessage.edit(`Error processing media: ${(error as Error).message} ❌`);
    }
  } catch (error) {
    console.error('Error in processMediaCommand:', error);
    await safeReply(message, `An error occurred: ${(error as Error).message}`);
  }
};

/**
 * Get media from the database based on search term
 */
async function getMediaFromDatabase(searchTerm?: string): Promise<{ filePath: string; isTemporary: false } | null> {
  let media;
  
  if (!searchTerm) {
    // Get random media when no search term provided
    const randomResults = await getRandomMedia(1);
    if (randomResults.length === 0) {
      return null;
    }
    media = randomResults[0];
  } else {
    // Search for media by term
    const results = await findMediaBySearch(searchTerm);
    
    if (results.length === 0) {
      return null;
    }
    media = results[0];
  }

  // Determine the file path by standardizing the normalized path format
  let filePath;
  
  if (media.normalizedPath) {
    const filename = path.basename(media.normalizedPath);
    // Ensure normalized path starts with 'norm_'
    const normalizedFilename = filename.startsWith('norm_') ? filename : `norm_${filename}`;
    filePath = path.join(NORMALIZED_DIR, normalizedFilename);
  } else {
    filePath = media.filePath;
  }
  
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return null;
  }
  
  return { filePath, isTemporary: false };
}

/**
 * Get media from message attachments or replied message
 */
async function getMediaFromReplyOrAttachments(message: Message): Promise<{ filePath: string; isTemporary: boolean } | null> {
  // Get the message to process
  let targetMessage = message;
  
  // If this is a reply, use the referenced message
  if (message.reference) {
    const referencedMessage = await fetchReferencedMessage(message);
    if (!referencedMessage) {
      return null;
    }
    targetMessage = referencedMessage;
  }
  
  // Find media URL in the message
  const mediaUrl = await findMediaUrl(targetMessage);
  
  if (!mediaUrl) {
    return null;
  }
  
  // Download the media to a temporary location
  const downloadedFilePath = await downloadMedia(mediaUrl);
  
  if (!downloadedFilePath) {
    return null;
  }
  
  return { filePath: downloadedFilePath, isTemporary: true };
}

/**
 * Fetch a message referenced in a reply
 */
async function fetchReferencedMessage(message: Message): Promise<Message | null> {
  const reference = message.reference;
  if (!reference || !reference.messageId) {
    return null;
  }
  
  try {
    const channel = message.channel;
    return await channel.messages.fetch(reference.messageId);
  } catch (error) {
    console.error('Error fetching referenced message:', error);
    return null;
  }
}

/**
 * Find a media URL in a message (attachment or embed)
 */
async function findMediaUrl(message: Message): Promise<string | null> {
  // Check message attachments first
  if (message.attachments.size > 0) {
    const attachment = message.attachments.first();
    if (attachment) {
      const url = attachment.url;
      const contentType = attachment.contentType || '';
      
      if (contentType.startsWith('video/') || 
          contentType.startsWith('audio/') || 
          contentType.startsWith('image/gif')) {
        return url;
      }
    }
  }
  
  // Check embeds for media links
  if (message.embeds.length > 0) {
    for (const embed of message.embeds) {
      // Check for video in the embed
      if (embed.video) {
        return embed.video.url;
      }
      
      // Check for an image in the embed (might be a gif)
      if (embed.image) {
        return embed.image.url;
      }
    }
  }
  
  // Check message content for media links
  const urlRegex = /(https?:\/\/[^\s]+\.(mp4|mp3|ogg|wav|webm|gif))/i;
  const urlMatch = message.content.match(urlRegex);
  if (urlMatch && urlMatch[0]) {
    return urlMatch[0];
  }
  
  return null;
}

/**
 * Download media from a URL to a local file
 */
async function downloadMedia(url: string): Promise<string | null> {
  try {
    const streamPipeline = promisify(Stream.pipeline);
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error(`Failed to download media: Server returned ${response.status} ${response.statusText}`);
      return null;
    }
    
    const contentType = response.headers.get('content-type') || '';
    let fileExtension = '.mp4'; // Default extension
    
    // Determine file extension from content type
    if (contentType.includes('video/mp4')) fileExtension = '.mp4';
    else if (contentType.includes('video/webm')) fileExtension = '.webm';
    else if (contentType.includes('audio/mpeg')) fileExtension = '.mp3';
    else if (contentType.includes('audio/ogg')) fileExtension = '.ogg';
    else if (contentType.includes('audio/wav')) fileExtension = '.wav';
    else if (contentType.includes('image/gif')) fileExtension = '.gif';
    
    // Create a temporary file
    const randomId = crypto.randomBytes(8).toString('hex');
    const filePath = path.join(TEMP_DIR, `download_${randomId}${fileExtension}`);
    
    // Stream the response to a file
    const fileStream = fs.createWriteStream(filePath);
    await streamPipeline(response.body, fileStream);
    
    return filePath;
  } catch (error) {
    console.error('Error downloading media:', error);
    return null;
  }
}