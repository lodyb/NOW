import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, OneToMany } from 'typeorm';
import { MediaAnswer } from './MediaAnswer';
import { MediaTag } from './MediaTag';

@Entity('media')
export class Media {
  @PrimaryGeneratedColumn()
  id: number = 0;

  @Column()
  title: string = '';

  @Column()
  filePath: string = '';

  @Column({ type: 'text', nullable: true, default: null })
  normalizedPath: string | null = null;
  
  @Column({ type: 'text', nullable: true, default: null })
  uncompressedPath: string | null = null;

  @Column({ type: 'integer', nullable: true, default: null })
  year: number | null = null;

  @Column({ type: 'simple-json', nullable: true, default: '{}' })
  metadata: Record<string, any> = {};

  @CreateDateColumn()
  createdAt: Date = new Date();

  @OneToMany(() => MediaAnswer, (mediaAnswer) => mediaAnswer.media)
  answers!: MediaAnswer[];

  @OneToMany(() => MediaTag, (mediaTag) => mediaTag.media)
  mediaTags!: MediaTag[];
}