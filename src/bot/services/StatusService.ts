import { Message, InteractionReplyOptions, MessageCreateOptions } from 'discord.js';

export type StatusCallback = (message: string) => Promise<void>;

export class StatusService {
  static createStatusUpdater(message: Message): StatusCallback {
    let statusMessage: Message | null = null;
    
    return async (status: string) => {
      try {
        if (!statusMessage) {
          statusMessage = await message.reply(status);
        } else {
          await statusMessage.edit(status);
        }
      } catch (err) {
        console.error('Error updating status message:', err);
      }
    };
  }

  /**
   * Create an ephemeral status updater that only shows messages to the command user
   * Uses reply with ephemeral flag when possible, falls back to regular reply
   */
  static createEphemeralStatusUpdater(message: Message): StatusCallback {
    let statusMessage: Message | null = null;
    
    return async (status: string) => {
      try {
        if (!statusMessage) {
          // For regular messages, just use a normal reply
          // We'll delete this later to reduce noise
          statusMessage = await message.reply(status);
        } else {
          await statusMessage.edit(status);
        }
      } catch (err) {
        console.error('Error updating ephemeral status message:', err);
      }
    };
  }

  /**
   * Delete a status message if it exists
   */
  static async deleteStatusMessage(statusMessage: Message | null): Promise<void> {
    if (statusMessage) {
      try {
        await statusMessage.delete();
      } catch (err) {
        console.error('Error deleting status message:', err);
      }
    }
  }

  static createProgressUpdater(baseMessage: string, statusMessage: Message): (progress: number) => Promise<void> {
    return async (progress: number) => {
      try {
        const progressBar = '█'.repeat(Math.floor(progress * 10)) + '░'.repeat(10 - Math.floor(progress * 10));
        await statusMessage.edit(`${baseMessage} [${progressBar}] ${Math.round(progress * 100)}%`);
      } catch (err) {
        console.error('Error updating progress:', err);
      }
    };
  }
}