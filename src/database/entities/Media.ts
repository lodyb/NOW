import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, OneToMany } from 'typeorm';
import { MediaAnswer } from './MediaAnswer';
import { MediaTag } from './MediaTag';

@Entity('media')
export class Media {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column()
  filePath!: string;

  @Column({ nullable: true })
  normalizedPath?: string;

  @Column({ nullable: true })
  year?: number;

  @Column({ type: 'json', nullable: true })
  metadata!: Record<string, any>;

  @CreateDateColumn()
  createdAt!: Date;

  @OneToMany(() => MediaAnswer, (mediaAnswer) => mediaAnswer.media)
  answers!: MediaAnswer[];

  @OneToMany(() => MediaTag, (mediaTag) => mediaTag.media)
  mediaTags!: MediaTag[];
}