#!/usr/bin/env node

// Direct replacement for the built server
// This bypasses TypeScript to ensure we have a working API server
// Run this instead of the original server to get working API endpoints

const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

// Set up paths
const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
const WEB_DIR = path.resolve(process.cwd(), 'web');
const PORT = process.env.PORT || 3000;

// Create upload directory if it doesn't exist
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Connect to database
const dbPath = path.join(process.cwd(), 'now.sqlite');
console.log(`Using database at: ${dbPath}`);

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
    process.exit(1);
  }
  console.log('Connected to the database');
});

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

// Create the Express app
const app = express();

// Log all requests for debugging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Parse JSON request bodies - MUST BE BEFORE ROUTES
app.use(express.json());

// Database helper functions (similar to our repositories)
// Helper function to find a media by ID
function findMediaById(id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM media WHERE id = ?', [id], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(null);
      resolve(row);
    });
  });
}

// Helper function to get answers for a media ID
function findAnswersByMediaId(mediaId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM media_answers WHERE media_id = ?', [mediaId], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

// Helper function to delete all answers for a media ID
function deleteMediaAnswersByMediaId(mediaId) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM media_answers WHERE media_id = ?', [mediaId], function(err) {
      if (err) return reject(err);
      resolve(this.changes);
    });
  });
}

// Helper function to save a media answer
function saveMediaAnswer(data) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO media_answers(media_id, answer, isPrimary) VALUES (?, ?, ?)',
      [data.media_id, data.answer, data.isPrimary ? 1 : 0],
      function(err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

// Helper function to save/update a media
function saveMedia(data) {
  return new Promise((resolve, reject) => {
    if (data.id) {
      // Update existing
      db.run(
        'UPDATE media SET title = ? WHERE id = ?',
        [data.title, data.id],
        function(err) {
          if (err) return reject(err);
          resolve(data.id);
        }
      );
    } else {
      // Insert new
      db.run(
        'INSERT INTO media(title, filePath, normalizedPath, metadata) VALUES (?, ?, ?, ?)',
        [data.title, data.filePath, data.normalizedPath, JSON.stringify(data.metadata || {})],
        function(err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    }
  });
}

// Helper function to delete a media item
function deleteMedia(id) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM media WHERE id = ?', [id], function(err) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
  });
}

// Helper function to get media items with their answers
async function getMediaWithAnswers(limit = 100) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM media ORDER BY createdAt DESC LIMIT ?', [limit], async (err, rows) => {
      if (err) return reject(err);
      
      try {
        // Parse metadata for each media item
        for (const media of rows) {
          try {
            media.metadata = JSON.parse(media.metadata || '{}');
          } catch (e) {
            media.metadata = {};
          }
        }
        
        // Get answers for each media item
        for (const media of rows) {
          media.answers = await findAnswersByMediaId(media.id);
        }
        
        resolve(rows);
      } catch (error) {
        reject(error);
      }
    });
  });
}

// Media normalization function
async function normalizeMedia(filePath) {
  console.log(`Normalizing media: ${filePath}`);
  
  // This is a placeholder - in a real implementation, this would call your 
  // existing normalization code or execute ffmpeg commands
  
  // For now, let's just return the original file path
  // In production, you'd create a normalized version
  return filePath;
}

// Validate an upload token
function validateUploadToken(token, userId) {
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
    console.error(`Token validation error: ${error.message}`);
    return false;
  }
}

// API ROUTES - Define all API routes
const apiRouter = express.Router();

// Test route to verify the API is working
apiRouter.get('/test', (req, res) => {
  console.log('Test API endpoint hit');
  res.json({ success: true, message: 'API is working' });
});

// Route for token validation
apiRouter.get('/validate-token', (req, res) => {
  const { token, user } = req.query;
  
  if (!token || !user || typeof token !== 'string' || typeof user !== 'string') {
    return res.status(400).json({ valid: false, message: 'Invalid request' });
  }
  
  try {
    // Validate the token
    const isValid = validateUploadToken(token, user);
    res.json({ valid: isValid });
  } catch (error) {
    console.error(`Token validation error: ${error.message}`);
    res.status(500).json({ valid: false, message: 'Server error' });
  }
});

