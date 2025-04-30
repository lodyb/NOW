export interface Media {
  id: number;
  title: string;
  filePath: string;
  normalizedPath: string | null;
  uncompressedPath: string | null;
  year: number | null;
  metadata: Record<string, any>;
  createdAt: Date;
  answers?: MediaAnswer[];
  mediaTags?: MediaTag[];
}

export interface MediaAnswer {
  id: number;
  media_id: number;
  answer: string;
  isPrimary: boolean;
  media?: Media;
}

export interface Tag {
  id: number;
  name: string;
  mediaTags?: MediaTag[];
}

export interface MediaTag {
  id: number;
  media_id: number;
  tag_id: number;
  media?: Media;
  tag?: Tag;
}

export interface User {
  id: string;
  username: string;
  correctAnswers: number;
  gamesPlayed: number;
}

export interface GameSession {
  id: number;
  guildId: string;
  channelId: string;
  startedAt: Date;
  endedAt: Date | null;
  rounds: number;
  currentRound: number;
}