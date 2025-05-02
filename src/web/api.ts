import express, { Request as ExpressRequest, Response } from 'express';
import path from 'path';
import multer, { FileFilterCallback } from 'multer';
import fs from 'fs';
import { normalizeMedia, generateThumbnailsForExistingMedia } from '../media/processor';
import { 
  findAllMedia, 
  saveMedia, 
  saveMediaAnswers, 
  toggleMediaDeleted,
  getMediaById,
  findAllMediaPaginated
} from '../database/db';

// Extend request type to include multer's file property
interface Request extends ExpressRequest {
  file?: Express.Multer.File;
  fileValidationError?: string;
}

const router = express.Router();
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const PROCESSED_DIR = path.join(process.cwd(), 'processed');
const NORMALIZED_DIR = path.join(process.cwd(), 'normalized');
const THUMBNAILS_DIR = path.join(process.cwd(), 'thumbnails');

// Track SSE clients
const sseClients = new Map<number, Response>();

// Ensure directories exist
[UPLOADS_DIR, PROCESSED_DIR, NORMALIZED_DIR, THUMBNAILS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB limit for initial upload
  fileFilter: (req: Request, file, cb) => {
    const allowedTypes = [
      'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'video/x-ms-wmv',
      'video/mp4', 'video/webm', 'video/avi', 'video/quicktime', 'video/x-matroska'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(null, false);
      (req as Request).fileValidationError = `Unsupported file type: ${file.mimetype}`;
    }
  }
});

// Serve static files
router.use('/media/normalized', express.static(NORMALIZED_DIR));
router.use('/media/uploads', express.static(UPLOADS_DIR));
router.use('/media/thumbnails', express.static(THUMBNAILS_DIR));

// Serve SPA from root
router.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'src/web/public/index.html'));
});

// API endpoints
router.get('/api/media', async (req, res) => {
  try {
    const search = req.query.search as string | undefined;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    
    const mediaData = await findAllMediaPaginated(page, pageSize, search);
    
    // Deduplicate items by ID to prevent duplicates in response
    const uniqueItems = Array.from(
      new Map(mediaData.items.map(item => [item.id, item])).values()
    );
    
    res.json({
      items: uniqueItems,
      total: mediaData.total,
      page,
      pageSize,
      totalPages: Math.ceil(mediaData.total / pageSize)
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Get media by ID
router.get('/api/media/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid media ID' });
    }
    
    const media = await getMediaById(id);
    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }
    
    res.json(media);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Check media processing status - Note: Removed duplicate endpoint
router.get('/api/media/:id/status', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid media ID' });
    }
    
    const media = await getMediaById(id);
    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }
    
    // If normalizedPath is set, the media is ready for use
    const isReady = !!media.normalizedPath;
    
    res.json({ 
      id: media.id,
      isReady,
      normalizedPath: media.normalizedPath,
      title: media.title,
      filePath: media.filePath
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/api/media/:id/toggle-deleted', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid media ID' });
    }
    
    await toggleMediaDeleted(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// SSE endpoint for media processing status
router.get('/api/sse/media-status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  
  // Keep connection alive with ping every 30 seconds
  const pingInterval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`);
  }, 30000);
  
  // Store the client connection
  const clientId = Date.now();
  sseClients.set(clientId, res);
  
  // Handle client disconnect
  req.on('close', () => {
    clearInterval(pingInterval);
    sseClients.delete(clientId);
  });
});

// Helper to send SSE update for media
function sendMediaStatusUpdate(mediaId: number, status: 'processing' | 'complete' | 'error', data?: any) {
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify({
      type: 'mediaStatus',
      mediaId,
      status,
      ...data
    })}\n\n`);
  });
}

// Handle file upload
router.post('/api/upload', upload.single('file'), express.json(), async (req: Request, res) => {
  try {
    if (req.fileValidationError) {
      return res.status(400).json({ error: req.fileValidationError });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Extract filename without extension as initial title/answer
    const filename = path.basename(req.file.originalname, path.extname(req.file.originalname));
    
    // Clean the filename for use as an answer (replace special chars with spaces)
    const cleanAnswer = filename.replace(/[-_]/g, ' ');
    
    // Determine if it's video or audio based on mimetype
    const isVideo = req.file.mimetype.startsWith('video/');
    
    // Start with normalizedPath as null and handle processing separately
    const mediaId = await saveMedia(
      cleanAnswer,
      req.file.path,
      null, // Start with null normalizedPath
      null, // No year
      { uploadedBy: req.query.user || 'unknown', originalFilename: req.file.originalname }
    );
    
    // Check if answers were provided in the request body, otherwise use filename
    const userAnswers = req.body.answers ? 
      (Array.isArray(req.body.answers) ? req.body.answers : [req.body.answers]) : 
      [cleanAnswer];
    
    // Save the answers
    await saveMediaAnswers(mediaId, userAnswers);
    
    // Create callback function for updating the database when processing is complete
    const updateMediaAfterProcessing = (normalizedPath: string) => {
      // Use our exported db functions instead of direct db access for consistency
      if (!mediaId || isNaN(mediaId)) {
        console.error('Invalid media ID when updating normalizedPath:', mediaId);
        sendMediaStatusUpdate(mediaId, 'error', { message: 'Invalid media ID' });
        return;
      }
      
      const db = require('../database/db').db;
      db.run(`UPDATE media SET normalizedPath = ? WHERE id = ?`, [normalizedPath, mediaId], function(err: Error | null) {
        if (err) {
          console.error(`Failed to update normalizedPath for media ${mediaId}:`, err);
          sendMediaStatusUpdate(mediaId, 'error', { message: err.message });
          return;
        }
        
        console.log(`Media ${mediaId} normalized successfully: ${normalizedPath}`);
        sendMediaStatusUpdate(mediaId, 'complete', { normalizedPath });
      });
    };
    
    // Respond to the client immediately with the media ID
    res.json({ 
      id: mediaId, 
      message: 'File uploaded and being processed. It will appear in the media list when ready.' 
    });
    
    // Send initial processing status
    sendMediaStatusUpdate(mediaId, 'processing');
    
    // Process the media file asynchronously (don't await)
    normalizeMedia(req.file.path, updateMediaAfterProcessing).catch(error => {
      console.error(`Error processing media ${mediaId}: ${error.message}`);
      sendMediaStatusUpdate(mediaId, 'error', { message: error.message });
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Update media answers
router.put('/api/media/:id/answers', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid media ID' });
    }
    
    const { answers } = req.body;
    if (!Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ error: 'Answers must be a non-empty array' });
    }
    
    await saveMediaAnswers(id, answers);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Generate thumbnails for existing videos without them
router.get('/api/generate-thumbnails', async (req, res) => {
  try {
    generateThumbnailsForExistingMedia();
    res.json({ success: true, message: 'Thumbnail generation started for existing media' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Generate thumbnails for existing videos without them
router.post('/api/generate-thumbnails', async (req, res) => {
  try {
    generateThumbnailsForExistingMedia();
    res.json({ success: true, message: 'Thumbnail generation started for existing media' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;