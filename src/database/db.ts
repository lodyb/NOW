import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

// Define interfaces for database objects
interface MediaRow {
  id: number;
  title: string;
  filePath: string;
  normalizedPath?: string;
  year?: number;
  metadata?: string;
  isDeleted?: number;
  thumbnails?: string;
  createdAt?: string;
  answers?: string; // This will be the concatenated string from SQL
}

interface Media extends Omit<MediaRow, 'answers' | 'thumbnails' | 'metadata'> {
  answers: string[];
  thumbnails: string[];
  metadata?: any;
}

const DB_PATH = path.join(process.cwd(), 'data', 'now.sqlite');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
    process.exit(1);
  }
  console.log('Connected to the SQLite database');
});

export const initDatabase = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Create tables if they don't exist
      db.run(`CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        title VARCHAR NOT NULL,
        filePath VARCHAR NOT NULL,
        normalizedPath VARCHAR,
        year INTEGER,
        metadata JSON,
        isDeleted BOOLEAN NOT NULL DEFAULT 0,
        thumbnails TEXT,
        createdAt DATETIME NOT NULL DEFAULT (datetime('now'))
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS media_answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        answer VARCHAR NOT NULL,
        isPrimary BOOLEAN NOT NULL DEFAULT (0),
        mediaId INTEGER,
        CONSTRAINT FK_32cd05114984960f6e9ab4dba55 FOREIGN KEY (mediaId) 
        REFERENCES media (id) ON DELETE CASCADE ON UPDATE NO ACTION
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS game_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        guildId VARCHAR NOT NULL,
        channelId VARCHAR NOT NULL,
        startedAt DATETIME NOT NULL DEFAULT (datetime('now')),
        endedAt DATETIME,
        rounds INTEGER NOT NULL DEFAULT (0),
        currentRound INTEGER NOT NULL DEFAULT (1)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS users (
        id VARCHAR PRIMARY KEY NOT NULL,
        username VARCHAR NOT NULL,
        correctAnswers INTEGER NOT NULL DEFAULT (0),
        gamesPlayed INTEGER NOT NULL DEFAULT (0)
      )`);

      // Check and add missing columns if needed
      db.all(`PRAGMA table_info(media)`, (err, rows) => {
        if (err) {
          console.error('Error checking table schema:', err);
          reject(err);
          return;
        }

        const columns = rows.map((row: any) => row.name);
        
        // Check for isDeleted column
        if (!columns.includes('isDeleted')) {
          db.run(`ALTER TABLE media ADD COLUMN isDeleted BOOLEAN NOT NULL DEFAULT 0`, 
            (err: Error | null) => {
              if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding isDeleted column:', err);
              }
            });
        }
        
        // Check for thumbnails column
        if (!columns.includes('thumbnails')) {
          db.run(`ALTER TABLE media ADD COLUMN thumbnails TEXT`, 
            (err: Error | null) => {
              if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding thumbnails column:', err);
              }
            });
        }
        
        resolve();
      });
    });
  });
};

