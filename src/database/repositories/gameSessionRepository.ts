import { getOne, getQuery, runQuery } from '../connection';
import { GameSession } from '../types';
import { logger } from '../../utils/logger';

export async function findGameSessionById(id: number): Promise<GameSession | null> {
  return getOne<GameSession>('SELECT * FROM game_sessions WHERE id = ?', [id]);
}

export async function findActiveGameSessionsByChannel(channelId: string): Promise<GameSession[]> {
  return getQuery<GameSession>(
    'SELECT * FROM game_sessions WHERE channelId = ? AND endedAt IS NULL',
    [channelId]
  );
}

export async function saveGameSession(session: Partial<GameSession>): Promise<number> {
  try {
    // If id is present, update the session
    if (session.id) {
      const sql = `
        UPDATE game_sessions
        SET
          guildId = COALESCE(?, guildId),
          channelId = COALESCE(?, channelId),
          endedAt = ?,
          rounds = COALESCE(?, rounds),
          currentRound = COALESCE(?, currentRound)
        WHERE id = ?
      `;
      
      await runQuery(sql, [
        session.guildId,
        session.channelId,
        session.endedAt ? session.endedAt : null,
        session.rounds,
        session.currentRound,
        session.id
      ]);
      
      return session.id;
    } 
    // Otherwise, insert a new session
    else {
      // guildId and channelId are required
      if (!session.guildId || !session.channelId) {
        throw new Error('Guild ID and Channel ID are required');
      }
      
      const sql = `
        INSERT INTO game_sessions (
          guildId, channelId, endedAt, rounds, currentRound
        ) VALUES (?, ?, ?, ?, ?)
      `;
      
      return new Promise<number>((resolve, reject) => {
        runQuery(sql, [
          session.guildId,
          session.channelId,
          session.endedAt || null,
          session.rounds || 0,
          session.currentRound || 1
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
    logger.error(`Error saving game session: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function updateGameSessionRound(id: number, currentRound: number): Promise<boolean> {
  try {
    await runQuery(
      'UPDATE game_sessions SET currentRound = ? WHERE id = ?',
      [currentRound, id]
    );
    return true;
  } catch (error) {
    logger.error(`Error updating game session round: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function endGameSession(id: number, rounds: number): Promise<boolean> {
  try {
    await runQuery(
      'UPDATE game_sessions SET endedAt = CURRENT_TIMESTAMP, rounds = ? WHERE id = ?',
      [rounds, id]
    );
    return true;
  } catch (error) {
    logger.error(`Error ending game session: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}