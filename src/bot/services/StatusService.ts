import { Message } from 'discord.js';

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

  static createProgressUpdater(baseMessage: string, statusMessage: Message): (progress: number) => Promise<void> {
    return async (progress: number) => {
      try {
        await statusMessage.edit(`${baseMessage} (${Math.round(progress * 100)}%)... ⏳`);
      } catch (err) {
        console.error('Error updating progress:', err);
      }
    };
  }
}