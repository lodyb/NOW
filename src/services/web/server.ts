import express, { Request, Response } from 'express';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { normalizeMedia } from '../media/normalizer';

// Import our new database repositories
import { Media, MediaAnswer } from '../../database/types';
import { findMediaById, saveMedia } from '../../database/repositories/mediaRepository';
import { findAnswersByMediaId, saveMediaAnswer, deleteMediaAnswersByMediaId } from '../../database/repositories/mediaAnswerRepository';

// Upload directory
const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
const WEB_DIR = path.resolve(process.cwd(), 'web');

// Create upload directory if it doesn't exist
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  }
});

// Configure multer upload
const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max for initial upload (will be processed down)
  },
  fileFilter: (_req, file, cb) => {
    // Accept audio and video files
    const allowedTypes = [
      'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav',
      'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
      'video/x-matroska', 'video/x-mkv', 'video/matroska', 'video/mkv'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      // Need to pass null as the first parameter for the error callback
      cb(null, false);
      return new Error(`Invalid file type: ${file.mimetype}. Only audio and video files are allowed.`);
    }
  }
});

/**
 * Start the web server for media uploads
 * @param port Port to run the server on
 */
export async function startWebServer(port: number): Promise<void> {
  const app = express();
  
  // Basic security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });
  
  // Parse JSON body
  app.use(express.json());
  
  // Serve static files from web directory
  app.use(express.static(WEB_DIR));
  
  // API Routes
  // Route for token validation
  app.get('/api/validate-token', (req, res) => {
    const { token, user } = req.query;
    
    if (!token || !user || typeof token !== 'string' || typeof user !== 'string') {
      return res.status(400).json({ valid: false, message: 'Invalid request' });
    }
    
    try {
      // Validate the token
      const isValid = validateUploadToken(token, user);
      res.json({ valid: isValid });
    } catch (error) {
      logger.error(`Token validation error: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ valid: false, message: 'Server error' });
    }
  });
  
  // Route for file uploads
  app.post('/api/upload', upload.array('files', 20), async (req, res) => {
    try {
      const { token, user, titles } = req.body;
      
      // For development/testing: Skip token validation if not provided
      if (token && user) {
        // Validate the token
        if (!validateUploadToken(token, user)) {
          return res.status(401).json({ success: false, message: 'Invalid or expired token' });
        }
      } else {
        logger.warn('Upload request received without token/user - skipping validation for development');
      }
      
      const files = req.files as Express.Multer.File[];
      
      if (!files || files.length === 0) {
        return res.status(400).json({ success: false, message: 'No files uploaded' });
      }
      
      // Parse titles
      const titlesList = titles ? JSON.parse(titles) : [];
      
      // Process each uploaded file
      const results = await Promise.all(
        files.map(async (file, index) => {
          try {
            // Get title for this file
            const title = titlesList[index] || path.basename(file.originalname, path.extname(file.originalname));
            
            // Normalize the media file for Discord compatibility
            const normalizedPath = await normalizeMedia(file.path);
            
            // Save to database using our repository
            const mediaId = await saveMedia({
              title,
              filePath: file.path,
              normalizedPath,
              metadata: {
                originalName: file.originalname,
                size: file.size,
                uploadedBy: user || 'anonymous',
                uploadDate: new Date().toISOString()
              }
            });
            
            // Create primary answer (the title itself)
            await saveMediaAnswer({
              media_id: mediaId,
              answer: title,
              isPrimary: true
            });
            
            return {
              originalName: file.originalname,
              title: title,
              id: mediaId,
              success: true
            };
          } catch (error) {
            logger.error(`Error processing uploaded file ${file.originalname}: ${error instanceof Error ? error.message : String(error)}`);
            
            // Clean up failed file
            try {
              fs.unlinkSync(file.path);
            } catch (e) {
              // Ignore cleanup errors
            }
            
            return {
              originalName: file.originalname,
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            };
          }
        })
      );
      
      // Return results
      res.json({
        success: true,
        message: `Processed ${results.filter(r => r.success).length} of ${files.length} files`,
        results
      });
    } catch (error) {
      logger.error(`Upload error: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ success: false, message: 'Server error during upload processing' });
    }
  });
  
  // API route for media listing
  app.get('/api/media', async (req, res) => {
    try {
      // Get all media and answers from database
      const mediaList = await getMediaWithAnswers(100);
      
      res.json({
        success: true,
        media: mediaList.map(item => ({
          id: item.id,
          title: item.title,
          normalizedPath: item.normalizedPath,
          filePath: item.filePath,
          createdAt: item.createdAt,
          answers: item.answers
        }))
      });
    } catch (error) {
      logger.error(`Media listing error: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });
  
  // API route for updating media - accept both PUT and POST for better compatibility
  app.put('/api/media/:id', handleMediaUpdate);
  app.post('/api/media/:id', handleMediaUpdate);
  
  // Handler function for media updates (shared between PUT and POST)
  async function handleMediaUpdate(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { answers: answersText } = req.body;
      
      // Log the request for debugging
      logger.info(`Media update request received for /api/media/${id} with method ${req.method}`);
      logger.info(`Request body: ${JSON.stringify(req.body)}`);
      
      if (!id) {
        logger.error('No media ID provided in request params');
        return res.status(400).json({ success: false, message: 'No media ID provided' });
      }
      
      // Parse ID as integer
      const mediaId = parseInt(id);
      if (isNaN(mediaId)) {
        logger.error(`Invalid media ID format: ${id}`);
        return res.status(400).json({ success: false, message: 'Invalid media ID format' });
      }
      
      logger.info(`Looking for media with ID: ${mediaId}`);
      
      // Get the media item using our repository
      const media = await findMediaById(mediaId);
      
      if (!media) {
        logger.error(`Media not found with ID: ${id}`);
        return res.status(404).json({ success: false, message: 'Media not found' });
      }
      
      logger.info(`Found media: ${JSON.stringify({ id: media.id, title: media.title })}`);
      
      if (!answersText && answersText !== '') {
        logger.error(`Missing answers field in request body for media ${id}`);
        return res.status(400).json({ success: false, message: 'Missing answers field in request body' });
      }
      
      // Split answers by newline and filter out empty lines
      const answerLines = (answersText || '').split('\n').filter((line: string) => line.trim() !== '');
      
      if (answerLines.length === 0) {
        logger.error('No valid answers provided in request');
        return res.status(400).json({ success: false, message: 'At least a title is required (first line)' });
      }
      
      // First line is the title, remaining lines are alternative answers
      const title = answerLines[0].trim();
      const alternateAnswers = answerLines.slice(1).map((line: string) => line.trim());
      
      logger.info(`Updating media ${id}: title="${title}", alternateAnswers=[${alternateAnswers.join(', ')}]`);
      
      // Update title if different
      if (title !== media.title) {
        logger.info(`Updating title for media ${id} from "${media.title}" to "${title}"`);
        try {
          await saveMedia({
            id: mediaId,
            title: title
          });
          logger.info(`Updated title for media ${id} to: ${title}`);
        } catch (titleError) {
          logger.error(`Error updating title for media ${id}: ${titleError instanceof Error ? titleError.message : String(titleError)}`);
          return res.status(500).json({ 
            success: false, 
            message: 'Error updating media title',
            error: titleError instanceof Error ? titleError.message : String(titleError)
          });
        }
      }
      
      try {
        // First, delete all existing answers
        logger.info(`Deleting existing answers for media ${id}...`);
        await deleteMediaAnswersByMediaId(mediaId);
        logger.info(`Deleted all existing answers for media ${id}`);
        
        // Create new primary answer (the title)
        await saveMediaAnswer({
          media_id: mediaId,
          answer: title,
          isPrimary: true
        });
        logger.info(`Added primary answer for media ${id}: ${title}`);
        
        // Create new alternate answers
        for (const answer of alternateAnswers) {
          // Skip empty answers
          if (!answer || answer.trim() === '') continue;
          
          // Skip if it's identical to the title (we already have a primary answer for that)
          if (answer.trim().toLowerCase() === title.toLowerCase()) continue;
          
          await saveMediaAnswer({
            media_id: mediaId,
            answer: answer.trim(),
            isPrimary: false
          });
          logger.info(`Added alternate answer for media ${id}: ${answer.trim()}`);
        }
      } catch (answerError) {
        logger.error(`Error updating answers for media ${id}: ${answerError instanceof Error ? answerError.message : String(answerError)}`);
        return res.status(500).json({ 
          success: false, 
          message: 'Error updating answers',
          error: answerError instanceof Error ? answerError.message : String(answerError)
        });
      }
      
      // Get updated media
      const updatedMedia = await findMediaById(mediaId);
      if (!updatedMedia) {
        logger.error(`Failed to retrieve updated media with ID ${mediaId} after successful update`);
        return res.status(500).json({
          success: false,
          message: 'Failed to retrieve updated media after changes'
        });
      }
      
      res.json({
        success: true,
        message: 'Media updated successfully',
        media: updatedMedia
      });
    } catch (error) {
      logger.error(`Media update error: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ 
        success: false, 
        message: 'Server error during update',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  // API endpoint for serving media files
  app.get('/media/:id/preview', async (req, res) => {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json({ success: false, message: 'No media ID provided' });
      }
      
      // Get the media item using our repository
      const media = await findMediaById(parseInt(id));
      
      if (!media) {
        return res.status(404).json({ success: false, message: 'Media not found' });
      }
      
      // Get the file path
      const filePath = media.normalizedPath || media.filePath;
      
      if (!filePath) {
        return res.status(404).json({ success: false, message: 'Media file path not found' });
      }
      
      // Check if file exists
      const fullPath = path.resolve(process.cwd(), filePath);
      if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ success: false, message: 'Media file not found on disk' });
      }
      
      // Send the file
      res.sendFile(fullPath);
    } catch (error) {
      logger.error(`Media preview error: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // API endpoint for waveform images (placeholder for now, returns a static image)
  app.get('/media/:id/waveform', async (req, res) => {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json({ success: false, message: 'No media ID provided' });
      }
      
      // Get the media item using our repository
      const media = await findMediaById(parseInt(id));
      
      if (!media) {
        return res.status(404).json({ success: false, message: 'Media not found' });
      }
      
      // For now, just send a generic waveform image or fallback to the actual audio file
      const wavePath = path.join(WEB_DIR, 'assets', 'waveform.png');
      
      if (fs.existsSync(wavePath)) {
        res.sendFile(wavePath);
      } else {
        // Fallback to actual audio file
        const filePath = media.normalizedPath || media.filePath;
        
        if (!filePath) {
          return res.status(404).json({ success: false, message: 'Media file path not found' });
        }
        
        const fullPath = path.resolve(process.cwd(), filePath);
        if (!fs.existsSync(fullPath)) {
          return res.status(404).json({ success: false, message: 'Media file not found on disk' });
        }
        
        res.sendFile(fullPath);
      }
    } catch (error) {
      logger.error(`Waveform error: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // API endpoint for deleting media
  app.delete('/api/media/:id', async (req, res) => {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json({ success: false, message: 'No media ID provided' });
      }
      
      // Get the media item using our repository
      const media = await findMediaById(parseInt(id));
      
      if (!media) {
        return res.status(404).json({ success: false, message: 'Media not found' });
      }
      
      // Get the file paths to delete
      const filePaths = [
        media.filePath, 
        media.normalizedPath,
        media.uncompressedPath
      ].filter(Boolean);
      
      // First delete from database
      await deleteMedia(parseInt(id));
      
      // Then try to delete files (but don't fail if files can't be deleted)
      for (const filePath of filePaths) {
        try {
          if (filePath) {
            const fullPath = filePath.startsWith('/') ? filePath : path.resolve(process.cwd(), filePath);
            if (fs.existsSync(fullPath)) {
              fs.unlinkSync(fullPath);
              logger.info(`Deleted file: ${fullPath}`);
            }
          }
        } catch (fileError) {
          logger.error(`Error deleting file ${filePath}: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
          // Continue with other files even if one fails
        }
      }
      
      res.json({
        success: true,
        message: 'Media deleted successfully'
      });
    } catch (error) {
      logger.error(`Media deletion error: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ success: false, message: 'Server error during media deletion' });
    }
  });
  
  // Keep the old routes for backward compatibility
  app.get('/validate-token', (req, res) => res.redirect(`/api/validate-token?${new URLSearchParams(req.query as any).toString()}`));
  app.post('/upload', (req, res) => res.redirect(307, '/api/upload'));
  
  // Default route - serve the upload page
  app.get('*', (req, res) => {
    res.sendFile(path.join(WEB_DIR, 'upload.html'));
  });
  
  // Start the server
  return new Promise((resolve, reject) => {
    try {
      const server = app.listen(port, () => {
        logger.info(`Web server started on http://localhost:${port}`);
        resolve();
      });
      
      server.on('error', (error) => {
        reject(error);
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Validate an upload token
 * @param token The token to validate
 * @param userId The user ID that should match the token
 * @returns True if the token is valid
 */
function validateUploadToken(token: string, userId: string): boolean {
  try {
    // Decode the token
    const decoded = Buffer.from(token, 'base64').toString();
    const [tokenUserId, expiresStr, signature] = decoded.split('-');
    
    // Check user ID
    if (tokenUserId !== userId) {
      return false;
    }
    
    // Check expiration
    const expires = parseInt(expiresStr, 10);
    if (isNaN(expires) || Date.now() > expires) {
      return false;
    }
    
    // Verify signature
    const secret = process.env.UPLOAD_SECRET || 'default-secret-key';
    const data = `${userId}-${expires}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(data);
    const expectedSignature = hmac.digest('hex');
    
    return signature === expectedSignature;
  } catch (error) {
    logger.error(`Token validation error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Helper function to get media items with their answers
 */
async function getMediaWithAnswers(limit: number = 100): Promise<Media[]> {
  // Import needed function to avoid circular dependency
  const { getQuery } = await import('../../database/connection');
  
  // Get media items ordered by creation date
  const mediaItems = await getQuery<Media>(
    'SELECT * FROM media ORDER BY createdAt DESC LIMIT ?',
    [limit]
  );
  
  // Parse metadata for each media item
  for (const media of mediaItems) {
    try {
      media.metadata = JSON.parse(media.metadata as unknown as string);
    } catch (e) {
      media.metadata = {};
    }
  }
  
  // Get answers for each media item
  for (const media of mediaItems) {
    media.answers = await findAnswersByMediaId(media.id);
  }
  
  return mediaItems;
}

/**
 * Helper function to delete a media item by ID
 */
async function deleteMedia(id: number): Promise<boolean> {
  // Import needed function to avoid circular dependency
  const { runQuery } = await import('../../database/connection');
  
  try {
    // Delete the media (all related answers will be deleted by the ON DELETE CASCADE)
    await runQuery('DELETE FROM media WHERE id = ?', [id]);
    return true;
  } catch (error) {
    logger.error(`Error deleting media: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}