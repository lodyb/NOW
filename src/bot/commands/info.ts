import { Message } from 'discord.js';
import { safeReply } from '../utils/helpers';
import { findMediaBySearch, getUserById } from '../../database/db';
import fs from 'fs';
import path from 'path';

export const handleInfoCommand = async (message: Message, searchTerm: string) => {
  try {
    if (!searchTerm.trim()) {
      await safeReply(message, 'Please provide a search term. Usage: `NOW info <search term>`');
      return;
    }

    const media = await findMediaBySearch(searchTerm, false, 1);
    
    if (media.length === 0) {
      await safeReply(message, `No media found for "${searchTerm}"`);
      return;
    }

    const item = media[0];
    
    // Get file size from the original file
    const originalPath = path.join(process.cwd(), 'uploads', path.basename(item.filePath));
    let fileSize = 'Unknown';
    let fileSizeBytes = 0;
    
    if (fs.existsSync(originalPath)) {
      const stats = fs.statSync(originalPath);
      fileSizeBytes = stats.size;
      fileSize = formatFileSize(fileSizeBytes);
    }

    // Get uploader info
    let uploaderInfo = 'Unknown';
    if (item.uploaderId) {
      try {
        const uploader = await getUserById(item.uploaderId);
        uploaderInfo = uploader ? uploader.username : 'Unknown User';
      } catch (error) {
        console.error('Error getting uploader info:', error);
      }
    } else if (item.metadata && typeof item.metadata === 'object' && 'uploader' in item.metadata) {
      uploaderInfo = item.metadata.uploader as string;
    }

    // Format creation date
    const createdDate = item.createdAt ? new Date(item.createdAt).toLocaleDateString() : 'Unknown';
    
    // Get media type
    const isVideo = item.normalizedPath?.endsWith('.mp4') || false;
    const mediaType = isVideo ? 'Video' : 'Audio';
    
    // Create info message
    const infoLines = [
      `**${item.title}**`,
      `**Type:** ${mediaType}`,
      `**Uploaded by:** ${uploaderInfo}`,
      `**Date:** ${createdDate}`,
      `**File size:** ${fileSize}`,
      `**Answers:** ${item.answers.join(', ')}`,
    ];

    // Add additional metadata if available
    if (item.metadata && typeof item.metadata === 'object') {
      if ('source' in item.metadata) {
        infoLines.push(`**Source:** ${item.metadata.source}`);
      }
      if ('originalFilename' in item.metadata) {
        infoLines.push(`**Original filename:** ${item.metadata.originalFilename}`);
      }
    }

    await safeReply(message, infoLines.join('\n'));

  } catch (error) {
    console.error('Error with info command:', error);
    await safeReply(message, `Error retrieving media info: ${(error as Error).message}`);
  }
};

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}