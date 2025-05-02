// filepath: /home/lody/now/src/bot/commands/mahjong.ts
import { Message } from 'discord.js';

// Define tile types
type TileType = 'm' | 'p' | 's' | 'z';
type TileValue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
type HonorType = 'r' | 'g' | 'w' | 'e' | 's' | 'x' | 'n';

interface Tile {
  type: TileType;
  value: TileValue | HonorType;
  isOpen?: boolean;
}

interface MahjongHand {
  tiles: Tile[];
  isComplete: boolean;
  shanten: number;
  yaku: Yaku[];
  han: number;
  fu: number;
  discardSuggestions?: Tile[];
}

interface Yaku {
  name: string;
  hanValue: number;
  description: string;
  isActive: boolean;
}

// Parse a string of tiles into a structured format
const parseTiles = (handString: string): Tile[] => {
  const tiles: Tile[] = [];
  let i = 0;
  
  while (i < handString.length) {
    let isOpen = false;
    
    // Check if next character is a number
    if (/[1-9]/.test(handString[i])) {
      const value = parseInt(handString[i]) as TileValue;
      i++;
      
      // Look for tile type
      if (i < handString.length && /[mps]/.test(handString[i])) {
        const type = handString[i] as TileType;
        i++;
        
        // Check for open marker (o)
        if (i < handString.length && handString[i] === 'o') {
          isOpen = true;
          i++;
        }
        
        tiles.push({ type, value, isOpen });
      }
    } else if (/[rgwensx]/.test(handString[i])) {
      // Honor tile
      const value = handString[i] as HonorType;
      i++;
      
      // Check for open marker (o)
      if (i < handString.length && handString[i] === 'o') {
        isOpen = true;
        i++;
      }
      
      tiles.push({ type: 'z', value, isOpen });
    } else {
      // Skip unknown characters
      i++;
    }
  }
  
  return tiles;
};

