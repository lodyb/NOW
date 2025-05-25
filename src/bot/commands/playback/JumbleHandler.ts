import { Message, AttachmentBuilder } from 'discord.js';
import { saveJumbleInfo } from '../../../database/db';
import { processMedia, isVideoFile, getMediaInfo, ProcessOptions, parseFilterString } from '../../../media/processor';
import { processFilterChainRobust } from '../../../media/chainProcessor';
import { safeReply } from '../../utils/helpers';
import { MediaService, FileService, StatusService } from '../../services';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { processMediaCommand } from '../mediaCommand';
import fetch from 'node-fetch';
import { Stream } from 'stream';
import { promisify } from 'util';
import crypto from 'crypto';
import youtubeDl from 'youtube-dl-exec';

// Directory for temporary downloads
const TEMP_DIR = path.join(process.cwd(), 'temp');

export async function handleJumblePlayback(
  message: Message,
  searchTerm?: string,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string }
): Promise<void> {
  const updateStatus = StatusService.createEphemeralStatusUpdater(message);
  let finalStatusMessage: Message | null = null;
  
  try {
    await updateStatus('Finding video and audio sources for jumble... ⏳');
    
    let videoResults: any[] = [];
    let allAudioResults: any[] = [];
    
    // If no search term provided, get random video and audio from the entire library
    if (!searchTerm || searchTerm.trim() === '') {
      // Get all video media
      videoResults = await MediaService.findMedia(undefined, true, 50);
      if (videoResults.length === 0) {
        await updateStatus('No video sources found in the library');
        return;
      }
      
      // Get all audio media (including videos with audio)
      allAudioResults = await MediaService.findMedia(undefined, false, 50);
      if (allAudioResults.length === 0) {
        await updateStatus('No audio sources found in the library');
        return;
      }
    } else {
      // Get video media that matches the search term
      videoResults = await MediaService.findMedia(searchTerm, true, 10);
      if (videoResults.length === 0) {
        await updateStatus('No video sources found matching your search');
        return;
      }
      
      // Get ALL audio media from the library (not just matching search) to maximize variety
      allAudioResults = await MediaService.findMedia(undefined, false, 50);
      if (allAudioResults.length === 0) {
        await updateStatus('No audio sources found in the library');
        return;
      }
    }
    
    // Select random video from results
    const videoMedia = videoResults[Math.floor(Math.random() * videoResults.length)];
    
    // Filter audio results to avoid using the same file as both video and audio source
    // This is important for media that has both video and audio tracks
    const availableAudioSources = allAudioResults.filter(m => m.id !== videoMedia.id);
    
    // Ensure we have at least one different audio source
    if (availableAudioSources.length === 0) {
      await updateStatus('⚠️ Only one media file found. Jumble requires at least 2 different media sources for mixing video and audio.');
      return;
    }
    
    const audioMedia = availableAudioSources[Math.floor(Math.random() * availableAudioSources.length)];
    
    await updateStatus(`Found "${videoMedia.title}" (video) and "${audioMedia.title}" (audio). Preparing to jumble... ⏳`);
    
    const videoPath = MediaService.resolveMediaPath(videoMedia);
    const audioPath = MediaService.resolveMediaPath(audioMedia);
    
    if (!MediaService.validateMediaExists(videoPath)) {
      await updateStatus(`Video file "${videoMedia.title}" not found on disk`);
      return;
    }
    
    if (!MediaService.validateMediaExists(audioPath)) {
      await updateStatus(`Audio file "${audioMedia.title}" not found on disk`);
      return;
    }
    
    // Extract media info with error handling
    let videoDuration = 0;
    let audioDuration = 0;
    
    try {
      const videoInfo = await getMediaInfo(videoPath);
      videoDuration = videoInfo.duration || 0;
      
      const audioInfo = await getMediaInfo(audioPath);
      audioDuration = audioInfo.duration || 0;
      
      if (!videoDuration || !audioDuration) {
        await updateStatus('Could not determine media durations');
        return;
      }
    } catch (error) {
      console.error('Error getting media info:', error);
      await updateStatus(`Error analyzing media: ${truncateError(error)}`);
      return;
    }
    
    // Calculate max clip duration (use clip duration from options if provided)
    let maxClipDuration = Math.min(30, videoDuration, audioDuration);
    if (clipOptions?.duration) {
      const requestedDuration = parseFloat(clipOptions.duration);
      if (!isNaN(requestedDuration)) {
        maxClipDuration = Math.min(maxClipDuration, requestedDuration);
      }
    }
    
    // Calculate start times (use start time from options if provided)
    let videoStartTime = videoDuration > maxClipDuration 
      ? Math.floor(Math.random() * (videoDuration - maxClipDuration)) 
      : 0;
      
    let audioStartTime = audioDuration > maxClipDuration 
      ? Math.floor(Math.random() * (audioDuration - maxClipDuration)) 
      : 0;
    
    if (clipOptions?.start) {
      const requestedStart = parseFloat(clipOptions.start);
      if (!isNaN(requestedStart)) {
        videoStartTime = Math.min(requestedStart, videoDuration - maxClipDuration);
        audioStartTime = Math.min(requestedStart, audioDuration - maxClipDuration);
      }
    }
    
    // Save jumble info for the 'what was that' command
    await saveJumbleInfo({
      userId: message.author.id,
      guildId: message.guildId || '',
      videoId: videoMedia.id,
      videoTitle: videoMedia.title,
      videoStart: videoStartTime,
      videoDuration: maxClipDuration,
      audioId: audioMedia.id,
      audioTitle: audioMedia.title,
      audioStart: audioStartTime,
      audioDuration: maxClipDuration,
      timestamp: Date.now()
    });
    
    const randomId = FileService.generateCryptoId();
    const tempDir = MediaService.getTempDir();
    
    const videoClipPath = path.join(tempDir, `video_clip_${randomId}.mp4`);
    const audioClipPath = path.join(tempDir, `audio_clip_${randomId}.aac`);
    const outputPath = path.join(tempDir, `jumble_${randomId}.mp4`);
    
    try {
      await updateStatus(`Creating video clip from "${videoMedia.title}"... ⏳`);
      await createVideoClip(videoPath, videoClipPath, videoStartTime, maxClipDuration);
      
      await updateStatus(`Video clip created, extracting audio from "${audioMedia.title}"... ⏳`);
      await createAudioClip(audioPath, audioClipPath, audioStartTime, maxClipDuration);
      
      await updateStatus('Combining clips... ⏳');
      await combineVideoAndAudio(videoClipPath, audioClipPath, outputPath);
    } catch (error) {
      console.error('Error processing media clips:', error);
      await updateStatus(`❌ Error processing media clips: ${truncateError(error)}`);
      FileService.cleanupTempFiles([videoClipPath, audioClipPath, outputPath]);
      return;
    }
    
    let finalPath = outputPath;
    let appliedFilters: string[] = [];
    let skippedFilters: string[] = [];
    
    try {
      if (filterString?.trim()) {
        await updateStatus('Applying additional filters... ⏳');
        const finalOutputFilename = `final_jumble_${randomId}.mp4`;
        
        const result = await processFilterChainRobust(
          outputPath,
          finalOutputFilename,
          filterString.startsWith('{') ? filterString : `{${filterString}}`,
          undefined,
          async (stage, progress) => {
            await updateStatus(`${stage} (${Math.round(progress * 100)}%)... ⏳`);
          },
          false // Don't enforce Discord limits for jumble playback
        );
        
        finalPath = result.path;
        appliedFilters = result.appliedFilters;
        skippedFilters = result.skippedFilters;
      } else {
        await updateStatus('Optimizing for Discord... ⏳');
        const finalOutputFilename = `final_jumble_${randomId}.mp4`;
        
        const result = await processFilterChainRobust(
          outputPath,
          finalOutputFilename,
          undefined,
          undefined,
          async (stage, progress) => {
            await updateStatus(`${stage} (${Math.round(progress * 100)}%)... ⏳`);
          },
          false // Don't enforce Discord limits for jumble without filters
        );
        
        finalPath = result.path;
      }
    } catch (error) {
      console.error('Error processing final media:', error);
      await updateStatus(`❌ Error optimizing media for Discord: ${truncateError(error)}`);
      FileService.cleanupTempFiles([videoClipPath, audioClipPath, outputPath]);
      return;
    }
    
    if (!MediaService.validateMediaExists(finalPath)) {
      await updateStatus('❌ Failed to create final jumble video');
      FileService.cleanupTempFiles([videoClipPath, audioClipPath, outputPath]);
      return;
    }
    
    await updateStatus('Jumble complete! Uploading... 📤');
    
    try {
      const attachment = new AttachmentBuilder(finalPath);
      
      // Create the final message content
      let messageContent = `Jumbled video from "${videoMedia.title}" with audio from "${audioMedia.title}" 🎬+🔊`;
      if (skippedFilters.length > 0) {
        messageContent += `\n⚠️ Some filters were skipped: ${skippedFilters.join(', ')}`;
      }
      
      // Send the final result to everyone (not ephemeral)
      await safeReply(message, { 
        content: messageContent,
        files: [attachment] 
      });
      
      // Clean up the ephemeral status message
      if (!message.interaction && finalStatusMessage) {
        await StatusService.deleteStatusMessage(finalStatusMessage);
      }
      
    } catch (error) {
      console.error('Error sending attachment:', error);
      await updateStatus(`❌ Error uploading jumble: ${truncateError(error)}`);
    } finally {
      // Cleanup temp files
      FileService.cleanupTempFiles([videoClipPath, audioClipPath, outputPath, finalPath]);
    }
  } catch (error) {
    console.error('Error handling jumble playback:', error);
    await updateStatus(`❌ Error creating jumble: ${(error as Error).message}`);
  }
}

