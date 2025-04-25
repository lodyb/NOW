import { DataSource } from 'typeorm';
import { Media } from '../database/entities/Media';
import { MediaAnswer } from '../database/entities/MediaAnswer';
import { normalizeMedia } from '../services/media/normalizer';
import { logger } from './logger';
import { AppDataSource } from '../database/connection';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';

// Load environment variables
config();

// Command line arguments
const args = process.argv.slice(2);
let sourceDbPath: string | undefined;
let sourceFilesDir: string | undefined;

// Parse command line arguments
args.forEach(arg => {
  if (arg.startsWith('--source-db=')) {
    sourceDbPath = arg.split('=')[1];
  } else if (arg.startsWith('--source-files=')) {
    sourceFilesDir = arg.split('=')[1];
  }
});

// Check required arguments
if (!sourceDbPath || !sourceFilesDir) {
  console.error('Usage: ts-node src/utils/migration.ts --source-db=path/to/old.sqlite --source-files=path/to/media/dir');
  process.exit(1);
}

// Check if source files directory exists
if (!fs.existsSync(sourceFilesDir)) {
  console.error(`Source files directory not found: ${sourceFilesDir}`);
  process.exit(1);
}

// Check if source database exists
if (!fs.existsSync(sourceDbPath)) {
  console.error(`Source database file not found: ${sourceDbPath}`);
  process.exit(1);
}

// Define the normalized directory in source files (to avoid processing these files)
const sourceNormalizedDir = path.join(sourceFilesDir, 'normalized');

// Define the upload directory from env or default
const uploadDir = process.env.UPLOAD_DIR || './uploads';
const normalizedDir = process.env.NORMALIZED_DIR || './normalized';

// Ensure directories exist
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

if (!fs.existsSync(normalizedDir)) {
  fs.mkdirSync(normalizedDir, { recursive: true });
}

// Create a source database connection
const SourceDataSource = new DataSource({
  type: 'sqlite',
  database: sourceDbPath,
  entities: [Media, MediaAnswer],
  synchronize: false,
  logging: false,
});

// Define source DB table schemas - needed for SQLite with different column names
// This helps map old database columns to our TypeORM entities
class OldMedia {
  id!: number;
  title!: string;
  file_path!: string;
  normalized_path?: string;
  year?: number;
  metadata?: string;
  created_at!: string;
}

class OldMediaAnswer {
  id!: number;
  media_id!: number;
  answer!: string;
  is_primary!: number | boolean; // SQLite might represent boolean as 0/1
}

/**
 * Copy a file from source to destination
 */
async function copyFile(source: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Create destination directory if it doesn't exist
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Create read and write streams
    const rd = fs.createReadStream(source);
    const wr = fs.createWriteStream(dest);

    // Handle errors
    rd.on('error', reject);
    wr.on('error', reject);
    wr.on('finish', resolve);

    // Start the copy
    rd.pipe(wr);
  });
}

/**
 * Main migration function
 */
async function migrate() {
  try {
    // At this point, we've validated that sourceFilesDir is defined
    // Tell TypeScript that this value is definitely a string
    const sourceDir = sourceFilesDir as string;
    
    // Connect to source database
    await SourceDataSource.initialize();
    logger.info(`Connected to source database: ${sourceDbPath}`);

    // Connect to destination database (AppDataSource from connection.ts)
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }
    logger.info(`Connected to destination database`);

    // Get all media entries from source using raw SQL query to handle column name differences
    const oldMediaEntries: OldMedia[] = await SourceDataSource.manager.query(
      `SELECT id, title, file_path, normalized_path, year, metadata, created_at FROM media`
    );
    
    logger.info(`Found ${oldMediaEntries.length} media entries in source database`);

    // Process each media entry
    for (let i = 0; i < oldMediaEntries.length; i++) {
      const sourceMedia = oldMediaEntries[i];
      logger.info(`Processing media ${i+1}/${oldMediaEntries.length}: ${sourceMedia.title}`);

      try {
        // Extract the filename from the file_path
        const sourceFileName = path.basename(sourceMedia.file_path);
        
        // Skip if this is a normalized file
        if (sourceMedia.file_path.includes('/normalized/')) {
          logger.info(`Skipping normalized file: ${sourceMedia.file_path}`);
          continue;
        }
        
        // Construct the full source file path - sourceDir is now asserted as a string
        const sourceFilePath = path.join(sourceDir, sourceFileName);
        
        if (!fs.existsSync(sourceFilePath)) {
          logger.error(`Source file not found: ${sourceFilePath}`);
          continue;
        }

        // Create a new filename for the destination
        const fileExt = path.extname(sourceFilePath);
        const newFileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${fileExt}`;
        const destFilePath = path.resolve(uploadDir, newFileName);

        // Copy the file to uploads directory
        logger.info(`Copying file from ${sourceFilePath} to ${destFilePath}`);
        await copyFile(sourceFilePath, destFilePath);

        // Process the file to create a normalized version
        logger.info(`Normalizing file ${destFilePath}`);
        const normalizedPath = await normalizeMedia(destFilePath, normalizedDir);
        
        // Relative path for storage in DB
        const relativeNormalizedPath = path.relative(process.cwd(), normalizedPath);

        // Create a new media entry in the destination database
        const newMedia = new Media();
        newMedia.title = sourceMedia.title;
        newMedia.filePath = destFilePath;
        newMedia.normalizedPath = relativeNormalizedPath;
        
        // Copy over other metadata if available
        if (sourceMedia.year) newMedia.year = sourceMedia.year;
        
        // Parse metadata if it exists and is a string
        let metadataObj = {};
        try {
          if (sourceMedia.metadata && typeof sourceMedia.metadata === 'string') {
            metadataObj = JSON.parse(sourceMedia.metadata);
          }
        } catch (e) {
          logger.warn(`Could not parse metadata for ${sourceMedia.title}: ${e}`);
        }
        
        // Create metadata object
        newMedia.metadata = {
          originalName: sourceFileName,
          size: fs.statSync(destFilePath).size,
          uploadedBy: 'migration',
          uploadDate: new Date().toISOString(),
          ...metadataObj
        };
        
        // Save the new media entry
        const savedMedia = await AppDataSource.manager.save(newMedia);
        logger.info(`Saved media entry with ID ${savedMedia.id}`);

        // Get all associated answers using raw SQL query
        const answers: OldMediaAnswer[] = await SourceDataSource.manager.query(
          `SELECT id, media_id, answer, is_primary FROM media_answers WHERE media_id = ?`, 
          [sourceMedia.id]
        );

        // Save each answer
        for (const answer of answers) {
          const newAnswer = new MediaAnswer();
          newAnswer.media = savedMedia;
          newAnswer.answer = answer.answer;
          
          // Handle the is_primary field which could be a number (0/1) or boolean
          if (typeof answer.is_primary === 'number') {
            newAnswer.isPrimary = answer.is_primary === 1;
          } else {
            newAnswer.isPrimary = !!answer.is_primary;
          }
          
          await AppDataSource.manager.save(newAnswer);
        }
        
        logger.info(`Saved ${answers.length} answers for media ${savedMedia.id}`);
        
      } catch (error) {
        logger.error(`Error processing media ${sourceMedia.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    logger.info(`Migration completed successfully!`);
  } catch (error) {
    logger.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Close database connections
    if (SourceDataSource.isInitialized) {
      await SourceDataSource.destroy();
    }
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}

// Run the migration
migrate().then(() => {
  logger.info('Migration script finished');
  process.exit(0);
}).catch(error => {
  logger.error(`Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});