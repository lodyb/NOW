import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryColumn()
  id!: string;

  @Column()
  username!: string;

  @Column({ default: 0 })
  correctAnswers!: number;

  @Column({ default: 0 })
  gamesPlayed!: number;
}