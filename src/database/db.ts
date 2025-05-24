import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import Fuse from 'fuse.js';

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
  uploaderId?: string;
  answers?: string; // This will be the concatenated string from SQL
}

export interface Media extends Omit<MediaRow, 'answers' | 'thumbnails' | 'metadata'> {
  answers: string[];
  thumbnails: string[];
  metadata?: any;
}

// Define interface for answer objects
interface AnswerItem {
  answer: string;
  isPrimary?: boolean;
}

type AnswerInput = string | AnswerItem;

// Define interface for prompt templates
export interface PromptTemplate {
  id: number;
  name: string;
  template: string;
  createdAt?: string;
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

// Initialize the database
export const initDatabase = async (): Promise<void> => {
  return new Promise((resolve, reject) => {
    try {
      // Create media table if not exists
      db.run(`
        CREATE TABLE IF NOT EXISTS media (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          filePath TEXT NOT NULL,
          normalizedPath TEXT,
          year INTEGER,
          metadata JSON,
          uploaderId TEXT,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Add uploaderId column to existing media table if it doesn't exist
      db.run(`
        ALTER TABLE media ADD COLUMN uploaderId TEXT
      `, (err) => {
        // Ignore error if column already exists
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding uploaderId column:', err);
        }
      });
      
      // Create users table if not exists
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          correctAnswers INTEGER DEFAULT 0,
          gamesPlayed INTEGER DEFAULT 0
        )
      `);
      
      // Create game sessions table if not exists
      db.run(`
        CREATE TABLE IF NOT EXISTS game_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guildId TEXT NOT NULL,
          channelId TEXT NOT NULL,
          startedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          endedAt DATETIME,
          rounds INTEGER DEFAULT 0,
          currentRound INTEGER DEFAULT 1
        )
      `);
      
      // Create user_last_commands table if not exists
      db.run(`
        CREATE TABLE IF NOT EXISTS user_last_commands (
          userId TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          command TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Create emote_bindings table if not exists
      db.run(`
        CREATE TABLE IF NOT EXISTS emote_bindings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guildId TEXT NOT NULL,
          userId TEXT NOT NULL,
          emoteId TEXT NOT NULL,
          emoteName TEXT NOT NULL, 
          searchTerm TEXT NOT NULL,
          filterString TEXT,
          clipDuration TEXT,
          clipStart TEXT,
          audioPath TEXT,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(guildId, emoteId)
        )
      `, (err) => {
        if (err) {
          console.error('Error creating emote_bindings table:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    } catch (err) {
      console.error('Error initializing database:', err);
      reject(err);
    }
  });
};

export const findAllMedia = (searchTerm?: string): Promise<Media[]> => {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT m.*, GROUP_CONCAT(ma.answer) as answers
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
          answers: row.answers ? row.answers.split(',') : [],
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
        SELECT m.id, m.title, m.filePath, MAX(m.normalizedPath) as normalizedPath, 
        m.year, m.metadata, m.isDeleted, m.thumbnails, m.createdAt, m.uploaderId,
        GROUP_CONCAT(DISTINCT ma.answer) as answers
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
            answers: row.answers ? row.answers.split(',') : [],
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

export const findMediaBySearch = (searchTerm: string, requireVideo?: boolean, limit: number = 1): Promise<Media[]> => {
  return new Promise((resolve, reject) => {
    const trimmedSearch = searchTerm.trim();
    
    // First check for exact matches in answers
    const exactQuery = `
      SELECT m.*, GROUP_CONCAT(ma.answer) as answers
      FROM media m
      JOIN media_answers ma ON ma.mediaId = m.id
      WHERE m.isDeleted = 0
      AND ma.answer = ?
    `;
    
    // Add video filter if required - check original filePath for video extensions
    const videoFilter = requireVideo 
      ? ` AND (m.filePath LIKE '%.mp4' OR m.filePath LIKE '%.avi' OR m.filePath LIKE '%.wmv' OR m.filePath LIKE '%.mkv' OR m.filePath LIKE '%.webm' OR m.filePath LIKE '%.mov')`
      : '';
    const exactQueryWithFilter = exactQuery + videoFilter + ` GROUP BY m.id`;
    
    db.all(exactQueryWithFilter, [trimmedSearch], (err, exactRows: MediaRow[]) => {
      if (err) {
        reject(err);
        return;
      }
      
      // If we found exact matches, return them in random order
      if (exactRows.length > 0) {
        // Process results
        const exactResults = exactRows.map((row) => ({
          ...row,
          answers: row.answers ? row.answers.split(',') : [],
          thumbnails: row.thumbnails ? JSON.parse(String(row.thumbnails)) : [],
          metadata: row.metadata ? JSON.parse(String(row.metadata)) : {}
        }));
        
        // Shuffle exact results and limit them
        const shuffledExact = [...exactResults].sort(() => Math.random() - 0.5).slice(0, limit);
        resolve(shuffledExact);
        return;
      }
      
      // No exact matches, do fuzzy search
      let fuzzyQuery = `
        SELECT m.*, GROUP_CONCAT(ma.answer) as answers
        FROM media m
        LEFT JOIN media_answers ma ON ma.mediaId = m.id
        WHERE m.isDeleted = 0
      `;
      
      const params: any[] = [];
      
      if (trimmedSearch !== '%') {
        fuzzyQuery += ` AND (m.title LIKE ? OR ma.answer LIKE ?)`;
        const param = `%${trimmedSearch}%`;
        params.push(param, param);
      }
      
      // Add video filter if required - check original filePath for video extensions
      if (requireVideo) {
        fuzzyQuery += ` AND (m.filePath LIKE '%.mp4' OR m.filePath LIKE '%.avi' OR m.filePath LIKE '%.wmv' OR m.filePath LIKE '%.mkv' OR m.filePath LIKE '%.webm' OR m.filePath LIKE '%.mov')`;
      }
      
      fuzzyQuery += `
        GROUP BY m.id
        ORDER BY RANDOM()
        LIMIT ?
      `;
      
      params.push(limit);
      
      db.all(fuzzyQuery, params, (fuzzyErr, fuzzyRows: MediaRow[]) => {
        if (fuzzyErr) {
          reject(fuzzyErr);
          return;
        }
        
        // Process partial match results
        const fuzzyResults = fuzzyRows.map((row) => ({
          ...row,
          answers: row.answers ? row.answers.split(',') : [],
          thumbnails: row.thumbnails ? JSON.parse(String(row.thumbnails)) : [],
          metadata: row.metadata ? JSON.parse(String(row.metadata)) : {}
        }));
        
        resolve(fuzzyResults);
      });
    });
  });
};

export const getRandomMedia = (limit: number = 1, requireVideo?: boolean): Promise<Media[]> => {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT m.*, GROUP_CONCAT(ma.answer) as answers
      FROM media m
      LEFT JOIN media_answers ma ON ma.mediaId = m.id
      WHERE m.isDeleted = 0 OR m.isDeleted IS NULL
    `;
    
    // Add video filter if required - check original filePath for video extensions
    if (requireVideo) {
      query += ` AND (m.filePath LIKE '%.mp4' OR m.filePath LIKE '%.avi' OR m.filePath LIKE '%.wmv' OR m.filePath LIKE '%.mkv' OR m.filePath LIKE '%.webm' OR m.filePath LIKE '%.mov')`;
    }
    
    query += `
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
          answers: row.answers ? row.answers.split(',') : [],
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
  metadata: any = {},
  uploaderId: string | null = null
): Promise<number> => {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT INTO media (title, filePath, normalizedPath, year, metadata, uploaderId)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    
    db.run(query, [title, filePath, normalizedPath, year, JSON.stringify(metadata), uploaderId], function(err) {
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

export const saveMediaAnswers = (mediaId: number, answers: AnswerInput[]): Promise<void> => {
  return new Promise((resolve, reject) => {
    // First delete existing answers
    db.run(`DELETE FROM media_answers WHERE mediaId = ?`, [mediaId], (err) => {
      if (err) {
        return reject(err);
      }
      
      // Process the answers which could be either strings or objects
      const processedAnswers = answers
        .filter(answer => answer !== null && answer !== undefined)
        .map((answer, index): [string, boolean] => {
          if (typeof answer === 'string') {
            return [answer.trim(), index === 0];
          } else if (typeof answer === 'object' && answer !== null) {
            const answerObj = answer as AnswerItem;
            const answerText = answerObj.answer ? String(answerObj.answer).trim() : '';
            const isPrimary = answerObj.isPrimary === undefined ? index === 0 : !!answerObj.isPrimary;
            return [answerText, isPrimary];
          }
          return ['', false]; // Fallback
        })
        .filter(([text]) => text !== '');
      
      // If no valid answers, just resolve
      if (processedAnswers.length === 0) {
        return resolve();
      }
      
      const stmt = db.prepare(`
        INSERT INTO media_answers (answer, isPrimary, mediaId)
        VALUES (?, ?, ?)
      `);
      
      try {
        db.serialize(() => {
          processedAnswers.forEach(([answer, isPrimary]) => {
            stmt.run(answer, isPrimary ? 1 : 0, mediaId);
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
      `SELECT m.*, GROUP_CONCAT(ma.answer) as answers 
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
          answers: row.answers ? row.answers.split(',') : [],
          thumbnails: row.thumbnails ? JSON.parse(String(row.thumbnails)) : [],
          metadata: row.metadata ? JSON.parse(String(row.metadata)) : {}
        };
        
        resolve(result);
      }
    );
  });
};

