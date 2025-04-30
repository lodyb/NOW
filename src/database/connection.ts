import sqlite3 from 'sqlite3';
import dotenv from 'dotenv';
import path from 'path';
import { logger } from '../utils/logger';

// Load environment variables
dotenv.config();

// Database connection configuration
const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'now.sqlite');

// Create SQLite database instance
export const db = new sqlite3.Database(dbPath);

// Enable foreign keys
db.run('PRAGMA foreign_keys = ON');

// Initialize database connection
export async function initializeDatabase(): Promise<void> {
  try {
    logger.info('Database connection initialized successfully');
    
    // Create tables if they don't exist
    await createTablesIfNotExist();
  } catch (error) {
    logger.error(`Database initialization error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Helper function to run SQL queries with proper Promise support
export function runQuery(sql: string, params: any[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) {
        logger.error(`SQL Error: ${err.message} in query: ${sql}`);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// Helper function to get results from SQL queries
export function getQuery<T>(sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        logger.error(`SQL Error: ${err.message} in query: ${sql}`);
        reject(err);
      } else {
        resolve(rows as T[]);
      }
    });
  });
}

// Helper function to get a single result from SQL queries
export function getOne<T>(sql: string, params: any[] = []): Promise<T | null> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        logger.error(`SQL Error: ${err.message} in query: ${sql}`);
        reject(err);
      } else {
        resolve(row as T || null);
      }
    });
  });
}

// Create database schema if tables don't exist
async function createTablesIfNotExist(): Promise<void> {
  try {
    // Media table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        filePath TEXT NOT NULL,
        normalizedPath TEXT,
        uncompressedPath TEXT,
        year INTEGER,
        metadata TEXT DEFAULT '{}',
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Media answers table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS media_answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id INTEGER NOT NULL,
        answer TEXT NOT NULL,
        isPrimary INTEGER DEFAULT 0,
        FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
      )
    `);

    // Tags table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      )
    `);

    // Media tags table (junction table)
    await runQuery(`
      CREATE TABLE IF NOT EXISTS media_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id INTEGER,
        tag_id INTEGER,
        FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      )
    `);

    // Users table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        correctAnswers INTEGER DEFAULT 0,
        gamesPlayed INTEGER DEFAULT 0
      )
    `);

    // Game sessions table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS game_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guildId TEXT NOT NULL,
        channelId TEXT NOT NULL,
        startedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        endedAt TIMESTAMP,
        rounds INTEGER DEFAULT 0,
        currentRound INTEGER DEFAULT 1
      )
    `);

    logger.info('Database schema created successfully');
  } catch (error) {
    logger.error(`Error creating database schema: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}