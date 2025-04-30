#!/usr/bin/env node

import 'reflect-metadata';
import { Command } from 'commander';
import { AppDataSource } from '../database/connection';
import { logger } from '../utils/logger';
import { processAllMedia, processSingleFile } from '../services/media/normalizer';

// Define option types
interface AllCommandOptions {
  verbose?: boolean;
}

interface FileCommandOptions {
  file: string;
  verbose?: boolean;
}

// Set up CLI options
const program = new Command();
program
  .name('now-normalize')
  .description('Normalize media files for Discord compatibility')
  .version('1.0.0');

// Command for normalizing all media in the database
program
  .command('all')
  .description('Process all media files in the database')
  .option('-v, --verbose', 'Show verbose output')
  .action(async (options: AllCommandOptions) => {
    try {
      // Initialize database connection
      await AppDataSource.initialize();
      
      // Process all media
      const results = await processAllMedia(options.verbose);
      
      // Close database connection
      await AppDataSource.destroy();
      
      process.exit(0);
    } catch (error) {
      logger.error(`Error in media normalization process: ${error}`);
      process.exit(1);
    }
  });

// Command for normalizing a single file
const fileCommand = program
  .command('file')
  .description('Process a single media file');

// Add options to the file command
fileCommand
  .option('--file <path>', 'Path to the media file', '')
  .option('-v, --verbose', 'Show verbose output')
  .action(async (options: FileCommandOptions) => {
    try {
      if (!options.file) {
        logger.error('No file specified. Use --file parameter to specify the file to normalize.');
        fileCommand.help();
        process.exit(1);
      }

      // Initialize database connection
      await AppDataSource.initialize();
      
      // Process single file
      const normalizedPath = await processSingleFile(options.file, undefined, options.verbose);
      
      // Close database connection
      await AppDataSource.destroy();
      
      if (normalizedPath) {
        logger.info(`Successfully normalized file to: ${normalizedPath}`);
        process.exit(0);
      } else {
        logger.error(`Failed to normalize file: ${options.file}`);
        process.exit(1);
      }
    } catch (error) {
      logger.error(`Error in media normalization process: ${error}`);
      process.exit(1);
    }
  });

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}