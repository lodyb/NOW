#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

/**
 * A simple script to clean up duplicate media entries in the database
 * This version uses plain Node.js with SQLite, avoiding TypeScript compilation issues
 */
async function cleanupDuplicateMedia() {
  console.log('Starting duplicate media cleanup process');
  
  // Location of the SQLite database file
  const dbPath = path.join(process.cwd(), 'now.sqlite');
  
  // Check if database file exists
  if (!fs.existsSync(dbPath)) {
    console.error(`Database file not found at: ${dbPath}`);
    return;
  }
  
  // Open database connection
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  
  try {
    console.log('Database connection established');
    
    // Find duplicate media entries based on title
    const duplicateGroups = await db.all(`
      SELECT title, COUNT(*) as count, GROUP_CONCAT(id) as ids
      FROM media 
      GROUP BY title 
      HAVING COUNT(*) > 1
    `);
    
    console.log(`Found ${duplicateGroups.length} titles with duplicate entries`);
    
    let totalRemoved = 0;
    
    // Process each group of duplicates
    for (const group of duplicateGroups) {
      const title = group.title;
      const idList = group.ids.split(',').map(Number);
      
      console.log(`Processing duplicates for "${title}" with IDs: ${idList.join(', ')}`);
      
      // Get the records with creation timestamps
      const records = await db.all(`
        SELECT id, createdAt
        FROM media
        WHERE title = ?
        ORDER BY createdAt ASC
      `, [title]);
      
      // Keep the oldest record, remove others
      const recordToKeep = records[0];
      const recordsToRemove = records.slice(1);
      
      console.log(`Keeping media ID ${recordToKeep.id}, removing ${recordsToRemove.length} duplicates`);
      
      // For each record to remove
      for (const recordToRemove of recordsToRemove) {
        // Start a transaction
        await db.run('BEGIN TRANSACTION');
        
        try {
          // 1. Transfer any MediaAnswer relationships
          await db.run(`
            UPDATE media_answers 
            SET mediaId = ? 
            WHERE mediaId = ?
          `, [recordToKeep.id, recordToRemove.id]);
          
          // 2. Transfer any MediaTag relationships (need to avoid duplicates)
          const mediaTags = await db.all(`
            SELECT tagId FROM media_tags WHERE mediaId = ?
          `, [recordToRemove.id]);
          
          for (const mediaTag of mediaTags) {
            // Check if the record to keep already has this tag
            const existingTag = await db.get(`
              SELECT 1 FROM media_tags 
              WHERE mediaId = ? AND tagId = ?
            `, [recordToKeep.id, mediaTag.tagId]);
            
            if (!existingTag) {
              // Add the tag to the record to keep
              await db.run(`
                INSERT INTO media_tags (mediaId, tagId)
                VALUES (?, ?)
              `, [recordToKeep.id, mediaTag.tagId]);
            }
          }
          
          // Remove old media_tags entries
          await db.run(`
            DELETE FROM media_tags
            WHERE mediaId = ?
          `, [recordToRemove.id]);
          
          // 3. Delete the duplicate record
          await db.run(`
            DELETE FROM media
            WHERE id = ?
          `, [recordToRemove.id]);
          
          // Commit transaction
          await db.run('COMMIT');
          totalRemoved++;
          
        } catch (error) {
          // Rollback transaction on error
          await db.run('ROLLBACK');
          console.error(`Error processing record ID ${recordToRemove.id}:`, error);
        }
      }
    }
    
    console.log(`Cleanup complete! Removed ${totalRemoved} duplicate media entries`);
    
  } catch (error) {
    console.error('Error during duplicate cleanup:', error);
  } finally {
    // Close database connection
    await db.close();
  }
}

// Run the cleanup function
cleanupDuplicateMedia().then(() => {
  console.log('Duplicate cleanup process completed');
  process.exit(0);
}).catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});