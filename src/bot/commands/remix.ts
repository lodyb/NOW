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
    console.log(`handleRemixCommand called with filterString: ${filterString || 'none'}`);
    // Get the message to process
    let targetMessage = message;
    
    // If this is a reply, use the referenced message
    if (message.reference) {
      console.log(`This is a reply, fetching referenced message: ${message.reference.messageId}`);
      const referencedMessage = await fetchReferencedMessage(message);
      if (!referencedMessage) {
        console.log(`Failed to fetch referenced message`);
        await safeReply(message, "Couldn't fetch the message you replied to.");
        return;
      }
      console.log(`Referenced message fetched successfully from ${referencedMessage.author.username}`);
      targetMessage = referencedMessage;
    }
    
    // First check for attachments in the message
    console.log(`Looking for media in the ${targetMessage === message ? 'original' : 'referenced'} message`);
    const mediaUrl = await findMediaUrl(targetMessage);
    
    if (!mediaUrl) {
      console.log(`No media found in message`);
      await safeReply(message, "No media found in this message. Please reply to a message with media or include media in your message.");
      return;
    }
    
    console.log(`Found media URL: ${mediaUrl}`);
    
    // Send initial status message
    const statusMessage = await message.reply(`Found media, downloading... ⏳`);
    
    try {
      // Download the media to a temporary location
      console.log(`Downloading media from URL: ${mediaUrl}`);
      const downloadedFilePath = await downloadMedia(mediaUrl, statusMessage);
      
      if (!downloadedFilePath) {
        console.log(`Failed to download media`);
        await statusMessage.edit("Failed to download media ❌");
        return;
      }
      
      console.log(`Media downloaded to: ${downloadedFilePath}`);
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
  console.log(`Finding media in message from ${message.author.username}`);
  
  // Check message attachments first
  if (message.attachments.size > 0) {
    console.log(`Found ${message.attachments.size} attachments in message`);
    const attachment = message.attachments.first();
    if (attachment) {
      const url = attachment.url;
      const contentType = attachment.contentType || '';
      console.log(`First attachment has URL ${url} and content type ${contentType || 'unknown'}`);
      
      if (contentType.startsWith('video/') || 
          contentType.startsWith('audio/') || 
          contentType.startsWith('image/gif')) {
        console.log(`Found valid media attachment: ${contentType}`);
        return url;
      } else {
        console.log(`Attachment content type not recognized as media: ${contentType || 'unknown'}`);
      }
    }
  } else {
    console.log(`No attachments found in the message`);
  }
  
  // Check embeds for media links
  if (message.embeds.length > 0) {
    console.log(`Found ${message.embeds.length} embeds in message`);
    for (const embed of message.embeds) {
      console.log(`Checking embed type: ${embed.type || 'unknown'}`);
      
      // Check for video in the embed
      if (embed.video) {
        console.log(`Found video in embed: ${embed.video.url}`);
        return embed.video.url;
      }
      
      // Check for an image in the embed (might be a gif)
      if (embed.image) {
        console.log(`Found image in embed: ${embed.image.url}`);
        return embed.image.url;
      }
    }
    console.log(`No usable media found in embeds`);
  } else {
    console.log(`No embeds found in the message`);
  }
  
  // Check message content for media links
  console.log(`Checking message content for media links: ${message.content.substring(0, 50)}...`);
  const urlRegex = /(https?:\/\/[^\s]+\.(mp4|mp3|ogg|wav|webm|gif))/i;
  const urlMatch = message.content.match(urlRegex);
  if (urlMatch && urlMatch[0]) {
    console.log(`Found direct media URL in content: ${urlMatch[0]}`);
    return urlMatch[0];
  } else {
    console.log(`No direct media URLs found in content`);
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
  
  console.log(`No media found in message`);
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