// Route for file uploads
apiRouter.post('/upload', upload.array('files', 20), async (req, res) => {
  try {
    const { token, user, titles } = req.body;
    
    // For development/testing: Skip token validation if not provided
    if (token && user) {
      // Validate the token
      if (!validateUploadToken(token, user)) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
      }
    } else {
      console.warn('Upload request received without token/user - skipping validation for development');
    }
    
    const files = req.files;
    
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
          console.error(`Error processing uploaded file ${file.originalname}: ${error.message}`);
          
          // Clean up failed file
          try {
            fs.unlinkSync(file.path);
          } catch (e) {
            // Ignore cleanup errors
          }
          
          return {
            originalName: file.originalname,
            success: false,
            error: error.message
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
    console.error(`Upload error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Server error during upload processing' });
  }
});

// API route for media listing
apiRouter.get('/media', async (req, res) => {
  try {
    // Get all media and answers from database
    const mediaList = await getMediaWithAnswers(100);
    
    res.json({
      success: true,
      media: mediaList
    });
  } catch (error) {
    console.error(`Media listing error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// API route for updating media - accept both PUT and POST
apiRouter.put('/media/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { answers: answersText } = req.body;
    
    console.log(`Media update request received for /api/media/${id} with method PUT`);
    console.log(`Request body:`, req.body);
    
    if (!id) {
      console.error('No media ID provided in request params');
      return res.status(400).json({ success: false, message: 'No media ID provided' });
    }
    
    // Parse ID as integer
    const mediaId = parseInt(id);
    if (isNaN(mediaId)) {
      console.error(`Invalid media ID format: ${id}`);
      return res.status(400).json({ success: false, message: 'Invalid media ID format' });
    }
    
    console.log(`Looking for media with ID: ${mediaId}`);
    
    // Get the media item
    let media;
    try {
      media = await findMediaById(mediaId);
      
      if (media) {
        console.log(`Found media: ${JSON.stringify({ id: media.id, title: media.title })}`);
      } else {
        console.error(`Media not found with ID: ${mediaId}`);
        
        // Direct DB queries for debugging
        db.get('SELECT COUNT(*) as count FROM media', [], (err, row) => {
          if (err) {
            console.error('Error counting media:', err.message);
          } else {
            console.log(`Total media count in database: ${row ? row.count : 'unknown'}`);
          }
        });
        
        return res.status(404).json({ 
          success: false, 
          message: 'Media not found',
          mediaId: mediaId
        });
      }
    } catch (findError) {
      console.error(`Error finding media: ${findError.message}`);
      return res.status(500).json({ 
        success: false, 
        message: 'Error finding media',
        error: findError.message
      });
    }
    
    // Check for answers field
    if (!answersText && answersText !== '') {
      console.error(`Missing answers field in request body for media ${id}`);
      return res.status(400).json({ success: false, message: 'Missing answers field in request body' });
    }
    
    // Split answers by newline and filter out empty lines
    const answerLines = (answersText || '').split('\n').filter((line) => line.trim() !== '');
    
    if (answerLines.length === 0) {
      console.error('No valid answers provided in request');
      return res.status(400).json({ success: false, message: 'At least a title is required (first line)' });
    }
    
    // First line is the title, remaining lines are alternative answers
    const title = answerLines[0].trim();
    const alternateAnswers = answerLines.slice(1).map((line) => line.trim());
    
    console.log(`Updating media ${id}: title="${title}", alternateAnswers=[${alternateAnswers.join(', ')}]`);
    
    // Update title if different
    if (title !== media.title) {
      console.log(`Updating title for media ${id} from "${media.title}" to "${title}"`);
      try {
        await saveMedia({
          id: mediaId,
          title: title
        });
        console.log(`Updated title for media ${id} to: ${title}`);
      } catch (titleError) {
        console.error(`Error updating title for media ${id}: ${titleError.message}`);
        return res.status(500).json({ 
          success: false, 
          message: 'Error updating media title',
          error: titleError.message
        });
      }
    }
    
    try {
      // First, delete all existing answers
      console.log(`Deleting existing answers for media ${id}...`);
      await deleteMediaAnswersByMediaId(mediaId);
      console.log(`Deleted all existing answers for media ${id}`);
      
      // Create new primary answer (the title)
      await saveMediaAnswer({
        media_id: mediaId,
        answer: title,
        isPrimary: true
      });
      console.log(`Added primary answer for media ${id}: ${title}`);
      
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
        console.log(`Added alternate answer for media ${id}: ${answer.trim()}`);
      }
    } catch (answerError) {
      console.error(`Error updating answers for media ${id}: ${answerError.message}`);
      return res.status(500).json({ 
        success: false, 
        message: 'Error updating answers',
        error: answerError.message
      });
    }
    
    // Get updated media
    const updatedMedia = await findMediaById(mediaId);
    if (!updatedMedia) {
      console.error(`Failed to retrieve updated media with ID ${mediaId} after successful update`);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve updated media after changes'
      });
    }

    // Get updated answers
    const answers = await findAnswersByMediaId(mediaId);
    updatedMedia.answers = answers;
    
    res.json({
      success: true,
      message: 'Media updated successfully',
      media: updatedMedia
    });
  } catch (error) {
    console.error(`Media update error: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during update',
      error: error.message
    });
  }
});

// Make POST work too for better compatibility
apiRouter.post('/media/:id', async (req, res) => {
  // Just delegate to the PUT handler
  try {
    await apiRouter.put('/media/:id')(req, res);
  } catch (err) {
    console.error('Error in POST handler:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// API endpoint for serving media files
apiRouter.get('/media/:id/preview', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ success: false, message: 'No media ID provided' });
    }
    
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
    console.error(`Media preview error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// API endpoint for waveform images
apiRouter.get('/media/:id/waveform', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ success: false, message: 'No media ID provided' });
    }
    
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
    console.error(`Waveform error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// API endpoint for deleting media
apiRouter.delete('/media/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ success: false, message: 'No media ID provided' });
    }
    
    const media = await findMediaById(parseInt(id));
    
    if (!media) {
      return res.status(404).json({ success: false, message: 'Media not found' });
    }
    
    // Delete from database
    await deleteMedia(parseInt(id));
    
    // Delete files if they exist
    const filePaths = [
      media.filePath, 
      media.normalizedPath
    ].filter(Boolean);
    
    // Try to delete files (but don't fail if files can't be deleted)
    for (const filePath of filePaths) {
      try {
        if (filePath) {
          const fullPath = filePath.startsWith('/') ? filePath : path.resolve(process.cwd(), filePath);
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            console.log(`Deleted file: ${fullPath}`);
          }
        }
      } catch (fileError) {
        console.error(`Error deleting file ${filePath}: ${fileError.message}`);
        // Continue with other files even if one fails
      }
    }
    
    res.json({
      success: true,
      message: 'Media deleted successfully'
    });
  } catch (error) {
    console.error(`Media deletion error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Server error during media deletion' });
  }
});

// Mount the API router
app.use('/api', apiRouter);

// Legacy route redirects
app.get('/validate-token', (req, res) => res.redirect(`/api/validate-token?${new URLSearchParams(req.query).toString()}`));
app.post('/upload', (req, res) => res.redirect(307, '/api/upload'));

// Serve static files AFTER API routes
app.use(express.static(WEB_DIR));

// Default route - serve the upload page (must be last)
app.get('*', (req, res) => {
  res.sendFile(path.join(WEB_DIR, 'upload.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Available API routes:');
  apiRouter.stack.forEach((r) => {
    if (r.route && r.route.path) {
      const methods = Object.keys(r.route.methods).map(m => m.toUpperCase()).join(',');
      console.log(`${methods.padEnd(7)} /api${r.route.path}`);
    }
  });
});

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.log('Closing database connection');
  db.close();
  process.exit(0);
});