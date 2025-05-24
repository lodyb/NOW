import { Message } from 'discord.js';
import { safeReply } from '../utils/helpers';
import { saveMedia, saveMediaAnswers } from '../../database/db';
import { normalizeMedia } from '../../media/processor';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { Stream } from 'stream';
import { promisify } from 'util';
// @ts-ignore
import youtubeDl from 'youtube-dl-exec';

const TEMP_DIR = path.join(process.cwd(), 'temp');
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

// Ensure directories exist
[TEMP_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

export const handleUploadCommand = async (message: Message, searchTerm?: string) => {
  try {
    // Parse the command arguments
    const args = parseUploadArgs(message.content);
    
    if (!args.url && !message.reference) {
      // No URL and not a reply - show web upload link
      const uploadUrl = `http://localhost:3000/?user=${message.author.id}`;
      await safeReply(message,
        `You can upload and manage media files here: ${uploadUrl}\n` +
        `Or use: \`NOW upload <url> "answer1" "answer2"\` to upload directly from Discord.`
      );
      return;
    }

    const statusMessage = await message.reply('Processing upload... ⏳');

    let mediaInfo: { filePath: string; title: string } | null = null;

    // Get media from URL or replied message
    if (args.url) {
      mediaInfo = await downloadMediaFromUrl(args.url);
    } else if (message.reference) {
      mediaInfo = await extractMediaFromReply(message);
    }

    if (!mediaInfo) {
      await statusMessage.edit('❌ No valid media found. Please provide a YouTube URL, direct media link, or reply to a message with media.');
      return;
    }

    await statusMessage.edit('Saving to database... 💾');

    // Move file to uploads directory
    const randomId = crypto.randomBytes(8).toString('hex');
    const extension = path.extname(mediaInfo.filePath);
    const uploadFileName = `upload_${randomId}${extension}`;
    const uploadPath = path.join(UPLOADS_DIR, uploadFileName);
    
    fs.renameSync(mediaInfo.filePath, uploadPath);

    // Determine answers
    let answers = args.answers;
    if (answers.length === 0) {
      // Use title or filename as default answer
      const defaultAnswer = mediaInfo.title || path.basename(mediaInfo.filePath, extension);
      answers = [defaultAnswer.replace(/[-_]/g, ' ')];
    }

    // Save to database
    const mediaId = await saveMedia(
      answers[0], // Use first answer as title
      uploadPath,
      null, // normalizedPath will be set after processing
      null, // year
      { uploader: message.author.username, source: args.url || 'Discord attachment' },
      message.author.id // Pass uploaderId
    );

    await saveMediaAnswers(mediaId, answers);

    await statusMessage.edit('Processing media for Discord compatibility... ⚙️');

    // Normalize media asynchronously
    normalizeMedia(uploadPath, (normalizedPath: string) => {
      // Update database with normalized path
      const db = require('../../database/db').db;
      db.run(`UPDATE media SET normalizedPath = ? WHERE id = ?`, [path.basename(normalizedPath), mediaId]);
    }).catch(error => {
      console.error('Error normalizing media:', error);
    });

    await statusMessage.edit(`✅ Successfully uploaded "${answers[0]}" with ${answers.length} answer(s)!\nMedia is being processed and will be available for use shortly.`);

  } catch (error) {
    console.error('Error with upload command:', error);
    await safeReply(message, `❌ Upload failed: ${(error as Error).message}`);
  }
};

interface UploadArgs {
  url?: string;
  answers: string[];
}

function parseUploadArgs(content: string): UploadArgs {
  // Remove the "NOW upload" prefix
  const args = content.replace(/^NOW\s+upload\s*/i, '').trim();
  
  if (!args) {
    return { answers: [] };
  }

  // Extract quoted answers
  const quotedAnswers: string[] = [];
  const quoteRegex = /"([^"]+)"/g;
  let match;
  
  while ((match = quoteRegex.exec(args)) !== null) {
    quotedAnswers.push(match[1].trim());
  }

  // Remove quotes to get the URL
  const urlPart = args.replace(/"[^"]+"/g, '').trim();
  
  // Check if there's a URL
  const urlMatch = urlPart.match(/(https?:\/\/[^\s]+)/);
  const url = urlMatch ? urlMatch[1] : undefined;

  return {
    url,
    answers: quotedAnswers
  };
}

