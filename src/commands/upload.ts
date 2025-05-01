import { Message, Client, AttachmentBuilder } from 'discord.js';
import { logger } from '../utils/logger';

/**
 * Handles the upload command
 * Provides a link to the web interface for uploading media files
 */
export async function uploadCommand(message: Message<boolean>, client: Client): Promise<void> {
  try {
    // Get the configured upload URL from environment variables or use the new direct API URL
    const uploadUrl = process.env.UPLOAD_URL || 'http://localhost:3000';
    
    // Generate a unique token for the upload session
    const uploadToken = generateUploadToken(message.author.id);
    
    // Create the full URL with the token - note that we're using the root path
    // which will serve the upload.html page in our new server.js implementation
    const fullUploadUrl = `${uploadUrl}?token=${uploadToken}&user=${message.author.id}`;
    
    // Send the upload link as an embedded message
    await message.reply({
      embeds: [{
        title: '📤 Upload Media Files',
        description: 'Click the link below to access the upload interface:',
        url: fullUploadUrl,
        color: 0x4caf50,
        fields: [
          {
            name: 'Features',
            value: [
              '• Batch upload support',
              '• Automatic volume normalization',
              '• Discord compatibility ensured',
              '• Progress tracking'
            ].join('\n')
          },
          {
            name: 'Instructions',
            value: [
              '1. Click the link above',
              '2. Select files to upload',
              '3. Add titles for each file',
              '4. Submit the form'
            ].join('\n')
          }
        ],
        footer: {
          text: 'This link is unique to you and will expire in 24 hours'
        }
      }]
    });
    
    logger.info(`User ${message.author.tag} requested upload link`);
  } catch (error) {
    logger.error(`Error in upload command: ${error instanceof Error ? error.message : String(error)}`);
    message.reply('An error occurred while generating upload link. Please try again later.');
  }
}

/**
 * Generates a secure token for upload authentication
 */
function generateUploadToken(userId: string): string {
  const crypto = require('crypto');
  const secret = process.env.UPLOAD_SECRET || 'default-secret-key';
  
  // Create a token that expires in 24 hours
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  const data = `${userId}-${expires}`;
  
  // Create an HMAC signature
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(data);
  const signature = hmac.digest('hex');
  
  // Combine into a token
  return Buffer.from(`${data}-${signature}`).toString('base64');
}