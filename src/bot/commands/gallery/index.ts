import { Message, User, AttachmentBuilder, MessageReaction, PartialMessageReaction, PartialUser } from 'discord.js';
import { safeReply } from '../../utils/helpers';
import { getUserGalleryItems, saveGalleryItem, checkGalleryItem, removeGalleryItem } from '../../../database/db';
import { getBaseUrl } from '../../../utils/network';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import crypto from 'crypto';

// Directory to store gallery media files
const GALLERY_DIR = path.join(process.cwd(), 'gallery');

// Ensure gallery directory exists
if (!fs.existsSync(GALLERY_DIR)) {
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
  console.log('Created gallery directory at', GALLERY_DIR);
}

/**
 * Handle the gallery command - shows a user's media collection
 */
export const handleGalleryCommand = async (message: Message, targetUser?: User) => {
  try {
    // Default to the author if no user is specified
    const user = targetUser || message.author;
    const baseUrl = await getBaseUrl();
    const galleryUrl = `${baseUrl}/gallery/${user.id}`;
    
    await safeReply(message, `🖼️ ${user.id === message.author.id ? 'Your' : `${user.username}'s`} gallery is available at ${galleryUrl}`);
  } catch (error) {
    console.error('Error handling gallery command:', error);
    await safeReply(message, `Error accessing gallery: ${(error as Error).message}`);
  }
};

/**
 * Handle a user adding the frog emoji reaction to a message
 */
export const handleGalleryReaction = async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
  try {
    // Ignore reactions from bots
    if (user.bot) return;
    
    // Get the full reaction if needed
    const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
    const message = fullReaction.message.partial ? await fullReaction.message.fetch() : fullReaction.message;
    
    // Check if this message-user combination is already in the gallery
    const alreadyExists = await checkGalleryItem(user.id, message.id);
    if (alreadyExists) return; // Skip if already added
    
    // Look for media attachments or embeds in the message
    let mediaUrl: string | null = null;
    let mediaType: string = 'unknown';
    
    // Check for attachments
    if (message.attachments.size > 0) {
      const attachment = message.attachments.first();
      if (attachment) {
        mediaUrl = attachment.url;
        if (attachment.contentType?.startsWith('image/')) {
          mediaType = 'image';
        } else if (attachment.contentType?.startsWith('video/')) {
          mediaType = 'video';
        } else if (attachment.contentType?.startsWith('audio/')) {
          mediaType = 'audio';
        }
      }
    }
    // If no attachment, check for embeds
    else if (message.embeds.length > 0) {
      const embed = message.embeds[0];
      if (embed.image) {
        mediaUrl = embed.image.url;
        mediaType = 'image';
      } else if (embed.video) {
        mediaUrl = embed.video.url;
        mediaType = 'video';
      }
    }
    
    // If no media found, ignore
    if (!mediaUrl) return;
    
    // Create a unique filename
    const randomId = crypto.randomBytes(8).toString('hex');
    const urlObj = new URL(mediaUrl);
    const originalFilename = path.basename(urlObj.pathname);
    const extension = path.extname(originalFilename);
    const filename = `${randomId}${extension}`;
    const filePath = path.join(GALLERY_DIR, filename);
    
    // Download the file
    const response = await fetch(mediaUrl);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buffer));
    
    // Save to the database
    await saveGalleryItem({
      userId: user.id,
      messageId: message.id,
      guildId: message.guildId || '',
      filePath: filename,
      mediaType,
      sourceUrl: mediaUrl
    });
    
    // Send ephemeral confirmation to the user when possible
    try {
      await user.send(`✅ Added media to your gallery from ${message.url}`);
    } catch (err) {
      console.log(`Couldn't send DM to user ${user.username}: ${err}`);
    }
    
  } catch (error) {
    console.error('Error handling gallery reaction:', error);
    // Don't send error messages to avoid spam - just log them
  }
};

/**
 * Handle a user removing the frog emoji reaction from a message
 */
export const handleGalleryReactionRemove = async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
  try {
    // Ignore reactions from bots
    if (user.bot) return;
    
    const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
    const message = fullReaction.message.partial ? await fullReaction.message.fetch() : fullReaction.message;
    
    // Remove from the user's gallery
    const removed = await removeGalleryItem(user.id, message.id);
    
    if (removed) {
      // Send ephemeral confirmation to the user when possible
      try {
        await user.send(`🗑️ Removed media from your gallery from ${message.url}`);
      } catch (err) {
        console.log(`Couldn't send DM to user ${user.username}: ${err}`);
      }
    }
  } catch (error) {
    console.error('Error handling gallery reaction removal:', error);
  }
};