import { getOne, getQuery, runQuery } from '../connection';
import { MediaTag } from '../types';
import { logger } from '../../utils/logger';

export async function findMediaTagsByMediaId(mediaId: number): Promise<MediaTag[]> {
  return getQuery<MediaTag>(
    'SELECT * FROM media_tags WHERE media_id = ?',
    [mediaId]
  );
}

export async function findMediaTagsByTagId(tagId: number): Promise<MediaTag[]> {
  return getQuery<MediaTag>(
    'SELECT * FROM media_tags WHERE tag_id = ?',
    [tagId]
  );
}

export async function addTagToMedia(mediaId: number, tagId: number): Promise<number> {
  try {
    // Check if the media-tag relationship already exists
    const existingMediaTag = await getOne<MediaTag>(
      'SELECT * FROM media_tags WHERE media_id = ? AND tag_id = ?',
      [mediaId, tagId]
    );
    
    if (existingMediaTag) {
      return existingMediaTag.id;
    }
    
    // Insert the new media-tag relationship
    const sql = 'INSERT INTO media_tags (media_id, tag_id) VALUES (?, ?)';
    
    return new Promise<number>((resolve, reject) => {
      runQuery(sql, [mediaId, tagId])
        .then(() => {
          // Get the last inserted id
          getOne<{id: number}>('SELECT last_insert_rowid() as id')
            .then(result => resolve(result?.id || 0))
            .catch(reject);
        })
        .catch(reject);
    });
  } catch (error) {
    logger.error(`Error adding tag to media: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function removeTagFromMedia(mediaId: number, tagId: number): Promise<boolean> {
  try {
    await runQuery(
      'DELETE FROM media_tags WHERE media_id = ? AND tag_id = ?',
      [mediaId, tagId]
    );
    return true;
  } catch (error) {
    logger.error(`Error removing tag from media: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function removeAllTagsFromMedia(mediaId: number): Promise<boolean> {
  try {
    await runQuery('DELETE FROM media_tags WHERE media_id = ?', [mediaId]);
    return true;
  } catch (error) {
    logger.error(`Error removing all tags from media: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}