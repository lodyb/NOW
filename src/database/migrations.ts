import { db } from '../database/db';

/**
 * Migration to split answers that contain newlines into separate entries
 */
export const migrateMultilineAnswers = async (): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Get all answers that contain newlines
    const query = `
      SELECT id, answer, mediaId, isPrimary 
      FROM media_answers 
      WHERE answer LIKE '%\n%' OR answer LIKE '%\r%'
    `;
    
    db.all(query, [], (err, rows: any[]) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (rows.length === 0) {
        console.log('No multiline answers found');
        resolve();
        return;
      }
      
      console.log(`Found ${rows.length} multiline answers to split`);
      
      // Process each multiline answer
      const updates: Promise<void>[] = rows.map(row => {
        return new Promise<void>((resolveRow, rejectRow) => {
          // Split the answer on both \n and \r\n
          const splitAnswers = row.answer
            .split(/\r?\n/)
            .map((a: string) => a.trim())
            .filter((a: string) => a.length > 0);
          
          if (splitAnswers.length <= 1) {
            resolveRow();
            return;
          }
          
          console.log(`Splitting "${row.answer}" into ${splitAnswers.length} answers`);
          
          // Delete the original multiline entry
          db.run('DELETE FROM media_answers WHERE id = ?', [row.id], (deleteErr) => {
            if (deleteErr) {
              rejectRow(deleteErr);
              return;
            }
            
            // Insert new separate entries
            const stmt = db.prepare(`
              INSERT INTO media_answers (answer, isPrimary, mediaId)
              VALUES (?, ?, ?)
            `);
            
            try {
              splitAnswers.forEach((answer: string, index: number) => {
                // First answer keeps the original primary status, others are not primary
                const isPrimary = index === 0 ? row.isPrimary : 0;
                stmt.run(answer, isPrimary, row.mediaId);
              });
              
              stmt.finalize((finalizeErr) => {
                if (finalizeErr) {
                  rejectRow(finalizeErr);
                } else {
                  resolveRow();
                }
              });
            } catch (error) {
              rejectRow(error);
            }
          });
        });
      });
      
      Promise.all(updates)
        .then(() => {
          console.log('Multiline answer migration completed');
          resolve();
        })
        .catch(reject);
    });
  });
};