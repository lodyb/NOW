import { Message, AttachmentBuilder } from 'discord.js';
import { MediaService } from '../services/MediaService';
import { parseFilterString, parseClipOptions } from '../../media/processor';
import { processFilterChainRobust } from '../../media/chainProcessor';
import { StatusService } from '../services/StatusService';
import { safeReply } from '../utils/helpers';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

interface MediaCommandOptions {
  searchTerm?: string;
  filterString?: string;
  clipOptions?: { duration?: string; start?: string };
  fromReply?: boolean;
}

/**
 * Get media from database using search term or random selection
 */
async function getMediaFromDatabase(searchTerm?: string): Promise<any> {
  const results = await MediaService.findMedia(searchTerm, false, 1);
  return results.length > 0 ? results[0] : null;
}

/**
 * Get media from reply or attachments (placeholder - needs implementation)
 */
async function getMediaFromReplyOrAttachments(message: Message): Promise<any> {
  // TODO: Implement getting media from replies/attachments
  return null;
}

/**
 * Handle media playback with robust error handling and ephemeral status updates
 */
export async function processMediaCommand(
  message: Message,
  options: MediaCommandOptions
): Promise<void> {
  try {
    const { searchTerm, filterString, clipOptions, fromReply } = options;
    
    // Create deletable status updater
    const { updateStatus, deleteStatus } = StatusService.createDeletableStatusUpdater(message);
    await updateStatus(`Processing request... ⏳`);
    
    // Get media source based on whether this is a play or remix command
    const mediaSource = fromReply ? 
      await getMediaFromReplyOrAttachments(message) : 
      await getMediaFromDatabase(searchTerm);

    if (!mediaSource) {
      await updateStatus(
        fromReply ?
          "No media found in this message or the one it replies to. Please include media or reply to a message with media." :
          `No media found ${searchTerm ? `for "${searchTerm}"` : 'in the database'}`
      );
      return;
    }

    try {
      let processedPath: string;
      let needsCleanup = false;
      let appliedFilters: string[] = [];
      let skippedFilters: string[] = [];

      // Skip processing if no filters or clip options are specified and the media is from database
      const hasFilters = !!filterString;
      const hasClipOptions = !!(clipOptions && (clipOptions.duration || clipOptions.start));

      if (!hasFilters && !hasClipOptions && !fromReply && !mediaSource.isTemporary) {
        // Use the normalized file for database media when no processing is needed
        processedPath = MediaService.resolveMediaPath(mediaSource);
        
        // Verify the normalized file exists
        if (!MediaService.validateMediaExists(processedPath)) {
          // Fall back to original file if normalized doesn't exist
          processedPath = mediaSource.filePath;
        }
        
        await updateStatus(`Found ${searchTerm ? `"${searchTerm}"` : 'media'}, uploading... 📤`);
      } else {
        // Prepare filter string for processing
        let parsedFilterString = filterString;
        if (filterString && !filterString.startsWith('{')) {
          parsedFilterString = `{${filterString}}`;
        }

        // Update status message based on filter presence
        if (parsedFilterString) {
          await updateStatus(`Processing media with filters... ⏳`);
        } else {
          await updateStatus(`Processing media... ⏳`);
        }

        // Generate random ID for output filename
        const randomId = crypto.randomBytes(4).toString('hex');
        const outputFilename = `processed_${randomId}${path.extname(mediaSource.filePath)}`;

        // Process the media with robust filter chain
        const result = await processFilterChainRobust(
          mediaSource.filePath,
          outputFilename,
          parsedFilterString,
          clipOptions,
          async (stage, progress) => {
            try {
              await updateStatus(`${stage} (${Math.round(progress * 100)}%)... ⏳`);
            } catch (err) {
              console.error('Error updating status message:', err);
            }
          },
          false // Don't enforce Discord limits for regular playback commands
        );

        processedPath = result.path;
        appliedFilters = result.appliedFilters;
        skippedFilters = result.skippedFilters;
        needsCleanup = true;

        // Log filter results
        if (appliedFilters.length > 0) {
          console.log(`✅ Applied filters: ${appliedFilters.join(', ')}`);
        }
        if (skippedFilters.length > 0) {
          console.log(`❌ Skipped filters: ${skippedFilters.join(', ')}`);
        }
      }

      // Upload the processed file
      await updateStatus(`Uploading... 📤`);
      const attachment = new AttachmentBuilder(processedPath);
      
      // Create the final message content
      let messageContent = '';
      if (skippedFilters.length > 0) {
        messageContent = `⚠️ Some filters were skipped due to errors: ${skippedFilters.join(', ')}`;
      }

      // Send the final result
      await safeReply(message, { 
        content: messageContent || undefined,
        files: [attachment] 
      });

      // Delete the status message now that we've posted the final result
      await deleteStatus();

      // Clean up temporary files
      if (needsCleanup) {
        try {
          fs.unlinkSync(processedPath);
        } catch (err) {
          console.error('Failed to clean up processed file:', err);
        }
      }

      // Clean up temporary media source if needed
      if (mediaSource.isTemporary) {
        try {
          fs.unlinkSync(mediaSource.filePath);
        } catch (err) {
          console.error('Failed to clean up temporary media source:', err);
        }
      }

    } catch (error) {
      console.error('Error processing media:', error);
      await updateStatus(`❌ Processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Error in handleMediaCommand:', error);
    await safeReply(message, `Error processing command: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}