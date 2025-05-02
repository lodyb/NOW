import { Message } from 'discord.js';
import { safeReply } from '../utils/helpers';

export const handleUploadCommand = async (message: Message) => {
  try {
    // Generate URL to the root SPA instead of /upload
    const uploadUrl = `http://localhost:3000/?user=${message.author.id}`;
    
    await safeReply(message,
      `You can upload and manage media files here: ${uploadUrl}\n` +
      `Drag files to the upload area at the top of the page. Enter each answer on a new line.`
    );
  } catch (error) {
    console.error('Error with upload command:', error);
    await safeReply(message, `Failed to generate upload link: ${(error as Error).message}`);
  }
};