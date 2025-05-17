// filepath: /home/lody/now/src/bot/commands/filtertest.ts
import { Message } from 'discord.js';
import { testAllFilters, testSpecificFilters } from '../../media/filterTester';
import { safeReply } from '../utils/helpers';

/**
 * Command handler for testing filters
 * Allows testing all filters or specific ones
 * Usage: NOW filtertest [filter1 filter2 ...]
 */
export const handleFilterTestCommand = async (message: Message, args: string[]) => {
  try {
    // Filter out the command name from args if present
    const specificFilters = args.filter(arg => arg !== 'filtertest');
    
    // Prepare status message
    const statusMessage = await message.reply('Starting filter tests... ⏳');
    
    // Define progress update function
    const updateProgress = async (current: number, total: number, filterName: string) => {
      const percent = Math.floor((current / total) * 100);
      try {
        if (current % 5 === 0 || current === total) { // Update every 5 filters to avoid Discord rate limits
          await statusMessage.edit(`Testing filters: ${percent}% (${current}/${total}) - Current: ${filterName}`);
        }
      } catch (e) {
        console.error('Error updating status message:', e);
      }
    };
    
    // Start the test
    await statusMessage.edit(`Initializing filter tests... ⏳`);
    
    let reportPath: string;
    
    if (specificFilters.length > 0) {
      await statusMessage.edit(`Running tests for ${specificFilters.length} specific filters... ⏳`);
      reportPath = await testSpecificFilters(specificFilters, updateProgress);
    } else {
      await statusMessage.edit(`Running tests for all filters... ⏳`);
      reportPath = await testAllFilters(updateProgress);
    }
    
    // Send completion message
    await statusMessage.edit(`Filter testing completed ✅\nResults saved to: ${reportPath}`);
    
    // For longer reports, we'll upload the file instead of trying to post it as a message
    await message.reply({ 
      content: 'Filter test results:', 
      files: [reportPath] 
    });
    
  } catch (error) {
    console.error('Error in filter test command:', error);
    await safeReply(message, `An error occurred while testing filters: ${error instanceof Error ? error.message : String(error)}`);
  }
};