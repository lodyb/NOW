import { Message } from 'discord.js';
import path from 'path';
import { AttachmentBuilder } from 'discord.js';
import { MediaService, FileService, StatusService } from '../../services';
import { safeReply } from '../../utils/helpers';
import { getMediaInfo, getDjFilters, isVideoFile } from '../../../media/processor';
import { 
  processFilterChainRobust, 
  processFilterChain 
} from '../../../media/chainProcessor';
import { saveDjInfo } from '../../../database/db';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';

/**
 * Handle DJ playback - combines random video + audio sources, clips them, 
 * then applies 2 random filters with retry logic
 */
export async function handleDjPlayback(
  message: Message,
  clipOptions?: { duration?: string; start?: string }
): Promise<void> {
  const updateStatus = StatusService.createStatusUpdater(message);
  
  try {
    await updateStatus('DJ mode activated! Finding video source... ⏳');
    
    // Get 1 random video source
    const videoResults = await MediaService.findMedia(undefined, true, 50);
    if (videoResults.length === 0) {
      await updateStatus('❌ No video sources found in the library');
      return;
    }
    
    await updateStatus('Finding audio source... ⏳');
    
    // Get 1 random audio/video source (for audio channel)
    const audioResults = await MediaService.findMedia(undefined, false, 50);
    if (audioResults.length === 0) {
      await updateStatus('❌ No audio sources found in the library');
      return;
    }
    
    // Randomly select sources
    const videoMedia = videoResults[Math.floor(Math.random() * videoResults.length)];
    const audioMedia = audioResults[Math.floor(Math.random() * audioResults.length)];
    
    const videoPath = MediaService.resolveMediaPath(videoMedia);
    const audioPath = MediaService.resolveMediaPath(audioMedia);
    
    if (!MediaService.validateMediaExists(videoPath)) {
      await updateStatus('❌ Video source file not found on disk');
      return;
    }
    
    if (!MediaService.validateMediaExists(audioPath)) {
      await updateStatus('❌ Audio source file not found on disk');
      return;
    }
    
    await updateStatus(`Analyzing "${videoMedia.title}" and "${audioMedia.title}"... ⏳`);
    
    // Get media durations
    let videoDuration = 0;
    let audioDuration = 0;
    
    try {
      const videoInfo = await getMediaInfo(videoPath);
      videoDuration = videoInfo.duration || 0;
      
      const audioInfo = await getMediaInfo(audioPath);
      audioDuration = audioInfo.duration || 0;
      
      if (!videoDuration || !audioDuration) {
        await updateStatus('❌ Could not determine media durations');
        return;
      }
    } catch (error) {
      console.error('Error getting media info:', error);
      await updateStatus(`❌ Error analyzing media: ${truncateError(error)}`);
      return;
    }
    
    // Calculate max clip duration (30s or shortest media length)
    let maxClipDuration = Math.min(30, videoDuration, audioDuration);
    if (clipOptions?.duration) {
      const requestedDuration = parseFloat(clipOptions.duration);
      if (!isNaN(requestedDuration)) {
        maxClipDuration = Math.min(maxClipDuration, requestedDuration);
      }
    }
    
    // Calculate random start times
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
    
    // Save DJ info for "what was that" command
    try {
      await saveDjInfo({
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
        timestamp: Date.now(),
        appliedFilters: [] // Will be updated after filters are applied
      });
    } catch (error) {
      console.error('Error saving DJ info:', error);
      // Continue even if this fails
    }
    
    const randomId = FileService.generateCryptoId();
    const tempDir = MediaService.getTempDir();
    
    const videoClipPath = path.join(tempDir, `video_clip_${randomId}.mp4`);
    const audioClipPath = path.join(tempDir, `audio_clip_${randomId}.aac`);
    const outputPath = path.join(tempDir, `dj_${randomId}.mp4`);
    
    try {
      await updateStatus(`Creating video clip from "${videoMedia.title}"... ⏳`);
      await createVideoClip(videoPath, videoClipPath, videoStartTime, maxClipDuration);
      
      await updateStatus(`Creating audio clip from "${audioMedia.title}"... ⏳`);
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
      await updateStatus('Applying DJ filters... ⏳');
      const finalOutputFilename = `final_dj_${randomId}.mp4`;
      
      // Get 2 random filters for DJ mode with retry logic
      const maxRetries = 3;
      let retryCount = 0;
      let djSuccess = false;
      const blacklistedFilters: string[] = [];
      
      while (!djSuccess && retryCount < maxRetries) {
        try {
          const djFilters = getDjFilters(blacklistedFilters);
          console.log(`DJ attempt ${retryCount + 1}: ${djFilters.join(', ')}`);
          
          const filterString = `{${djFilters.join(',')}}`;
          
          const result = await processFilterChainRobust(
            outputPath,
            finalOutputFilename,
            filterString,
            undefined,
            async (stage, progress) => {
              await updateStatus(`DJ filters (attempt ${retryCount + 1}): ${stage} (${Math.round(progress * 100)}%)... ⏳`);
            },
            true
          );
          
          finalPath = result.path;
          appliedFilters = djFilters;
          djSuccess = true;
          console.log(`✅ DJ filters applied successfully: ${djFilters.join(', ')}`);
          
        } catch (error) {
          console.error(`❌ DJ attempt ${retryCount + 1} failed:`, error);
          
          // Blacklist the failed filters and try again
          const djFilters = getDjFilters(blacklistedFilters);
          blacklistedFilters.push(...djFilters);
          retryCount++;
          
          if (retryCount >= maxRetries) {
            console.error('All DJ filter attempts failed, using original combined video');
            finalPath = outputPath;
            skippedFilters.push('dj-filters');
          }
        }
      }
      
    } catch (error) {
      console.error('Error processing DJ filters:', error);
      await updateStatus(`❌ Error applying DJ filters: ${truncateError(error)}`);
      finalPath = outputPath;
      skippedFilters.push('dj-filters');
    }
    
    if (!MediaService.validateMediaExists(finalPath)) {
      await updateStatus('❌ Failed to create final DJ video');
      FileService.cleanupTempFiles([videoClipPath, audioClipPath, outputPath]);
      return;
    }
    
    // Update DJ info with applied filters
    if (appliedFilters.length > 0) {
      try {
        await saveDjInfo({
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
          timestamp: Date.now(),
          appliedFilters
        });
      } catch (error) {
        console.error('Error updating DJ info with filters:', error);
      }
    }
    
    await updateStatus('DJ mix complete! Uploading... 📤');
    
    try {
      const attachment = new AttachmentBuilder(finalPath);
      
      let messageContent = `🎧 **DJ MIX**\n` +
        `**Video**: ${videoMedia.title} (${Math.floor(videoStartTime)}s-${Math.floor(videoStartTime + maxClipDuration)}s)\n` +
        `**Audio**: ${audioMedia.title} (${Math.floor(audioStartTime)}s-${Math.floor(audioStartTime + maxClipDuration)}s)`;
      
      if (appliedFilters.length > 0) {
        messageContent += `\n**Filters**: ${appliedFilters.join(', ')}`;
      }
      
      if (skippedFilters.length > 0) {
        messageContent += `\n⚠️ Skipped filters: ${skippedFilters.join(', ')}`;
      }
      
      await safeReply(message, { 
        content: messageContent,
        files: [attachment] 
      });
      
    } catch (error) {
      console.error('Error sending attachment:', error);
      await updateStatus(`❌ Error uploading DJ mix: ${truncateError(error)}`);
    } finally {
      // Cleanup temp files
      FileService.cleanupTempFiles([videoClipPath, audioClipPath, outputPath, finalPath]);
    }
    
  } catch (error) {
    console.error('Error handling DJ playback:', error);
    await updateStatus(`❌ Error creating DJ mix: ${truncateError(error)}`);
  }
}

