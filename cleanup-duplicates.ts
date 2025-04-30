#!/usr/bin/env node

import { AppDataSource } from './src/database/connection';
import { Media } from './src/database/entities/Media';
import { MediaAnswer } from './src/database/entities/MediaAnswer';
import { MediaTag } from './src/database/entities/MediaTag';
import { logger } from './src/utils/logger';

/**
 * Script to identify and remove duplicate media entries
 * Preserves all relationships by transferring them to the record we keep
 */
async function cleanupDuplicateMedia(): Promise<void> {
  logger.info('Starting duplicate media cleanup process');
  
  try {
    // Initialize database connection
    await AppDataSource.initialize();
    logger.info('Database connection established');
    
    // Get all media with title counts to identify duplicates
    const duplicateGroups = await AppDataSource.manager.query(`
      SELECT title, COUNT(*) as count, GROUP_CONCAT(id) as ids
      FROM media 
      GROUP BY title 
      HAVING COUNT(*) > 1
    `);
    
    logger.info(`Found ${duplicateGroups.length} titles with duplicate entries`);
    
    let totalRemoved = 0;
    
    // Process each group of duplicates
    for (const group of duplicateGroups) {
      const title = group.title;
      const idList = group.ids.split(',').map(Number);
      
      logger.info(`Processing duplicates for "${title}" with IDs: ${idList.join(', ')}`);
      
      // Get all records for this title with their creation dates
      const records = await AppDataSource.manager.find(Media, {
        where: { title },
        relations: ['answers', 'mediaTags'],
        order: { createdAt: 'ASC' } // Keep the oldest record
      });
      
      // Keep the first record (oldest), remove the others
      const recordToKeep = records[0];
      const recordsToRemove = records.slice(1);
      
      logger.info(`Keeping media ID ${recordToKeep.id}, removing ${recordsToRemove.length} duplicates`);
      
      // For each record to remove
      for (const recordToRemove of recordsToRemove) {
        // 1. Transfer any MediaAnswer relationships
        if (recordToRemove.answers && recordToRemove.answers.length > 0) {
          logger.info(`Transferring ${recordToRemove.answers.length} answers from ID ${recordToRemove.id} to ID ${recordToKeep.id}`);
          
          // Update the mediaId for all answers from the record to remove
          await AppDataSource.manager.query(`
            UPDATE media_answers 
            SET mediaId = ? 
            WHERE mediaId = ?
          `, [recordToKeep.id, recordToRemove.id]);
        }
        
        // 2. Transfer any MediaTag relationships
        if (recordToRemove.mediaTags && recordToRemove.mediaTags.length > 0) {
          logger.info(`Transferring ${recordToRemove.mediaTags.length} tags from ID ${recordToRemove.id} to ID ${recordToKeep.id}`);
          
          // For each tag on the record to remove
          for (const mediaTag of recordToRemove.mediaTags) {
            // Check if the record to keep already has this tag
            const tagExists = recordToKeep.mediaTags.some(tag => tag.tagId === mediaTag.tagId);
            
            if (!tagExists) {
              // Add the tag to the record to keep
              await AppDataSource.manager.query(`
                INSERT OR IGNORE INTO media_tags (mediaId, tagId)
                VALUES (?, ?)
              `, [recordToKeep.id, mediaTag.tagId]);
            }
          }
          
          // Remove the old media_tags entries
          await AppDataSource.manager.query(`
            DELETE FROM media_tags
            WHERE mediaId = ?
          `, [recordToRemove.id]);
        }
        
        // 3. Now delete the duplicate record
        await AppDataSource.manager.remove(recordToRemove);
        totalRemoved++;
      }
    }
    
    logger.info(`Cleanup complete! Removed ${totalRemoved} duplicate media entries`);
  } catch (error) {
    logger.error(`Error during duplicate cleanup: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Close database connection
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}

// Run the cleanup function
cleanupDuplicateMedia().then(() => {
  logger.info('Duplicate cleanup process completed');
  process.exit(0);
}).catch(error => {
  logger.error(`Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});