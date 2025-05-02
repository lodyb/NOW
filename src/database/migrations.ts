// filepath: /home/lody/now/src/database/migrations.ts
import { db } from './db';
import path from 'path';

export const migrateNormalizedPaths = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Get all media with normalized paths that need updating
    const query = `
      SELECT id, normalizedPath 
      FROM media 
      WHERE normalizedPath LIKE 'normalized/%'
    `;
    
    db.all(query, [], (err, rows: {id: number, normalizedPath: string}[]) => {
      if (err) {
        console.error('Error querying media for migration:', err);
        return reject(err);
      }
      
      if (rows.length === 0) {
        console.log('No media paths need migration');
        return resolve();
      }
      
      console.log(`Found ${rows.length} media entries to migrate`);
      
      // Prepare update statement
      const updateStmt = db.prepare(`
        UPDATE media
        SET normalizedPath = ?
        WHERE id = ?
      `);
      
      try {
        db.serialize(() => {
          let migrationCount = 0;
          
          rows.forEach(row => {
            // Convert 'normalized/1234567890-123456789.mp4' to 'norm_1234567890-123456789.mp4'
            const filename = path.basename(row.normalizedPath);
            const newPath = `norm_${filename}`;
            
            updateStmt.run(newPath, row.id, function(err) {
              if (err) {
                console.error(`Error updating media ${row.id}:`, err);
              } else if (this.changes > 0) {
                migrationCount++;
              }
            });
          });
          
          updateStmt.finalize((err) => {
            if (err) {
              console.error('Error finalizing migration:', err);
              reject(err);
            } else {
              console.log(`Successfully migrated ${migrationCount} media entries`);
              resolve();
            }
          });
        });
      } catch (error) {
        updateStmt.finalize();
        console.error('Migration error:', error);
        reject(error);
      }
    });
  });
};