/**
 * Handle jumble functionality for the remix command
 * Combines video from a message with audio from the database or vice versa
 */
export async function handleJumbleRemix(
  message: Message,
  filterString?: string,
  clipOptions?: { duration?: string; start?: string }
): Promise<void> {
  const updateStatus = StatusService.createEphemeralStatusUpdater(message);
  
  try {
    await updateStatus('Processing message media for jumble... ⏳');
    
    // Check direct YouTube URL in command text first
    const youtubeUrl = extractYoutubeUrl(message.content);
    let mediaInfo = null;
    
    if (youtubeUrl) {
      await updateStatus(`Detected YouTube URL, downloading... ⏳`);
      try {
        mediaInfo = await downloadYouTubeVideo(youtubeUrl);
        if (!mediaInfo) {
          await updateStatus('❌ Failed to download YouTube video. Try a different URL.');
          return;
        }
      } catch (error) {
        console.error('YouTube download error:', error);
        await updateStatus(`❌ Error downloading YouTube video: ${(error as Error).message?.substring(0, 200) || 'Unknown error'}`);
        return;
      }
    } else {
      // Get message to process (either message being replied to or current message)
      const targetMessage = message.reference?.messageId 
        ? await message.channel.messages.fetch(message.reference.messageId).catch(() => null)
        : message;

      if (!targetMessage) {
        await updateStatus('❌ Could not find the message to remix. Make sure you\'re replying to a message with media or provide a YouTube URL.');
        return;
      }
      
      // Extract media from the message
      mediaInfo = await extractMediaFromMessage(targetMessage);
      if (!mediaInfo || !mediaInfo.filePath) {
        await updateStatus('❌ No media found in the message to jumble with. Try replying to a message with media or provide a YouTube URL.');
        return;
      }
    }
    
    // Verify we have valid media
    let isMessageVideo = false;
    try {
      isMessageVideo = await isVideoFile(mediaInfo.filePath);
    } catch (error) {
      console.error('Error checking if file is video:', error);
      await updateStatus(`❌ Error processing media: ${truncateError(error)}`);
      return;
    }
    
    await updateStatus(`Found ${isMessageVideo ? 'video' : 'audio'} source, looking for a ${isMessageVideo ? 'audio' : 'video'} to jumble with... ⏳`);
    
    // Search for complementary media in the database
    const dbResults = await MediaService.findMedia('', !isMessageVideo, 10); // Find opposite type
    if (dbResults.length === 0) {
      await updateStatus(`❌ No ${isMessageVideo ? 'audio' : 'video'} sources found in the database to jumble with.`);
      return;
    }
    
    // Select a random media item from the database
    const dbMedia = dbResults[Math.floor(Math.random() * dbResults.length)];
    const dbMediaPath = MediaService.resolveMediaPath(dbMedia);
    
    if (!MediaService.validateMediaExists(dbMediaPath)) {
      await updateStatus('❌ The selected media file could not be found on disk.');
      return;
    }
    
    const { filePath: messageMediaPath, title: messageMediaTitle } = mediaInfo;
    
    // Get media info with error handling
    let messageMediaDuration = 0;
    let dbMediaDuration = 0;
    
    try {
      const messageMediaInfo = await getMediaInfo(messageMediaPath);
      messageMediaDuration = messageMediaInfo.duration || 0;
      
      const dbMediaInfo = await getMediaInfo(dbMediaPath);
      dbMediaDuration = dbMediaInfo.duration || 0;
      
      if (!messageMediaDuration || !dbMediaDuration) {
        await updateStatus('❌ Could not determine media durations');
        return;
      }
    } catch (error) {
      console.error('Error getting media info:', error);
      await updateStatus(`❌ Error analyzing media: ${truncateError(error)}`);
      return;
    }
    
    // Calculate clip durations
    const maxClipDuration = Math.min(30, messageMediaDuration, dbMediaDuration);
    const messageStartTime = messageMediaDuration > maxClipDuration 
      ? Math.floor(Math.random() * (messageMediaDuration - maxClipDuration)) 
      : 0;
    const dbStartTime = dbMediaDuration > maxClipDuration 
      ? Math.floor(Math.random() * (dbMediaDuration - maxClipDuration)) 
      : 0;
    
    // Set the video and audio sources based on the message media type
    const videoPath = isMessageVideo ? messageMediaPath : dbMediaPath;
    const audioPath = isMessageVideo ? dbMediaPath : messageMediaPath;
    const videoTitle = isMessageVideo ? messageMediaTitle || 'Message video' : dbMedia.title;
    const audioTitle = isMessageVideo ? dbMedia.title : messageMediaTitle || 'Message audio';
    const videoId = isMessageVideo ? 0 : dbMedia.id; // Use 0 for message media since it's not in DB
    const audioId = isMessageVideo ? dbMedia.id : 0;
    
    // Save jumble info for what-was-that command
    try {
      await saveJumbleInfo({
        userId: message.author.id,
        guildId: message.guildId || '',
        videoId,
        videoTitle,
        videoStart: isMessageVideo ? messageStartTime : dbStartTime,
        videoDuration: maxClipDuration,
        audioId, 
        audioTitle,
        audioStart: isMessageVideo ? dbStartTime : messageStartTime,
        audioDuration: maxClipDuration,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Error saving jumble info:', error);
      // Continue even if this fails
    }
    
    const randomId = FileService.generateCryptoId();
    const tempDir = MediaService.getTempDir();
    
    const videoClipPath = path.join(tempDir, `video_clip_${randomId}.mp4`);
    const audioClipPath = path.join(tempDir, `audio_clip_${randomId}.aac`);
    const outputPath = path.join(tempDir, `jumble_${randomId}.mp4`);
    
    try {
      await updateStatus('Creating video clip... ⏳');
      await createVideoClip(videoPath, videoClipPath, messageStartTime, maxClipDuration);
      
      await updateStatus('Video clip created, extracting audio... ⏳');
      await createAudioClip(audioPath, audioClipPath, dbStartTime, maxClipDuration);
      
      await updateStatus('Combining clips... ⏳');
      await combineVideoAndAudio(videoClipPath, audioClipPath, outputPath);
    } catch (error) {
      console.error('Error processing media clips:', error);
      await updateStatus(`❌ Error processing media clips: ${truncateError(error)}`);
      FileService.cleanupTempFiles([videoClipPath, audioClipPath, outputPath, messageMediaPath]);
      return;
    }
    
    let finalPath = outputPath;
    let appliedFilters: string[] = [];
    let skippedFilters: string[] = [];
    
    try {
      if (filterString?.trim()) {
        await updateStatus('Applying additional filters... ⏳');
        const finalOutputFilename = `final_jumble_${randomId}.mp4`;
        
        const result = await processFilterChainRobust(
          outputPath,
          finalOutputFilename,
          filterString.startsWith('{') ? filterString : `{${filterString}}`,
          undefined,
          async (stage, progress) => {
            await updateStatus(`${stage} (${Math.round(progress * 100)}%)... ⏳`);
          },
          false // Don't enforce Discord limits for jumble remix
        );
        
        finalPath = result.path;
        appliedFilters = result.appliedFilters;
        skippedFilters = result.skippedFilters;
      } else {
        await updateStatus('Optimizing for Discord... ⏳');
        const finalOutputFilename = `final_jumble_${randomId}.mp4`;
        
        const result = await processFilterChainRobust(
          outputPath,
          finalOutputFilename,
          undefined,
          undefined,
          async (stage, progress) => {
            await updateStatus(`${stage} (${Math.round(progress * 100)}%)... ⏳`);
          },
          false // Don't enforce Discord limits for jumble without filters
        );
        
        finalPath = result.path;
      }
    } catch (error) {
      console.error('Error processing final media:', error);
      await updateStatus(`❌ Error optimizing media for Discord: ${truncateError(error)}`);
      FileService.cleanupTempFiles([videoClipPath, audioClipPath, outputPath, messageMediaPath]);
      return;
    }
    
    if (!MediaService.validateMediaExists(finalPath)) {
      await updateStatus('❌ Failed to create final jumble video');
      FileService.cleanupTempFiles([videoClipPath, audioClipPath, outputPath, messageMediaPath]);
      return;
    }
    
    await updateStatus('Jumble remix complete! Uploading... 📤');
    
    try {
      const attachment = new AttachmentBuilder(finalPath);
      
      let messageContent = isMessageVideo 
        ? `Jumbled video from ${youtubeUrl ? 'YouTube' : 'message'} with audio from "${audioTitle}" 🎬+🔊`
        : `Jumbled audio from ${youtubeUrl ? 'YouTube' : 'message'} with video from "${videoTitle}" 🔊+🎬`;
      
      if (skippedFilters.length > 0) {
        messageContent += `\n⚠️ Some filters were skipped: ${skippedFilters.join(', ')}`;
      }
      
      // Send the final result to everyone (not ephemeral)
      await safeReply(message, { 
        content: messageContent,
        files: [attachment] 
      });
      
    } catch (error) {
      console.error('Error sending attachment:', error);
      await updateStatus(`❌ Error uploading jumble remix: ${truncateError(error)}`);
    } finally {
      // Cleanup temp files
      FileService.cleanupTempFiles([videoClipPath, audioClipPath, outputPath, finalPath, messageMediaPath]);
    }
    
  } catch (error) {
    console.error('Error handling jumble remix:', error);
    await updateStatus(`❌ Error creating jumble remix: ${truncateError(error)}`);
  }
}

// Helper function to extract YouTube URL from message
function extractYoutubeUrl(content: string): string | null {
  // Support various YouTube URL formats
  const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;
  const match = content.match(youtubeRegex);
  return match ? match[0] : null;
}

// Helper function to download a YouTube video using youtube-dl-exec
async function downloadYouTubeVideo(url: string): Promise<{ filePath: string; title?: string } | null> {
  try {
    console.log(`Downloading YouTube video: ${url}`);
    
    // Generate a temp file path
    const randomId = crypto.randomBytes(8).toString('hex');
    const filePath = path.join(TEMP_DIR, `youtube_${randomId}.mp4`);
    
    // First attempt - best mp4 format with height <= 720p
    try {
      await youtubeDl(url, {
        output: filePath,
        format: 'best[ext=mp4][height<=720]/bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        limitRate: '5M',
        noPlaylist: true,
      });
    } catch (error) {
      console.error('First download attempt failed:', error);
      
      // Second attempt - with more options
      try {
        await youtubeDl(url, {
          output: filePath,
          format: 'best',
          noPlaylist: true,
          addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'],
        });
      } catch (secondError) {
        console.error('Second download attempt failed:', secondError);
        throw new Error(`YouTube video download failed: ${(secondError as Error).message}`);
      }
    }
    
    // Verify file was downloaded
    if (!fs.existsSync(filePath)) {
      throw new Error('YouTube video download failed - file not created');
    }
    
    // Get file stats
    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      fs.unlinkSync(filePath);
      throw new Error('YouTube video download failed - zero byte file');
    }
    
    console.log(`Downloaded YouTube video to ${filePath} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
    
    // Try to get video title
    let videoTitle = 'YouTube video';
    try {
      const info = await youtubeDl(url, {
        skipDownload: true,
        dumpSingleJson: true,
        noPlaylist: true,
      });
      
      // Handle type safety - info could be a string or object
      if (info && typeof info === 'object' && 'title' in info) {
        videoTitle = info.title as string;
      }
    } catch (error) {
      console.error('Error getting video info:', error);
      // Continue with default title
    }
    
    return {
      filePath,
      title: videoTitle
    };
  } catch (error) {
    console.error('Error downloading YouTube video:', error);
    return null;
  }
}

// Helper to truncate error messages to avoid Discord's character limit
function truncateError(error: unknown): string {
  const fullMessage = error instanceof Error ? error.message : String(error);
  // Extract just first line or truncate to reasonable size
  const firstLine = fullMessage.split('\n')[0];
  return firstLine.substring(0, 200);
}

function createVideoClip(inputPath: string, outputPath: string, startTime: number, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // First check if the file has a video stream
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        console.error('Error probing input file:', err);
        return reject(err);
      }

      // Check if file has video streams
      const videoStreams = metadata.streams?.filter(s => s.codec_type === 'video');
      if (!videoStreams || videoStreams.length === 0) {
        console.error('No video streams found in the input file');
        return reject(new Error('No video streams found in the input file'));
      }

      console.log(`Found ${videoStreams.length} video streams in input file`);
      
      // Get video dimensions if available
      const videoStream = videoStreams[0];
      const width = videoStream.width;
      const height = videoStream.height;
      
      // Create ffmpeg command with more robust options
      const command = ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(duration);
      
      // Add explicit dimensions if we have them
      if (width && height) {
        command.size(`${width}x${height}`);
      }
      
      // Add more robust output options
      command.outputOptions('-c:v libx264')   // H.264 video codec
        .outputOptions('-preset fast')      // Fast encoding preset
        .outputOptions('-crf 23')           // Constant Rate Factor for quality
        .outputOptions('-pix_fmt yuv420p')  // Pixel format for compatibility
        .outputOptions('-an')               // No audio
        .outputOptions('-y')                // Overwrite without asking
        .on('start', (commandLine) => {
          console.log('FFmpeg video command:', commandLine);
        })
        .on('end', () => {
          console.log('Video extraction completed');
          resolve();
        })
        .on('error', (err) => {
          console.error('Error extracting video:', err);
          
          // If first attempt fails, try again with more basic settings
          console.log('First attempt failed, trying with fallback options...');
          ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(duration)
            .outputOptions('-c:v libx264')
            .outputOptions('-preset ultrafast')  // Use simpler preset
            .outputOptions('-crf 28')           // Lower quality
            .outputOptions('-pix_fmt yuv420p')
            .outputOptions('-vf format=yuv420p') // Force pixel format
            .outputOptions('-an')
            .outputOptions('-y')
            .on('end', () => {
              console.log('Video extraction completed with fallback options');
              resolve();
            })
            .on('error', (secondErr) => {
              console.error('Error extracting video with fallback options:', secondErr);
              reject(secondErr);
            })
            .save(outputPath);
        })
        .save(outputPath);
    });
  });
}

function createAudioClip(inputPath: string, outputPath: string, startTime: number, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // First check if the file has an audio stream
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        console.error('Error probing input file:', err);
        return reject(err);
      }

      // Check if the file has audio streams
      const audioStreams = metadata.streams?.filter(s => s.codec_type === 'audio');
      if (!audioStreams || audioStreams.length === 0) {
        console.error('No audio streams found in the input file');
        return reject(new Error('No audio streams found in the input file'));
      }

      console.log(`Found ${audioStreams.length} audio streams in input file`);
      
      // Proceed with extracting audio
      ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(duration)
        .outputOptions('-vn')           // No video
        .outputOptions('-c:a aac')      // AAC audio codec
        .outputOptions('-b:a 192k')     // 192k bitrate
        .outputOptions('-ar 44100')     // 44.1kHz sampling rate
        .outputOptions('-ac 2')         // Stereo audio (2 channels)
        .outputOptions('-y')            // Overwrite output without asking
        .on('start', (commandLine) => {
          console.log('FFmpeg audio command:', commandLine);
        })
        .on('end', () => {
          console.log('Audio extraction completed');
          resolve();
        })
        .on('error', (err) => {
          console.error('Error extracting audio:', err);
          reject(err);
        })
        .save(outputPath);
    });
  });
}

function combineVideoAndAudio(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // First check if both inputs exist and are valid
    if (!fs.existsSync(videoPath)) {
      return reject(new Error(`Video file does not exist: ${videoPath}`));
    }
    if (!fs.existsSync(audioPath)) {
      return reject(new Error(`Audio file does not exist: ${audioPath}`));
    }

    console.log(`Combining video (${videoPath}) with audio (${audioPath})`);
    
    ffmpeg(videoPath)
      .input(audioPath)
      .outputOptions('-c:v libx264')   // Always encode to H.264 for Discord compatibility
      .outputOptions('-preset fast')   // Fast encoding preset
      .outputOptions('-crf 23')        // Good quality
      .outputOptions('-pix_fmt yuv420p') // Pixel format for compatibility
      .outputOptions('-c:a aac')       // Use AAC for audio
      .outputOptions('-b:a 192k')      // 192k bitrate for audio
      .outputOptions('-map 0:v:0')     // Take video from first input
      .outputOptions('-map 1:a:0')     // Take audio from second input
      .outputOptions('-shortest')      // End when shortest input ends
      .outputOptions('-y')             // Overwrite without asking
      .on('start', (commandLine) => {
        console.log('FFmpeg combine command:', commandLine);
      })
      .on('progress', (progress) => {
        // Log progress to help with debugging
        if (progress.percent && typeof progress.percent === 'number') {
          console.log(`Processing: ${Math.round(progress.percent)}% done`);
        }
      })
      .on('end', () => {
        console.log('Video and audio combined successfully');
        resolve();
      })
      .on('error', (err) => {
        console.error('Error combining video and audio:', err);
        
        // Try alternative approach if first attempt fails
        console.log('Trying alternative approach to combine video and audio...');
        ffmpeg(videoPath)
          .input(audioPath)
          .outputOptions('-c:v libx264')   // Re-encode video with h264
          .outputOptions('-crf 28')        // Lower quality for compatibility
          .outputOptions('-preset ultrafast') // Faster encoding
          .outputOptions('-pix_fmt yuv420p') // Force pixel format
          .outputOptions('-c:a aac')       // AAC audio
          .outputOptions('-strict experimental')
          .outputOptions('-shortest')
          .outputOptions('-y')
          .on('end', () => {
            console.log('Alternative combine approach succeeded');
            resolve();
          })
          .on('error', (secondErr) => {
            console.error('Alternative approach also failed:', secondErr);
            reject(new Error(`Failed to combine video and audio: ${err.message}`));
          })
          .save(outputPath);
      })
      .save(outputPath);
  });
}

/**
 * Extract media from a message (attachments, embeds, or links)
 */
async function extractMediaFromMessage(message: Message): Promise<{ filePath: string; title?: string } | null> {
  // Check message attachments first
  if (message.attachments.size > 0) {
    const attachment = message.attachments.first();
    if (attachment) {
      const url = attachment.url;
      const contentType = attachment.contentType || '';
      
      if (contentType.startsWith('video/') || 
          contentType.startsWith('audio/') || 
          contentType.startsWith('image/gif')) {
        const filePath = await downloadMedia(url);
        return filePath ? { filePath, title: attachment.name } : null;
      }
    }
  }
  
  // Check embeds for media links
  if (message.embeds.length > 0) {
    for (const embed of message.embeds) {
      let url = null;
      let title = embed.title || '';
      
      // Check for video in the embed
      if (embed.video) {
        url = embed.video.url;
      }
      // Check for an image in the embed (might be a gif)
      else if (embed.image) {
        url = embed.image.url;
      }
      
      if (url) {
        const filePath = await downloadMedia(url);
        return filePath ? { filePath, title } : null;
      }
    }
  }
  
  // Check message content for media links
  const urlRegex = /(https?:\/\/[^\s]+\.(mp4|mp3|ogg|wav|webm|gif))/i;
  const urlMatch = message.content.match(urlRegex);
  if (urlMatch && urlMatch[0]) {
    const filePath = await downloadMedia(urlMatch[0]);
    return filePath ? { filePath } : null;
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