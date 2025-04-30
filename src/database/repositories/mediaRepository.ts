import { getOne, getQuery, runQuery } from '../connection';
import { Media, MediaAnswer } from '../types';
import { logger } from '../../utils/logger';

export async function findMediaById(id: number): Promise<Media | null> {
  // Get the media
  const media = await getOne<Media>('SELECT * FROM media WHERE id = ?', [id]);
  
  if (!media) return null;
  
  // Parse the metadata field
  try {
    media.metadata = JSON.parse(media.metadata as unknown as string);
  } catch (e) {
    media.metadata = {};
  }
  
  // Get the answers
  media.answers = await getQuery<MediaAnswer>(
    'SELECT * FROM media_answers WHERE media_id = ?', 
    [id]
  );
  
  return media;
}

export async function findMediaByTitle(searchTerm: string, limit: number = 1): Promise<Media[]> {
  // Search for media by title or answer using LIKE
  const sql = `
    SELECT DISTINCT m.* 
    FROM media m
    LEFT JOIN media_answers ma ON m.id = ma.media_id
    WHERE m.title LIKE ? OR ma.answer LIKE ?
    ORDER BY RANDOM()
    LIMIT ?
  `;
  
  const searchPattern = `%${searchTerm}%`;
  const mediaList = await getQuery<Media>(sql, [searchPattern, searchPattern, limit]);
  
  // Parse the metadata for each media
  for (const media of mediaList) {
    try {
      media.metadata = JSON.parse(media.metadata as unknown as string);
    } catch (e) {
      media.metadata = {};
    }
  }
  
  // Get the answers for each media
  for (const media of mediaList) {
    media.answers = await getQuery<MediaAnswer>(
      'SELECT * FROM media_answers WHERE media_id = ?', 
      [media.id]
    );
  }
  
  return mediaList;
}

export async function saveMedia(media: Partial<Media>): Promise<number> {
  try {
    // If id is present, update the media
    if (media.id) {
      const sql = `
        UPDATE media 
        SET 
          title = COALESCE(?, title),
          filePath = COALESCE(?, filePath),
          normalizedPath = ?,
          uncompressedPath = ?,
          year = ?,
          metadata = COALESCE(?, metadata)
        WHERE id = ?
      `;
      
      // Convert metadata to string if it exists
      const metadataStr = media.metadata ? JSON.stringify(media.metadata) : null;
      
      await runQuery(sql, [
        media.title, 
        media.filePath, 
        media.normalizedPath, 
        media.uncompressedPath,
        media.year, 
        metadataStr, 
        media.id
      ]);
      
      return media.id;
    } 
    // Otherwise, insert a new media
    else {
      // Only title and filePath are required
      if (!media.title || !media.filePath) {
        throw new Error('Title and filePath are required');
      }
      
      const sql = `
        INSERT INTO media (
          title, filePath, normalizedPath, uncompressedPath, year, metadata
        ) VALUES (?, ?, ?, ?, ?, ?)
      `;
      
      // Convert metadata to string
      const metadataStr = media.metadata ? JSON.stringify(media.metadata) : '{}';
      
      return new Promise<number>((resolve, reject) => {
        runQuery(sql, [
          media.title, 
          media.filePath, 
          media.normalizedPath || null, 
          media.uncompressedPath || null,
          media.year || null, 
          metadataStr
        ])
          .then(() => {
            // Get the last inserted id
            getOne<{id: number}>('SELECT last_insert_rowid() as id')
              .then(result => resolve(result?.id || 0))
              .catch(reject);
          })
          .catch(reject);
      });
    }
  } catch (error) {
    logger.error(`Error saving media: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function getRandomMedia(limit: number = 1): Promise<Media[]> {
  const sql = `
    SELECT * FROM media
    ORDER BY RANDOM()
    LIMIT ?
  `;
  
  const mediaList = await getQuery<Media>(sql, [limit]);
  
  // Parse the metadata for each media
  for (const media of mediaList) {
    try {
      media.metadata = JSON.parse(media.metadata as unknown as string);
    } catch (e) {
      media.metadata = {};
    }
  }
  
  // Get the answers for each media
  for (const media of mediaList) {
    media.answers = await getQuery<MediaAnswer>(
      'SELECT * FROM media_answers WHERE media_id = ?', 
      [media.id]
    );
  }
  
  return mediaList;
}

export async function getMediaCount(): Promise<number> {
  const result = await getOne<{count: number}>('SELECT COUNT(*) as count FROM media');
  return result?.count || 0;
}

export async function deleteMedia(id: number): Promise<boolean> {
  try {
    await runQuery('DELETE FROM media WHERE id = ?', [id]);
    return true;
  } catch (error) {
    logger.error(`Error deleting media: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}