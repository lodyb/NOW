import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('game_sessions')
export class GameSession {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  guildId!: string;

  @Column()
  channelId!: string;

  @CreateDateColumn()
  startedAt!: Date;

  @Column({ nullable: true })
  endedAt?: Date;

  @Column({ default: 0 })
  rounds!: number;

  @Column({ default: 1 })
  currentRound!: number;
}