// Prompt template functions
export const savePromptTemplate = (name: string, template: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    console.log(`Saving template "${name}" with content length: ${template.length}`);
    const query = `
      INSERT INTO prompt_templates (name, template)
      VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET
        template = ?
    `;
    
    db.run(query, [name, template, template], function(err) {
      if (err) {
        console.error(`Error saving prompt template "${name}":`, err);
        reject(err);
      } else {
        console.log(`Successfully saved prompt template "${name}" with ID: ${this.lastID || 'updated'}`);
        resolve(this.lastID || 0);
      }
    });
  });
};

export const getPromptTemplate = (name: string): Promise<PromptTemplate | null> => {
  return new Promise((resolve, reject) => {
    console.log(`Looking up template with name: "${name}"`);
    db.get(
      `SELECT * FROM prompt_templates WHERE name = ?`,
      [name],
      (err, row: PromptTemplate | undefined) => {
        if (err) {
          console.error(`Error retrieving template "${name}":`, err);
          reject(err);
          return;
        }
        
        if (!row) {
          console.log(`Template "${name}" not found`);
          resolve(null);
          return;
        }
        
        console.log(`Found template "${name}" with id ${row.id}`);
        resolve(row);
      }
    );
  });
};

export const getAllPromptTemplates = (): Promise<PromptTemplate[]> => {
  return new Promise((resolve, reject) => {
    console.log(`Retrieving all prompt templates`);
    db.all(
      `SELECT * FROM prompt_templates ORDER BY name ASC`,
      [],
      (err, rows: PromptTemplate[]) => {
        if (err) {
          console.error(`Error retrieving all templates:`, err);
          reject(err);
          return;
        }
        
        console.log(`Found ${rows?.length || 0} templates`);
        resolve(rows || []);
      }
    );
  });
};

