import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('game_sessions')
export class GameSession {
  @PrimaryGeneratedColumn()
  id: number = 0;

  @Column()
  guildId: string = '';

  @Column()
  channelId: string = '';

  @CreateDateColumn()
  startedAt: Date = new Date();

  @Column({ nullable: true, default: null })
  endedAt: Date | null = null;

  @Column({ default: 0 })
  rounds: number = 0;

  @Column({ default: 1 })
  currentRound: number = 1;
}