// Count tiles by type and value
const countTiles = (tiles: Tile[]): Map<string, number> => {
  const counts = new Map<string, number>();
  
  for (const tile of tiles) {
    const key = `${tile.value}${tile.type}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  
  return counts;
};

// Calculate shanten (how many tiles away from tenpai)
const calculateShanten = (tiles: Tile[]): number => {
  // Simplified shanten calculation
  // This is a basic implementation - a complete one would require much more complex logic
  
  const counts = countTiles(tiles);
  let pairs = 0;
  let sets = 0;
  let almostSets = 0;
  
  // Count pairs and potential sets
  for (const [_, count] of counts.entries()) {
    if (count >= 3) {
      sets++;
    } else if (count === 2) {
      pairs++;
    } else if (count === 1) {
      // Check for potential sequences
      // This is simplified and doesn't handle all cases
      almostSets += 0.5; // Rough approximation
    }
  }
  
  // A complete hand needs 4 sets and 1 pair
  // Shanten = (4 - sets) + (1 - min(1, pairs))
  const shantenValue = Math.max(0, 4 - sets) + Math.max(0, 1 - Math.min(1, pairs));
  
  // Adjust for almost sets (simplified)
  return Math.max(0, Math.ceil(shantenValue - Math.min(almostSets, shantenValue)));
};

// Check for various yaku
const checkYaku = (tiles: Tile[]): Yaku[] => {
  const yaku: Yaku[] = [];
  const counts = countTiles(tiles);
  
  // Check for tanyao (all simples)
  const hasTanyao = !Array.from(counts.keys()).some(key => {
    const value = parseInt(key.charAt(0));
    const type = key.charAt(1);
    return (value === 1 || value === 9 || type === 'z');
  });
  
  if (hasTanyao) {
    yaku.push({
      name: 'Tanyao',
      hanValue: 1,
      description: 'All simples',
      isActive: true
    });
  }
  
  // Check for pinfu (all sequences with pair that isn't yakuhai)
  // This is simplified - real pinfu checking is more complex
  
  // Check for yakuhai (dragons and winds)
  let hasYakuhai = false;
  let yakuhaiCount = 0;
  
  for (const [key, count] of counts.entries()) {
    const value = key.charAt(0);
    const type = key.charAt(1);
    
    if (type === 'z' && count >= 3) {
      hasYakuhai = true;
      yakuhaiCount++;
    }
  }
  
  if (hasYakuhai) {
    yaku.push({
      name: 'Yakuhai',
      hanValue: yakuhaiCount,
      description: `Value tiles (${yakuhaiCount} sets)`,
      isActive: true
    });
  }
  
  // Many more yaku checks would go here
  // Simplified for now
  
  return yaku;
};

// Calculate fu points
const calculateFu = (tiles: Tile[]): number => {
  // Basic fu calculation - simplified
  // In reality, fu calculation is more complex based on the hand structure
  let fu = 20; // Starting value
  
  // Add fu for pair of dragons, seat wind, or round wind
  const counts = countTiles(tiles);
  
  for (const [key, count] of counts.entries()) {
    const value = key.charAt(0);
    const type = key.charAt(1);
    
    if (type === 'z' && count === 2) {
      fu += 2; // Pair of dragons or winds
    }
  }
  
  // Round up to next 10
  return Math.ceil(fu / 10) * 10;
};

// Generate discard suggestions
const suggestDiscards = (tiles: Tile[]): Tile[] => {
  // This is a simplified suggestion algorithm
  // In reality, would need to calculate efficiency for each possible discard
  
  const counts = countTiles(tiles);
  const suggestions: Tile[] = [];
  
  // Suggest isolated tiles first
  for (const [key, count] of counts.entries()) {
    if (count === 1) {
      const value = key.charAt(0);
      const type = key.charAt(1);
      
      // Convert back to actual value
      const tileValue = /[1-9]/.test(value) 
        ? parseInt(value) as TileValue 
        : value as HonorType;
      
      suggestions.push({
        type: type as TileType,
        value: tileValue
      });
    }
  }
  
  return suggestions.slice(0, 3); // Return top 3 suggestions
};

// Analyze a mahjong hand
const analyzeMahjongHand = (handString: string): MahjongHand => {
  const tiles = parseTiles(handString);
  
  // Check if hand is complete (14 tiles)
  const isComplete = tiles.length === 14;
  
  // Calculate shanten value
  const shanten = calculateShanten(tiles);
  
  // Check for yaku if hand is complete
  const yaku = isComplete ? checkYaku(tiles) : [];
  
  // Calculate han value
  const han = yaku.reduce((sum, current) => sum + current.hanValue, 0);
  
  // Calculate fu
  const fu = isComplete ? calculateFu(tiles) : 0;
  
  // Generate discard suggestions if not complete
  const discardSuggestions = !isComplete || shanten > 0 
    ? suggestDiscards(tiles) 
    : undefined;
  
  return {
    tiles,
    isComplete,
    shanten,
    yaku,
    han,
    fu,
    discardSuggestions
  };
};

// Format a tile for display
const formatTile = (tile: Tile): string => {
  if (tile.type === 'z') {
    // Honor tiles
    const honors: Record<string, string> = {
      'r': '🔴 Red Dragon',
      'g': '🟢 Green Dragon',
      'w': '⚪ White Dragon',
      'e': '🌅 East Wind',
      's': '🌞 South Wind',
      'x': '🌙 West Wind',
      'n': '⭐ North Wind'
    };
    
    return honors[tile.value as string] || tile.value.toString();
  } else {
    // Number tiles
    const suits: Record<string, string> = {
      'm': 'Man 🀇',
      'p': 'Pin 🀙',
      's': 'Sou 🀐'
    };
    
    return `${tile.value} ${suits[tile.type]}${tile.isOpen ? ' (open)' : ''}`;
  }
};

// Generate the response message
const formatResponse = (hand: MahjongHand): string => {
  let response = '**Mahjong Hand Analysis**\n\n';
  
  // Basic info
  response += `Tiles: ${hand.tiles.length}\n`;
  response += `Complete hand: ${hand.isComplete ? 'Yes' : 'No'}\n`;
  
  if (hand.shanten === 0 && hand.isComplete) {
    response += `**This is a winning hand!** 🎉\n\n`;
  } else {
    response += `Shanten: ${hand.shanten} (${hand.shanten === 0 ? 'Ready to win!' : hand.shanten + ' tiles away from ready'})\n\n`;
  }
  
  // Yaku information if any
  if (hand.yaku.length > 0) {
    response += '**Yaku:**\n';
    for (const yaku of hand.yaku) {
      response += `- ${yaku.name} (${yaku.hanValue} han): ${yaku.description}\n`;
    }
    response += `\nTotal Han: ${hand.han}\n`;
    response += `Fu: ${hand.fu}\n\n`;
    
    // Basic scoring info - very simplified
    if (hand.han >= 5) {
      response += 'Score: Mangan or higher 💰\n';
    } else if (hand.han > 0) {
      response += `Score: ${hand.han} han, ${hand.fu} fu\n`;
    }
  } else if (hand.isComplete) {
    response += 'No yaku detected. This hand cannot win.\n\n';
  }
  
  // Discard suggestions
  if (hand.discardSuggestions && hand.discardSuggestions.length > 0) {
    response += '**Discard Suggestions:**\n';
    for (const tile of hand.discardSuggestions) {
      response += `- ${formatTile(tile)}\n`;
    }
  }
  
  return response;
};

// Handle the mahjong command
export const handleMahjongCommand = async (message: Message, handString?: string) => {
  if (!handString) {
    await message.reply(
      'Please provide a mahjong hand to analyze. Example: `NOW mahjong 1s1s2s2s3s3s1p1p2p2p3p3prr`\n' +
      'Use numbers 1-9 followed by m (man), p (pin), or s (sou) for number tiles.\n' +
      'Use r (red), g (green), w (white) for dragons.\n' +
      'Use e (east), s (south), x (west), n (north) for winds.\n' +
      'Add o at the end of a tile to mark it as open (e.g., 1so)'
    );
    return;
  }
  
  // Clean up input - remove spaces and other non-alphanumeric chars
  const cleanHand = handString.replace(/[^1-9mpsrgwenxo]/g, '');
  
  if (cleanHand.length === 0) {
    await message.reply('Invalid hand format. Please check your input.');
    return;
  }
  
  try {
    const analysis = analyzeMahjongHand(cleanHand);
    const response = formatResponse(analysis);
    await message.reply(response);
  } catch (error) {
    console.error('Error analyzing mahjong hand:', error);
    await message.reply(`Error analyzing hand: ${(error as Error).message}`);
  }
};