export const deletePromptTemplate = (name: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    console.log(`Attempting to delete template "${name}"`);
    db.run(
      `DELETE FROM prompt_templates WHERE name = ?`,
      [name],
      function(err) {
        if (err) {
          console.error(`Error deleting template "${name}":`, err);
          reject(err);
          return;
        }
        
        console.log(`Template "${name}" deletion result: ${this.changes > 0 ? 'deleted' : 'not found'}`);
        resolve(this.changes > 0);
      }
    );
  });
};

export const saveUserLastCommand = (userId: string, username: string, command: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO users (id, username, correctAnswers, gamesPlayed, lastCommand)
      VALUES (?, ?, 0, 0, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = ?,
        lastCommand = ?
    `, [userId, username, command, username, command], (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

export const getUserLastCommand = (userId: string): Promise<string | null> => {
  return new Promise((resolve, reject) => {
    db.get('SELECT lastCommand FROM users WHERE id = ?', [userId], (err, row: { lastCommand?: string } | undefined) => {
      if (err) {
        reject(err);
      } else {
        resolve(row?.lastCommand || null);
      }
    });
  });
};

// Functions to track and retrieve jumble source information
export interface JumbleInfo {
  userId: string;
  guildId: string;
  videoId: number;
  videoTitle: string;
  videoStart: number;
  videoDuration: number;
  audioId: number;
  audioTitle: string;
  audioStart: number;
  audioDuration: number;
  timestamp: number;
}

export const saveJumbleInfo = (jumbleInfo: JumbleInfo): Promise<void> => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO jumble_history 
      (userId, guildId, videoId, videoTitle, videoStart, videoDuration, audioId, audioTitle, audioStart, audioDuration, timestamp) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jumbleInfo.userId,
        jumbleInfo.guildId,
        jumbleInfo.videoId,
        jumbleInfo.videoTitle,
        jumbleInfo.videoStart,
        jumbleInfo.videoDuration,
        jumbleInfo.audioId,
        jumbleInfo.audioTitle,
        jumbleInfo.audioStart,
        jumbleInfo.audioDuration,
        jumbleInfo.timestamp
      ],
      function(err) {
        if (err) {
          console.error('Error saving jumble info:', err);
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
};

export const getLatestJumbleInfo = (userId: string, guildId: string): Promise<JumbleInfo | null> => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM jumble_history
       WHERE userId = ? AND guildId = ?
       ORDER BY timestamp DESC
       LIMIT 1`,
      [userId, guildId],
      (err, row) => {
        if (err) {
          console.error('Error retrieving jumble info:', err);
          reject(err);
        } else {
          resolve(row ? row as JumbleInfo : null);
        }
      }
    );
  });
};

