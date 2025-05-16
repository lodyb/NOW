import { Message, MessageReference, AttachmentBuilder, MessageType } from 'discord.js';
import { processMedia, parseFilterString, ClipOptions } from '../../media/processor';
import { safeReply } from '../utils/helpers';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { Stream } from 'stream';
import { promisify } from 'util';

// Directory for temporary downloads
const TEMP_DIR = path.join(process.cwd(), 'temp');

/**
 * Handle the remix command that processes media from message attachments or embeds
 */
export const handleRemixCommand = async (
  message: Message,
  filterString?: string,
  clipOptions?: ClipOptions
) => {
  try {
    // Get the message to process
    let targetMessage = message;
    
    // If this is a reply, use the referenced message
    if (message.reference) {
      const referencedMessage = await fetchReferencedMessage(message);
      if (!referencedMessage) {
        await safeReply(message, "Couldn't fetch the message you replied to.");
        return;
      }
      targetMessage = referencedMessage;
    }
    
    // First check for attachments in the message
    const mediaUrl = await findMediaUrl(targetMessage);
    
    if (!mediaUrl) {
      await safeReply(message, "No media found in this message. Please reply to a message with media or include media in your message.");
      return;
    }
    
    // Send initial status message
    const statusMessage = await message.reply(`Found media, downloading... ⏳`);
    
    try {
      // Download the media to a temporary location
      const downloadedFilePath = await downloadMedia(mediaUrl, statusMessage);
      
      if (!downloadedFilePath) {
        await statusMessage.edit("Failed to download media ❌");
        return;
      }
      
      await statusMessage.edit(`Media downloaded, processing with filters... ⏳`);
      
      // Process the media with filters
      const randomId = crypto.randomBytes(4).toString('hex');
      const outputFilename = `remix_${randomId}${path.extname(downloadedFilePath)}`;
      
      const options = {
        filters: filterString ? parseFilterString(filterString) : {},
        clip: clipOptions,
        enforceDiscordLimit: true,
        progressCallback: async (stage: string, progress: number) => {
          try {
            await statusMessage.edit(`${stage} (${Math.round(progress * 100)}%)... ⏳`);
          } catch (err) {
            console.error('Error updating status message:', err);
          }
        }
      };
      
      const processedPath = await processMedia(downloadedFilePath, outputFilename, options);
      
      // Send the processed media
      await statusMessage.edit(`Processing complete, uploading... 📤`);
      const attachment = new AttachmentBuilder(processedPath);
      await safeReply(message, { files: [attachment] });
      
      // Clean up
      await statusMessage.delete().catch(err => console.error('Failed to delete status message:', err));
      
      try {
        if (fs.existsSync(downloadedFilePath)) {
          fs.unlinkSync(downloadedFilePath);
        }
        if (fs.existsSync(processedPath)) {
          fs.unlinkSync(processedPath);
        }
      } catch (error) {
        console.error('Error cleaning up temporary files:', error);
      }
      
    } catch (error) {
      console.error('Error processing media:', error);
      await statusMessage.edit(`Error processing media: ${(error as Error).message} ❌`);
    }
  } catch (error) {
    console.error('Error handling remix command:', error);
    await safeReply(message, `An error occurred: ${(error as Error).message}`);
  }
};

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
    const referencedMessage = await channel.messages.fetch(reference.messageId);
    return referencedMessage;
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
  
  // Check for common video hosting links
  const youtubeRegex = /https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const tiktokRegex = /https?:\/\/(www\.)?(tiktok\.com)\/(@[a-zA-Z0-9_.]+\/video\/\d+|t\/[a-zA-Z0-9_]+)/;
  const twitterRegex = /https?:\/\/(www\.)?(twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/\d+/;
  
  // If we find a platform-specific URL, return null for now
  // These would require special handling with youtube-dl or similar tools
  if (message.content.match(youtubeRegex) || 
      message.content.match(tiktokRegex) || 
      message.content.match(twitterRegex)) {
    console.log('Found platform-specific URL, but direct extraction not implemented');
    return null;
  }
  
  return null;
}

/**
 * Download media from a URL to a local file
 */
async function downloadMedia(url: string, statusMessage: Message): Promise<string | null> {
  try {
    const streamPipeline = promisify(Stream.pipeline);
    const response = await fetch(url);
    
    if (!response.ok) {
      await statusMessage.edit(`Failed to download media: Server returned ${response.status} ${response.statusText}`);
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
    await statusMessage.edit(`Error downloading media: ${(error as Error).message}`);
    return null;
  }
}