export const findAllMedia = (searchTerm?: string): Promise<Media[]> => {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT m.*, GROUP_CONCAT(ma.answer, '|') as answers
      FROM media m
      LEFT JOIN media_answers ma ON ma.mediaId = m.id
      WHERE m.isDeleted = 0
    `;
    
    const params: any[] = [];
    
    if (searchTerm) {
      query += ` AND (m.title LIKE ? OR ma.answer LIKE ?)`;
      const param = `%${searchTerm}%`;
      params.push(param, param);
    }
    
    query += `
      GROUP BY m.id
      ORDER BY m.createdAt DESC
    `;
    
    db.all(query, params, (err, rows: MediaRow[]) => {
      if (err) {
        reject(err);
      } else {
        // Convert answers string to array and safely parse JSON fields
        const results = rows.map((row) => ({
          ...row,
          answers: row.answers ? row.answers.split('|') : [],
          thumbnails: row.thumbnails ? JSON.parse(String(row.thumbnails)) : [],
          metadata: row.metadata ? JSON.parse(String(row.metadata)) : {},
        }));
        resolve(results);
      }
    });
  });
};

export const findAllMediaPaginated = (
  page: number = 1, 
  pageSize: number = 20, 
  searchTerm?: string
): Promise<{items: Media[], total: number}> => {
  return new Promise((resolve, reject) => {
    // First get total count for pagination
    let countQuery = `
      SELECT COUNT(DISTINCT m.id) as total
      FROM media m
      LEFT JOIN media_answers ma ON ma.mediaId = m.id
      WHERE m.isDeleted = 0
    `;
    
    const countParams: any[] = [];
    
    if (searchTerm) {
      countQuery += ` AND (m.title LIKE ? OR ma.answer LIKE ?)`;
      const param = `%${searchTerm}%`;
      countParams.push(param, param);
    }
    
    db.get(countQuery, countParams, (countErr, countRow: {total: number}) => {
      if (countErr) {
        return reject(countErr);
      }
      
      // Then get the actual data with pagination
      let query = `
        SELECT m.*, GROUP_CONCAT(ma.answer, '|') as answers
        FROM media m
        LEFT JOIN media_answers ma ON ma.mediaId = m.id
        WHERE m.isDeleted = 0
      `;
      
      const params: any[] = [];
      
      if (searchTerm) {
        query += ` AND (m.title LIKE ? OR ma.answer LIKE ?)`;
        const param = `%${searchTerm}%`;
        params.push(param, param);
      }
      
      query += `
        GROUP BY m.id
        ORDER BY m.createdAt DESC
        LIMIT ? OFFSET ?
      `;
      
      const offset = (page - 1) * pageSize;
      params.push(pageSize, offset);
      
      db.all(query, params, (err, rows: MediaRow[]) => {
        if (err) {
          reject(err);
        } else {
          // Convert answers string to array and safely parse JSON fields
          const results = rows.map((row) => ({
            ...row,
            answers: row.answers ? row.answers.split('|') : [],
            thumbnails: row.thumbnails ? JSON.parse(String(row.thumbnails)) : [],
            metadata: row.metadata ? JSON.parse(String(row.metadata)) : {},
          }));
          resolve({ 
            items: results,
            total: countRow.total
          });
        }
      });
    });
  });
};

export const findMediaBySearch = (searchTerm: string): Promise<Media[]> => {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT m.*, GROUP_CONCAT(ma.answer, '|') as answers
      FROM media m
      LEFT JOIN media_answers ma ON ma.mediaId = m.id
      WHERE m.title LIKE ? OR ma.answer LIKE ?
      GROUP BY m.id
      LIMIT 10
    `;
    const param = `%${searchTerm}%`;
    
    db.all(query, [param, param], (err, rows: MediaRow[]) => {
      if (err) {
        reject(err);
      } else {
        // Convert answers string to array and safely parse JSON fields
        const results = rows.map((row) => ({
          ...row,
          answers: row.answers ? row.answers.split('|') : [],
          thumbnails: row.thumbnails ? JSON.parse(String(row.thumbnails)) : [],
          metadata: row.metadata ? JSON.parse(String(row.metadata)) : {}
        }));
        resolve(results);
      }
    });
  });
};

export const getRandomMedia = (limit: number = 1): Promise<Media[]> => {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT m.*, GROUP_CONCAT(ma.answer, '|') as answers
      FROM media m
      LEFT JOIN media_answers ma ON ma.mediaId = m.id
      GROUP BY m.id
      ORDER BY RANDOM()
      LIMIT ?
    `;
    
    db.all(query, [limit], (err, rows: MediaRow[]) => {
      if (err) {
        reject(err);
      } else {
        // Convert answers string to array and safely parse JSON fields
        const results = rows.map((row) => ({
          ...row,
          answers: row.answers ? row.answers.split('|') : [],
          thumbnails: row.thumbnails ? JSON.parse(String(row.thumbnails)) : [],
          metadata: row.metadata ? JSON.parse(String(row.metadata)) : {}
        }));
        resolve(results);
      }
    });
  });
};

export const saveMedia = (
  title: string, 
  filePath: string, 
  normalizedPath: string | null = null,
  year: number | null = null,
  metadata: any = {}
): Promise<number> => {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT INTO media (title, filePath, normalizedPath, year, metadata)
      VALUES (?, ?, ?, ?, ?)
    `;
    
    db.run(query, [title, filePath, normalizedPath, year, JSON.stringify(metadata)], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
  });
};