// Initialize jumble history table
export const initializeJumbleTable = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    db.run(`CREATE TABLE IF NOT EXISTS jumble_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      userId VARCHAR NOT NULL,
      guildId VARCHAR NOT NULL,
      videoId INTEGER NOT NULL,
      videoTitle VARCHAR NOT NULL,
      videoStart FLOAT NOT NULL,
      videoDuration FLOAT NOT NULL,
      audioId INTEGER NOT NULL,
      audioTitle VARCHAR NOT NULL,
      audioStart FLOAT NOT NULL,
      audioDuration FLOAT NOT NULL,
      timestamp INTEGER NOT NULL
    )`, (err) => {
      if (err) {
        console.error('Error creating jumble_history table:', err);
        reject(err);
      } else {
        console.log('jumble_history table initialized');
        resolve();
      }
    });
  });
};

// Functions to manage gallery items

// Define interface for gallery items
export interface GalleryItem {
  id?: number;
  userId: string;
  messageId: string;
  guildId: string;
  filePath: string;
  mediaType: string;
  sourceUrl: string;
  createdAt?: string;
}

export const saveGalleryItem = (item: GalleryItem): Promise<number> => {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT INTO gallery_items (userId, messageId, guildId, filePath, mediaType, sourceUrl)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    
    db.run(query, [
      item.userId, 
      item.messageId, 
      item.guildId, 
      item.filePath, 
      item.mediaType, 
      item.sourceUrl
    ], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
  });
};

export const getUserGalleryItems = (userId: string): Promise<GalleryItem[]> => {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT * FROM gallery_items
      WHERE userId = ?
      ORDER BY createdAt DESC
    `;
    
    db.all(query, [userId], (err, rows: GalleryItem[]) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows || []);
      }
    });
  });
};

export const getGalleryUsers = (): Promise<{id: string, username: string, itemCount: number}[]> => {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT u.id, u.username, COUNT(g.id) as itemCount
      FROM users u
      JOIN gallery_items g ON u.id = g.userId
      GROUP BY u.id, u.username
      ORDER BY COUNT(g.id) DESC
    `;
    
    db.all(query, [], (err, rows: {id: string, username: string, itemCount: number}[]) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows || []);
      }
    });
  });
};