async function downloadMediaFromUrl(url: string): Promise<{ filePath: string; title: string } | null> {
  try {
    // Check if it's a YouTube URL
    if (isYouTubeUrl(url)) {
      return await downloadYouTubeVideo(url);
    } else {
      // Try direct media download
      return await downloadDirectMedia(url);
    }
  } catch (error) {
    console.error('Error downloading media from URL:', error);
    throw new Error(`Failed to download media: ${(error as Error).message}`);
  }
}

function isYouTubeUrl(url: string): boolean {
  const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;
  return youtubeRegex.test(url);
}

async function downloadYouTubeVideo(url: string): Promise<{ filePath: string; title: string } | null> {
  try {
    console.log(`Downloading YouTube video: ${url}`);
    
    const randomId = crypto.randomBytes(8).toString('hex');
    const filePath = path.join(TEMP_DIR, `youtube_${randomId}.mp4`);
    
    // Download with best quality under 720p
    await youtubeDl(url, {
      output: filePath,
      format: 'best[ext=mp4][height<=720]/bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      limitRate: '5M',
      noPlaylist: true,
    });

    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      throw new Error('YouTube download failed - no file created');
    }

    // Get video title
    let title = 'YouTube Video';
    try {
      const info = await youtubeDl(url, {
        skipDownload: true,
        dumpSingleJson: true,
        noPlaylist: true,
      });
      
      if (info && typeof info === 'object' && 'title' in info) {
        title = info.title as string;
      }
    } catch (error) {
      console.error('Error getting video title:', error);
    }

    return { filePath, title };
  } catch (error) {
    console.error('Error downloading YouTube video:', error);
    return null;
  }
}

async function downloadDirectMedia(url: string): Promise<{ filePath: string; title: string } | null> {
  try {
    const streamPipeline = promisify(Stream.pipeline);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    
    // Check if it's a valid media type
    if (!contentType.includes('video/') && !contentType.includes('audio/')) {
      throw new Error('URL does not point to a valid video or audio file');
    }

    // Determine file extension
    let extension = '.mp4';
    if (contentType.includes('video/mp4')) extension = '.mp4';
    else if (contentType.includes('video/webm')) extension = '.webm';
    else if (contentType.includes('audio/mpeg')) extension = '.mp3';
    else if (contentType.includes('audio/ogg')) extension = '.ogg';
    else if (contentType.includes('audio/wav')) extension = '.wav';

    const randomId = crypto.randomBytes(8).toString('hex');
    const filePath = path.join(TEMP_DIR, `download_${randomId}${extension}`);
    
    const fileStream = fs.createWriteStream(filePath);
    await streamPipeline(response.body, fileStream);

    // Extract filename from URL for title
    const urlPath = new URL(url).pathname;
    const filename = path.basename(urlPath, extension) || 'Downloaded Media';

    return { filePath, title: filename };
  } catch (error) {
    console.error('Error downloading direct media:', error);
    return null;
  }
}

async function extractMediaFromReply(message: Message): Promise<{ filePath: string; title: string } | null> {
  try {
    if (!message.reference?.messageId) {
      return null;
    }

    const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
    
    // Check for attachments
    if (repliedMessage.attachments.size > 0) {
      const attachment = repliedMessage.attachments.first()!;
      const contentType = attachment.contentType || '';
      
      if (contentType.startsWith('video/') || contentType.startsWith('audio/')) {
        const downloadedFile = await downloadDirectMedia(attachment.url);
        if (downloadedFile) {
          return {
            filePath: downloadedFile.filePath,
            title: attachment.name || downloadedFile.title
          };
        }
      }
    }

    // Check for URLs in the message content
    const urlMatch = repliedMessage.content.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) {
      return await downloadMediaFromUrl(urlMatch[1]);
    }

    return null;
  } catch (error) {
    console.error('Error extracting media from reply:', error);
    return null;
  }
}