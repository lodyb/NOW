import { getOne, getQuery, runQuery } from '../connection';
import { MediaAnswer } from '../types';
import { logger } from '../../utils/logger';

export async function findAnswersByMediaId(mediaId: number): Promise<MediaAnswer[]> {
  return getQuery<MediaAnswer>(
    'SELECT * FROM media_answers WHERE media_id = ?',
    [mediaId]
  );
}

export async function saveMediaAnswer(answer: Partial<MediaAnswer>): Promise<number> {
  try {
    // If id is present, update the answer
    if (answer.id) {
      const sql = `
        UPDATE media_answers
        SET
          answer = COALESCE(?, answer),
          isPrimary = COALESCE(?, isPrimary)
        WHERE id = ?
      `;
      
      await runQuery(sql, [
        answer.answer,
        answer.isPrimary === true ? 1 : answer.isPrimary === false ? 0 : null,
        answer.id
      ]);
      
      return answer.id;
    } 
    // Otherwise, insert a new answer
    else {
      // media_id and answer are required
      if (!answer.media_id || !answer.answer) {
        throw new Error('Media ID and answer are required');
      }
      
      const sql = `
        INSERT INTO media_answers (
          media_id, answer, isPrimary
        ) VALUES (?, ?, ?)
      `;
      
      return new Promise<number>((resolve, reject) => {
        runQuery(sql, [
          answer.media_id,
          answer.answer,
          answer.isPrimary ? 1 : 0
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
    logger.error(`Error saving media answer: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function deleteMediaAnswer(id: number): Promise<boolean> {
  try {
    await runQuery('DELETE FROM media_answers WHERE id = ?', [id]);
    return true;
  } catch (error) {
    logger.error(`Error deleting media answer: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function deleteMediaAnswersByMediaId(mediaId: number): Promise<boolean> {
  try {
    await runQuery('DELETE FROM media_answers WHERE media_id = ?', [mediaId]);
    return true;
  } catch (error) {
    logger.error(`Error deleting media answers by media ID: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}