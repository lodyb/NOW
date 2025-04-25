import express from 'express';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { normalizeMedia } from '../media/normalizer';
import { AppDataSource } from '../../database/connection';
import { Media } from '../../database/entities/Media';
import { MediaAnswer } from '../../database/entities/MediaAnswer';

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
      'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'
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
            
            // Save to database
            const media = new Media();
            media.title = title;
            media.filePath = file.path;
            media.normalizedPath = normalizedPath;
            media.metadata = {
              originalName: file.originalname,
              size: file.size,
              uploadedBy: user || 'anonymous',
              uploadDate: new Date().toISOString()
            };
            
            await AppDataSource.manager.save(media);
            
            // Create primary answer (the title itself)
            const answer = new MediaAnswer();
            answer.media = media;
            answer.answer = title;
            answer.isPrimary = true;
            
            await AppDataSource.manager.save(answer);
            
            return {
              originalName: file.originalname,
              title: title,
              id: media.id,
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
      const mediaRepository = AppDataSource.getRepository(Media);
      const media = await mediaRepository.find({
        order: { createdAt: 'DESC' },
        take: 20
      });
      
      res.json(media.map(item => ({
        id: item.id,
        title: item.title,
        createdAt: item.createdAt
      })));
    } catch (error) {
      logger.error(`Media listing error: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ success: false, message: 'Server error' });
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