// Helper function to truncate error messages
function truncateError(error: unknown): string {
  const fullMessage = error instanceof Error ? error.message : String(error);
  const firstLine = fullMessage.split('\n')[0];
  return firstLine.substring(0, 200);
}

// Helper functions for media processing (reused from JumbleHandler)
function createVideoClip(inputPath: string, outputPath: string, startTime: number, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        console.error('Error probing input file:', err);
        return reject(err);
      }

      const videoStreams = metadata.streams?.filter(s => s.codec_type === 'video');
      if (!videoStreams || videoStreams.length === 0) {
        console.error('No video streams found in the input file');
        return reject(new Error('No video streams found in the input file'));
      }

      console.log(`Found ${videoStreams.length} video streams in input file`);
      
      const videoStream = videoStreams[0];
      const width = videoStream.width;
      const height = videoStream.height;
      
      const command = ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(duration);
      
      if (width && height) {
        command.size(`${width}x${height}`);
      }
      
      command.outputOptions('-c:v libx264')
        .outputOptions('-preset fast')
        .outputOptions('-crf 23')
        .outputOptions('-pix_fmt yuv420p')
        .outputOptions('-an')
        .outputOptions('-y')
        .on('start', (commandLine) => {
          console.log('FFmpeg video command:', commandLine);
        })
        .on('end', () => {
          console.log('Video extraction completed');
          resolve();
        })
        .on('error', (err) => {
          console.error('Error extracting video:', err);
          
          console.log('First attempt failed, trying with fallback options...');
          ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(duration)
            .outputOptions('-c:v libx264')
            .outputOptions('-preset ultrafast')
            .outputOptions('-crf 28')
            .outputOptions('-pix_fmt yuv420p')
            .outputOptions('-vf format=yuv420p')
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
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        console.error('Error probing input file:', err);
        return reject(err);
      }

      const audioStreams = metadata.streams?.filter(s => s.codec_type === 'audio');
      if (!audioStreams || audioStreams.length === 0) {
        console.error('No audio streams found in the input file');
        return reject(new Error('No audio streams found in the input file'));
      }

      console.log(`Found ${audioStreams.length} audio streams in input file`);
      
      ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(duration)
        .outputOptions('-vn')
        .outputOptions('-c:a aac')
        .outputOptions('-b:a 192k')
        .outputOptions('-ar 44100')
        .outputOptions('-ac 2')
        .outputOptions('-y')
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
    if (!fs.existsSync(videoPath)) {
      return reject(new Error(`Video file does not exist: ${videoPath}`));
    }
    if (!fs.existsSync(audioPath)) {
      return reject(new Error(`Audio file does not exist: ${audioPath}`));
    }

    console.log(`Combining video (${videoPath}) with audio (${audioPath})`);
    
    ffmpeg(videoPath)
      .input(audioPath)
      .outputOptions('-c:v libx264')
      .outputOptions('-preset fast')
      .outputOptions('-crf 23')
      .outputOptions('-pix_fmt yuv420p')
      .outputOptions('-c:a aac')
      .outputOptions('-b:a 192k')
      .outputOptions('-map 0:v:0')
      .outputOptions('-map 1:a:0')
      .outputOptions('-shortest')
      .outputOptions('-y')
      .on('start', (commandLine) => {
        console.log('FFmpeg combine command:', commandLine);
      })
      .on('progress', (progress) => {
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
        
        console.log('Trying alternative approach to combine video and audio...');
        ffmpeg(videoPath)
          .input(audioPath)
          .outputOptions('-c:v libx264')
          .outputOptions('-crf 28')
          .outputOptions('-preset ultrafast')
          .outputOptions('-pix_fmt yuv420p')
          .outputOptions('-c:a aac')
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