export const removeGalleryItem = (userId: string, messageId: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const query = `
      DELETE FROM gallery_items
      WHERE userId = ? AND messageId = ?
    `;
    
    db.run(query, [userId, messageId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.changes > 0);
      }
    });
  });
};

export const checkGalleryItem = (userId: string, messageId: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT COUNT(*) as count
      FROM gallery_items
      WHERE userId = ? AND messageId = ?
    `;
    
    db.get(query, [userId, messageId], (err, row: {count: number}) => {
      if (err) {
        reject(err);
      } else {
        resolve(row.count > 0);
      }
    });
  });
};

// Emote binding types
export interface EmoteBinding {
  id?: number;
  guildId: string;
  userId: string;
  emoteId: string;
  emoteName: string;
  searchTerm: string;
  filterString?: string;
  clipDuration?: string;
  clipStart?: string;
  audioPath?: string;
  createdAt?: string;
}

// Create emote_bindings table during initialization
const createEmoteBindingsTable = () => {
  return new Promise<void>((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS emote_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        guildId VARCHAR NOT NULL,
        userId VARCHAR NOT NULL,
        emoteId VARCHAR NOT NULL,
        emoteName VARCHAR NOT NULL,
        searchTerm VARCHAR NOT NULL,
        filterString VARCHAR,
        clipDuration VARCHAR,
        clipStart VARCHAR,
        audioPath VARCHAR,
        createdAt DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

// Save an emote binding to the database
export const saveEmoteBinding = (binding: EmoteBinding): Promise<number> => {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT INTO emote_bindings (
        guildId, userId, emoteId, emoteName, searchTerm, 
        filterString, clipDuration, clipStart
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    db.run(
      query, 
      [
        binding.guildId, 
        binding.userId, 
        binding.emoteId, 
        binding.emoteName, 
        binding.searchTerm, 
        binding.filterString || null, 
        binding.clipDuration || null, 
        binding.clipStart || null
      ],
      function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      }
    );
  });
};

// Update the processed audio path for an emote binding
export const updateEmoteBindingAudioPath = (
  guildId: string, 
  emoteId: string, 
  audioPath: string
): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const query = `
      UPDATE emote_bindings
      SET audioPath = ?
      WHERE guildId = ? AND emoteId = ?
    `;
    
    db.run(query, [audioPath, guildId, emoteId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.changes > 0);
      }
    });
  });
};

// Update an existing emote binding
export const updateEmoteBinding = (binding: EmoteBinding): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const query = `
      UPDATE emote_bindings
      SET userId = ?, emoteName = ?, searchTerm = ?, 
          filterString = ?, clipDuration = ?, clipStart = ?, audioPath = NULL
      WHERE guildId = ? AND emoteId = ?
    `;
    
    db.run(
      query, 
      [
        binding.userId, 
        binding.emoteName, 
        binding.searchTerm, 
        binding.filterString || null, 
        binding.clipDuration || null, 
        binding.clipStart || null,
        binding.guildId,
        binding.emoteId
      ],
      function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      }
    );
  });
};

// Get an emote binding by guildId and emoteId
export const getEmoteBinding = (guildId: string, emoteId: string): Promise<EmoteBinding | null> => {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT * FROM emote_bindings
      WHERE guildId = ? AND emoteId = ?
    `;
    
    db.get(query, [guildId, emoteId], (err, row: EmoteBinding | undefined) => {
      if (err) {
        reject(err);
      } else {
        resolve(row || null);
      }
    });
  });
};

export const getUserById = async (userId: string): Promise<{id: string, username: string} | null> => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id, username FROM users WHERE id = ?`,
      [userId],
      (err, row: {id: string, username: string} | undefined) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row || null);
      }
    );
  });
};