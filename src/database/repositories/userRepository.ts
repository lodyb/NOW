import { getOne, getQuery, runQuery } from '../connection';
import { User } from '../types';
import { logger } from '../../utils/logger';

export async function findUserById(id: string): Promise<User | null> {
  return getOne<User>('SELECT * FROM users WHERE id = ?', [id]);
}

export async function saveUser(user: Partial<User>): Promise<string> {
  try {
    // id is required
    if (!user.id) {
      throw new Error('User ID is required');
    }

    // Check if the user exists
    const existingUser = await findUserById(user.id);
    
    if (existingUser) {
      // Update existing user
      const sql = `
        UPDATE users
        SET
          username = COALESCE(?, username),
          correctAnswers = COALESCE(?, correctAnswers),
          gamesPlayed = COALESCE(?, gamesPlayed)
        WHERE id = ?
      `;
      
      await runQuery(sql, [
        user.username,
        user.correctAnswers,
        user.gamesPlayed,
        user.id
      ]);
    } else {
      // Insert new user
      // username is required for new users
      if (!user.username) {
        throw new Error('Username is required for new users');
      }
      
      const sql = `
        INSERT INTO users (
          id, username, correctAnswers, gamesPlayed
        ) VALUES (?, ?, ?, ?)
      `;
      
      await runQuery(sql, [
        user.id,
        user.username,
        user.correctAnswers || 0,
        user.gamesPlayed || 0
      ]);
    }
    
    return user.id;
  } catch (error) {
    logger.error(`Error saving user: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function getTopUsers(limit: number = 10): Promise<User[]> {
  return getQuery<User>(
    'SELECT * FROM users ORDER BY correctAnswers DESC LIMIT ?',
    [limit]
  );
}

export async function incrementUserStats(userId: string, correctAnswers: number = 0, gamesPlayed: number = 0): Promise<boolean> {
  try {
    const user = await findUserById(userId);
    
    if (user) {
      // User exists, update the stats
      await runQuery(
        'UPDATE users SET correctAnswers = correctAnswers + ?, gamesPlayed = gamesPlayed + ? WHERE id = ?',
        [correctAnswers, gamesPlayed, userId]
      );
    }
    
    return true;
  } catch (error) {
    logger.error(`Error incrementing user stats: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}