export const toggleMediaDeleted = (mediaId: number): Promise<void> => {
  return new Promise((resolve, reject) => {
    const query = `
      UPDATE media 
      SET isDeleted = CASE WHEN isDeleted = 1 THEN 0 ELSE 1 END
      WHERE id = ?
    `;
    
    db.run(query, [mediaId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

export const saveMediaAnswers = (mediaId: number, answers: string[]): Promise<void> => {
  return new Promise((resolve, reject) => {
    // First delete existing answers
    db.run(`DELETE FROM media_answers WHERE mediaId = ?`, [mediaId], (err) => {
      if (err) {
        return reject(err);
      }
      
      // Filter out empty answers and handle edge cases
      // Make sure each answer is actually a string first
      const validAnswers = answers
        .filter(answer => answer !== null && answer !== undefined)
        .map(answer => String(answer).trim())
        .filter(answer => answer !== '');
      
      // If no valid answers, just resolve
      if (validAnswers.length === 0) {
        return resolve();
      }
      
      const stmt = db.prepare(`
        INSERT INTO media_answers (answer, isPrimary, mediaId)
        VALUES (?, ?, ?)
      `);
      
      try {
        db.serialize(() => {
          validAnswers.forEach((answer, index) => {
            stmt.run(answer, index === 0 ? 1 : 0, mediaId);
          });
          
          // Use callback form to avoid SQLITE_RANGE error
          stmt.finalize(function(err) {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      } catch (error) {
        // Ensure statement is finalized even on error
        stmt.finalize();
        reject(error);
      }
    });
  });
};

export const updateUserStats = (userId: string, username: string, correctAnswer: boolean): Promise<void> => {
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO users (id, username, correctAnswers, gamesPlayed)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = ?,
        correctAnswers = correctAnswers + ?,
        gamesPlayed = gamesPlayed + ?
    `, [userId, username, correctAnswer ? 1 : 0, 1, username, correctAnswer ? 1 : 0, 1], (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

// Update the media record with waveform and spectrogram paths
export const updateMediaWaveform = (normalizedFileName: string, visualizationPaths: string[]): Promise<void> => {
  return new Promise((resolve, reject) => {
    const query = `
      UPDATE media 
      SET thumbnails = ?
      WHERE normalizedPath LIKE ?
    `;
    
    db.run(query, [JSON.stringify(visualizationPaths), `%${normalizedFileName}%`], function(err) {
      if (err) {
        console.error(`Failed to update thumbnails for ${normalizedFileName}:`, err);
        reject(err);
      } else {
        if (this.changes === 0) {
          console.warn(`No media found with normalizedPath like %${normalizedFileName}%`);
        } else {
          console.log(`Updated thumbnails for ${normalizedFileName}`);
        }
        resolve();
      }
    });
  });
};

export const getMediaById = async (id: number): Promise<Media | null> => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT m.*, GROUP_CONCAT(ma.answer, '|') as answers 
       FROM media m
       LEFT JOIN media_answers ma ON m.id = ma.mediaId
       WHERE m.id = ?
       GROUP BY m.id`,
      [id],
      (err, row: MediaRow | undefined) => {
        if (err) {
          reject(err);
          return;
        }
        
        if (!row) {
          resolve(null);
          return;
        }
        
        // Process the concatenated answers and thumbnails with safe type handling
        const result: Media = {
          ...row,
          answers: row.answers ? row.answers.split('|') : [],
          thumbnails: row.thumbnails ? JSON.parse(String(row.thumbnails)) : [],
          metadata: row.metadata ? JSON.parse(String(row.metadata)) : {}
        };
        
        resolve(result);
      }
    );
  });
};