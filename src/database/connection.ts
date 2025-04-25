import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { Media } from './entities/Media';
import { MediaAnswer } from './entities/MediaAnswer';
import { Tag } from './entities/Tag';
import { MediaTag } from './entities/MediaTag';
import { User } from './entities/User';
import { GameSession } from './entities/GameSession';
import { logger } from '../utils/logger';
import path from 'path';

// Load environment variables
config();

// Set up SQLite database path - store in project root by default
const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'otoq.sqlite');

export const AppDataSource = new DataSource({
  type: 'sqlite',
  database: dbPath,
  synchronize: true, // Auto-create schema
  logging: process.env.NODE_ENV !== 'production',
  entities: [Media, MediaAnswer, Tag, MediaTag, User, GameSession],
  subscribers: [],
  migrations: [],
});

export async function initializeDatabase(): Promise<void> {
  try {
    await AppDataSource.initialize();
    logger.info(`Database initialized successfully at ${dbPath}`);
  } catch (error) {
    logger.error('Error initializing database:', error);
    throw error;
  }
}