import { getOne, getQuery, runQuery } from '../connection';
import { Tag, MediaTag } from '../types';
import { logger } from '../../utils/logger';

export async function findTagById(id: number): Promise<Tag | null> {
  return getOne<Tag>('SELECT * FROM tags WHERE id = ?', [id]);
}

export async function findTagByName(name: string): Promise<Tag | null> {
  return getOne<Tag>('SELECT * FROM tags WHERE name = ?', [name]);
}

export async function getAllTags(): Promise<Tag[]> {
  return getQuery<Tag>('SELECT * FROM tags ORDER BY name');
}

export async function findTagsForMedia(mediaId: number): Promise<Tag[]> {
  const sql = `
    SELECT t.* 
    FROM tags t
    JOIN media_tags mt ON t.id = mt.tag_id
    WHERE mt.media_id = ?
    ORDER BY t.name
  `;
  
  return getQuery<Tag>(sql, [mediaId]);
}

export async function saveTag(tag: Partial<Tag>): Promise<number> {
  try {
    // If id is present, update the tag
    if (tag.id) {
      // Name is required for tags
      if (!tag.name) {
        throw new Error('Tag name is required');
      }
      
      const sql = 'UPDATE tags SET name = ? WHERE id = ?';
      
      await runQuery(sql, [tag.name, tag.id]);
      
      return tag.id;
    } 
    // Otherwise, insert a new tag
    else {
      // Name is required for tags
      if (!tag.name) {
        throw new Error('Tag name is required');
      }
      
      // Check if the tag already exists
      const existingTag = await findTagByName(tag.name);
      
      if (existingTag) {
        return existingTag.id;
      }
      
      const sql = 'INSERT INTO tags (name) VALUES (?)';
      
      return new Promise<number>((resolve, reject) => {
        runQuery(sql, [tag.name])
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
    logger.error(`Error saving tag: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function deleteTag(id: number): Promise<boolean> {
  try {
    await runQuery('DELETE FROM tags WHERE id = ?', [id]);
    return true;
  } catch (error) {
    logger.error(`Error deleting tag: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}